/**
 * Durable 32/10 explicit budget through the tool host (WP-08, AC-011.8/.9).
 *
 * Evidence label: [INT-SYNTH-OP]. Real SQLite store, real loopback listeners,
 * synthetic display/interactive test ops and a fake transport double whose
 * outcomes mix acknowledged, definitive-failure and ambiguous sends. "Retry"
 * and "resume" are simulated by fresh attempts of the same generation, which
 * is exactly what the bridge does per SDK attempt; the production-op
 * AC-011.4/.9 positive controls remain WP-09 candidate gates.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardToolResult, ToolOpcode, TrustedTurnContext } from "../cards/contracts.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { encodeBootstrapFrame, parseBootstrapReply, parseReplyFrame, readFrame } from "../cards/protocol.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import { EXPLICIT_BUDGET_EXHAUSTED, MAX_EXPLICIT_INVOCATIONS, MAX_EXPLICIT_SENDS, type CardBinding, type CardStore } from "../cards/store.js";
import { createToolHost, type ExplicitOpHandler, type ExplicitTransport, type ExplicitTransportOutcome, type ToolHost } from "../cards/tool-host.js";
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

const EXHAUSTED = JSON.parse(JSON.stringify(EXPLICIT_BUDGET_EXHAUSTED)) as CardToolResult;
const DISPLAY = { blocks: [{ kind: "text", text: "hello" }] };
const INTERACTIVE = { title: "Pick", buttons: [{ id: "ok", label: "OK" }] };

function provisioned(): string {
  const root = mkdtempSync(join(tmpdir(), "wp08-budget-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  return dataDir;
}

interface Incarnation {
  readonly store: CardStore;
  readonly adapter: DbAdapter;
  readonly host: ToolHost;
  readonly time: ManualTime;
  readonly incarnation: string;
  readonly stop: () => void;
  /** Process death: the store lease and database go first, so no close fence reaches the ledger. */
  readonly crash: () => void;
}

let messageSeq = 9_000_000_000;

/** Outcome mix: every third acked send is followed by a definitive failure and then an ambiguous one. */
function mixedTransport(): ExplicitTransport & { sends: number } {
  const t = {
    sends: 0,
    async send(): Promise<ExplicitTransportOutcome> {
      const n = t.sends++;
      if (n % 3 === 1) return { kind: "failed" };
      if (n % 3 === 2) throw new Error("connection reset after write");
      return { kind: "acked", messageId: String(messageSeq++) };
    },
  };
  return t;
}

function testOp(op: ToolOpcode): ExplicitOpHandler {
  return {
    op,
    async handle(_args, c, send) {
      const binding = bindingOf(c.ctx);
      return send.reserveAndSend(op === "display"
        ? { opcode: "display", binding, bodyDigest: "d".repeat(64) }
        : { opcode: "interactive", binding, bodyDigest: "d".repeat(64),
          contract: { requesterUid: c.ctx.requesterUid, contractVersion: 1, authoredContractJson: "{}", authoredDataHash: "h".repeat(64) } });
    },
  };
}

async function incarnate(dataDir: string, transport: ExplicitTransport): Promise<Incarnation> {
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== "ready") throw new Error(sub.state);
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: cardSubsystemPaths(dataDir).cardsDir,
    ops: new Map([["display", testOp("display")], ["interactive", testOp("interactive")]]), excludedRoots: [],
    clock: time.clock, wall: time.wall, timers: time.timers, transport,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } })!;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    host.close({ reason: "shutdown", deadlineMono: time.now(), signal: AbortSignal.abort() });
    sub.store.retire();
    adapter.close();
  };
  const crash = () => {
    if (stopped) return;
    stopped = true;
    sub.store.retire();
    adapter.close();
    host.close({ reason: "shutdown", deadlineMono: time.now(), signal: AbortSignal.abort() });
  };
  cleanups.push(stop);
  return { store: sub.store, adapter, host, time, incarnation, stop, crash };
}

function bindingOf(ctx: TrustedTurnContext): CardBinding {
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: ctx.route.channelId, channelType: 1, topicScope: null,
    generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}

