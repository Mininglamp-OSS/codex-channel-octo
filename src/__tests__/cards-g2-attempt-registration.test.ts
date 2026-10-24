/**
 * E9′ regression guard G2: one redeeming `initialize` per attempt registration
 * (WP09-PF v3 §3 as amended by v3.1 N-e).
 *
 * Evidence label: [UNIT]/[INT-SYNTH-OP]. The real proxy (`runMcpProxy`, the
 * packaged module run in-process) and raw loopback doubles redeem against a
 * real host admitted through the real G-d path. For every attempt
 * registration exactly one redemption carries authority; every other
 * `initialize` in the process (a forced child, a respawn, a stale ticket, an
 * overlapping launch) is ticketless and inert, case-4 zero state, or a
 * pre-request case-2 revoke, and none of them changes the ledger. This is a
 * guard on the gateway side only: it does not mark E9′ not applicable.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { CardToolResult, TrustedTurnContext } from "../cards/contracts.js";
import { runMcpProxy } from "../cards/mcp-server.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { encodeBootstrapFrame, parseBootstrapReply, parseReplyFrame, readFrame } from "../cards/protocol.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import type { CardBinding } from "../cards/store.js";
import { createToolHost, type AttemptHandle, type ExplicitGeneration, type ExplicitOpHandler, type ToolHost } from "../cards/tool-host.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, type ManualTime } from "./fixtures/card-write-harness.js";
import { admissibleGateway } from "./fixtures/gd-admit.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const DISPLAY = { blocks: [{ kind: "text", text: "hello" }] };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0.163.0" } };

const displayOp: ExplicitOpHandler = {
  op: "display",
  async handle(_args, c, send) {
    const binding: CardBinding = { sessionKey: c.ctx.sessionKey, channelId: c.ctx.route.channelId, channelType: 1, topicScope: null,
      generation: c.ctx.turnGeneration, resetEpoch: c.ctx.resetEpoch };
    return send.reserveAndSend({ opcode: "display", binding, bodyDigest: "d".repeat(64) });
  },
};

interface Rig {
  readonly host: ToolHost;
  readonly adapter: DbAdapter;
  readonly time: ManualTime;
  readonly gen: ExplicitGeneration;
}

async function rig(): Promise<Rig> {
  const dataDir = join(mkdtempSync(join(tmpdir(), "g2-")), "data");
  roots.push(join(dataDir, ".."));
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== "ready") throw new Error(sub.state);
  let seq = 5_000_000_000;
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir,
    ops: new Map([["display", displayOp]]), excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers,
    transport: { async send() { return { kind: "acked", messageId: String(seq++) }; } },
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } })!;
  cleanups.push(() => { host.close({ reason: "shutdown", deadlineMono: time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  const ctx: TrustedTurnContext = Object.freeze({
    botRef: { originKey: "https://test.invalid", credentialRef: "c".repeat(43) }, route: { channelId: "chan", channelType: 1 },
    requesterUid: "u1", sessionKey: "s1", turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: "c".repeat(43),
    runtimeIncarnation: incarnation, injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}`,
    routeEligibility: { kind: "dm" as const, obo: false, docTask: false, cron: false }, origin: { kind: "user" as const },
  });
  const gen = host.openGeneration({ ctx, binding: { sessionKey: "s1", channelId: "chan", channelType: 1, topicScope: null,
    generation: ctx.turnGeneration, resetEpoch: 0 }, expiresAtMono: time.now() + 600_000, currentResetEpoch: () => 0,
  ops: ["display"], admit: gateway.admit })!;
  return { host, adapter, time, gen };
}

async function attempt(r: Rig): Promise<{ h: AttemptHandle; argv: string[]; ticketPath: string; port: number }> {
  const h = (await r.gen.launch.prepareAttempt())!;
  expect(h).toBeDefined();
  const args = h.mcpEntry.args as string[];
  return { h, argv: args.slice(1), ticketPath: args[2] as string, port: Number(args[4]) };
}

/** The packaged proxy over in-memory stdio, as Codex launches it from the merged entry. */
function proxy(argv: readonly string[]) {
  const stdin = new PassThrough();
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const done = runMcpProxy({ argv, stdin, write: (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === "number") waiters.get(msg.id)?.(msg);
  }, ...(uid !== undefined ? { uid } : {}) });
  let id = 0;
  const request = (method: string, params: unknown = {}) => {
    const n = ++id;
    const p = new Promise<Record<string, unknown>>((resolve) => waiters.set(n, resolve));
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    return p;
  };
  const tools = async () => ((await request("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
  const call = async () => ((await request("tools/call", { name: "display", arguments: DISPLAY })).result as { structuredContent: CardToolResult }).structuredContent;
  cleanups.push(() => stdin.destroy());
  return { request, tools, call, end: async () => { stdin.end(); await done; } };
}

/** Raw loopback double for one proxy connection. */
class Conn {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: ((b: Uint8Array | null) => void)[] = [];
  private constructor(readonly socket: Socket) {
    socket.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (;;) {
        const f = readFrame(this.buf);
        if (f.kind !== "frame") break;
        this.buf = this.buf.subarray(f.consumed);
        this.waiters.shift()?.(f.body);
      }
    });
    socket.on("close", () => { for (const w of this.waiters.splice(0)) w(null); });
    socket.on("error", () => { /* close follows */ });
    cleanups.push(() => socket.destroy());
  }
  static open(port: number): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port });
      s.once("connect", () => resolve(new Conn(s)));
      s.once("error", reject);
    });
  }
  /** Write `bytes`; resolve with the next frame body, or null when the host closes the connection first. */
  send(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (this.socket.destroyed) return Promise.resolve(null);
    const wait = new Promise<Uint8Array | null>((resolve) => this.waiters.push(resolve));
    this.socket.write(Buffer.from(bytes));
    return wait;
  }
}

