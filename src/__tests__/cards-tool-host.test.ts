/**
 * Trusted explicit-card tool host (WP-08, AM-08 v4 §4/§5/§7).
 *
 * Evidence label: [UNIT]/[INT-SYNTH-OP]. Real SQLite store, real loopback
 * listeners and a synthetic test op with a fake transport double; no
 * production op, no Octo send, no model. Covers the authority-free entry,
 * the four redemption cases, endpoint-bound authentication, the D0–D6
 * dispatch order with its ledger outcomes, fences, rotation and drain, and
 * the G-d hardening of WP09-PF v3 §4.4 as amended by v3.1 (auth, code-mode
 * and MDM terms, the admit slot and the redeem-time fence).
 *
 * Host-only roots (`/etc/codex`, `/Library/Managed Preferences`) are never
 * touched: `node:fs` is wrapped in this file only, to redirect those two
 * paths to temp directories and to inject one `lstat` race. `node:path` and
 * `node:util` are wrapped only to make the session check or the comparator
 * throw for the throw-mapping fixture. Every wrapper passes through unless a
 * test arms it, and none of this exists in the emitted package.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const armed = vi.hoisted(() => ({
  /** Logical host path → temp path. */
  redirect: new Map<string, string>(),
  /** Logical path whose `lstat` fails with ENOENT (an entry gone after `readdir`). */
  vanished: new Set<string>(),
  /** Absolute path for which `isAbsolute` throws. */
  isAbsoluteThrows: undefined as string | undefined,
  deepEqualThrows: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const to = (p: unknown): unknown => {
    if (typeof p !== "string") return p;
    for (const [from, target] of armed.redirect) if (p === from || p.startsWith(`${from}/`)) return target + p.slice(from.length);
    return p;
  };
  const lstatSync = ((p: string, o?: never) => {
    if (armed.vanished.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return actual.lstatSync(to(p) as string, o);
  }) as typeof actual.lstatSync;
  const readdirSync = ((p: string, o?: never) => actual.readdirSync(to(p) as string, o)) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, lstatSync, readdirSync }, lstatSync, readdirSync };
});
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  const isAbsolute = (p: string): boolean => {
    if (armed.isAbsoluteThrows !== undefined && p === armed.isAbsoluteThrows) throw new Error("isAbsolute");
    return actual.isAbsolute(p);
  };
  return { ...actual, default: { ...actual, isAbsolute }, isAbsolute };
});
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  const isDeepStrictEqual = (a: unknown, b: unknown): boolean => {
    if (armed.deepEqualThrows) throw new Error("isDeepStrictEqual");
    return actual.isDeepStrictEqual(a, b);
  };
  return { ...actual, default: { ...actual, isDeepStrictEqual }, isDeepStrictEqual };
});

import { buildThreadOptions, resolveSandbox } from "../agent-bridge.js";
import type { Config } from "../config.js";
import type { CardToolResult, ToolOpcode, TrustedTurnContext } from "../cards/contracts.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { encodeBootstrapFrame, parseBootstrapReply, parseReplyFrame, readFrame } from "../cards/protocol.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import type { CardBinding, CardStore, ExplicitCard } from "../cards/store.js";
import {
  BOOTSTRAP_TTL_MS,
  CODEX_AUTH_ENV_MARKERS,
  EXPLICIT_OP_UNAVAILABLE,
  PRODUCTION_EXPLICIT_OPS,
  REQUIRED_DISABLED_CODEX_FEATURES,
  admitsCodexConfigToml,
  createToolHost,
  gatewayAdmitsInjection,
  hasCodexAuthEnvMarker,
  registerGatewayExposure,
  type AttemptHandle,
  type ExplicitOpHandler,
  type ExplicitTransport,
  type ExplicitTransportOutcome,
  type GatewayExposureEntry,
  type ToolHost,
} from "../cards/tool-host.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, type ManualTime } from "./fixtures/card-write-harness.js";
import { ADMITTED_CONFIG_TOML, admissibleGateway } from "./fixtures/gd-admit.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  armed.redirect.clear();
  armed.vanished.clear();
  armed.isAbsoluteThrows = undefined;
  armed.deepEqualThrows = false;
  for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// ─── rig ────────────────────────────────────────────────────────────────────

interface Rig {
  readonly store: CardStore;
  readonly adapter: DbAdapter;
  readonly host: ToolHost;
  readonly time: ManualTime;
  readonly cardsDir: string;
  readonly incarnation: string;
  readonly installationRef: string;
  /** The real G-d admit over this rig's admissible exposure and session cwd. */
  readonly admit: () => boolean;
  readonly cwd: string;
  readonly codexHome: string;
}

async function rig(opts: { ops?: ReadonlyMap<ToolOpcode, ExplicitOpHandler>; transport?: ExplicitTransport; excludedRoots?: readonly string[];
  ref?: string } = {}): Promise<Rig> {
  const dataDir = join(tempDir("wp08-host-"), "data");
  mkdirSync(dataDir);
  const ref = opts.ref ?? "install-a";
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, `${ref}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, ref, Date.UTC(2026, 9, 22));
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== "ready") throw new Error(`subsystem ${sub.state}`);
  const host = createToolHost({
    store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir,
    ops: opts.ops ?? new Map([["display", sendingOp("display")]]),
    excludedRoots: opts.excludedRoots ?? [], clock: time.clock, wall: time.wall, timers: time.timers,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname },
    ...(opts.transport !== undefined ? { transport: opts.transport } : { transport: ackingTransport() }),
  });
  if (host === undefined) throw new Error("no host");
  cleanups.push(() => { host.close({ reason: "shutdown", deadlineMono: time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  return { store: sub.store, adapter, host, time, cardsDir: p.cardsDir, incarnation, installationRef: sub.meta.installationRef,
    admit: gateway.admit, cwd: gateway.cwd, codexHome: gateway.codexHome };
}

let messageSeq = 7_000_000_000;
function ackingTransport(outcome: () => ExplicitTransportOutcome = () => ({ kind: "acked", messageId: String(messageSeq++) })): ExplicitTransport & { sends: number } {
  const t = { sends: 0, async send() { t.sends++; return outcome(); } };
  return t;
}

/** Synthetic test op: reserves exactly one send for its own trusted binding. */
function sendingOp(op: ToolOpcode, before?: () => Promise<void>): ExplicitOpHandler {
  return {
    op,
    async handle(_args, c, send) {
      await before?.();
      const card: ExplicitCard = op === "display"
        ? { opcode: "display", binding: bindingOf(c.ctx), bodyDigest: "d".repeat(64) }
        : { opcode: "interactive", binding: bindingOf(c.ctx), bodyDigest: "d".repeat(64),
          contract: { requesterUid: c.ctx.requesterUid, contractVersion: 1, authoredContractJson: "{}", authoredDataHash: "h".repeat(64) } };
      return send.reserveAndSend(card);
    },
  };
}

function bindingOf(ctx: TrustedTurnContext): CardBinding {
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: ctx.route.channelId, channelType: 1, topicScope: null,
    generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}

function context(r: Rig, over: Partial<TrustedTurnContext> = {}): TrustedTurnContext {
  return Object.freeze({
    botRef: Object.freeze({ originKey: "https://test.invalid", credentialRef: "c".repeat(43) }),
    route: Object.freeze({ channelId: "chan", channelType: 1 }),
    requesterUid: "u1", sessionKey: `s-${randomUUID()}`, turnGeneration: randomUUID(), resetEpoch: 0,
    policyIdentity: "c".repeat(43), runtimeIncarnation: r.incarnation,
    injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}`,
    routeEligibility: Object.freeze({ kind: "dm" as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: "user" as const }),
    ...over,
  });
}

function open(r: Rig, over: { ctx?: TrustedTurnContext; ops?: readonly ToolOpcode[]; epoch?: () => number; ttl?: number; admit?: () => boolean } = {}) {
  const ctx = over.ctx ?? context(r);
  const gen = r.host.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: r.time.now() + (over.ttl ?? 600_000),
    currentResetEpoch: over.epoch ?? (() => 0), ops: over.ops ?? ["display"], admit: over.admit ?? r.admit });
  if (gen === undefined) throw new Error("no generation");
  return { gen, ctx };
}

function entryOf(h: AttemptHandle): { ticketPath: string; port: number; args: string[] } {
  const args = h.mcpEntry.args as string[];
  return { ticketPath: args[2] as string, port: Number(args[4]), args };
}

// ─── loopback client (stands in for the packaged proxy) ─────────────────────

class Client {
  readonly socket: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private waiters: ((b: Uint8Array | null) => void)[] = [];
  closed = false;
  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (;;) {
        const f = readFrame(this.buf);
        if (f.kind !== "frame") break;
        this.buf = this.buf.subarray(f.consumed);
        this.waiters.shift()?.(f.body);
      }
    });
    socket.on("close", () => { this.closed = true; for (const w of this.waiters.splice(0)) w(null); });
    socket.on("error", () => { /* close follows */ });
  }
  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port });
      s.once("connect", () => resolve(new Client(s)));
      s.once("error", reject);
    });
  }
  private next(): Promise<Uint8Array | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async redeem(ticket: string): Promise<{ authority: string; ops: readonly ToolOpcode[] } | null> {
    const wait = this.next();
    this.socket.write(Buffer.from(encodeBootstrapFrame({ v: 1, bootstrap: ticket })));
    const body = await wait;
    return body === null ? null : parseBootstrapReply(body);
  }
  sendRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
    const wait = this.next();
    this.socket.write(Buffer.from(bytes));
    return wait;
  }
  async call(authority: string, op: string, args: unknown, requestId = randomBytes(16).toString("hex")): Promise<CardToolResult | null> {
    const body = Buffer.from(JSON.stringify({ v: 1, request_id: requestId, authority, op, args }), "utf8");
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    const reply = await this.sendRaw(frame);
    if (reply === null) return null;
    const parsed = parseReplyFrame(reply);
    if (!parsed.ok) throw new Error(`bad reply ${parsed.code}`);
    expect(parsed.frame.request_id).toBe(requestId);
    return parsed.frame.result;
  }
  close(): void { this.socket.destroy(); }
}

