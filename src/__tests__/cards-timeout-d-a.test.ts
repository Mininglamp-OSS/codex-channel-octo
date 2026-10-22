/**
 * Dispatch timeout under D-A with cards on and off (WP-06 B3/N4 timeout contract).
 *
 * The ordinary path follows main exactly: publication is revoked, a late
 * selected answer is neither delivered nor written to history, an uncertain
 * execution quarantines the session, and the plain-text timeout reply and the
 * cleanup follow-up are byte-identical with cards on and off. The card closes
 * its own generation with Error/timed_out through the coordinator's own
 * finalization authority, even though the cancelled turn's
 * `assertPublishable()` throws, and it never revives that turn.
 *
 * AC-008.3 (late answer reaches delivery/history) conflicts with D-A main and
 * is recorded as blocked on OD-5; it is not asserted as written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentScript = vi.hoisted(() => ({
  events: [] as unknown[],
  advance: undefined as undefined | ((ms: number) => Promise<void>),
}));
vi.mock("../agent-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent-bridge.js")>(),
  queryAgentEvents: vi.fn(async function* (_m: string, _c: unknown, _s: unknown, _t: unknown, opts?: { itemStates?: boolean; signal?: AbortSignal }, onSafeItem?: (f: unknown) => void) {
    let afterAbort = false;
    for (const ev of agentScript.events) {
      const e = ev as { kind: string; ms?: number; phase?: string; safe?: unknown };
      if (e.kind === "__advance") { await agentScript.advance?.(e.ms ?? 0); continue; }
      if (e.kind === "__waitAbort") {
        // The model keeps running after the dispatch timeout; its late output is still produced.
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) resolve(); else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        afterAbort = true;
        continue;
      }
      if (e.kind === "item_state") {
        if (onSafeItem && !afterAbort && (e.phase === "started" || e.phase === "completed")) onSafeItem(e.safe);
        if (opts?.itemStates !== true) continue;
      }
      yield ev;
    }
  }),
}));

import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { createPacer } from "../cards/pacer.js";
import { cardSubsystemPaths } from "../cards/recovery.js";
import { openCardRuntime, type CardRuntime } from "../cards/runtime.js";
import type { Config } from "../config.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { GroupContext } from "../group-context.js";
import { handleMessage } from "../index.js";
import { ChannelType, MessageType, type BotMessage } from "../octo/types.js";
import { SessionRouter } from "../session-router.js";
import { SessionStore } from "../session-store.js";
import { StreamRelay } from "../stream-relay.js";
import { TurnContext } from "../turn-context.js";
import { profile } from "./fixtures/card-profile.js";
import { json, manualTime, scriptedFetch } from "./fixtures/card-write-harness.js";

const API = "https://test.invalid";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMEOUT_MS = 40;

const work = (id: string, phase: "started" | "completed") => ({
  kind: "item_state", attempt: 0, itemId: id, seq: 0, itemType: "command_execution", phase,
  status: phase === "started" ? "in_progress" : "completed", safe: { category: "command", program: "git" },
});

/** A displayable row, the first frame acknowledged, then the model outlives the timeout and answers late. */
const LATE_ANSWER = () => [
  { kind: "attempt_start", attempt: 0, reason: "initial", continues: null },
  { kind: "work", attempt: 0, itemId: "cmd", seq: 0, itemType: "command_execution" },
  work("cmd", "started"),
  { kind: "__advance", ms: 900 },
  { kind: "__waitAbort" },
  work("cmd", "completed"),
  { kind: "message", attempt: 0, itemId: "answer", seq: 1, text: "LATE_SELECTED_ANSWER", phase: "final_answer" },
  { kind: "attempt_end", attempt: 0, terminal: "completed" },
];
/** Times out before the model starts: execution is proven not started and no card exists. */
const NOT_STARTED = () => [{ kind: "__waitAbort" }];

interface Outcome {
  /** Ordinary sends other than tool-progress notices (which card mode replaces by design). */
  sends: string[];
  notices: string[];
  history: unknown[];
  outputs: unknown[];
  parts: unknown[];
  quarantined: boolean;
  nextRejection: string | undefined;
  nextSends: string[];
  cardRequests: { path: string; body: string }[];
  revoked: boolean;
  rows: unknown[];
}