const bootstrapFrame = (ticket: string) => encodeBootstrapFrame({ v: 1, bootstrap: ticket });

function callFrame(authority: string): Buffer {
  const body = Buffer.from(JSON.stringify({ v: 1, request_id: randomBytes(16).toString("hex"), authority, op: "display", args: DISPLAY }), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function ledger(r: Rig) {
  return {
    generation: r.adapter.prepare("SELECT state, invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?")
      .get(r.gen.launch.generation),
    requests: r.adapter.prepare("SELECT request_id, state, send_slot FROM card_explicit_requests WHERE generation = ? ORDER BY request_id")
      .all(r.gen.launch.generation),
  };
}

describe("G2: exactly one redeeming initialize per attempt registration", () => {
  it("fresh start: the proxy redeems once and gets the authority; a respawn on the same entry is ticketless and inert", async () => {
    const r = await rig();
    const a = await attempt(r);
    const first = proxy(a.argv);
    await first.request("initialize", INIT);
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapReplay: 0, bootstrapUnknown: 0, liveRegistrations: 1 });
    expect(existsSync(a.ticketPath)).toBe(false);
    expect(await first.tools()).toEqual(["display"]);
    const before = ledger(r);
    // A respawn (closed connection, reconcile during startup, changed identity) launches the same command and args.
    const respawn = proxy(a.argv);
    await respawn.request("initialize", INIT);
    expect(await respawn.tools()).toEqual([]);
    expect(await respawn.call()).toEqual({ status: "error", error: { code: "unavailable" } });
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapReplay: 0, bootstrapUnknown: 0, authRejected: 0, liveRegistrations: 1 });
    expect(ledger(r)).toEqual(before);
    // The first proxy keeps its authority.
    expect(await first.call()).toMatchObject({ status: "sent" });
    await respawn.end();
    await first.end();
  });

  it("forced child spawn: a child session's initialize on the parent entry is inert and leaves the ledger alone", async () => {
    const r = await rig();
    const a = await attempt(r);
    const parent = proxy(a.argv);
    await parent.request("initialize", INIT);
    const before = ledger(r);
    const children = [proxy(a.argv), proxy(a.argv)];
    for (const child of children) {
      await child.request("initialize", INIT);
      expect(await child.tools()).toEqual([]);
    }
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapReplay: 0, bootstrapUnknown: 0, authRejected: 0 });
    expect(ledger(r)).toEqual(before);
    expect(await parent.call()).toMatchObject({ status: "sent" });
    for (const child of children) await child.end();
    await parent.end();
  });

  it("retry rotation: the new registration redeems once; the earlier attempt's ticket gets case-4 zero state", async () => {
    const r = await rig();
    const first = await attempt(r);
    const staleTicket = readFileSync(first.ticketPath, "utf8");
    const p1 = proxy(first.argv);
    await p1.request("initialize", INIT);
    expect(r.host.stats().bootstrapRedeemed).toBe(1);
    const second = await attempt(r);
    expect(second.port).not.toBe(first.port);
    expect(await p1.call()).toEqual({ status: "error", error: { code: "unavailable" } });
    const before = ledger(r);
    const stale = await Conn.open(second.port);
    expect(await stale.send(bootstrapFrame(staleTicket))).toBeNull();
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapUnknown: 1, bootstrapReplay: 0, liveRegistrations: 1 });
    expect(ledger(r)).toEqual(before);
    const p2 = proxy(second.argv);
    await p2.request("initialize", INIT);
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 2, bootstrapReplay: 0 });
    expect(await p2.call()).toMatchObject({ status: "sent" });
    await p1.end();
    await p2.end();
  });

  it("resume: a new attempt process gets a new registration and ticket; the closed attempt's proxy has no authority left", async () => {
    const r = await rig();
    const first = await attempt(r);
    const p1 = proxy(first.argv);
    await p1.request("initialize", INIT);
    expect(await p1.call()).toMatchObject({ status: "sent" });
    // The attempt process exits; the bridge closes its registration, and resume starts a fresh one.
    first.h.close();
    const resumed = await attempt(r);
    expect(resumed.ticketPath).not.toBe(first.ticketPath);
    const before = ledger(r);
    expect(await p1.call()).toEqual({ status: "error", error: { code: "unavailable" } });
    expect(ledger(r)).toEqual(before);
    const p2 = proxy(resumed.argv);
    await p2.request("initialize", INIT);
    const respawn = proxy(resumed.argv);
    await respawn.request("initialize", INIT);
    expect(await respawn.tools()).toEqual([]);
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 2, bootstrapReplay: 0, bootstrapUnknown: 0 });
    expect(await p2.call()).toMatchObject({ status: "sent" });
    for (const p of [p1, p2, respawn]) await p.end();
  });

  it("overlap: two launches read the ticket before either unlinks; one case-1 redeem, then a pre-request case-2 revoke with ledger Δ0", async () => {
    const r = await rig();
    const a = await attempt(r);
    // Both launches open the ticket inside the first one's open-then-unlink window.
    const ticket = readFileSync(a.ticketPath, "utf8");
    const before = ledger(r);
    const first = await Conn.open(a.port);
    const second = await Conn.open(a.port);
    const firstReply = await first.send(bootstrapFrame(ticket));
    expect(firstReply).not.toBeNull();
    const redeemed = parseBootstrapReply(firstReply!)!;
    expect(redeemed.authority).toMatch(/^[0-9a-f]{64}$/);
    expect(redeemed.ops).toEqual(["display"]);
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapReplay: 0, liveRegistrations: 1 });
    // The overlapping launch redeems the same ticket. A call carrying the first proxy's authority
    // arrives on the registration right behind it.
    const replay = Buffer.concat([Buffer.from(bootstrapFrame(ticket)), callFrame(redeemed.authority)]);
    expect(await second.send(replay)).toBeNull();
    expect(r.host.stats()).toMatchObject({ bootstrapRedeemed: 1, bootstrapReplay: 1, authRejected: 1, liveRegistrations: 0, liveListeners: 0 });
    // The first proxy's own later call gets no tool reply: its registration is revoked.
    const late = await first.send(callFrame(redeemed.authority));
    expect(late === null ? null : parseReplyFrame(late)).toBeNull();
    expect(ledger(r)).toEqual(before);
    expect(ledger(r).requests).toEqual([]);
    expect(r.gen.live).toBe(true);
  });
});