function ticketOf(path: string): string { return readFileSync(path, "utf8"); }

async function live(r: Rig, over: Parameters<typeof open>[1] = {}) {
  const { gen, ctx } = open(r, over);
  const h = (await gen.launch.prepareAttempt())!;
  expect(h).toBeDefined();
  const e = entryOf(h);
  const client = await Client.connect(e.port);
  cleanups.push(() => client.close());
  const redeemed = (await client.redeem(ticketOf(e.ticketPath)))!;
  expect(redeemed).not.toBeNull();
  return { gen, ctx, h, e, client, authority: redeemed.authority };
}

const DISPLAY = { blocks: [{ kind: "text", text: "hello" }] };

function snapshot(adapter: DbAdapter) {
  const q = (sql: string) => adapter.prepare(sql).all();
  return {
    generations: q("SELECT generation, state, invocation_count, logical_send_count FROM card_handler_generations ORDER BY generation"),
    requests: q("SELECT generation, request_id, state, send_slot, safe_result_json FROM card_explicit_requests ORDER BY generation, request_id"),
    messages: q("SELECT card_id, state, message_id FROM card_messages ORDER BY card_id"),
    sessions: q("SELECT session_id, status FROM card_sessions ORDER BY session_id"),
  };
}

function genRow(adapter: DbAdapter, generation: string) {
  return adapter.prepare("SELECT state, invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?")
    .get(generation) as { state: string; inv: number; sends: number } | undefined;
}

function requestRows(adapter: DbAdapter, generation: string) {
  return adapter.prepare("SELECT request_id, state, send_slot, safe_result_json FROM card_explicit_requests WHERE generation = ? ORDER BY created_at, request_id")
    .all(generation) as { request_id: string; state: string; send_slot: number | null; safe_result_json: string | null }[];
}

const settleIo = () => new Promise((r) => setTimeout(r, 20));
/** Wait for the host to reach an asserted state instead of a fixed sleep. */
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 2_000, interval: 5 });

// ─── contract constants ─────────────────────────────────────────────────────

describe("contract constants (AM-08 v4 §7.1)", () => {
  it("the production op table is frozen with both closed handlers and the unavailable result is exact", () => {
    expect([...PRODUCTION_EXPLICIT_OPS.keys()]).toEqual(["display", "interactive"]);
    expect(Object.isFrozen(PRODUCTION_EXPLICIT_OPS)).toBe(true);
    expect(EXPLICIT_OP_UNAVAILABLE).toEqual({ status: "error", error: { code: "unavailable", diagnostics: [{ path: "$.op", rule: "explicit_op_unavailable" }] } });
  });

  it("refuses to build over a store whose explicit ledger was not recovered (G-g)", () => {
    const time = manualTime();
    expect(createToolHost({ store: {} as CardStore, installationRef: "x", cardsDir: tempDir("wp08-norec-"), ops: new Map(),
      excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers })).toBeUndefined();
  });
});

// ─── entry and ticket ───────────────────────────────────────────────────────

describe("authority-free MCP entry and bootstrap ticket (§4.2/§4.3)", () => {
  it("merges only per-server keys: absolute paths, ticket path and port; no env, env_vars or authority", async () => {
    const r = await rig();
    const { h, e, authority, gen } = await live(r);
    expect(Object.keys(h.mcpEntry).sort()).toEqual(["args", "command", "enabled_tools", "required", "startup_readiness", "startup_timeout_sec", "tools"]);
    expect(h.mcpEntry).toMatchObject({ command: process.execPath, required: true, startup_timeout_sec: 10, startup_readiness: "connection",
      enabled_tools: ["display"], tools: { display: { approval_mode: "approve" } } });
    expect(e.args[1]).toBe("--bootstrap");
    expect(e.args[3]).toBe("--port");
    for (const a of [h.mcpEntry.command as string, e.args[0] as string, e.ticketPath]) expect(a.startsWith("/")).toBe(true);
    const serialized = JSON.stringify(h.mcpEntry);
    expect(serialized).not.toContain(authority);
    expect(serialized).not.toContain("env");
    expect(gen.launch).not.toHaveProperty("authority");
    expect(JSON.stringify(gen.launch)).not.toContain(authority);
  });

  it("writes an owner-only single-link ticket under <cards>/bootstrap and unlinks it at redemption", async () => {
    const r = await rig();
    const { gen } = open(r);
    const h = (await gen.launch.prepareAttempt())!;
    const { ticketPath, port } = entryOf(h);
    expect(ticketPath.startsWith(join(r.cardsDir, "bootstrap") + "/")).toBe(true);
    const st = statSync(ticketPath);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.nlink).toBe(1);
    expect(statSync(join(ticketPath, "..")).mode & 0o777).toBe(0o700);
    expect(readFileSync(ticketPath, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    const c = await Client.connect(port);
    cleanups.push(() => c.close());
    await c.redeem(ticketOf(ticketPath));
    expect(existsSync(ticketPath)).toBe(false);
    h.close();
    expect(existsSync(join(ticketPath, ".."))).toBe(false);
  });

  it("startup removes a stale bootstrap directory before the first listener exists", async () => {
    const dataDir = join(tempDir("wp08-stale-"), "data");
    const p = cardSubsystemPaths(dataDir);
    mkdirSync(join(p.cardsDir, "bootstrap", "r-old"), { recursive: true, mode: 0o700 });
    writeFileSync(join(p.cardsDir, "bootstrap", "r-old", "t"), "a".repeat(64), { mode: 0o600 });
    writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600 });
    provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const time = manualTime();
    const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: randomUUID() });
    if (sub.state !== "ready") throw new Error("not ready");
    const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir, ops: new Map(),
      excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers })!;
    expect(existsSync(join(p.cardsDir, "bootstrap", "r-old"))).toBe(false);
    host.close({ reason: "shutdown", deadlineMono: 0, signal: AbortSignal.abort() });
    sub.store.retire();
    adapter.close();
  });

  it("a bootstrap root inside an excluded root (TMPDIR, cwd, CODEX_HOME) offers no attempt", async () => {
    const r = await rig({ excludedRoots: [tmpdir(), "/tmp"] });
    const { gen } = open(r);
    expect(await gen.launch.prepareAttempt()).toBeUndefined();
    expect(r.host.stats().liveListeners).toBe(0);
  });

  it("a failing per-attempt gate offers no attempt and opens no listener", async () => {
    const r = await rig();
    const { gen } = open(r, { admit: () => false });
    expect(await gen.launch.prepareAttempt()).toBeUndefined();
    expect(r.host.stats().liveListeners).toBe(0);
  });
});

// ─── redemption lifecycle ───────────────────────────────────────────────────

describe("redemption lifecycle: four disjoint cases (§5)", () => {
  it("case 1: the first valid redemption returns the authority and offered ops once", async () => {
    const r = await rig();
    const { authority } = await live(r);
    expect(authority).toMatch(/^[0-9a-f]{64}$/);
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapReplay: 0, liveRegistrations: 1, liveListeners: 1 });
  });

  it("case 2: replaying the consumed ticket revokes; charged → cancelled, reserved → ambiguous", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = ackingTransport();
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const transport: ExplicitTransport = { async send(i) { await sendGate; return slow.send(i as never); } };
    const r = await rig({ transport, ops: new Map<ToolOpcode, ExplicitOpHandler>([
      ["display", sendingOp("display")],
      ["interactive", { op: "interactive", async handle() { await gate; return EXPLICIT_OP_UNAVAILABLE; } }],
    ]) });
    const { gen } = open(r, { ops: ["display", "interactive"] });
    const h = (await gen.launch.prepareAttempt())!;
    const { ticketPath, port } = entryOf(h);
    const ticket = ticketOf(ticketPath);
    const client = await Client.connect(port);
    cleanups.push(() => client.close());
    const { authority } = (await client.redeem(ticket))!;
    const reservedCall = client.call(authority, "display", DISPLAY);
    const chargedCall = client.call(authority, "interactive", { title: "t", buttons: [{ id: "b", label: "B" }] });
    await until(() => expect(requestRows(r.adapter, gen.launch.generation).map((x) => x.state).sort()).toEqual(["charged", "reserved"]));
    const replay = await Client.connect(port);
    expect(await replay.redeem(ticket)).toBeNull();
    await until(() => expect(r.host.stats()).toMatchObject({ bootstrapReplay: 1, liveListeners: 0, liveRegistrations: 0 }));
    const rows = requestRows(r.adapter, gen.launch.generation);
    expect(rows.map((x) => x.state).sort()).toEqual(["ambiguous", "cancelled"]);
    expect(rows.find((x) => x.state === "ambiguous")?.send_slot).toBe(1);
    expect(genRow(r.adapter, gen.launch.generation)).toMatchObject({ inv: 2, sends: 1 });
    release(); releaseSend();
    expect(await reservedCall).toBeNull();
    expect(await chargedCall).toBeNull();
    // The old authority cannot reach anything: the listener is gone.
    await expect(Client.connect(port)).rejects.toThrow();
  });

  it("case 3: a ticket never redeemed closes the registration at the 5 s TTL", async () => {
    const r = await rig();
    const { gen } = open(r);
    const h = (await gen.launch.prepareAttempt())!;
    const { ticketPath, port } = entryOf(h);
    await r.time.advance(BOOTSTRAP_TTL_MS);
    expect(r.host.stats()).toMatchObject({ bootstrapExpired: 1, liveListeners: 0 });
    expect(existsSync(ticketPath)).toBe(false);
    await expect(Client.connect(port)).rejects.toThrow();
    expect(gen.live).toBe(true);
    expect(snapshot(r.adapter).requests).toEqual([]);
  });

  it("case 4: an unknown ticket is unauthenticated zero state; the real ticket still redeems", async () => {
    const r = await rig();
    const { gen } = open(r);
    const h = (await gen.launch.prepareAttempt())!;
    const { ticketPath, port } = entryOf(h);
    const before = snapshot(r.adapter);
    const stranger = await Client.connect(port);
    expect(await stranger.redeem(randomBytes(32).toString("hex"))).toBeNull();
    expect(r.host.stats()).toMatchObject({ bootstrapUnknown: 1, bootstrapRedeemed: 0, liveListeners: 1 });
    expect(snapshot(r.adapter)).toEqual(before);
    const ok = await Client.connect(port);
    cleanups.push(() => ok.close());
    expect(await ok.redeem(ticketOf(ticketPath))).not.toBeNull();
  });
});