const roots: string[] = [];
let turns: TurnContext[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  turns = [];
  const cancel = TurnContext.prototype.cancel;
  vi.spyOn(TurnContext.prototype, "cancel").mockImplementation(function (this: TurnContext) { turns.push(this); return cancel.call(this); });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function run(cards: boolean, events: () => unknown[]): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), "wp06-timeout-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  if (cards) {
    const p = cardSubsystemPaths(dataDir);
    mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
    writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
    chmodSync(p.installationRefPath, 0o600);
    provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  }
  const adapter: DbAdapter = createAdapter(join(dataDir, "cc-octo.db"));
  const store = new SessionStore(adapter);
  store.init();
  const config = { botToken: "FAKE_TEST_TOKEN", apiUrl: API, cwd: join(root, "ws"), dataDir, sdk: { toolProgress: true },
    rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 }, dispatchTimeoutMs: TIMEOUT_MS,
    cards: { disable: false, eventTransport: "off", reasoningSummary: "off" } } as Config;
  const router = new SessionRouter(config, "bot", "owner", store);
  const time = manualTime();
  const net = scriptedFetch(time);
  const cardFetch = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith("/v1/bot/card/profile") ? json(200, profile()) : net.fetchImpl(input, init)) as typeof fetch;
  let runtime: CardRuntime | undefined;
  if (cards) {
    runtime = await openCardRuntime({ adapter, dataDir, apiUrl: API, botToken: config.botToken, clock: time.clock, wall: time.wall,
      timers: time.timers, fetchImpl: cardFetch, pacer: createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 }) });
    expect(runtime).toBeDefined();
    router.setDispatchObserver(runtime!);
    await time.advance(0);
    await runtime!.idle();
  }
  agentScript.advance = (ms) => time.advance(ms);
  const sends: string[] = [];
  const notices: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/v1/bot/sendMessage")) return new Response("{}");
    const content = (JSON.parse(String(init?.body)) as { payload: { content: string } }).payload.content;
    (content.startsWith("🔧 ") ? notices : sends).push(content);
    return new Response(`{"message_id":${700 + sends.length},"message_seq":1}`);
  }));
  const msg = (n: number): BotMessage => ({ message_id: `in-${n}`, message_seq: n, from_uid: "human", from_name: "Human",
    channel_id: "human", channel_type: ChannelType.DM, timestamp: 0, payload: { type: MessageType.Text, content: `request ${n}` } });
  const handle = (n: number) => handleMessage(msg(n), config, store, router, new GroupContext(adapter, 6000), new StreamRelay(), "bot", () => "owner", runtime);
  try {
    agentScript.events = events();
    await handle(1);
    await new Promise((r) => setTimeout(r, 20));
    await time.advance(0);
    await runtime?.idle();
    await time.advance(0);
    const first = turns[0];
    const revoked = first !== undefined && (() => { try { first.assertPublishable(); return false; } catch { return true; } })();
    const outcome = {
      sends: sends.map((s) => s.replace(UUID, "<id>")),
      notices: notices.slice(),
      history: adapter.prepare("SELECT role, content FROM messages ORDER BY id").all(),
      outputs: adapter.prepare("SELECT * FROM turn_outputs").all(),
      parts: adapter.prepare("SELECT * FROM delivery_parts").all(),
      quarantined: store.isTurnQuarantined("human"),
      revoked,
      rows: cards ? adapter.prepare("SELECT state, terminal_reason AS reason, terminal_at IS NOT NULL AS terminal FROM card_messages").all() : [],
    };
    sends.length = 0;
    const second = await router.routeAndHandle(msg(2), async () => { throw new Error("must not run while quarantined"); });
    return { ...outcome, nextRejection: second?.rejectionReason, nextSends: sends.map((s) => s.replace(UUID, "<id>")),
      cardRequests: net.requests.map((r) => ({ path: r.path, body: r.body })) };
  } finally {
    await runtime?.close("shutdown");
    try { store.close(); } catch { /* closed */ }
  }
}

