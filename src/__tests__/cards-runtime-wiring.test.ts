/**
 * Card runtime facade and ordinary-path wiring (WP-06 C08b).
 *
 * - startup: `openCardRuntime` is card-inert unless the Bot is provisioned and
 *   ready; `cards.disable` skips the subsystem entirely;
 * - parity: the real handler, router, relay, REST client and SQLite run the
 *   S04-M cases card-off and card-on; ordinary sends, ledger, outputs and
 *   history are byte-identical, and the card terminal follows D-A
 *   (AC-009.1/.2, AC-020.1, AC-021.1);
 * - notices, the route matrix (AC-006.1), two-Bot isolation with a shared
 *   origin cooldown (AC-002.1/AC-007.6) and protected sentinels (AC-019.2);
 * - NB-1: every `ManagedBot.shutdown` call site passes its reason to the
 *   registry, and the registry closes after `stopTurns` and before
 *   `gateway.stop`/`store.close`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic model events only. The mock honours the bridge contract: item_state
// events exist only with the `itemStates` opt-in, and safe notices are reported
// through `onSafeItem` exactly where the real bridge reports them.
const agentScript = vi.hoisted(() => ({
  events: [] as unknown[],
  throwAfter: false,
  advance: undefined as undefined | ((ms: number) => Promise<void>),
  calls: [] as { itemStates: boolean }[],
}));
vi.mock("../agent-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent-bridge.js")>(),
  queryAgentEvents: vi.fn(async function* (_m: string, _c: unknown, _s: unknown, _t: unknown, opts?: { itemStates?: boolean; signal?: AbortSignal }, onSafeItem?: (f: unknown) => void) {
    agentScript.calls.push({ itemStates: opts?.itemStates === true });
    for (const ev of agentScript.events) {
      const e = ev as { kind: string; ms?: number; phase?: string; safe?: unknown };
      if (e.kind === "__advance") { await agentScript.advance?.(e.ms ?? 0); continue; }
      if (e.kind === "item_state") {
        if (onSafeItem && (e.phase === "started" || e.phase === "completed")) onSafeItem(e.safe);
        if (opts?.itemStates !== true) continue;
      }
      opts?.signal?.throwIfAborted();
      yield ev;
    }
    if (agentScript.throwAfter) throw new Error("synthetic stream failure");
  }),
}));

// startBot-level cases only: registration and the socket are synthetic; every
// other REST call (sendMessage, typing, receipts) stays real over the stubbed fetch.
vi.mock("../octo/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../octo/api.js")>(),
  registerBot: vi.fn(async () => ({ robot_id: "test_bot", im_token: "im", ws_url: "ws://localhost", api_url: "https://test.invalid",
    owner_uid: "human", owner_channel_id: "owner-channel" })),
  getUploadCredentials: vi.fn(async () => ({})),
  sendHeartbeat: vi.fn(async () => undefined),
}));
vi.mock("../octo/socket.js", () => ({
  WKSocket: vi.fn().mockImplementation(() => ({ connect: vi.fn(), disconnectAndWait: vi.fn().mockResolvedValue(undefined) })),
}));

const registrySpy = vi.hoisted(() => ({ reasons: [] as string[], order: [] as string[] }));
vi.mock("../cards/resource-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/resource-registry.js")>();
  return {
    ...actual,
    createResourceRegistry: vi.fn((options: Parameters<typeof actual.createResourceRegistry>[0]) => {
      const real = actual.createResourceRegistry(options);
      return Object.freeze({
        get closing() { return real.closing; },
        register: real.register,
        closeAll: (reason: Parameters<typeof real.closeAll>[0]) => { registrySpy.reasons.push(reason); registrySpy.order.push("closeAll"); return real.closeAll(reason); },
      });
    }),
  };
});

const openSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../cards/recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/recovery.js")>();
  return { ...actual, openCardSubsystem: vi.fn((o: Parameters<typeof actual.openCardSubsystem>[0]) => { openSpy.calls++; return actual.openCardSubsystem(o); }) };
});

import { BotManager, type ManagedBot } from "../bot-manager.js";
import type { ShutdownReason } from "../cards/contracts.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { createPacer } from "../cards/pacer.js";
import { cardSubsystemPaths } from "../cards/recovery.js";
import { reduceItem } from "../cards/redact.js";
import { openCardRuntime, type CardRuntime } from "../cards/runtime.js";
import type { Config } from "../config.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { GroupContext } from "../group-context.js";
import { handleMessage, startBot } from "../index.js";
import { OctoGateway } from "../gateway.js";
import { ChannelType, MessageType, type BotMessage } from "../octo/types.js";
import { SessionRouter } from "../session-router.js";
import { SessionStore } from "../session-store.js";
import { StreamRelay } from "../stream-relay.js";
import { profile } from "./fixtures/card-profile.js";
import { json, manualTime, scriptedFetch, type ManualTime } from "./fixtures/card-write-harness.js";

const API = "https://test.invalid";
const NOTICE = "[No response generated. Please try rephrasing your question.]";
const THREE = ["A".repeat(3000), "B".repeat(3000), "C".repeat(3000)].join("\n\n");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Deployment-side provisioning through the existing marker contract (WP-18 owns the real step). */
function provision(dataDir: string, ref = "install-a"): void {
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, `${ref}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, ref, Date.UTC(2026, 9, 22));
}

function cardTransport(time: ManualTime, prof: () => unknown = () => profile()) {
  const net = scriptedFetch(time);
  const profileAuth: (string | null)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/v1/bot/card/profile")) {
      profileAuth.push(new Headers(init?.headers).get("authorization"));
      return json(200, prof());
    }
    return net.fetchImpl(input, init);
  }) as typeof fetch;
  return { net, fetchImpl, profileAuth };
}

// ─── startup ────────────────────────────────────────────────────────────────

describe("openCardRuntime startup", () => {
  it("an unprovisioned Bot is card-inert: no runtime, no card directory, no card tables", async () => {
    const dataDir = join(tempDir("wp06-inert-"), "data");
    mkdirSync(dataDir);
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const time = manualTime();
    const runtime = await openCardRuntime({ adapter, dataDir, apiUrl: API, botToken: "token-a", clock: time.clock, wall: time.wall, timers: time.timers });
    expect(runtime).toBeUndefined();
    expect(existsSync(join(dataDir, "cards"))).toBe(false);
    expect(adapter.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'card_%'").all()).toEqual([]);
    adapter.close();
  });

  it("a provisioned Bot opens a ready runtime over its own database", async () => {
    const dataDir = join(tempDir("wp06-ready-"), "data");
    mkdirSync(dataDir);
    provision(dataDir);
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const time = manualTime();
    const runtime = await openCardRuntime({ adapter, dataDir, apiUrl: API, botToken: "token-a", clock: time.clock, wall: time.wall, timers: time.timers,
      fetchImpl: cardTransport(time).fetchImpl });
    expect(runtime).toBeDefined();
    expect((adapter.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'card_%'").get() as { n: number }).n).toBeGreaterThan(0);
    await runtime!.close("shutdown");
    adapter.close();
  });

  it("an invalid API base or credential leaves the Bot card-inert without throwing", async () => {
    const dataDir = join(tempDir("wp06-badcfg-"), "data");
    mkdirSync(dataDir);
    provision(dataDir);
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const time = manualTime();
    await expect(openCardRuntime({ adapter, dataDir, apiUrl: "not a url", botToken: "token-a", clock: time.clock, wall: time.wall, timers: time.timers })).resolves.toBeUndefined();
    await expect(openCardRuntime({ adapter, dataDir, apiUrl: API, botToken: "bad token", clock: time.clock, wall: time.wall, timers: time.timers })).resolves.toBeUndefined();
    adapter.close();
  });
});

// ─── route matrix and turn context ──────────────────────────────────────────

describe("beginTurn route matrix (AC-006.1) and trusted context", () => {
  async function ready() {
    const dataDir = join(tempDir("wp06-route-"), "data");
    mkdirSync(dataDir);
    provision(dataDir);
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const time = manualTime();
    const runtime = (await openCardRuntime({ adapter, dataDir, apiUrl: API, botToken: "token-a", clock: time.clock, wall: time.wall, timers: time.timers,
      fetchImpl: cardTransport(time).fetchImpl }))!;
    return { runtime, adapter, time };
  }
  const input = (channelType: number, over: Record<string, unknown> = {}) =>
    ({ dispatchId: `d-${channelType}`, sessionKey: `s-${channelType}`, channelId: "c", channelType, requesterUid: "u", resetEpoch: 0, cron: false, obo: undefined, docTask: undefined, ...over });

  it("DM, group and community topic get a coordinator with the trusted route kind; other channel types get none", async () => {
    const { runtime, adapter } = await ready();
    expect(runtime.beginTurn(input(ChannelType.DM, { obo: false, docTask: false }))?.coordinator.context.routeEligibility).toEqual({ kind: "dm", obo: false, docTask: false, cron: false });
    // D-W1(b): an unknown route fact is never guessed false.
    expect(runtime.beginTurn(input(ChannelType.DM, { dispatchId: "d-unknown" }))?.coordinator.context.routeEligibility).toEqual({ kind: "dm", obo: true, docTask: true, cron: false });
    expect(runtime.beginTurn(input(ChannelType.Group))?.coordinator.context.routeEligibility.kind).toBe("group");
    expect(runtime.beginTurn(input(ChannelType.CommunityTopic))?.coordinator.context.routeEligibility.kind).toBe("topic");
    for (const other of [0, 3, 4, 6, 99]) expect(runtime.beginTurn(input(other))).toBeUndefined();
    await runtime.close("shutdown");
    adapter.close();
  });

  it("the context is deeply frozen and carries no credential", async () => {
    const { runtime, adapter } = await ready();
    const t = runtime.beginTurn(input(ChannelType.DM, { cron: true }))!.coordinator;
    expect(Object.isFrozen(t.context)).toBe(true);
    expect(Object.isFrozen(t.context.route)).toBe(true);
    expect(Object.isFrozen(t.context.botRef)).toBe(true);
    expect(t.context.routeEligibility.cron).toBe(true);
    expect(JSON.stringify(t.context)).not.toContain("token-a");
    expect(t.context.botRef.credentialRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await runtime.close("shutdown");
    adapter.close();
  });

  it("a turn begun after close, or for an already timed-out dispatch, never opens a card", async () => {
    const { runtime, adapter } = await ready();
    runtime.onTimeout("d-early");
    const early = runtime.beginTurn(input(ChannelType.DM, { dispatchId: "d-early" }))?.coordinator;
    expect(early?.inspect().terminal).toBe("timed_out");
    await runtime.close("shutdown");
    expect(runtime.beginTurn(input(ChannelType.DM, { dispatchId: "d-late" }))).toBeUndefined();
    adapter.close();
  });

  it("a newer turn of the same session supersedes the older generation", async () => {
    const { runtime, adapter } = await ready();
    const a = runtime.beginTurn(input(ChannelType.DM, { dispatchId: "d-a", sessionKey: "same" }))!.coordinator;
    const b = runtime.beginTurn(input(ChannelType.DM, { dispatchId: "d-b", sessionKey: "same" }))!.coordinator;
    expect(a.inspect().superseded).toBe(true);
    expect(b.inspect().superseded).toBe(false);
    expect(a.generation).not.toBe(b.generation);
    await runtime.close("shutdown");
    adapter.close();
  });
});

// ─── handler-level parity ───────────────────────────────────────────────────

type Path = "return" | "catch" | "abort";
const answerEvents = (text: string, work = true) => [
  { kind: "attempt_start", attempt: 0, reason: "initial", continues: null },
  ...(work ? [
    { kind: "work", attempt: 0, itemId: "cmd", seq: 0, itemType: "command_execution" },
    { kind: "item_state", attempt: 0, itemId: "cmd", seq: 0, itemType: "command_execution", phase: "started", status: "in_progress", safe: reduceItem({ type: "command_execution", command: "git status", status: "in_progress" }) },
    { kind: "__advance", ms: 900 },
    { kind: "item_state", attempt: 0, itemId: "cmd", seq: 0, itemType: "command_execution", phase: "completed", status: "completed", safe: reduceItem({ type: "command_execution", command: "git status", status: "completed", exit_code: 0 }) },
  ] : []),
  { kind: "message", attempt: 0, itemId: "answer", seq: 1, text, phase: "unknown" },
  { kind: "attempt_end", attempt: 0, terminal: "completed" },
];
const ok = (id: string) => new Response(`{"message_id":${id},"client_msg_no":"server-generated-key","message_seq":7}`);

interface Observation {
  sends: string[];
  parts: unknown[];
  outputs: unknown[];
  history: unknown[];
  failures: string[];
}

interface Run { obs: Observation; notices: string[]; cards: { sends: number; terminal?: { state: string; label: string } }; rows: unknown[] }

class Harness {
  root = tempDir("wp06-parity-");
  dataDir = join(this.root, "data");
  adapter!: DbAdapter;
  store!: SessionStore;
  router!: SessionRouter;
  config!: Config;
  time = manualTime();
  transport = cardTransport(this.time);
  runtime: CardRuntime | undefined;
  /** Ordinary sends other than tool-progress notices, which card mode replaces by design (TD §5.4 step 3). */
  sends: string[] = [];
  notices: string[] = [];
  /** Every ordinary send in order. */
  all: string[] = [];
  failures: string[] = [];

  async open(cards: boolean, over: Partial<Config> = {}): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    if (cards) provision(this.dataDir);
    this.adapter = createAdapter(join(this.dataDir, "cc-octo.db"));
    this.store = new SessionStore(this.adapter);
    this.store.init();
    this.config = { botToken: "FAKE_TEST_TOKEN", apiUrl: API, cwd: join(this.root, "ws"), dataDir: this.dataDir,
      sdk: { toolProgress: true }, rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      cards: { disable: false, eventTransport: "off", reasoningSummary: "off" }, ...over } as Config;
    this.router = new SessionRouter(this.config, "bot", "owner", this.store);
    this.runtime = cards ? await openCardRuntime({ adapter: this.adapter, dataDir: this.dataDir, apiUrl: API, botToken: this.config.botToken,
      clock: this.time.clock, wall: this.time.wall, timers: this.time.timers, fetchImpl: this.transport.fetchImpl,
      pacer: createPacer({ clock: this.time.clock, timers: this.time.timers, rng: () => 0 }) }) : undefined;
    if (cards) expect(this.runtime).toBeDefined();
    if (this.runtime) this.router.setDispatchObserver(this.runtime);
    agentScript.advance = (ms) => this.time.advance(ms);
    agentScript.throwAfter = false;
  }

  stub(responder: (i: number, init: RequestInit) => Promise<Response> | Response): void {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/v1/bot/sendMessage")) return new Response("{}");
      const body = JSON.parse(String(init?.body)) as { payload: { type: number; content: string } };
      expect(body.payload.type).not.toBe(17);
      this.all.push(body.payload.content);
      if (body.payload.content.startsWith("🔧 ")) { this.notices.push(body.payload.content); return ok("1"); }
      this.sends.push(body.payload.content);
      return responder(this.sends.length - 1, init ?? {});
    }));
  }

  msg(n: number): BotMessage {
    return { message_id: `incoming-${n}`, message_seq: n, from_uid: "human", from_name: "Human",
      channel_id: "human", channel_type: ChannelType.DM, timestamp: 0, payload: { type: MessageType.Text, content: `request ${n}` } };
  }

  async turn(n = 1): Promise<string> {
    await handleMessage(this.msg(n), this.config, this.store, this.router, new GroupContext(this.adapter, 6000), new StreamRelay(), "bot", () => "owner", this.runtime);
    await new Promise((r) => setTimeout(r, 0));
    await this.time.advance(0);
    await this.runtime?.idle();
    await this.time.advance(0);
    return (this.adapter.prepare("SELECT turn_id FROM turn_execution ORDER BY rowid DESC").get() as { turn_id: string }).turn_id;
  }

  observe(): Observation {
    const norm = (s: string) => s.replace(UUID, "<id>");
    return {
      sends: this.sends.map(norm),
      parts: (this.adapter.prepare("SELECT part_index, state, message_id, payload FROM delivery_parts ORDER BY rowid").all() as { payload: string }[])
        .map((p) => ({ ...p, payload: norm(p.payload) })),
      outputs: this.adapter.prepare("SELECT state, content FROM turn_outputs ORDER BY rowid").all(),
      history: this.adapter.prepare("SELECT role, content FROM messages ORDER BY id").all(),
      failures: this.failures.map(norm),
    };
  }

  cards(): Run["cards"] {
    const sends = this.transport.net.sends().length;
    const last = this.transport.net.requests.at(-1);
    if (!last) return { sends };
    const body = JSON.parse(last.body) as { state?: string; data?: { statusLabel: string }; payload?: { state: string; data: { statusLabel: string } } };
    const state = body.state ?? body.payload?.state ?? "";
    const label = (body.data ?? body.payload?.data)?.statusLabel ?? "";
    return { sends, terminal: { state, label } };
  }

  /** Durable automatic card rows, read before the runtime closes. */
  rows(): unknown[] {
    try {
      return this.adapter.prepare("SELECT kind, state, terminal_reason AS reason, terminal_at IS NOT NULL AS terminal FROM card_messages ORDER BY rowid").all();
    } catch { return []; }
  }

  async close(): Promise<void> {
    await this.runtime?.close("shutdown");
    try { this.store.close(); } catch { /* closed */ }
  }
}

interface Case {
  readonly name: string;
  readonly path: Path;
  readonly events: () => unknown[];
  readonly throwAfter?: boolean;
  readonly setup?: (h: Harness) => void;
  readonly responder: (h: Harness) => (i: number, init: RequestInit) => Promise<Response> | Response;
  readonly turns?: number;
}

const CASES: readonly Case[] = [
  { name: "C01a single part confirmed", path: "return", events: () => answerEvents("Hello S04M"), responder: () => () => ok("101") },
  { name: "C01b three parts confirmed", path: "return", events: () => answerEvents(THREE), responder: () => (i) => ok(String(200 + i)) },
  ...([["first", 0], ["middle", 1], ["last", 2]] as const).map(([label, at]): Case => ({
    name: `C02-${label} transport error`, path: "catch", events: () => answerEvents(THREE),
    responder: () => (i) => { if (i === at) throw new TypeError("fetch failed"); return ok(String(300 + i)); },
  })),
  { name: "C02-http500 middle part", path: "catch", events: () => answerEvents(THREE), responder: () => (i) => i === 1 ? new Response("boom", { status: 500 }) : ok(String(310 + i)) },
  { name: "C03 empty-object id", path: "catch", events: () => answerEvents("ID probe"), responder: () => (i) => i === 0 ? new Response("{}") : ok("999") },
  { name: "C03 leading-zero id", path: "catch", events: () => answerEvents("ID probe"), responder: () => (i) => i === 0 ? new Response("{\"message_id\":\"0123\"}") : ok("999") },
  { name: "C03 canonical id", path: "return", events: () => answerEvents("ID probe"), responder: () => () => new Response("{\"message_id\":\"12345\"}") },
  { name: "C04 server client_msg_no differs", path: "return", events: () => answerEvents("Key echo"), responder: () => () => new Response("{\"message_id\":4242,\"client_msg_no\":\"other\"}") },
  { name: "C05a delivery_parts insert fails", path: "catch", events: () => answerEvents(THREE),
    setup: (h) => h.adapter.exec("CREATE TRIGGER wp06_fail BEFORE INSERT ON delivery_parts BEGIN SELECT RAISE(ABORT,'wp06'); END;"), responder: () => (i) => ok(String(500 + i)) },
  { name: "C05b turn_outputs insert fails", path: "catch", events: () => answerEvents("Output probe"),
    setup: (h) => h.adapter.exec("CREATE TRIGGER wp06_fail BEFORE INSERT ON turn_outputs BEGIN SELECT RAISE(ABORT,'wp06'); END;"), responder: () => (i) => ok(String(510 + i)) },
  { name: "C05c history append fails after all parts confirmed", path: "catch", events: () => answerEvents(THREE),
    setup: (h) => h.adapter.exec("CREATE TRIGGER wp06_fail BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'wp06'); END;"), responder: () => (i) => ok(String(520 + i)) },
  { name: "C06 abort during the middle part", path: "abort", events: () => answerEvents(THREE), responder: (h) => (i, init) => {
    if (i !== 1) return ok(String(600 + i));
    void h.router.stopTurns(0);
    return new Promise<Response>((_, reject) => {
      const sig = init.signal!;
      const fail = () => reject(new DOMException("aborted", "AbortError"));
      if (sig.aborted) fail(); else sig.addEventListener("abort", fail, { once: true });
    });
  } },
  { name: "C07a empty selection, notice 2xx without id", path: "return", events: () => answerEvents("", true).filter((e) => (e as { kind: string }).kind !== "message"), responder: () => () => new Response("{}") },
  { name: "C07c empty selection, notice rejects", path: "catch", events: () => answerEvents("", true).filter((e) => (e as { kind: string }).kind !== "message"),
    responder: () => (i) => { if (i === 0) throw new TypeError("fetch failed"); return new Response("{}"); } },
  { name: "C08a Unicode split", path: "return", events: () => answerEvents("中".repeat(3499) + "😀" + "é".repeat(100) + "\u{1F468}‍\u{1F469}‍\u{1F467}" + "終"), responder: () => (i) => ok(String(800 + i)) },
  { name: "C09-handler agent throws after text", path: "catch", events: () => answerEvents("partial-before-throw").slice(0, -1), throwAfter: true, responder: () => (i) => ok(String(900 + i)) },
];

async function runCase(c: Case, cards: boolean): Promise<Run> {
  const h = new Harness();
  await h.open(cards);
  try {
    c.setup?.(h);
    agentScript.events = c.events();
    agentScript.throwAfter = c.throwAfter === true;
    h.stub(c.responder(h));
    await h.turn();
    if (c.path === "abort") { await new Promise((r) => setTimeout(r, 20)); await h.time.advance(0); await h.runtime?.idle(); }
    return { obs: h.observe(), notices: h.notices.slice(), cards: h.cards(), rows: h.rows() };
  } finally {
    await h.close();
  }
}

describe("card-off / card-on parity over the S04-M cases (AC-009.1/.2, AC-020.1, AC-021.1)", () => {
  let errors: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    agentScript.calls = [];
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { if (a[0] === "[codex-channel-octo] turn failed") errors.push(String(a[1])); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  for (const c of CASES) {
    it(`${c.name}: ordinary bytes equal card-off, and the card terminal follows D-A`, async () => {
      const off = await runCase(c, false);
      const offErrors = errors.splice(0);
      const on = await runCase(c, true);
      const onErrors = errors.splice(0);
      expect(on.obs).toEqual(off.obs);
      // The only ordinary difference: the card replaces the sanitized tool notices.
      expect(off.notices).toEqual(["🔧 Running command…"]);
      expect(on.notices).toEqual([]);
      expect(onErrors.map((e) => e.replace(UUID, "<id>"))).toEqual(offErrors.map((e) => e.replace(UUID, "<id>")));
      expect(off.cards.sends).toBe(0);
      // A card exists because the scripted turn had a displayable row before the debounce elapsed.
      expect(on.cards.sends).toBe(1);
      const committed = (on.obs.outputs as { state: string }[]).some((o) => o.state === "committed");
      const noticeResolved = c.path === "return" && on.obs.outputs.length === 0 && on.obs.sends.at(-1) === NOTICE;
      if (c.path === "return") {
        expect(committed || noticeResolved).toBe(true);
        expect(on.cards.terminal).toEqual({ state: "completed", label: "Completed" });
        expect(on.rows).toEqual([{ kind: "automatic", state: "done", reason: "completed", terminal: 1 }]);
      } else if (c.path === "catch") {
        expect(on.cards.terminal?.state).toBe("error");
        expect(on.cards.terminal?.label).toBe("Failed");
        expect(on.rows).toEqual([{ kind: "automatic", state: "error", reason: "failed", terminal: 1 }]);
      } else {
        expect(on.cards.terminal?.state).toBe("error");
        expect(on.cards.terminal?.label).toBe("Interrupted; needs review");
        expect(on.rows).toEqual([{ kind: "automatic", state: "error", reason: "interrupted", terminal: 1 }]);
      }
      expect(off.rows).toEqual([]);
      expect(agentScript.calls.map((x) => x.itemStates)).toEqual([false, true]);
    });
  }

  it("C10 exact turn: a failed turn and a later successful turn keep separate cards and identical ordinary bytes", async () => {
    const run = async (cards: boolean) => {
      const h = new Harness();
      await h.open(cards);
      try {
        agentScript.events = answerEvents(THREE);
        h.stub((i) => i === 1 ? new Response("{}") : ok(String(1000 + i)));
        const t1 = await h.turn(1);
        const session = (h.adapter.prepare("SELECT session_key FROM turn_outputs WHERE turn_id=?").get(t1) as { session_key: string }).session_key;
        expect(h.store.reconcileTurn(session, t1)).toBe(true);
        agentScript.events = answerEvents("Second turn answer");
        h.sends = [];
        h.stub((i) => ok(String(1100 + i)));
        await h.turn(2);
        const cardSends = h.transport.net.sends().map((s) => JSON.parse(s.body) as { client_msg_no: string });
        return { obs: h.observe(), cardSends };
      } finally { await h.close(); }
    };
    const off = await run(false);
    errors.splice(0);
    const on = await run(true);
    expect(on.obs).toEqual(off.obs);
    expect(off.cardSends).toHaveLength(0);
    expect(on.cardSends).toHaveLength(2);
    expect(on.cardSends[0]!.client_msg_no).not.toBe(on.cardSends[1]!.client_msg_no);
  });
});

// ─── notices and opt-outs ───────────────────────────────────────────────────

describe("tool-progress notices and card mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentScript.calls = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function run(cards: boolean, opts: { toolProgress: boolean; prof?: () => unknown }) {
    const h = new Harness();
    if (opts.prof) h.transport = cardTransport(h.time, opts.prof);
    await h.open(cards, { sdk: { toolProgress: opts.toolProgress } } as Partial<Config>);
    try {
      agentScript.events = answerEvents("final answer");
      h.stub((i) => ok(String(1200 + i)));
      await h.turn();
      return { sends: h.all.slice(), cardRequests: h.transport.net.requests.length, calls: agentScript.calls.splice(0) };
    } finally { await h.close(); }
  }

  it("card mode replaces the safe notices: only the answer is sent as an ordinary message", async () => {
    const on = await run(true, { toolProgress: true });
    expect(on.sends).toEqual(["final answer"]);
    expect(on.cardRequests).toBeGreaterThan(0);
    const off = await run(false, { toolProgress: true });
    expect(off.sends).toEqual(["🔧 Running command…", "final answer"]);
  });

  it("policy-disabled automatic cards fall back to notices identical to card-off", async () => {
    const disabled = () => profile({ config: { card_enabled: true, reasoning_enabled: false, reasoning_template_ref: null, display_enabled: true, interaction_enabled: false } });
    const on = await run(true, { toolProgress: true, prof: disabled });
    const off = await run(false, { toolProgress: true });
    expect(on.sends).toEqual(off.sends);
    expect(on.cardRequests).toBe(0);
  });

  it("toolProgress=false: no card, no notice and no item_state opt-in, even when provisioned", async () => {
    const on = await run(true, { toolProgress: false });
    const off = await run(false, { toolProgress: false });
    expect(on.sends).toEqual(["final answer"]);
    expect(on.sends).toEqual(off.sends);
    expect(on.cardRequests).toBe(0);
    expect(on.calls).toEqual([{ itemStates: false }]);
  });
});

// ─── privacy sentinels (AC-019.2) ───────────────────────────────────────────

describe("protected sentinels never reach card writes, ordinary sends or logs (AC-019.2)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("corpus-style raw items reduced at the bridge leak nothing", async () => {
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    }
    const raws = [
      { type: "command_execution", command: "SENTINEL_KEY=sk-live-SENTINEL1 curl https://u:SENTINEL_PW@SENTINEL.corp/x", status: "completed", exit_code: 7, aggregated_output: "SENTINEL_OUTPUT" },
      { type: "file_change", changes: [{ path: "/srv/SENTINEL_PATH/.env", kind: "update" }], status: "completed" },
      { type: "web_search", query: "SENTINEL_QUERY", url: "https://a.SENTINEL-sub.example.com/p?q=SENTINEL_Q" },
      { type: "mcp_tool_call", server: "SENTINEL_SERVER", tool: "SENTINEL_TOOL", arguments: { secret: "SENTINEL_ARG" }, status: "failed" },
    ];
    const h = new Harness();
    await h.open(true);
    try {
      agentScript.events = [
        { kind: "attempt_start", attempt: 0, reason: "initial", continues: null },
        ...raws.flatMap((raw, i) => [
          { kind: "item_state", attempt: 0, itemId: `i${i}`, seq: i, itemType: raw.type, phase: "completed", status: raw.status === "failed" ? "failed" : "completed", safe: reduceItem(raw) },
        ]),
        { kind: "__advance", ms: 900 },
        { kind: "message", attempt: 0, itemId: "answer", seq: 9, text: "public answer", phase: "unknown" },
        { kind: "attempt_end", attempt: 0, terminal: "completed" },
      ];
      h.stub((i) => ok(String(1300 + i)));
      await h.turn();
      const card = h.transport.net.requests.map((r) => r.body).join("\n");
      expect(h.transport.net.sends()).toHaveLength(1);
      for (const surface of [card, h.all.join("\n"), logged.join("\n")]) expect(surface).not.toMatch(/SENTINEL/);
    } finally { await h.close(); }
  });
});

// ─── two Bots at one origin (AC-002.1 / AC-007.6) ───────────────────────────

describe("per-Bot isolation with a shared origin cooldown (AC-002.1, AC-007.6)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("a 429 for Bot A delays Bot B at the same normalized origin but not Bot C at another origin", async () => {
    const time = manualTime();
    const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
    async function bot(name: string, apiUrl: string, token: string) {
      const dataDir = join(tempDir(`wp06-iso-${name}-`), "data");
      mkdirSync(dataDir);
      provision(dataDir, `install-${name}`);
      const adapter = createAdapter(join(dataDir, "cc-octo.db"));
      new SessionStore(adapter).init();
      const transport = cardTransport(time);
      const runtime = (await openCardRuntime({ adapter, dataDir, apiUrl, botToken: token, clock: time.clock, wall: time.wall, timers: time.timers,
        fetchImpl: transport.fetchImpl, pacer }))!;
      return { runtime, transport, adapter };
    }
    const a = await bot("a", "https://API.example.com:443/base", "token-a");
    const b = await bot("b", "https://api.example.com", "token-b");
    const c = await bot("c", "https://other.example.com", "token-c");
    const begin = (x: typeof a, id: string) => x.runtime.beginTurn({ dispatchId: id, sessionKey: id, channelId: "c", channelType: 1, requesterUid: "u", resetEpoch: 0, cron: false, obo: undefined, docTask: undefined })!.coordinator;
    const item = { kind: "item_state", attempt: 0, itemId: "x", seq: 0, itemType: "command_execution", phase: "started", safe: { category: "command" } } as const;

    const ta = begin(a, "a1");
    await time.advance(0);
    a.transport.net.reply({ status: 429, headers: { "retry-after": "5" } });
    ta.observe({ kind: "attempt_start", attempt: 0, reason: "initial", continues: null });
    ta.observe(item);
    await time.advance(800);
    expect(a.transport.net.sends()).toHaveLength(1);

    const tb = begin(b, "b1"); const tc = begin(c, "c1");
    await time.advance(0);
    tb.observe(item); tc.observe(item);
    await time.advance(800);
    expect(c.transport.net.sends()).toHaveLength(1);
    expect(b.transport.net.sends()).toHaveLength(0);
    await time.advance(4200);
    expect(b.transport.net.sends()).toHaveLength(1);

    // Identity, policy and payload isolation.
    expect(ta.context.botRef.originKey).toBe(tb.context.botRef.originKey);
    expect(ta.context.botRef.credentialRef).not.toBe(tb.context.botRef.credentialRef);
    expect(a.transport.profileAuth).toEqual(["Bearer token-a"]);
    expect(b.transport.profileAuth).toEqual(["Bearer token-b"]);
    expect(a.transport.net.requests.every((r) => r.authorization === "Bearer token-a")).toBe(true);
    expect(b.transport.net.requests.every((r) => r.authorization === "Bearer token-b")).toBe(true);
    for (const x of [a, b, c]) { await x.runtime.close("shutdown"); x.adapter.close(); }
  });
});

// ─── NB-1 shutdown reasons ──────────────────────────────────────────────────

describe("NB-1: ManagedBot.shutdown reason per call site", () => {
  function fakeBot(uid: string, reasons: (ShutdownReason | undefined)[], connect: () => Promise<void> = async () => {}): ManagedBot {
    return {
      robotUid: uid,
      router: { registerKnownBot: vi.fn(), unregisterKnownBot: vi.fn() } as unknown as ManagedBot["router"],
      connect,
      shutdown: async (reason?: ShutdownReason) => { reasons.push(reason); },
    };
  }

  it("addBot connect-failure rollback passes 'shutdown'", async () => {
    const reasons: (ShutdownReason | undefined)[] = [];
    const m = new BotManager(async (id) => fakeBot(id, reasons, async () => { throw new Error("connect failed"); }));
    await expect(m.addBot("a")).rejects.toThrow("connect failed");
    expect(reasons).toEqual(["shutdown"]);
  });

  it("removeBot passes 'bot_removed', including a replacement (remove then add)", async () => {
    const reasons: (ShutdownReason | undefined)[] = [];
    const m = new BotManager(async (id) => fakeBot(id, reasons));
    await m.addBot("a");
    await m.removeBot("a");
    expect(reasons).toEqual(["bot_removed"]);
    await m.addBot("a");
    await m.removeBot("a");
    await m.addBot("a");
    expect(reasons).toEqual(["bot_removed", "bot_removed"]);
  });

  it("addBotsBatch startup connect-failure rollback passes 'shutdown'", async () => {
    const reasons: (ShutdownReason | undefined)[] = [];
    const m = new BotManager(async (id) => fakeBot(id, reasons, id === "bad" ? async () => { throw new Error("no"); } : undefined));
    const { failed } = await m.addBotsBatch(["good", "bad"]);
    expect(failed.map((f) => f.configId)).toEqual(["bad"]);
    expect(reasons).toEqual(["shutdown"]);
  });

  it("shutdownAll passes 'shutdown' to every Bot (never an array index)", async () => {
    const reasons: (ShutdownReason | undefined)[] = [];
    const m = new BotManager(async (id) => fakeBot(id, reasons));
    await m.addBot("a"); await m.addBot("b");
    await m.shutdownAll();
    expect(reasons).toEqual(["shutdown", "shutdown"]);
  });
});

// ─── startBot hook sites ────────────────────────────────────────────────────

describe("startBot hook sites (index.ts)", () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    registrySpy.reasons = []; registrySpy.order = []; openSpy.calls = 0;
    root = tempDir("wp06-start-");
    mkdirSync(join(root, "data"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).pathname.endsWith("/v1/bot/card/profile") ? json(200, profile()) : new Response("{}")));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const config = (disable: boolean): Parameters<typeof startBot>[0] => ({
    botId: "test", apiUrl: API, botToken: "test-token", baseDir: root,
    cards: { disable, eventTransport: "off", reasoningSummary: "off" },
    cwd: join(root, "workspace"), dataDir: join(root, "data"), sdk: { toolProgress: true },
    rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288, dispatchTimeoutMs: 300000,
  } as Parameters<typeof startBot>[0]);

  it("cards.disable=true never opens the card subsystem", async () => {
    provision(join(root, "data"));
    const stack = await startBot(config(true), true);
    expect(openSpy.calls).toBe(0);
    await stack.shutdown();
    expect(registrySpy.reasons).toEqual([]);
  });

  it("an unprovisioned Bot opens the subsystem once and stays card-inert", async () => {
    const stack = await startBot(config(false), true);
    expect(openSpy.calls).toBe(1);
    expect(existsSync(join(root, "data", "cards"))).toBe(false);
    await stack.shutdown();
    expect(registrySpy.reasons).toEqual([]);
  });

  function order(): string[] {
    const seen: string[] = [];
    const stop = SessionRouter.prototype.stopTurns;
    vi.spyOn(SessionRouter.prototype, "stopTurns").mockImplementation(function (this: SessionRouter, ...a: Parameters<typeof stop>) { seen.push("stopTurns"); return stop.apply(this, a); });
    const gstop = OctoGateway.prototype.stop;
    vi.spyOn(OctoGateway.prototype, "stop").mockImplementation(function (this: OctoGateway, ...a: Parameters<typeof gstop>) { seen.push("gateway.stop"); return gstop.apply(this, a); });
    const close = SessionStore.prototype.close;
    vi.spyOn(SessionStore.prototype, "close").mockImplementation(function (this: SessionStore) { seen.push("store.close"); return close.call(this); });
    return seen;
  }

  it("shutdown() closes the registry with 'shutdown' after stopTurns and before gateway.stop / store.close", async () => {
    provision(join(root, "data"));
    const stack = await startBot(config(false), true);
    const seen = order();
    const push = registrySpy.order;
    registrySpy.order = seen;
    await stack.shutdown();
    registrySpy.order = push;
    expect(registrySpy.reasons).toEqual(["shutdown"]);
    expect(seen).toEqual(["stopTurns", "closeAll", "gateway.stop", "store.close"]);
  });

  it("shutdown('bot_removed') forwards the reason to the registry", async () => {
    provision(join(root, "data"));
    const stack = await startBot(config(false), true);
    await stack.shutdown("bot_removed");
    expect(registrySpy.reasons).toEqual(["bot_removed"]);
  });

  it("the single-Bot gateway signal callback (no argument) yields 'shutdown'", async () => {
    provision(join(root, "data"));
    let callback: (() => Promise<void>) | undefined;
    const set = OctoGateway.prototype.setShutdownCallback;
    vi.spyOn(OctoGateway.prototype, "setShutdownCallback").mockImplementation(function (this: OctoGateway, fn: () => Promise<void>) { callback = fn; return set.call(this, fn); });
    await startBot(config(false), false);
    expect(callback).toBeDefined();
    await callback!();
    expect(registrySpy.reasons).toEqual(["shutdown"]);
  });
});