// ─── authentication (AC-011.5) ──────────────────────────────────────────────

describe("endpoint-bound authentication before accounting (AC-011.5)", () => {
  it("forged, unknown and other-generation authority on this endpoint mutate nothing; a correlated positive control follows", async () => {
    const r = await rig();
    const victim = await live(r);
    const other = await live(r);
    const before = snapshot(r.adapter);
    for (const authority of [randomBytes(32).toString("hex"), other.authority, victim.authority.slice(0, 62) + "00"]) {
      const c = await Client.connect(victim.e.port);
      expect(await c.call(authority, "display", DISPLAY)).toBeNull();
      expect(snapshot(r.adapter)).toEqual(before);
    }
    expect(r.host.stats().authRejected).toBe(3);
    const ok = await victim.client.call(victim.authority, "display", DISPLAY);
    expect(ok?.status).toBe("sent");
    expect(genRow(r.adapter, victim.gen.launch.generation)).toMatchObject({ inv: 1, sends: 1 });
  });

  it("a second Bot's live authority on the first Bot's endpoint mutates neither Bot", async () => {
    const a = await rig({ ref: "install-a" });
    const b = await rig({ ref: "install-b" });
    const va = await live(a);
    const vb = await live(b);
    const beforeA = snapshot(a.adapter);
    const beforeB = snapshot(b.adapter);
    const c = await Client.connect(va.e.port);
    expect(await c.call(vb.authority, "display", DISPLAY)).toBeNull();
    expect(snapshot(a.adapter)).toEqual(beforeA);
    expect(snapshot(b.adapter)).toEqual(beforeB);
    expect((await va.client.call(va.authority, "display", DISPLAY))?.status).toBe("sent");
    expect((await vb.client.call(vb.authority, "display", DISPLAY))?.status).toBe("sent");
  });

  it("frame-stage rejects (oversize prefix, bad version, prototype key, malformed JSON) close the connection with zero state", async () => {
    const r = await rig();
    const v = await live(r);
    const before = snapshot(r.adapter);
    const body = (s: string) => { const b = Buffer.from(s); const f = Buffer.alloc(4 + b.length); f.writeUInt32BE(b.length, 0); b.copy(f, 4); return f; };
    const big = Buffer.alloc(4); big.writeUInt32BE(40_000, 0);
    const id = randomBytes(16).toString("hex");
    for (const frame of [big, body("{"), body(JSON.stringify({ v: 2, request_id: id, authority: v.authority, op: "display", args: DISPLAY })),
      body(`{"v":1,"request_id":"${id}","authority":"${v.authority}","op":"display","args":{"__proto__":{}}}`),
      body(JSON.stringify({ v: 1, request_id: id, authority: v.authority, op: "delete", args: {} }))]) {
      const c = await Client.connect(v.e.port);
      expect(await c.sendRaw(frame)).toBeNull();
    }
    expect(snapshot(r.adapter)).toEqual(before);
    expect((await v.client.call(v.authority, "display", DISPLAY))?.status).toBe("sent");
  });
});

// ─── dispatch D2–D6 ─────────────────────────────────────────────────────────

describe("dispatch order and ledger outcomes (§7.3/§7.4)", () => {
  it("D3: an op with no handler is charged, finished failed with EXPLICIT_OP_UNAVAILABLE, no reservation", async () => {
    const r = await rig({ ops: new Map() });
    const v = await live(r, { ops: ["display"] });
    expect(await v.client.call(v.authority, "display", DISPLAY)).toEqual(EXPLICIT_OP_UNAVAILABLE);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 0 });
    const [row] = requestRows(r.adapter, v.gen.launch.generation);
    expect(row).toMatchObject({ state: "failed", send_slot: null });
    expect(JSON.parse(row!.safe_result_json!)).toEqual(EXPLICIT_OP_UNAVAILABLE);
    expect(snapshot(r.adapter).messages).toEqual([]);
  });

  it("D3: an op the table has but this generation was not offered is unavailable too", async () => {
    const r = await rig({ ops: new Map([["display", sendingOp("display")], ["interactive", sendingOp("interactive")]]) });
    const v = await live(r, { ops: ["display"] });
    expect(await v.client.call(v.authority, "interactive", { title: "t", buttons: [{ id: "b", label: "B" }] })).toEqual(EXPLICIT_OP_UNAVAILABLE);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 0 });
  });

  it("D4: forbidden routing/HTML/credential fields reject after one charge, with no reservation (AC-011.1/.6)", async () => {
    const transport = ackingTransport();
    const r = await rig({ transport });
    const v = await live(r);
    const cases: [unknown, string][] = [
      [{ blocks: [{ kind: "text", text: "x" }], channel_id: "victim" }, "invalid_route"],
      [{ blocks: [{ kind: "text", text: "x", authority: "a" }] }, "invalid_route"],
      [{ blocks: [{ kind: "text", text: "<script>x</script>" }] }, "validation_failed"],
      [{ blocks: [{ kind: "text", text: "x" }], unknown_key: 1 }, "validation_failed"],
    ];
    for (const [args, code] of cases) {
      const res = await v.client.call(v.authority, "display", args);
      expect(res?.status).toBe("error");
      expect(res?.status === "error" && res.error.code).toBe(code);
      expect(JSON.stringify(res)).not.toContain("victim");
    }
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 4, sends: 0 });
    expect(requestRows(r.adapter, v.gen.launch.generation).every((x) => x.state === "failed" && x.send_slot === null)).toBe(true);
    expect(transport.sends).toBe(0);
  });

  it("D5: the synthetic op reserves one send through the host and records the acknowledged identity", async () => {
    const r = await rig();
    const v = await live(r);
    const res = await v.client.call(v.authority, "display", DISPLAY);
    expect(res).toMatchObject({ status: "sent", route: { kind: "dm" } });
    const [row] = requestRows(r.adapter, v.gen.launch.generation);
    expect(row).toMatchObject({ state: "acked", send_slot: 1 });
    expect(snapshot(r.adapter).messages).toHaveLength(1);
  });

  it("D5 pre-reserve handler exception → failed/unavailable, charged, no reservation (carry-forward)", async () => {
    const r = await rig({ ops: new Map([["display", { op: "display", async handle() { throw new Error("boom"); } }]]) });
    const v = await live(r);
    expect(await v.client.call(v.authority, "display", DISPLAY)).toEqual(EXPLICIT_OP_UNAVAILABLE);
    expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "failed", send_slot: null }]);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 0 });
  });

  it("D5 pre-reserve close → cancelled (distinct from the exception outcome)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const r = await rig({ ops: new Map([["display", sendingOp("display", () => gate)]]) });
    const v = await live(r);
    const pending = v.client.call(v.authority, "display", DISPLAY);
    await until(() => expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "charged" }]));
    v.gen.close();
    release();
    expect(await pending).toBeNull();
    await until(() => expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "cancelled", send_slot: null }]));
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ state: "closed", inv: 1, sends: 0 });
  });

  it("D5 post-reserve transport failure is host-classified ambiguous; the slot is retained", async () => {
    const r = await rig({ transport: { async send() { throw new Error("socket reset"); } } });
    const v = await live(r);
    const res = await v.client.call(v.authority, "display", DISPLAY);
    expect(res).toEqual({ status: "error", error: { code: "send_unconfirmed" } });
    expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "ambiguous", send_slot: 1 }]);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 1 });
  });

  it("a handler cannot fabricate a successful send without a reservation", async () => {
    const r = await rig({ ops: new Map([["display", { op: "display", async handle() {
      return { status: "sent", message_id: "123", route: { kind: "dm", ref: "x" } } as CardToolResult;
    } }]]) });
    const v = await live(r);
    expect(await v.client.call(v.authority, "display", DISPLAY)).toEqual(EXPLICIT_OP_UNAVAILABLE);
    expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "failed", send_slot: null }]);
  });

  it("a card bound to another session is refused before reservation", async () => {
    const r = await rig({ ops: new Map([["display", { op: "display", async handle(_a, c, send) {
      return send.reserveAndSend({ opcode: "display", binding: { ...bindingOf(c.ctx), sessionKey: "victim" }, bodyDigest: "d".repeat(64) });
    } }]]) });
    const v = await live(r);
    expect(await v.client.call(v.authority, "display", DISPLAY)).toEqual(EXPLICIT_OP_UNAVAILABLE);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 0 });
    expect(snapshot(r.adapter).messages).toEqual([]);
  });
});

// ─── dedup, barriers, rotation (AC-011.7/.8) ────────────────────────────────