describe("dispatch timeout with an uncertain execution (late answer)", () => {
  it("no late delivery or history, in either card mode", async () => {
    for (const cards of [false, true]) {
      const o = await run(cards, LATE_ANSWER);
      expect(o.sends.join("\n")).not.toContain("LATE_SELECTED_ANSWER");
      expect(o.history.filter((h) => (h as { role: string }).role === "assistant")).toEqual([]);
      expect(o.outputs).toEqual([]);
      expect(o.parts).toEqual([]);
    }
  });

  it("the plain timeout reply and the cleanup follow-up are byte-identical with cards on and off", async () => {
    const off = await run(false, LATE_ANSWER);
    const on = await run(true, LATE_ANSWER);
    expect(off.sends).toHaveLength(2);
    expect(off.sends[0]).toMatch(/^⚠️ 任务超时，正在停止原执行。/);
    expect(on.sends).toEqual(off.sends);
    expect(off.notices).toEqual(["🔧 Running command…"]);
    expect(on.notices).toEqual([]);
  });

  it("quarantine is unchanged: the session is quarantined and the next request is rejected identically", async () => {
    const off = await run(false, LATE_ANSWER);
    const on = await run(true, LATE_ANSWER);
    expect(off.quarantined).toBe(true);
    expect(on.quarantined).toBe(true);
    expect(off.nextRejection).toBe("quarantined");
    expect(on.nextRejection).toBe("quarantined");
    expect(on.nextSends).toEqual(off.nextSends);
  });

  it("the card reaches Error/timed_out although the cancelled turn's assertPublishable throws, and the turn stays revoked", async () => {
    const on = await run(true, LATE_ANSWER);
    expect(on.revoked).toBe(true);
    const sends = on.cardRequests.filter((r) => r.path.endsWith("/v1/bot/sendMessage"));
    const edits = on.cardRequests.filter((r) => r.path.endsWith("/v1/bot/message/edit"));
    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    const terminal = JSON.parse(edits[0]!.body) as { state: string; transient?: boolean; data: { statusLabel: string } };
    expect(terminal.state).toBe("error");
    expect(terminal.data.statusLabel).toBe("Timed out");
    expect(terminal.transient).toBeUndefined();
    // Durable: the acknowledged timed_out terminal is persisted on the card row.
    expect(on.rows).toEqual([{ state: "error", reason: "timed_out", terminal: 1 }]);
  });

  it("the timed_out card text contains no late-reply promise", async () => {
    const on = await run(true, LATE_ANSWER);
    const text = on.cardRequests.map((r) => r.body).join("\n").toLowerCase();
    for (const promise of ["later reply", "may still arrive", "a later"]) expect(text).not.toContain(promise);
  });

  it("late events after the timeout add no card content (absorbing terminal)", async () => {
    const on = await run(true, LATE_ANSWER);
    // One initial frame and the one terminal edit; the late completion and answer phase add nothing.
    expect(on.cardRequests).toHaveLength(2);
    expect(on.cardRequests.map((r) => r.body).join("\n")).not.toContain("LATE_SELECTED_ANSWER");
  });

  // AC-008.3 asserts that a late selected answer reaches normal delivery/history. Main (D-A) revokes
  // publication on timeout, so this cannot hold as written; it is blocked on OD-5 and not claimed.
  it.todo("AC-008.3 — blocked on OD-5: late selected answer after timeout reaches delivery/history");
});

describe("dispatch timeout before the model starts", () => {
  it("proven-not-started: identical reply, no quarantine and no card in either mode", async () => {
    const off = await run(false, NOT_STARTED);
    const on = await run(true, NOT_STARTED);
    expect(off.sends).toHaveLength(1);
    expect(off.sends[0]).toMatch(/^⚠️ 任务超时，模型执行未启动；/);
    expect(on.sends).toEqual(off.sends);
    expect(off.quarantined).toBe(false);
    expect(on.quarantined).toBe(false);
    expect(on.cardRequests.filter((r) => !r.path.endsWith("/v1/bot/card/profile"))).toEqual([]);
  });
});
