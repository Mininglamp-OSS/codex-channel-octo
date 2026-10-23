/**
 * Trusted explicit-card tool host (WP-08, AM-08 v4 §4/§5/§7).
 *
 * Evidence label: [UNIT]/[INT-SYNTH-OP]. Real SQLite store, real loopback
 * listeners and a synthetic test op with a fake transport double; no
 * production op, no Octo send, no model. Covers the authority-free entry,
 * the four redemption cases, endpoint-bound authentication, the D0–D6
 * dispatch order with its ledger outcomes, fences, rotation and drain.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardToolResult, ToolOpcode, TrustedTurnContext } from "../cards/contracts.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { encodeBootstrapFrame, parseBootstrapReply, parseReplyFrame, readFrame } from "../cards/protocol.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import type { CardBinding, CardStore, ExplicitCard } from "../cards/store.js";
import {
  BOOTSTRAP_TTL_MS,
  EXPLICIT_OP_UNAVAILABLE,
  PRODUCTION_EXPLICIT_OPS,
  admitsCodexConfigToml,
  createToolHost,
  gatewayAdmitsInjection,
  registerGatewayExposure,
  type AttemptHandle,
  type ExplicitOpHandler,
  type ExplicitTransport,
  type ExplicitTransportOutcome,
  type ToolHost,
} from "../cards/tool-host.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, type ManualTime } from "./fixtures/card-write-harness.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
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
  return { store: sub.store, adapter, host, time, cardsDir: p.cardsDir, incarnation, installationRef: sub.meta.installationRef };
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
    currentResetEpoch: over.epoch ?? (() => 0), ops: over.ops ?? ["display"], admit: over.admit ?? (() => true) });
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
  it("the production op table is frozen empty and the unavailable result is exact", () => {
    expect(PRODUCTION_EXPLICIT_OPS.size).toBe(0);
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

describe("gateway-wide discovery gate G-d (§6)", () => {
  it("the closed allowlist admits only plain model settings", () => {
    expect(admitsCodexConfigToml("")).toBe(true);
    expect(admitsCodexConfigToml('# c\nmodel = "gpt"\nmodel_reasoning_effort = "high"\n[model_providers.p]\nbase_url = "https://x"\n')).toBe(true);
    for (const bad of [
      'notify = ["say"]', '[mcp_servers.node_repl]\ncommand = "node"', "[hooks]\nx = 1", '[profiles.a]\nmodel = "x"',
      'profile = "a"', '[plugins.x]\nenabled = true', '[apps.codex_apps]\nenabled = true', 'mcp_servers.x.command = "y"',
      'model = """\nx\n"""', 'model = { a = 1 }', 'sandbox_mode = "danger-full-access"', "garbage line",
    ]) expect(admitsCodexConfigToml(bad)).toBe(false);
  });

  it("injection holds only when every Bot is sandboxed and its CODEX_HOME admits nothing else", () => {
    const clean = tempDir("wp08-home-");
    // /tmp has no `.codex` ancestor on any CI host; the walk is conservative up to "/".
    const cwd = mkdtempSync("/tmp/wp08-cwd-");
    roots.push(cwd);
    const release = [registerGatewayExposure({ sandboxMode: "read-only", codexHome: clean })];
    cleanups.push(() => { for (const r of release) r(); });
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    expect(gatewayAdmitsInjection(undefined)).toBe(false);
    mkdirSync(join(cwd, ".codex"));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    rmSync(join(cwd, ".codex"), { recursive: true });
    const notify = tempDir("wp08-home-notify-");
    writeFileSync(join(notify, "config.toml"), 'notify = ["say"]\n');
    release.push(registerGatewayExposure({ sandboxMode: "workspace-write", codexHome: notify }));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
    release.pop()!();
    expect(gatewayAdmitsInjection(cwd)).toBe(true);
    release.push(registerGatewayExposure({ sandboxMode: "read-only", codexHome: undefined }));
    expect(gatewayAdmitsInjection(cwd)).toBe(false);
  });

  it("a Bot that newly allows danger-full-access revokes every live registration of every host", async () => {
    const r = await rig();
    const v = await live(r);
    const release = registerGatewayExposure({ sandboxMode: "danger-full-access", codexHome: tempDir("wp08-danger-") });
    cleanups.push(release);
    expect(r.host.stats().liveListeners).toBe(0);
    expect(await v.client.call(v.authority, "display", DISPLAY)).toBeNull();
  });
});