describe("deduplication and barriers (AC-011.7/.8)", () => {
  it("identical concurrent request ids join one charge and one send; changed-body reuse rejects with no new accounting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport = ackingTransport();
    const r = await rig({ transport, ops: new Map([["display", sendingOp("display", () => gate)]]) });
    const v = await live(r);
    const id = randomBytes(16).toString("hex");
    const second = await Client.connect(v.e.port);
    cleanups.push(() => second.close());
    const a = v.client.call(v.authority, "display", DISPLAY, id);
    const b = second.call(v.authority, "display", { blocks: [{ text: "hello", kind: "text" }] }, id);
    await settleIo();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra?.status).toBe("sent");
    expect(transport.sends).toBe(1);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 1 });
    expect(await v.client.call(v.authority, "display", DISPLAY, id)).toEqual(ra);
    expect(await v.client.call(v.authority, "display", { blocks: [{ kind: "text", text: "changed" }] }, id))
      .toEqual({ status: "error", error: { code: "validation_failed", diagnostics: [{ path: "$.request_id", rule: "request_id_reused" }] } });
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ inv: 1, sends: 1 });
  });

  it("after close, new and completed ids reject before cache lookup with zero mutation", async () => {
    const r = await rig();
    const v = await live(r);
    const id = randomBytes(16).toString("hex");
    expect((await v.client.call(v.authority, "display", DISPLAY, id))?.status).toBe("sent");
    // Expiry barrier: the generation's monotonic deadline passes.
    const before = snapshot(r.adapter);
    v.gen.close();
    expect(r.host.stats().liveListeners).toBe(0);
    await expect(Client.connect(v.e.port)).rejects.toThrow();
    expect(snapshot(r.adapter).requests).toEqual(before.requests);
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ state: "closed", inv: 1, sends: 1 });
  });

  it("a /reset fences the generation: the next call is rejected and the handler closes", async () => {
    let epoch = 0;
    const r = await rig();
    const v = await live(r, { epoch: () => epoch });
    expect((await v.client.call(v.authority, "display", DISPLAY))?.status).toBe("sent");
    epoch = 5;
    expect(await v.client.call(v.authority, "display", DISPLAY))
      .toEqual({ status: "error", error: { code: "unavailable", diagnostics: [{ path: "$", rule: "explicit_authority_closed" }] } });
    expect(genRow(r.adapter, v.gen.launch.generation)).toMatchObject({ state: "closed", inv: 1, sends: 1 });
    expect(v.gen.live).toBe(false);
  });

  it("the monotonic dispatch deadline bounds the generation; expiry closes it", async () => {
    const r = await rig();
    const v = await live(r, { ttl: 30_000 });
    await r.time.advance(30_000);
    expect(v.gen.live).toBe(false);
    expect(genRow(r.adapter, v.gen.launch.generation)?.state).toBe("closed");
    expect(r.host.stats().liveListeners).toBe(0);
  });

  it("rotation closes the old registration and keeps the generation's counts", async () => {
    const r = await rig();
    const first = await live(r);
    expect((await first.client.call(first.authority, "display", DISPLAY))?.status).toBe("sent");
    const h2 = (await first.gen.launch.prepareAttempt())!;
    await expect(Client.connect(first.e.port)).rejects.toThrow();
    const e2 = entryOf(h2);
    expect(e2.port).not.toBe(first.e.port);
    const c2 = await Client.connect(e2.port);
    cleanups.push(() => c2.close());
    const { authority } = (await c2.redeem(ticketOf(e2.ticketPath)))!;
    expect(authority).not.toBe(first.authority);
    expect((await c2.call(first.authority, "display", DISPLAY))).toBeNull();
    const c3 = await Client.connect(e2.port);
    cleanups.push(() => c3.close());
    expect((await c3.call(authority, "display", DISPLAY))?.status).toBe("sent");
    expect(genRow(r.adapter, first.gen.launch.generation)).toMatchObject({ inv: 2, sends: 2 });
    expect(first.gen.launch.serverId).toBe(first.ctx.injectedServerId);
  });

  it("the trusted server match needs the stable id and a live registration", async () => {
    const r = await rig();
    const v = await live(r);
    expect(v.h.isTrustedServer(v.ctx.injectedServerId)).toBe(true);
    expect(v.h.isTrustedServer("octo_cards_" + "0".repeat(32))).toBe(false);
    expect(v.h.isTrustedServer("display")).toBe(false);
    v.h.close();
    expect(v.h.isTrustedServer(v.ctx.injectedServerId)).toBe(false);
  });

  it("a fractional monotonic clock (performance.now) still registers a whole-millisecond durable expiry", async () => {
    const r = await rig();
    const fractional = createToolHost({ store: r.store, installationRef: r.installationRef, cardsDir: r.cardsDir,
      ops: new Map([["display", sendingOp("display")]]), excludedRoots: [], clock: { nowMono: () => r.time.now() + 0.375 }, wall: r.time.wall,
      timers: r.time.timers, transport: ackingTransport(), entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } })!;
    cleanups.push(() => fractional.close({ reason: "shutdown", deadlineMono: 0, signal: AbortSignal.abort() }));
    const ctx = context(r);
    const gen = fractional.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: r.time.now() + 1000.5, currentResetEpoch: () => 0,
      ops: ["display"], admit: () => true });
    expect(gen).toBeDefined();
    const row = r.adapter.prepare("SELECT expires_at FROM card_handler_generations WHERE generation = ?").get(ctx.turnGeneration) as { expires_at: number };
    expect(Number.isInteger(row.expires_at)).toBe(true);
  });

  it("a duplicate generation identity disables injection for it", async () => {
    const r = await rig();
    const ctx = context(r);
    open(r, { ctx });
    expect(r.host.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: r.time.now() + 1000, currentResetEpoch: () => 0,
      ops: ["display"], admit: () => true })).toBeUndefined();
  });
});

// ─── drain ──────────────────────────────────────────────────────────────────

describe("shutdown drain (§2.4 shutdown row)", () => {
  it("close fences listeners immediately; unresolved post-reserve work becomes ambiguous at the deadline", async () => {
    const never = new Promise<ExplicitTransportOutcome>(() => { /* never settles */ });
    const r = await rig({ transport: { send: () => never } });
    const v = await live(r);
    void v.client.call(v.authority, "display", DISPLAY);
    await until(() => expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "reserved" }]));
    const ac = new AbortController();
    const fence = { reason: "shutdown" as const, deadlineMono: r.time.now() + 100, signal: ac.signal };
    r.host.close(fence);
    expect(r.host.stats().liveListeners).toBe(0);
    const drained = r.host.drain(fence);
    await r.time.advance(100);
    const report = await drained;
    expect(report.unresolved).toBeGreaterThanOrEqual(1);
    expect(requestRows(r.adapter, v.gen.launch.generation)).toMatchObject([{ state: "ambiguous", send_slot: 1 }]);
    expect(genRow(r.adapter, v.gen.launch.generation)?.state).toBe("closed");
    expect(existsSync(join(r.cardsDir, "bootstrap"))).toBe(false);
  });
});

// ─── gateway-wide G-d ───────────────────────────────────────────────────────

/** The only `config.toml` G-d admits: API-key login forced and every required feature explicitly off. */
const ADMITTED = ADMITTED_CONFIG_TOML;

function featuresOffHome(prefix: string, extra = ""): string {
  const home = tempDir(prefix);
  writeFileSync(join(home, "config.toml"), `${extra}${ADMITTED}`);
  return home;
}

function homeWith(prefix: string, configToml: string): string {
  const home = tempDir(prefix);
  writeFileSync(join(home, "config.toml"), configToml);
  return home;
}

/** /tmp has no `.codex` ancestor on any CI host; the walk is conservative up to "/". */
function sessionCwd(): string {
  const cwd = mkdtempSync("/tmp/wp08-cwd-");
  roots.push(cwd);
  return cwd;
}

/** An admissible exposure of `codexHome`, with any field overridden (also with a wrong type). */
function exposure(codexHome: string | undefined, over: { readonly [K in keyof GatewayExposureEntry]?: unknown } = {}): GatewayExposureEntry {
  return { sandboxMode: "read-only", codexHome, apiKeyConfigured: true, sdkEnvAuthMarkers: false, ...over } as GatewayExposureEntry;
}

function expose(entry: GatewayExposureEntry): () => void {
  const release = registerGatewayExposure(entry);
  cleanups.push(release);
  return release;
}

/** G-d for `cwd` with `entry` as the only extra exposure, then unregistered. */
function admitsWith(cwd: string, entry: GatewayExposureEntry): boolean {
  const release = registerGatewayExposure(entry);
  try { return gatewayAdmitsInjection(cwd); } finally { release(); }
}

/** Run `fn` with `key` present in the live process.env, restoring the prior state. */
function withEnv<T>(key: string, fn: () => T): T {
  const had = Object.hasOwn(process.env, key);
  const prior = process.env[key];
  process.env[key] = "";
  try { return fn(); } finally { if (had) process.env[key] = prior; else delete process.env[key]; }
}