function context(inc: Incarnation, generation = randomUUID()): TrustedTurnContext {
  return Object.freeze({
    botRef: Object.freeze({ originKey: "https://test.invalid", credentialRef: "c".repeat(43) }),
    route: Object.freeze({ channelId: "chan", channelType: 1 }), requesterUid: "u1", sessionKey: "s1",
    turnGeneration: generation, resetEpoch: 0, policyIdentity: "c".repeat(43), runtimeIncarnation: inc.incarnation,
    injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}`,
    routeEligibility: Object.freeze({ kind: "dm" as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: "user" as const }),
  });
}

class Conn {
  private buf: Buffer = Buffer.alloc(0);
  private readonly waiting = new Map<string, (r: CardToolResult | null) => void>();
  private boot: ((b: Uint8Array | null) => void) | undefined;
  private constructor(readonly socket: Socket) {
    socket.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (;;) {
        const f = readFrame(this.buf);
        if (f.kind !== "frame") break;
        this.buf = this.buf.subarray(f.consumed);
        if (this.boot) { const b = this.boot; this.boot = undefined; b(f.body); continue; }
        const p = parseReplyFrame(f.body);
        if (!p.ok) continue;
        this.waiting.get(p.frame.request_id)?.(p.frame.result);
        this.waiting.delete(p.frame.request_id);
      }
    });
    socket.on("close", () => { for (const w of this.waiting.values()) w(null); this.waiting.clear(); this.boot?.(null); });
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
  redeem(ticket: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.boot = (b) => { const r = b && parseBootstrapReply(b); if (r) resolve(r.authority); else reject(new Error("redeem")); };
      this.socket.write(Buffer.from(encodeBootstrapFrame({ v: 1, bootstrap: ticket })));
    });
  }
  call(authority: string, op: string, args: unknown, requestId = randomBytes(16).toString("hex")): Promise<CardToolResult | null> {
    const body = Buffer.from(JSON.stringify({ v: 1, request_id: requestId, authority, op, args }));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return new Promise((resolve) => { this.waiting.set(requestId, resolve); this.socket.write(frame); });
  }
}

/** One attempt: a fresh registration, redeemed, with `n` connections. */
async function attempt(gen: NonNullable<ReturnType<ToolHost["openGeneration"]>>, n = 1) {
  const h = (await gen.launch.prepareAttempt())!;
  const args = h.mcpEntry.args as string[];
  const port = Number(args[4]);
  const first = await Conn.open(port);
  const authority = await first.redeem(readFileSync(args[2] as string, "utf8"));
  const conns = [first];
  for (let i = 1; i < n; i++) conns.push(await Conn.open(port));
  return { h, authority, conns, port };
}

function counts(adapter: DbAdapter, generation: string) {
  const g = adapter.prepare("SELECT state, invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?")
    .get(generation) as { state: string; inv: number; sends: number };
  const rows = adapter.prepare("SELECT state, send_slot FROM card_explicit_requests WHERE generation = ?").all(generation) as { state: string; send_slot: number | null }[];
  return { ...g, rows };
}

function open(inc: Incarnation, ctx = context(inc)) {
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  const gen = inc.host.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: inc.time.now() + 600_000, currentResetEpoch: () => 0,
    ops: ["display", "interactive"], admit: gateway.admit });
  if (gen === undefined) throw new Error("no generation");
  return gen;
}

describe("32 invocations / 10 logical sends per handler generation (AC-011.9)", () => {
  it("≥128 concurrent mixed new-ID calls never exceed 32 charges or 10 sends; the rest get the exact exhaustion diagnostic", async () => {
    const transport = mixedTransport();
    const inc = await incarnate(provisioned(), transport);
    const gen = open(inc);
    const { authority, conns } = await attempt(gen, 8);
    const kinds = ["display", "interactive", "display-invalid", "interactive-invalid"] as const;
    const calls: Promise<CardToolResult | null>[] = [];
    for (let i = 0; i < 128; i++) {
      const kind = kinds[i % kinds.length] as (typeof kinds)[number];
      const conn = conns[i % conns.length] as Conn;
      if (kind === "display") calls.push(conn.call(authority, "display", DISPLAY));
      else if (kind === "interactive") calls.push(conn.call(authority, "interactive", INTERACTIVE));
      else if (kind === "display-invalid") calls.push(conn.call(authority, "display", { blocks: [{ kind: "text", text: "x" }], channel_id: "c" }));
      else calls.push(conn.call(authority, "interactive", { title: "t", buttons: [], routing: "x" }));
    }
    const results = await Promise.all(calls);
    expect(results.every((r) => r !== null)).toBe(true);
    const c = counts(inc.adapter, gen.launch.generation);
    expect(c.inv).toBe(MAX_EXPLICIT_INVOCATIONS);
    expect(c.rows).toHaveLength(32);
    expect(c.sends).toBeLessThanOrEqual(MAX_EXPLICIT_SENDS);
    expect(c.rows.filter((r) => r.send_slot !== null)).toHaveLength(c.sends);
    expect(new Set(c.rows.filter((r) => r.send_slot !== null).map((r) => r.send_slot)).size).toBe(c.sends);
    expect(transport.sends).toBe(c.sends);
    const exhausted = results.filter((r) => JSON.stringify(r) === JSON.stringify(EXHAUSTED));
    expect(exhausted.length).toBeGreaterThanOrEqual(128 - 32);
    // Failed and ambiguous sends keep their slots: nothing is refunded.
    expect(c.rows.filter((r) => (r.state === "failed" || r.state === "ambiguous") && r.send_slot !== null).length).toBeGreaterThan(0);
  });

  it("exhaustion of the 10 sends is exact and survives failed and ambiguous outcomes", async () => {
    const transport: ExplicitTransport = { async send() { throw new Error("reset"); } };
    const inc = await incarnate(provisioned(), transport);
    const gen = open(inc);
    const { authority, conns } = await attempt(gen);
    const results: (CardToolResult | null)[] = [];
    for (let i = 0; i < 12; i++) results.push(await (conns[0] as Conn).call(authority, "display", DISPLAY));
    expect(results.slice(0, 10).every((r) => JSON.stringify(r) === '{"status":"error","error":{"code":"send_unconfirmed"}}')).toBe(true);
    expect(results.slice(10)).toEqual([EXHAUSTED, EXHAUSTED]);
    expect(counts(inc.adapter, gen.launch.generation)).toMatchObject({ inv: 12, sends: 10 });
  });

  it("rotation, reconnect and simulated fresh retry/resume never refund or reset the counts", async () => {
    const inc = await incarnate(provisioned(), mixedTransport());
    const gen = open(inc);
    let total = 0;
    for (let a = 0; a < 4; a++) {
      const { authority, conns, port } = await attempt(gen, 2);
      for (let i = 0; i < 10; i++) {
        const r = await (conns[i % 2] as Conn).call(authority, i % 2 === 0 ? "display" : "interactive", i % 2 === 0 ? DISPLAY : INTERACTIVE);
        expect(r).not.toBeNull();
        total++;
      }
      // Reconnect inside the same attempt: a new connection with the same authority.
      const extra = await Conn.open(port);
      expect(await extra.call(authority, "display", { blocks: [{ kind: "text", text: "reconnect" }] })).not.toBeNull();
      total++;
    }
    const c = counts(inc.adapter, gen.launch.generation);
    expect(total).toBe(44);
    expect(c.inv).toBe(32);
    expect(c.sends).toBe(10);
  });

  it("an identical retried request id joins its retained outcome and charges nothing", async () => {
    const inc = await incarnate(provisioned(), mixedTransport());
    const gen = open(inc);
    const { authority, conns } = await attempt(gen);
    const id = randomBytes(16).toString("hex");
    const first = await (conns[0] as Conn).call(authority, "display", DISPLAY, id);
    const again = await attempt(gen);
    expect(await (again.conns[0] as Conn).call(again.authority, "display", DISPLAY, id)).toEqual(first);
    expect(counts(inc.adapter, gen.launch.generation)).toMatchObject({ inv: 1, sends: 1 });
  });

  it("restart closes the old incarnation's live generation before any host exists; nothing restores or refunds", async () => {
    const dataDir = provisioned();
    const old = await incarnate(dataDir, mixedTransport());
    const ctx = context(old);
    const gen = open(old, ctx);
    const { authority, conns, port } = await attempt(gen);
    for (let i = 0; i < 5; i++) await (conns[0] as Conn).call(authority, "display", DISPLAY);
    const before = counts(old.adapter, gen.launch.generation);
    expect(before).toMatchObject({ state: "live", inv: 5, sends: 5 });
    // Process restart: the old process is gone without a clean close.
    old.crash();
    const peek = createAdapter(join(dataDir, "cc-octo.db"));
    expect(counts(peek, gen.launch.generation)).toMatchObject({ state: "live", inv: 5, sends: 5 });
    peek.close();
    const next = await incarnate(dataDir, mixedTransport());
    expect(counts(next.adapter, gen.launch.generation)).toMatchObject({ state: "closed", inv: 5, sends: 5 });
    // The old listener does not exist; the same generation cannot be re-registered.
    await expect(Conn.open(port)).rejects.toThrow();
    expect(next.host.openGeneration({ ctx: { ...ctx, runtimeIncarnation: next.incarnation }, binding: bindingOf(ctx),
      expiresAtMono: next.time.now() + 1000, currentResetEpoch: () => 0, ops: ["display"], admit: () => true })).toBeUndefined();
    expect(counts(next.adapter, gen.launch.generation)).toMatchObject({ state: "closed", inv: 5, sends: 5 });
  });
});