describe("gateway-wide discovery gate G-d (§6)", () => {
  it("requires the Codex 0.163 default-on plugin, connector, hook and code-mode host features to be explicitly off", () => {
    expect([...REQUIRED_DISABLED_CODEX_FEATURES].sort()).toEqual(["apps", "code_mode_host", "hooks", "plugins", "remote_plugin", "skill_mcp_dependency_install"]);
    // Empty or settings-only config leaves the 0.163 defaults on.
    expect(admitsCodexConfigToml("")).toBe(false);
    expect(admitsCodexConfigToml('model = "gpt"\n')).toBe(false);
    expect(admitsCodexConfigToml(ADMITTED)).toBe(true);
    expect(admitsCodexConfigToml(`# c\nmodel = "gpt"\nmodel_reasoning_effort = "high"\n${ADMITTED}[model_providers.p]\nbase_url = "https://x"\n`)).toBe(true);
    for (const missing of REQUIRED_DISABLED_CODEX_FEATURES) {
      expect(admitsCodexConfigToml(ADMITTED.replace(`${missing} = false\n`, ""))).toBe(false);
    }
    for (const bad of [
      ADMITTED.replace("apps = false", "apps = true"),
      ADMITTED.replace("hooks = false", 'hooks = "false"'),
      ADMITTED.replace("plugins = false", "plugins = 0"),
      `${ADMITTED}web_search = false\n`,
      `${ADMITTED}apps = false\n`,
      `${ADMITTED}[features]\n`,
      `${ADMITTED}[model_providers.p]\nname = "a"\n[model_providers.p]\nname = "b"\n`,
      `model = "a"\nmodel = "b"\n${ADMITTED}`,
      `features.apps = false\n${ADMITTED}`,
      `[features.apps]\nenabled = false\n${ADMITTED}`,
      `${ADMITTED.replace(/\n$/, "")} garbage\n`,
    ]) expect(admitsCodexConfigToml(bad)).toBe(false);
  });

  it("the closed allowlist admits only plain model settings next to the required features", () => {
    for (const bad of [
      'notify = ["say"]', '[mcp_servers.node_repl]\ncommand = "node"', "[hooks]\nx = 1", '[profiles.a]\nmodel = "x"',
      'profile = "a"', '[plugins.x]\nenabled = true', '[apps.codex_apps]\nenabled = true', 'mcp_servers.x.command = "y"',
      'model = """\nx\n"""', 'model = { a = 1 }', 'sandbox_mode = "danger-full-access"', "garbage line",
    ]) expect(admitsCodexConfigToml(`${ADMITTED}${bad}\n`)).toBe(false);
  });

  it("code mode: an absent or enabled code_mode_host and every fallback or code_mode shape turn injection off (C2)", () => {
    const cwd = sessionCwd();
    const noHost = ADMITTED.replace("code_mode_host = false\n", "");
    const shapes = [
      noHost,
      ADMITTED.replace("code_mode_host = false", "code_mode_host = true"),
      `${noHost}[features.code_mode_host]\ndisable_in_process_fallback = true\n`,
      `${ADMITTED}[features.code_mode_host]\ndisable_in_process_fallback = true\n`,
      noHost.replace("[features]\n", "[features]\ncode_mode_host = { enabled = false, disable_in_process_fallback = true }\n"),
      `${ADMITTED}[features.code_mode]\nenabled = true\n`,
      `features.code_mode_host.disable_in_process_fallback = true\n${ADMITTED}`,
      ADMITTED.replace("[features]\n", "[features]\ncode_mode = true\n"),
      ADMITTED.replace("[features]\n", "[features]\ncode_mode_only = true\n"),
    ];
    for (const text of shapes) {
      expect([text, admitsCodexConfigToml(text)]).toEqual([text, false]);
      expect([text, admitsWith(cwd, exposure(homeWith("wp08-cm-", text)))]).toEqual([text, false]);
    }
    expect(admitsWith(cwd, exposure(homeWith("wp08-cm-", ADMITTED)))).toBe(true);
  });

  it("auth: only presence-checked API-key auth, forced api login and the file store admit (§4.4-2/3)", () => {
    const cwd = sessionCwd();
    const home = featuresOffHome("wp08-auth-");
    expect(admitsWith(cwd, exposure(home))).toBe(true);
    // Exposure fields: no API key, an sdk.env marker, or any non-boolean value.
    for (const over of [
      { apiKeyConfigured: false }, { sdkEnvAuthMarkers: true },
      { apiKeyConfigured: "true" }, { apiKeyConfigured: 1 }, { apiKeyConfigured: undefined }, { apiKeyConfigured: null },
      { sdkEnvAuthMarkers: "false" }, { sdkEnvAuthMarkers: 0 }, { sdkEnvAuthMarkers: undefined }, { sdkEnvAuthMarkers: null },
    ]) expect([over, admitsWith(cwd, exposure(home, over))]).toEqual([over, false]);
    // Each marker in the live process.env, by key presence alone (an empty value counts).
    for (const key of CODEX_AUTH_ENV_MARKERS) expect([key, withEnv(key, () => admitsWith(cwd, exposure(home)))]).toEqual([key, false]);
    expect(admitsWith(cwd, exposure(home))).toBe(true);
    // Stored or cloud auth in CODEX_HOME, as any entry type, a dangling symlink included.
    const makers: [string, (p: string) => void][] = [
      ["file", (p) => writeFileSync(p, "{}")], ["directory", (p) => mkdirSync(p)], ["dangling symlink", (p) => symlinkSync(join(home, "missing-target"), p)],
    ];
    for (const name of ["auth.json", "cloud-config-bundle-cache.json"]) {
      for (const [kind, make] of makers) {
        const p = join(home, name);
        make(p);
        // Links are unlinked: Node 24.10's rmSync leaves a dangling symlink in place.
        try { expect([name, kind, admitsWith(cwd, exposure(home))]).toEqual([name, kind, false]); } finally { if (kind === "directory") rmSync(p, { recursive: true }); else unlinkSync(p); }
      }
    }
    expect(admitsWith(cwd, exposure(home))).toBe(true);
    // Login method and credential store.
    const cases: [string, boolean][] = [
      [ADMITTED, true],
      [ADMITTED.replace('"api"', "'api'"), true],
      [`cli_auth_credentials_store = "file"\n${ADMITTED}`, true],
      [`cli_auth_credentials_store = 'file'\n${ADMITTED}`, true],
      [ADMITTED.replace('forced_login_method = "api"\n', ""), false],
      [ADMITTED.replace('"api"', '"chatgpt"'), false],
      [ADMITTED.replace('"api"', '"API"'), false],
      [ADMITTED.replace('"api"', '"\\u0061pi"'), false],
      [ADMITTED.replace('"api"', "true"), false],
      ...["keyring", "auto", "ephemeral", "File"].map((m): [string, boolean] => [`cli_auth_credentials_store = "${m}"\n${ADMITTED}`, false]),
    ];
    for (const [text, ok] of cases) {
      expect([text, admitsCodexConfigToml(text)]).toEqual([text, ok]);
      expect([text, admitsWith(cwd, exposure(homeWith("wp08-auth-cfg-", text)))]).toEqual([text, ok]);
    }
  });

  it("the sdk.env marker flag registered by index.ts is key presence only", () => {
    expect([...CODEX_AUTH_ENV_MARKERS].sort()).toEqual(["CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"]);
    expect(hasCodexAuthEnvMarker(undefined)).toBe(false);
    expect(hasCodexAuthEnvMarker({})).toBe(false);
    expect(hasCodexAuthEnvMarker({ OPENAI_API_KEY: "x", CODEX_API_KEY: "x", CODEX_HOME: "/h" })).toBe(false);
    for (const key of CODEX_AUTH_ENV_MARKERS) expect(hasCodexAuthEnvMarker({ [key]: "" })).toBe(true);
  });

  it("index.ts registers the resolved sandbox mode and both auth presence flags at its only call site", () => {
    const src = readFileSync(join(new URL("../..", import.meta.url).pathname, "src", "index.ts"), "utf8");
    expect(src.match(/registerGatewayExposure\(/g)).toHaveLength(1);
    expect(src).toContain("registerGatewayExposure({ sandboxMode: resolveSandbox(config.sdk), codexHome,\n"
      + "      apiKeyConfigured: Boolean(config.sdk.codexApiKey), sdkEnvAuthMarkers: hasCodexAuthEnvMarker(config.sdk.env) });");
  });

  it("injection holds only when every Bot is admissible and its CODEX_HOME admits nothing else", () => {
    const clean = featuresOffHome("wp08-home-");
    const cwd = sessionCwd();
    const release = [registerGatewayExposure(exposure(clean))];
    cleanups.push(() => { for (const r of release) r(); });
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    expect(gatewayAdmitsInjection(undefined)).toBe(false);
    expect(gatewayAdmitsInjection("relative/cwd")).toBe(false);
    mkdirSync(join(cwd, ".codex"));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    rmSync(join(cwd, ".codex"), { recursive: true });
    symlinkSync(join(cwd, "missing"), join(cwd, ".codex"));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    unlinkSync(join(cwd, ".codex"));
    const notify = featuresOffHome("wp08-home-notify-", 'notify = ["say"]\n');
    release.push(registerGatewayExposure(exposure(notify)));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    release.pop()!();
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    // A CODEX_HOME without config.toml runs with the 0.163 defaults on.
    release.push(registerGatewayExposure(exposure(tempDir("wp08-home-empty-"))));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    release.pop()!();
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    release.push(registerGatewayExposure(exposure(undefined)));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    release.pop()!();
    // Unadmitted CODEX_HOME layers, as any entry type.
    for (const name of ["managed_config.toml", "requirements.toml", "hooks.json", "hooks", "plugins"]) {
      const home = featuresOffHome("wp08-home-layer-");
      mkdirSync(join(home, name));
      expect([name, admitsWith(cwd, exposure(home))]).toEqual([name, false]);
    }
    // A config.toml that is a symlink, a directory or over 64 KiB is not read.
    const linked = tempDir("wp08-home-link-");
    symlinkSync(join(clean, "config.toml"), join(linked, "config.toml"));
    expect(admitsWith(cwd, exposure(linked))).toBe(false);
    const dir = tempDir("wp08-home-dir-");
    mkdirSync(join(dir, "config.toml"));
    expect(admitsWith(cwd, exposure(dir))).toBe(false);
    expect(admitsWith(cwd, exposure(featuresOffHome("wp08-home-big-", `# ${"x".repeat(65_536)}\n`)))).toBe(false);
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    release.pop()!();
    // No running Bot at all is unknown exposure.
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
  });

  it("a dangling /etc/codex symlink turns injection off", () => {
    const cwd = sessionCwd();
    expose(exposure(featuresOffHome("wp08-etc-home-")));
    const etc = join(tempDir("wp08-etc-"), "codex");
    armed.redirect.set("/etc/codex", etc);
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    symlinkSync(join(etc, "..", "missing"), etc);
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    unlinkSync(etc);
    writeFileSync(etc, "");
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
  });

  it("a new Bot whose CODEX_HOME leaves the default features on revokes every live registration", async () => {
    const r = await rig();
    const v = await live(r);
    cleanups.push(registerGatewayExposure(exposure(tempDir("wp08-home-default-"))));
    expect(r.host.stats().liveListeners).toBe(0);
    expect(await v.client.call(v.authority, "display", DISPLAY)).toBeNull();
  });

  it("[PINNED-RUNTIME] codex 0.163.0 default-on features equal the reviewed 59-entry table, and the admitted config turns each required one off", async () => {
    // Precondition: no system or managed layer on this host, or `features list` would report host state.
    let etc: NodeJS.ErrnoException | undefined;
    try { statSync("/etc/codex"); } catch (err) { etc = err as NodeJS.ErrnoException; }
    if (etc?.code !== "ENOENT") throw new Error("environment: /etc/codex is present; the snapshot needs a host with no system layer");
    const probe = admissibleGateway();
    cleanups.push(probe.release);
    if (!probe.admit()) throw new Error("environment: G-d does not admit on this host (system layer, managed preferences or an auth marker)");
    const codexJs = join(new URL("../..", import.meta.url).pathname, "node_modules", "@openai", "codex", "bin", "codex.js");
    const run = async (home: string): Promise<Map<string, { stage: string; enabled: string }>> => {
      const { stdout } = await promisify(execFile)(process.execPath, [codexJs, "features", "list"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CODEX_HOME: home }, timeout: 60_000, maxBuffer: 1 << 20,
      });
      const rows = new Map<string, { stage: string; enabled: string }>();
      for (const line of stdout.split("\n")) {
        const m = /^(\S+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)\s*$/.exec(line);
        if (m !== null) rows.set(m[1] as string, { stage: m[2] as string, enabled: m[3] as string });
      }
      return rows;
    };
    const { stdout: version } = await promisify(execFile)(process.execPath, [codexJs, "--version"], { timeout: 60_000 });
    expect(version.trim()).toBe("codex-cli 0.163.0");
    const defaults = await run(tempDir("wp08-home-default-"));
    const enabledByDefault = [...defaults].filter(([, row]) => row.enabled === "true").map(([name, row]) => `${name} ${row.stage}`).sort();
    expect(enabledByDefault).toEqual([...REVIEWED_DEFAULT_ON_FEATURES].sort());
    const off = featuresOffHome("wp08-home-off-");
    const disabled = await run(off);
    for (const f of REQUIRED_DISABLED_CODEX_FEATURES) {
      expect([f, defaults.get(f)?.enabled]).toEqual([f, "true"]);
      expect([f, disabled.get(f)?.enabled]).toEqual([f, "false"]);
    }
    expect(admitsCodexConfigToml(readFileSync(join(off, "config.toml"), "utf8"))).toBe(true);
  }, 120_000);

  it("a Bot that newly allows danger-full-access revokes every live registration of every host", async () => {
    const r = await rig();
    const v = await live(r);
    const release = registerGatewayExposure(exposure(featuresOffHome("wp08-danger-"), { sandboxMode: "danger-full-access" }));
    cleanups.push(release);
    expect(r.host.stats().liveListeners).toBe(0);
    expect(await v.client.call(v.authority, "display", DISPLAY)).toBeNull();
  });
});

/** WP09-PF v3 §4.3: every default-enabled feature of codex 0.163.0 with its stage, as reviewed. Never generated from host output. */
const REVIEWED_DEFAULT_ON_FEATURES: readonly string[] = Object.freeze([
  "daemon_auto_start stable", "shell_tool stable", "view_image stable", "sleep_tool stable", "unified_exec stable",
  "unified_exec_tty stable", "shell_snapshot stable", "content_item_kinds stable", "code_mode_host stable",
  "code_mode_interrupt stable", "instant_interrupt under development", "terminal_resize_reflow removed", "sqlite removed",
  "write_stdin_approval stable", "hooks stable", "api_key_model_discovery stable", "cli_daybreak stable",
  "api_key_cyber_access_programs stable", "enable_request_compression stable", "unbounded_connection_retries stable",
  "worktrees stable", "system_proxy_fallback stable", "multi_agent stable", "apps stable",
  "tool_search_always_defer_mcp_tools removed", "tool_suggest stable", "plugins stable", "in_app_browser stable",
  "browser_annotation_api stable", "in_app_chat stable", "in_app_dictation stable", "in_app_voice stable",
  "in_app_local_automation stable", "in_app_updates stable", "browser_use stable", "browser_use_full_cdp_access stable",
  "browser_use_external stable", "computer_use stable", "remote_plugin stable", "plugin_sharing stable",
  "image_generation stable", "resize_all_images removed", "item_ids removed", "skill_mcp_dependency_install stable",
  "skill_search stable", "mentions_v2 stable", "steer removed", "guardian_approval stable",
  "guardian_reuse_parent_compaction stable", "goals stable", "collaboration_modes removed", "tool_call_mcp_elicitation stable",
  "auth_elicitation stable", "fast_mode stable", "ultrafast_mode stable", "realtime_conversation stable",
  "tui_app_server removed", "compaction_image_budget stable", "workspace_dependencies stable",
]);

// ─── managed-preferences walk ───────────────────────────────────────────────

describe("managed-preferences walk (§4.4-1, v3.1 N-f)", () => {
  const MDM = "/Library/Managed Preferences";

  function mdmRig(): { readonly root: string; readonly admits: () => boolean } {
    const cwd = sessionCwd();
    expose(exposure(featuresOffHome("wp08-mdm-home-")));
    const root = join(tempDir("wp08-mdm-"), "Managed Preferences");
    armed.redirect.set(MDM, root);
    return { root, admits: () => gatewayAdmitsInjection(cwd) };
  }

  it("an absent root passes; a root of non-Codex plists and directories passes (clean)", () => {
    const m = mdmRig();
    expect(m.admits()).toBe(true);
    mkdirSync(join(m.root, "alice", "nested"), { recursive: true });
    writeFileSync(join(m.root, "com.apple.dock.plist"), "");
    writeFileSync(join(m.root, "alice", "com.example.app.plist"), "");
    expect(m.admits()).toBe(true);
  });

  it("a symlink root, a symlink entry, a FIFO entry or an entry gone after readdir turns injection off", () => {
    const m = mdmRig();
    const target = tempDir("wp08-mdm-target-");
    symlinkSync(target, m.root);
    expect(m.admits()).toBe(false);
    unlinkSync(m.root);
    mkdirSync(m.root);
    expect(m.admits()).toBe(true);
    symlinkSync(join(target, "x.plist"), join(m.root, "link.plist"));
    expect(m.admits()).toBe(false);
    unlinkSync(join(m.root, "link.plist"));
    execFileSync("mkfifo", [join(m.root, "fifo")]);
    expect(m.admits()).toBe(false);
    rmSync(join(m.root, "fifo"));
    expect(m.admits()).toBe(true);
    writeFileSync(join(m.root, "gone.plist"), "");
    armed.vanished.add(`${MDM}/gone.plist`);
    expect(m.admits()).toBe(false);
    armed.vanished.clear();
    expect(m.admits()).toBe(true);
    // A root that is a regular file.
    rmSync(m.root, { recursive: true });
    writeFileSync(m.root, "");
    expect(m.admits()).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable subdirectory (EACCES) turns injection off", () => {
    const m = mdmRig();
    const locked = join(m.root, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    cleanups.push(() => chmodSync(locked, 0o700));
    expect(m.admits()).toBe(false);
    chmodSync(locked, 0o700);
    expect(m.admits()).toBe(true);
  });

  it("a real depth-3 directory is walked; an entry at depth 4 turns injection off", () => {
    const m = mdmRig();
    const depth3 = join(m.root, "d1", "d2", "d3");
    mkdirSync(depth3, { recursive: true });
    writeFileSync(join(m.root, "d1", "d2", "at-depth-3.plist"), "");
    expect(m.admits()).toBe(true);
    writeFileSync(join(depth3, "at-depth-4.plist"), "");
    expect(m.admits()).toBe(false);
  });

  it("4096 visited entries (directories included) pass; the 4097th, spread over depths 1–2, turns injection off", () => {
    const m = mdmRig();
    const sub = join(m.root, "sub");
    mkdirSync(sub, { recursive: true });
    // 1 directory + 2047 files at depth 1, 2048 files at depth 2 = 4096 entries.
    for (let i = 0; i < 2047; i++) writeFileSync(join(m.root, `f${i}`), "");
    for (let i = 0; i < 2048; i++) writeFileSync(join(sub, `g${i}`), "");
    expect(m.admits()).toBe(true);
    writeFileSync(join(sub, "one-more"), "");
    expect(m.admits()).toBe(false);
  });

  it("a Codex plist at depth 1, at depth 2 or in another letter case turns injection off", () => {
    const m = mdmRig();
    mkdirSync(join(m.root, "alice"), { recursive: true });
    for (const rel of ["com.openai.codex.plist", join("alice", "com.openai.codex.plist"), "COM.OpenAI.Codex.PLIST"]) {
      writeFileSync(join(m.root, rel), "");
      expect([rel, m.admits()]).toEqual([rel, false]);
      rmSync(join(m.root, rel));
      expect([rel, m.admits()]).toEqual([rel, true]);
    }
  });
});

// ─── admit slot ─────────────────────────────────────────────────────────────

describe("single-use admit slot (v3.1 N-c)", () => {
  it("admit() true without a G-d evaluation opens no registration, ticket or listener", async () => {
    const r = await rig();
    const { gen } = open(r, { admit: () => true });
    expect(await gen.launch.prepareAttempt()).toBeUndefined();
    expect(r.host.stats()).toMatchObject({ liveRegistrations: 0, liveListeners: 0 });
    expect(readdirSync(join(r.cardsDir, "bootstrap"))).toEqual([]);
  });

  it("an offer-time snapshot is cleared before admit, and the slot is empty after a take, a false admit and a throw", async () => {
    const r = await rig();
    // Offer-time evaluation (runtime.ts:378) fills the slot; the attempt clears it before its own admit.
    expect(gatewayAdmitsInjection(r.cwd)).toBe(true);
    expect(await open(r, { admit: () => true }).gen.launch.prepareAttempt()).toBeUndefined();
    expect(await open(r).gen.launch.prepareAttempt()).toBeDefined();
    expect(await open(r, { admit: () => true }).gen.launch.prepareAttempt()).toBeUndefined();
    expect(await open(r, { admit: () => { r.admit(); return false; } }).gen.launch.prepareAttempt()).toBeUndefined();
    expect(await open(r, { admit: () => true }).gen.launch.prepareAttempt()).toBeUndefined();
    expect(await open(r, { admit: () => { r.admit(); throw new Error("admit"); } }).gen.launch.prepareAttempt()).toBeUndefined();
    expect(await open(r, { admit: () => true }).gen.launch.prepareAttempt()).toBeUndefined();
    expect(r.host.stats().liveRegistrations).toBe(1);
  });

  it("the registration keeps the admitted session cwd: only that cwd's project layer fences it", async () => {
    const r = await rig();
    const other = sessionCwd();
    const first = await admittedAttempt(r);
    mkdirSync(join(other, ".codex"));
    expect(await redeemOn(first.e)).not.toBeNull();
    const second = await admittedAttempt(r, { admit: () => gatewayAdmitsInjection(other) === false && r.admit() });
    mkdirSync(join(r.cwd, ".codex"));
    expect(await redeemOn(second.e)).toBeNull();
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapAdmitDrift: 1, bootstrapAdmitGatewayRevoke: 0 });
  });
});

async function admittedAttempt(r: Rig, over: Parameters<typeof open>[1] = {}) {
  const { gen, ctx } = open(r, over);
  const h = (await gen.launch.prepareAttempt())!;
  expect(h).toBeDefined();
  return { gen, ctx, h, e: entryOf(h) };
}

async function redeemOn(e: { ticketPath: string; port: number }) {
  const c = await Client.connect(e.port);
  cleanups.push(() => c.close());
  return c.redeem(ticketOf(e.ticketPath));
}

// ─── redeem-time fence ──────────────────────────────────────────────────────

describe("redeem-time G-d fence (v3 §4.4-7 as split by v3.1 D1)", () => {
  interface Change {
    readonly name: string;
    readonly scope: "local" | "gateway";
    readonly before?: (r: Rig) => void;
    readonly change: (r: Rig) => void;
  }
  const config = (r: Rig) => join(r.codexHome, "config.toml");
  let removable: (() => void) | undefined;
  const changes: Change[] = [
    { name: "a still-admitted byte change to config.toml", scope: "local", change: (r) => writeFileSync(config(r), `# touched\n${readFileSync(config(r), "utf8")}`) },
    { name: "an inode swap with identical bytes", scope: "local", change: (r) => {
      const next = `${config(r)}.next`;
      writeFileSync(next, readFileSync(config(r)));
      renameSync(next, config(r));
    } },
    { name: "an mtimeNs change", scope: "local", change: (r) => utimesSync(config(r), new Date(Date.UTC(2001, 0, 1)), new Date(Date.UTC(2001, 0, 1))) },
    { name: "an admissible exposure added", scope: "local", change: () => { expose(exposure(featuresOffHome("wp08-fence-add-"))); } },
    { name: "an admissible exposure removed", scope: "local",
      before: () => { removable = registerGatewayExposure(exposure(featuresOffHome("wp08-fence-rm-"))); cleanups.push(removable); },
      change: () => removable!() },
    { name: "a new project .codex layer", scope: "local", change: (r) => mkdirSync(join(r.cwd, ".codex")) },
    { name: "managed preferences absent → clean", scope: "local",
      before: () => armed.redirect.set("/Library/Managed Preferences", join(tempDir("wp08-fence-mdm-"), "mp")),
      change: () => {
        const root = armed.redirect.get("/Library/Managed Preferences")!;
        mkdirSync(root);
        writeFileSync(join(root, "com.apple.dock.plist"), "");
      } },
    { name: "a config.toml that no longer admits", scope: "gateway", change: (r) => writeFileSync(config(r), `notify = ["say"]\n${ADMITTED}`) },
    { name: "a new denied file (auth.json)", scope: "gateway", change: (r) => writeFileSync(join(r.codexHome, "auth.json"), "{}") },
    { name: "a new process.env marker", scope: "gateway", change: () => {
      const had = Object.hasOwn(process.env, "CODEX_ACCESS_TOKEN");
      process.env.CODEX_ACCESS_TOKEN = "";
      if (!had) cleanups.push(() => { delete process.env.CODEX_ACCESS_TOKEN; });
    } },
  ];

  it("an unchanged snapshot redeems as case 1", async () => {
    const r = await rig();
    const a = await admittedAttempt(r);
    expect(await redeemOn(a.e)).not.toBeNull();
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapAdmitDrift: 0, bootstrapAdmitGatewayRevoke: 0 });
  });

  for (const c of changes) {
    it(`${c.name} closes the redeeming registration as case 3 (${c.scope}): no reply, ledger Δ0, bootstrapExpired unchanged`, async () => {
      const r = await rig();
      const bystander = await live(r);
      c.before?.(r);
      const a = await admittedAttempt(r);
      const before = r.host.stats();
      c.change(r);
      expect(await redeemOn(a.e)).toBeNull();
      expect(r.host.stats()).toMatchObject({
        bootstrapRedeemed: before.bootstrapRedeemed, bootstrapAdmitDrift: before.bootstrapAdmitDrift + 1,
        bootstrapAdmitGatewayRevoke: before.bootstrapAdmitGatewayRevoke + (c.scope === "gateway" ? 1 : 0),
        bootstrapExpired: before.bootstrapExpired, bootstrapReplay: before.bootstrapReplay,
      });
      expect(requestRows(r.adapter, a.gen.launch.generation)).toEqual([]);
      expect(genRow(r.adapter, a.gen.launch.generation)).toMatchObject({ state: "live", inv: 0, sends: 0 });
      expect(existsSync(a.e.ticketPath)).toBe(false);
      await expect(Client.connect(a.e.port)).rejects.toThrow();
      // A gateway failure revokes every live authority; a local one leaves the bystander alone.
      if (c.scope === "gateway") {
        expect(r.host.stats().liveRegistrations).toBe(0);
        expect(await bystander.client.call(bystander.authority, "display", DISPLAY)).toBeNull();
      } else {
        expect(r.host.stats().liveRegistrations).toBe(1);
        expect((await bystander.client.call(bystander.authority, "display", DISPLAY))?.status).toBe("sent");
      }
    });
  }
});

describe("fence scope across registrations and hosts (v3.1 D1 fixtures 1–4)", () => {
  /** H1 holds R0 (admitted, not redeemed, session cwd C0); H2 holds redeemed Rp (no request), Rc (one charged) and Rr (one reserved). */
  async function scene() {
    let releaseCharge!: () => void;
    const chargeGate = new Promise<void>((resolve) => { releaseCharge = resolve; });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let holdNextSend = true;
    const transport: ExplicitTransport = { async send() {
      if (holdNextSend) { holdNextSend = false; await sendGate; }
      return { kind: "acked", messageId: String(messageSeq++) };
    } };
    const h1 = await rig();
    const h2 = await rig({ ref: "install-b", transport, ops: new Map<ToolOpcode, ExplicitOpHandler>([
      ["display", sendingOp("display")],
      ["interactive", { op: "interactive", async handle() { await chargeGate; return EXPLICIT_OP_UNAVAILABLE; } }],
    ]) });
    cleanups.push(() => { releaseCharge(); releaseSend(); });
    const onOwnCwd = async (ops: readonly ToolOpcode[]) => {
      const cwd = sessionCwd();
      return live(h2, { ops, admit: () => gatewayAdmitsInjection(cwd) });
    };
    const rp = await onOwnCwd(["display"]);
    const rc = await onOwnCwd(["interactive"]);
    const rr = await onOwnCwd(["display"]);
    const charged = rc.client.call(rc.authority, "interactive", { title: "t", buttons: [{ id: "b", label: "B" }] });
    await until(() => expect(requestRows(h2.adapter, rc.gen.launch.generation)).toMatchObject([{ state: "charged" }]));
    const reserved = rr.client.call(rr.authority, "display", DISPLAY);
    await until(() => expect(requestRows(h2.adapter, rr.gen.launch.generation)).toMatchObject([{ state: "reserved" }]));
    const r0 = await admittedAttempt(h1);
    return { h1, h2, rp, rc, rr, r0, charged, reserved };
  }

  type Scene = Awaited<ReturnType<typeof scene>>;

  async function expectLocalClose(s: Scene): Promise<void> {
    const h2Before = snapshot(s.h2.adapter);
    expect(await redeemOn(s.r0.e)).toBeNull();
    expect(s.h1.host.stats()).toMatchObject({ bootstrapRedeemed: 0, bootstrapAdmitDrift: 1, bootstrapAdmitGatewayRevoke: 0, bootstrapExpired: 0 });
    expect(requestRows(s.h1.adapter, s.r0.gen.launch.generation)).toEqual([]);
    // H2 is untouched: Rc stays charged, Rr stays reserved, nothing is revoked.
    expect(s.h2.host.stats()).toMatchObject({ liveRegistrations: 3, bootstrapReplay: 0, bootstrapAdmitDrift: 0 });
    expect(snapshot(s.h2.adapter)).toEqual(h2Before);
    expect(requestRows(s.h2.adapter, s.rc.gen.launch.generation)).toMatchObject([{ state: "charged" }]);
    expect(requestRows(s.h2.adapter, s.rr.gen.launch.generation)).toMatchObject([{ state: "reserved", send_slot: 1 }]);
    // A later valid call on Rp is authorized.
    expect((await s.rp.client.call(s.rp.authority, "display", DISPLAY))?.status).toBe("sent");
  }

  async function expectGatewayCascade(s: Scene): Promise<void> {
    expect(await redeemOn(s.r0.e)).toBeNull();
    expect(s.h1.host.stats()).toMatchObject({ bootstrapRedeemed: 0, bootstrapAdmitDrift: 1, bootstrapAdmitGatewayRevoke: 1, bootstrapExpired: 0 });
    expect(requestRows(s.h1.adapter, s.r0.gen.launch.generation)).toEqual([]);
    expect(s.h2.host.stats()).toMatchObject({ liveRegistrations: 0, liveListeners: 0 });
    expect(requestRows(s.h2.adapter, s.rp.gen.launch.generation)).toEqual([]);
    expect(requestRows(s.h2.adapter, s.rc.gen.launch.generation)).toMatchObject([{ state: "cancelled", send_slot: null }]);
    expect(requestRows(s.h2.adapter, s.rr.gen.launch.generation)).toMatchObject([{ state: "ambiguous", send_slot: 1 }]);
    expect(await s.charged).toBeNull();
    expect(await s.reserved).toBeNull();
    expect(await s.rp.client.call(s.rp.authority, "display", DISPLAY)).toBeNull();
  }

  it("1. a project layer under C0 closes only R0; Rp, Rc and Rr keep their state and Rp still works", async () => {
    const s = await scene();
    mkdirSync(join(s.h1.cwd, ".codex"));
    await expectLocalClose(s);
  });

  it("2. a gateway snapshot that drifted but still admits (new mtimeNs, or an inode swap) closes only R0", async () => {
    const s = await scene();
    utimesSync(join(s.h1.codexHome, "config.toml"), new Date(Date.UTC(2001, 0, 1)), new Date(Date.UTC(2001, 0, 1)));
    await expectLocalClose(s);
    const t = await scene();
    const path = join(t.h1.codexHome, "config.toml");
    writeFileSync(`${path}.next`, readFileSync(path));
    renameSync(`${path}.next`, path);
    await expectLocalClose(t);
  });

  it("3. auth.json appearing in one CODEX_HOME closes R0 and revokes Rp (Δ0), Rc (cancelled) and Rr (ambiguous, retained)", async () => {
    const s = await scene();
    writeFileSync(join(s.h1.codexHome, "auth.json"), "{}");
    await expectGatewayCascade(s);
  });

  it("4a. the gateway check throwing behaves as fixture 3", async () => {
    const s = await scene();
    const env = process.env;
    process.env = new Proxy(env, { getOwnPropertyDescriptor(target, key) {
      if (typeof key === "string" && CODEX_AUTH_ENV_MARKERS.includes(key)) throw new Error("env");
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    try { await expectGatewayCascade(s); } finally { process.env = env; }
  });

  it("4b. the session check throwing behaves as fixture 1", async () => {
    const s = await scene();
    armed.isAbsoluteThrows = s.h1.cwd;
    await expectLocalClose(s);
  });

  it("4c. the comparator throwing behaves as fixture 1", async () => {
    const s = await scene();
    armed.deepEqualThrows = true;
    try { await expectLocalClose(s); } finally { armed.deepEqualThrows = false; }
  });
});

// ─── FIFO config.toml ───────────────────────────────────────────────────────

describe("a FIFO config.toml fails closed without blocking the gateway (B1)", () => {
  /** Bound on one fail-closed evaluation; far below the watchdog delay. */
  const PROMPT_MS = 1_500;
  /** After this delay a watchdog keeps opening the FIFO for writing, releasing any blocking reader so a regression cannot freeze CI. */
  const WATCHDOG_MS = 4_000;

  /** Replace `home`'s config.toml with a FIFO and arm the watchdog writer. */
  function fifoConfig(home: string): void {
    const path = join(home, "config.toml");
    rmSync(path, { force: true });
    execFileSync("mkfifo", [path]);
    const writer = spawn(process.execPath, ["-e",
      `const fs = require("node:fs"); setTimeout(() => { for (;;) fs.closeSync(fs.openSync(process.argv[1], "w")); }, ${WATCHDOG_MS});`, path],
      { stdio: "ignore" });
    cleanups.push(() => { writer.kill("SIGKILL"); });
  }

  async function timed<T>(fn: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
    const start = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - start };
  }

  it("admission is false at once, and registering the exposure revokes every live registration at once", async () => {
    const r = await rig();
    const v = await live(r);
    const home = featuresOffHome("wp08-fifo-home-");
    fifoConfig(home);
    const registered = await timed(() => expose(exposure(home)));
    expect(registered.ms).toBeLessThan(PROMPT_MS);
    expect(r.host.stats()).toMatchObject({ liveRegistrations: 0, liveListeners: 0 });
    expect(await v.client.call(v.authority, "display", DISPLAY)).toBeNull();
    const admitted = await timed(() => gatewayAdmitsInjection(r.cwd));
    expect(admitted).toMatchObject({ value: false });
    expect(admitted.ms).toBeLessThan(PROMPT_MS);
    expect((await timed(() => open(r).gen.launch.prepareAttempt())).value).toBeUndefined();
  }, 20_000);

  it("a config.toml swapped for a FIFO after admit fails the redeem fence at once as a gateway failure", async () => {
    const r = await rig();
    const bystander = await live(r);
    const a = await admittedAttempt(r);
    const before = r.host.stats();
    fifoConfig(r.codexHome);
    const redeemed = await timed(() => redeemOn(a.e));
    expect(redeemed.value).toBeNull();
    expect(redeemed.ms).toBeLessThan(PROMPT_MS);
    expect(r.host.stats()).toMatchObject({
      bootstrapRedeemed: before.bootstrapRedeemed, bootstrapAdmitDrift: before.bootstrapAdmitDrift + 1,
      bootstrapAdmitGatewayRevoke: before.bootstrapAdmitGatewayRevoke + 1, bootstrapExpired: before.bootstrapExpired,
      liveRegistrations: 0,
    });
    expect(requestRows(r.adapter, a.gen.launch.generation)).toEqual([]);
    expect(await bystander.client.call(bystander.authority, "display", DISPLAY)).toBeNull();
  }, 20_000);
});

// ─── resolved read-only exposures ───────────────────────────────────────────

describe("only resolved read-only exposures admit (v3.1 D2)", () => {
  const sdk = (over: Record<string, unknown>) => over as Config["sdk"];
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("1. a resolved workspace-write exposure makes admit() false: no registration, ticket, fence or revoke", async () => {
    quiet();
    const r = await rig();
    const mode = resolveSandbox(sdk({ sandboxMode: "workspace-write", allowWorkspaceWrite: true }));
    expect(mode).toBe("workspace-write");
    expose(exposure(featuresOffHome("wp08-ww-"), { sandboxMode: mode }));
    const { gen } = open(r);
    expect(await gen.launch.prepareAttempt()).toBeUndefined();
    expect(r.host.stats()).toMatchObject({ liveRegistrations: 0, liveListeners: 0, bootstrapAdmitDrift: 0, bootstrapAdmitGatewayRevoke: 0 });
    expect(readdirSync(join(r.cardsDir, "bootstrap"))).toEqual([]);
  });

  it("2. registering that exposure while another Bot has a live registration revokes it (case 2)", async () => {
    quiet();
    const r = await rig();
    const v = await live(r);
    expose(exposure(featuresOffHome("wp08-ww-"), { sandboxMode: resolveSandbox(sdk({ sandboxMode: "workspace-write", allowWorkspaceWrite: true })) }));
    expect(r.host.stats()).toMatchObject({ liveRegistrations: 0, liveListeners: 0 });
    expect(await v.client.call(v.authority, "display", DISPLAY)).toBeNull();
  });

  it("3. workspace-write without allowWorkspaceWrite registers as read-only and is admitted", async () => {
    quiet();
    const r = await rig();
    const mode = resolveSandbox(sdk({ sandboxMode: "workspace-write", allowWorkspaceWrite: false }));
    expect(mode).toBe("read-only");
    expose(exposure(featuresOffHome("wp08-ww-ro-"), { sandboxMode: mode }));
    const v = await live(r);
    expect((await v.client.call(v.authority, "display", DISPLAY))?.status).toBe("sent");
  });

  it("4. danger-full-access, or a missing or non-string mode, makes admit() false", async () => {
    const cwd = sessionCwd();
    const home = featuresOffHome("wp08-modes-");
    expect(resolveSandbox(sdk({ sandboxMode: "danger-full-access" }))).toBe("danger-full-access");
    for (const sandboxMode of ["danger-full-access", "workspace-write", undefined, 42, null, "READ-ONLY", ""]) {
      expect([sandboxMode, admitsWith(cwd, exposure(home, { sandboxMode }))]).toEqual([sandboxMode, false]);
    }
    expect(admitsWith(cwd, exposure(home))).toBe(true);
  });

  it("5. ordinary turns are unchanged: buildThreadOptions is byte-identical for all three modes", () => {
    quiet();
    const config = (s: Record<string, unknown>) => ({ sdk: s }) as unknown as Config;
    const base = { workingDirectory: "/tmp/x", skipGitRepoCheck: true };
    const tail = { approvalPolicy: "never", modelReasoningEffort: "medium" };
    expect(JSON.stringify(buildThreadOptions(config({}), "/tmp/x"))).toBe(JSON.stringify({ ...base, sandboxMode: "read-only", ...tail,
      networkAccessEnabled: false, webSearchEnabled: false, webSearchMode: "disabled" }));
    expect(JSON.stringify(buildThreadOptions(config({ sandboxMode: "workspace-write", allowWorkspaceWrite: true }), "/tmp/x")))
      .toBe(JSON.stringify({ ...base, sandboxMode: "workspace-write", ...tail, networkAccessEnabled: false, webSearchEnabled: false, webSearchMode: "disabled" }));
    expect(JSON.stringify(buildThreadOptions(config({ sandboxMode: "danger-full-access" }), "/tmp/x")))
      .toBe(JSON.stringify({ ...base, sandboxMode: "danger-full-access", ...tail, networkAccessEnabled: true, webSearchEnabled: false, webSearchMode: "disabled" }));
  });
});
