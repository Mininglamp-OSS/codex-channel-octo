/**
 * WP-13A-2: automatic card restart recovery (DTI-2.1 §4, RWS-v3 NB-2).
 *
 * Every case runs the production path: `openCardRuntime` over a provisioned
 * Bot whose card store is a real SQLite file in WAL mode. Two kinds of restart
 * are used, and each test says which one it uses:
 * - in-process restart: the previous adapter, store, queue and runtime are
 *   abandoned without `close()` and their manual clock never runs again; a
 *   new adapter and runtime open the same file, so only committed rows
 *   survive. This is not an operating-system process kill;
 * - process kill: a child process opens the same Bot from the real source
 *   (transpiled on load, no build needed) and is killed with SIGKILL at a
 *   named point.
 *
 * Faults at an exact store boundary (a method that throws once) stand in for
 * a kill at that boundary; the durable row they leave is asserted directly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CardObservableEvent, ItemState, SafeProgram } from "../cards/contracts.js";
import { provisionFirstInstallMarker, serializeIntentLegacy } from "../cards/migrations.js";
import {
  cardSubsystemPaths,
  classifyAutomaticRow,
  prepareAutomaticRecovery,
  scanAutomaticRecovery,
  type AutomaticRecoveryReport,
  type AutomaticRecoveryResult,
} from "../cards/recovery.js";
import { openCardRuntime, type CardRuntime } from "../cards/runtime.js";
import { CardStore, type CardBinding, type CardMessageRecord, type LiveAutomaticCard } from "../cards/store.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { profile } from "./fixtures/card-profile.js";
import { json, manualTime, scriptedFetch, seqOf, type ManualTime, type ScriptedReply } from "./fixtures/card-write-harness.js";

const API = "https://api.example.com";
const TEMPLATE_ID = "ai.reasoning-process";
const TEMPLATE_VERSION = "0.4.0";
const HOUR = 3_600_000;

const roots: string[] = [];
const handles: DbAdapter[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const a of handles.splice(0)) { try { a.close(); } catch { /* already closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ─── Bot harness ────────────────────────────────────────────────────────────

type ProfileReply = "ok" | "unavailable" | "card_disabled" | { readonly templateVersion?: string; readonly templateId?: string };

function profileResponse(reply: ProfileReply): Response {
  if (reply === "ok") return json(200, profile());
  if (reply === "unavailable") return json(503, {});
  if (reply === "card_disabled") {
    const p = profile();
    return json(200, { ...p, config: { ...p.config, card_enabled: false } });
  }
  const id = reply.templateId ?? TEMPLATE_ID;
  const version = reply.templateVersion ?? TEMPLATE_VERSION;
  const p = profile();
  return json(200, {
    ...p,
    config: { ...p.config, reasoning_template_ref: { id, version } },
    templating: { ...p.templating, templates: p.templating.templates.map((t) => ({ ...t, id, version })) },
  });
}

interface Incarnation {
  readonly adapter: DbAdapter;
  readonly time: ManualTime;
  readonly net: ReturnType<typeof scriptedFetch>;
  readonly runtime: CardRuntime | undefined;
  readonly profileReads: () => number;
}

interface StartOptions {
  readonly profile?: ProfileReply;
  readonly script?: readonly ScriptedReply[];
}

/** One provisioned Bot over one SQLite file; every `start()` is a new incarnation that never closes the previous one. */
function bot(name = "bot") {
  const root = mkdtempSync(join(tmpdir(), `wp13a2-${name}-`));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  const dbPath = join(dataDir, "cc-octo.db");
  const nets: ReturnType<typeof scriptedFetch>[] = [];
  let starts = 0;

  function adapter(): DbAdapter {
    const a = createAdapter(dbPath);
    handles.push(a);
    new SessionStore(a).init();
    return a;
  }

  return {
    dataDir,
    dbPath,
    /** Every card edit sent by any incarnation of this Bot. */
    edits: () => nets.flatMap((n) => n.edits()),
    sends: () => nets.flatMap((n) => n.sends()),
    async start(o: StartOptions = {}): Promise<Incarnation> {
      const a = adapter();
      const time = manualTime(1_000, Date.UTC(2026, 9, 22, 6) + starts++ * HOUR);
      const net = scriptedFetch(time);
      nets.push(net);
      if (o.script !== undefined) net.reply(...o.script);
      let reads = 0;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(input)).pathname.endsWith("/v1/bot/card/profile")) {
          reads++;
          return profileResponse(o.profile ?? "ok");
        }
        return net.fetchImpl(input, init);
      }) as typeof fetch;
      const runtime = await openCardRuntime({ adapter: a, dataDir, apiUrl: API, botToken: "token-a",
        clock: time.clock, wall: time.wall, timers: time.timers, fetchImpl });
      return { adapter: a, time, net, runtime, profileReads: () => reads };
    },
    /** A direct store over its own (abandoned) adapter, for crafting and reading rows. */
    store(): CardStore {
      return new CardStore(adapter(), { clock: { nowUtcMs: () => Date.UTC(2026, 9, 22, 5) }, newId: () => `card-${randomUUID()}` });
    },
    raw(id: string): Record<string, unknown> | undefined {
      return adapter().prepare("SELECT * FROM card_messages WHERE card_id = ?").get(id) as Record<string, unknown> | undefined;
    },
    markLegacy(ids: readonly string[]): void {
      adapter().prepare("UPDATE card_meta SET v = ? WHERE k = 'intent_legacy'").run(serializeIntentLegacy(ids));
    },
  };
}
type Bot = ReturnType<typeof bot>;

/** Let an incarnation's queued work run, then collect its recovery result. */
async function recovered(inc: Incarnation): Promise<AutomaticRecoveryResult> {
  expect(inc.runtime).toBeDefined();
  await inc.time.advance(0);
  await inc.time.advance(1_000);
  return await (inc.runtime as CardRuntime).recovery;
}

function okReport(result: AutomaticRecoveryResult): AutomaticRecoveryReport {
  if (result.scan !== "ok") throw new Error("scan failed");
  const r = result.report;
  // The §4.3 invariant holds for every report.
  expect(r.scanned).toBe(r.restored + r.rolledForward + r.uncertain + r.legacy + r.deferred + r.failed);
  return r;
}

const ZERO: AutomaticRecoveryReport = { scanned: 0, restored: 0, rolledForward: 0, uncertain: 0, legacy: 0, deferred: 0, failed: 0 };
const report = (over: Partial<AutomaticRecoveryReport>): AutomaticRecoveryReport => ({ ...ZERO, ...over });

/** First start: creates the v2 schema on an empty store and closes cleanly. */
async function install(b: Bot): Promise<void> {
  const inc = await b.start();
  expect(okReport(await recovered(inc))).toEqual(ZERO);
  await inc.runtime?.close("shutdown");
}

// ─── Row crafting through the real store primitives ────────────────────────

const BINDING: CardBinding = { sessionKey: "group:g1", channelId: "g1", channelType: 2, topicScope: null, generation: "gen-1", resetEpoch: 0 };
let messageNo = 0;

function reserved(store: CardStore, over: { kind?: "automatic" | "display"; templateVersion?: string; binding?: Partial<CardBinding> } = {}): string {
  const r = store.reserveMessage({ kind: over.kind ?? "automatic", binding: { ...BINDING, ...over.binding }, bodyDigest: "digest",
    clientMsgNo: randomUUID(), templateId: TEMPLATE_ID, templateVersion: over.templateVersion ?? TEMPLATE_VERSION });
  if (r.kind !== "reserved") throw new Error("reservation failed");
  return r.cardId;
}

/** A bound live row as left by an acknowledged initial send (S = A = 0). */
function bound(store: CardStore, over: Parameters<typeof reserved>[1] = {}): string {
  const id = reserved(store, over);
  const r = store.ackMessage({ cardId: id, messageId: `7${String(++messageNo).padStart(17, "0")}`, currentResetEpoch: 0, policyAllows: true });
  if (r.kind !== "bound") throw new Error("bind failed");
  return id;
}

/** Acknowledged progress edits: S = A = n. */
function progressed(store: CardStore, n = 1, over: Parameters<typeof reserved>[1] = {}): string {
  const id = bound(store, over);
  for (let i = 1; i <= n; i++) {
    expect(store.reserveSequence(id)).toEqual({ kind: "reserved", seq: i });
    expect(store.ackSequence(id, i)).toMatchObject({ kind: "acked" });
  }
  return id;
}

const shapes = {
  c0a: (s: CardStore) => progressed(s, 1),
  c0aUnedited: (s: CardStore) => bound(s),
  c0b: (s: CardStore) => { const id = progressed(s, 1); expect(s.reserveSequence(id)).toEqual({ kind: "reserved", seq: 2 }); return id; },
  c1: (s: CardStore, reason: "completed" | "failed" | "interrupted" = "completed") => {
    const id = progressed(s, 1);
    expect(s.reserveTerminalSequence(id, reason)).toEqual({ kind: "reserved", seq: 2 });
    expect(s.ackSequence(id, 2)).toMatchObject({ kind: "acked" });
    return id;
  },
  c2: (s: CardStore) => {
    const id = progressed(s, 1);
    expect(s.reserveTerminalSequence(id, "failed")).toEqual({ kind: "reserved", seq: 2 });
    return id;
  },
};

function row(b: Bot, id: string): CardMessageRecord {
  return b.store().getMessage(id) as CardMessageRecord;
}

// ─── Lifecycle events for real turns ────────────────────────────────────────

let itemSeq = 0;
const ATTEMPT: CardObservableEvent = { kind: "attempt_start", attempt: 0, reason: "initial", continues: null };
const cmd = (id: string, phase: ItemState["phase"] = "started", status?: ItemState["status"]): ItemState => ({
  kind: "item_state", attempt: 0, itemId: id, seq: itemSeq++, itemType: "command_execution", phase,
  ...(status ? { status } : {}), safe: { category: "command", program: "git" as SafeProgram },
});
const TURN = { dispatchId: "d-1", sessionKey: "group:g1", channelId: "g1", channelType: 2, requesterUid: "u1", resetEpoch: 0, cron: false };

/** A real turn that sent its card and one acknowledged progress edit; returns the store card id. */
async function turnWithAckedProgress(inc: Incarnation, dispatchId = "d-1") {
  const runtime = inc.runtime as CardRuntime;
  await inc.time.advance(0);
  const turn = runtime.beginTurn({ ...TURN, dispatchId });
  if (turn === undefined) throw new Error("no coordinator");
  turn.observe(ATTEMPT);
  turn.observe(cmd(`${dispatchId}-a`));
  await inc.time.advance(800);
  turn.observe(cmd(`${dispatchId}-a`, "completed", "completed"));
  await inc.time.advance(800);
  expect(inc.net.sends()).toHaveLength(1);
  // Only this turn's card: a recovery closure of a crafted row (message ids "7…") may share the transport.
  expect(inc.net.edits().filter((e) => !String(JSON.parse(e.body).message_id).startsWith("7")).map(seqOf)).toEqual([1]);
  return turn;
}

function liveIds(b: Bot): string[] {
  return b.store().liveAutomaticCards().map((c) => c.record.cardId);
}

// ─── Classification (pure) ──────────────────────────────────────────────────

describe("classification of live automatic rows (DTI-2.1 §4)", () => {
  const card = (r: Partial<CardMessageRecord>, legacy = false): LiveAutomaticCard =>
    ({ legacy, record: { terminalIntent: null, seqReserved: 0, seqAcked: 0, ...r } as CardMessageRecord });

  it("maps every reviewed shape to exactly one class", () => {
    expect(classifyAutomaticRow(card({ seqReserved: 0, seqAcked: 0 }))).toBe("c0a");
    expect(classifyAutomaticRow(card({ seqReserved: 3, seqAcked: 3 }))).toBe("c0a");
    expect(classifyAutomaticRow(card({ seqReserved: 3, seqAcked: 2 }))).toBe("c0b");
    expect(classifyAutomaticRow(card({ seqReserved: 2, seqAcked: 2, terminalIntent: "completed" }))).toBe("c1");
    expect(classifyAutomaticRow(card({ seqReserved: 2, seqAcked: 1, terminalIntent: "failed" }))).toBe("c2");
    expect(classifyAutomaticRow(card({ seqReserved: 2, seqAcked: 2 }, true))).toBe("legacy");
  });

  it("shapes outside the matrix fall into a retained class, never into C0a or C1", () => {
    // An intent with S = 0 (refused by the startup invariant) and A > S (refused by the schema CHECK).
    expect(classifyAutomaticRow(card({ seqReserved: 0, seqAcked: 0, terminalIntent: "interrupted" }))).toBe("c2");
    expect(classifyAutomaticRow(card({ seqReserved: 1, seqAcked: 2 }))).toBe("c0b");
    expect(classifyAutomaticRow(card({ seqReserved: 1, seqAcked: 2, terminalIntent: "failed" }))).toBe("c2");
    expect(classifyAutomaticRow({ legacy: undefined as unknown as boolean, record: { terminalIntent: null, seqReserved: 0, seqAcked: 0 } as CardMessageRecord })).toBe("legacy");
  });
});

// ─── Class matrix through the production path ──────────────────────────────

describe("restart recovery over every class (production path, in-process restart)", () => {
  it("C0a gets exactly one Error/interrupted edit; C1 rolls forward with no transport; C0b, C2, legacy, N2, terminal and display rows are untouched", async () => {
    const b = bot();
    await install(b);
    const s = b.store();
    const c0a = shapes.c0a(s);
    const c0aUnedited = shapes.c0aUnedited(s);
    const c0b = shapes.c0b(s);
    const c1 = shapes.c1(s, "completed");
    const c1Failed = shapes.c1(s, "failed");
    const c2 = shapes.c2(s);
    const legacy = progressed(s, 1);
    const sending = reserved(s);
    const ambiguous = reserved(s);
    s.markSendAmbiguous(ambiguous);
    const terminal = progressed(s, 1);
    expect(s.markTerminal(terminal, "completed")).toEqual({ kind: "updated" });
    const display = bound(s, { kind: "display" });
    b.markLegacy([legacy]);
    const frozen = [c0b, c2, legacy, sending, ambiguous, terminal, display].map((id) => [id, b.raw(id)] as const);
    const c1Before = b.raw(c1);

    const inc = await b.start();
    const result = okReport(await recovered(inc));
    expect(result).toEqual(report({ scanned: 7, restored: 2, rolledForward: 2, uncertain: 2, legacy: 1 }));

    // Exactly one edit per C0a row, each at S+1, both minimal Error/interrupted closures; nothing else on the wire.
    expect(b.sends()).toHaveLength(0);
    const edits = inc.net.edits();
    expect(edits).toHaveLength(2);
    const byMessage = new Map(edits.map((e) => [JSON.parse(e.body).message_id as string, e]));
    for (const [id, seq] of [[c0a, 2], [c0aUnedited, 1]] as const) {
      const r = row(b, id);
      const e = byMessage.get(r.messageId as string);
      expect(e).toBeDefined();
      expect(seqOf(e!)).toBe(seq);
      expect(e!.body).toContain('"error"');
      expect(e!.body).not.toContain('"completed"');
      expect(r).toMatchObject({ state: "error", terminalReason: "interrupted", terminalIntent: null, seqReserved: seq, seqAcked: seq });
    }
    // C1: the durable intent is recorded exactly, locally.
    expect(row(b, c1)).toMatchObject({ state: "done", terminalReason: "completed", seqReserved: 2, seqAcked: 2 });
    expect(row(b, c1Failed)).toMatchObject({ state: "error", terminalReason: "failed", seqReserved: 2, seqAcked: 2 });
    expect(c1Before).toMatchObject({ state: "active", terminal_reason: "completed", terminal_at: null });
    // Retained, N2, terminal and display rows are byte-identical.
    for (const [id, before] of frozen) expect(b.raw(id)).toEqual(before);

    // Two more restarts: nothing further is sent and the retained rows stay exactly as they were.
    for (let i = 0; i < 2; i++) {
      const again = await b.start();
      expect(okReport(await recovered(again))).toEqual(report({ scanned: 3, uncertain: 2, legacy: 1 }));
      expect(again.net.requests.filter((r) => !r.path.endsWith("/v1/bot/card/profile"))).toHaveLength(0);
      for (const [id, before] of frozen) expect(b.raw(id)).toEqual(before);
    }
    expect(b.edits()).toHaveLength(2);
    expect(liveIds(b).sort()).toEqual([c0b, c2, legacy].sort());
  });

  it("with no live automatic row the policy is not read for recovery and nothing is written", async () => {
    const b = bot();
    await install(b);
    const inc = await b.start();
    expect(okReport(await recovered(inc))).toEqual(ZERO);
    expect(inc.net.requests).toHaveLength(0);
  });
});

// ─── Preconditions P1–P5 ────────────────────────────────────────────────────

describe("policy and template preconditions defer with zero writes, then a matching policy restores (P1–P5)", () => {
  const cases: [string, ProfileReply][] = [
    ["profile unavailable", "unavailable"],
    ["cards disabled", "card_disabled"],
    ["template version differs from the row", { templateVersion: "0.5.0" }],
    ["template id differs from the row", { templateId: "ai.reasoning-other" }],
  ];
  for (const [name, reply] of cases) {
    it(`${name}: deferred, no grant and no write; a later start with the matching template sends exactly one edit`, async () => {
      const b = bot();
      await install(b);
      const id = shapes.c0a(b.store());
      const before = b.raw(id);

      const denied = await b.start({ profile: reply });
      expect(okReport(await recovered(denied))).toEqual(report({ scanned: 1, deferred: 1 }));
      expect(b.edits()).toHaveLength(0);
      expect(b.raw(id)).toEqual(before);

      const allowed = await b.start();
      expect(okReport(await recovered(allowed))).toEqual(report({ scanned: 1, restored: 1 }));
      expect(b.edits().map(seqOf)).toEqual([2]);
      expect(row(b, id)).toMatchObject({ state: "error", terminalReason: "interrupted" });
    });
  }

  it("a row whose own template is no longer current stays deferred across restarts and is never closed with another template", async () => {
    const b = bot();
    await install(b);
    const id = shapes.c0a(b.store());
    const old = progressed(b.store(), 1, { templateVersion: "0.3.0" });
    const inc = await b.start();
    expect(okReport(await recovered(inc))).toEqual(report({ scanned: 2, restored: 1, deferred: 1 }));
    expect(inc.net.edits()).toHaveLength(1);
    expect(JSON.parse(inc.net.edits()[0].body).message_id).toBe(row(b, id).messageId);
    expect(row(b, old)).toMatchObject({ state: "active", seqReserved: 1, seqAcked: 1, terminalIntent: null });
    const again = await b.start();
    expect(okReport(await recovered(again))).toEqual(report({ scanned: 1, deferred: 1 }));
    expect(b.edits()).toHaveLength(1);
  });

  it("prepare reads the policy before any grant: a throwing snapshot defers every C0a row", async () => {
    const b = bot();
    await install(b);
    shapes.c0a(b.store());
    shapes.c0aUnedited(b.store());
    const scan = scanAutomaticRecovery(b.store());
    expect(scan.candidates).toHaveLength(2);
    const authorize = vi.fn();
    const prepared = await prepareAutomaticRecovery(scan, {
      botRef: { originKey: "o", credentialRef: "c" }, eligible: () => true, nowUtcMs: () => 0, newId: () => "x",
      policy: { snapshot: () => Promise.reject(new Error("boom")), authorize },
    });
    expect(prepared.closures).toEqual([]);
    expect(prepared.counts).toMatchObject({ scanned: 2, deferred: 2 });
    expect(authorize).not.toHaveBeenCalled();
    const gated = await prepareAutomaticRecovery(scan, {
      botRef: { originKey: "o", credentialRef: "c" }, eligible: () => false, nowUtcMs: () => 0, newId: () => "x",
      policy: { snapshot: vi.fn(), authorize },
    });
    expect(gated.counts).toMatchObject({ scanned: 2, deferred: 2 });
  });
});

// ─── C1 and scan failures ───────────────────────────────────────────────────

describe("C1 roll-forward and fail-closed scan", () => {
  it("a C1 markTerminal refusal counts failed, leaves the row live, and the next start rolls it forward with no transport", async () => {
    const b = bot();
    await install(b);
    const id = shapes.c1(b.store(), "interrupted");
    const spy = vi.spyOn(CardStore.prototype, "markTerminal").mockImplementationOnce(() => { throw new Error("disk"); });
    const first = await b.start();
    expect(okReport(await recovered(first))).toEqual(report({ scanned: 1, failed: 1 }));
    expect(row(b, id)).toMatchObject({ state: "active", terminalIntent: "interrupted" });
    spy.mockRestore();
    const second = await b.start();
    expect(okReport(await recovered(second))).toEqual(report({ scanned: 1, rolledForward: 1 }));
    expect(row(b, id)).toMatchObject({ state: "error", terminalReason: "interrupted", seqReserved: 2, seqAcked: 2 });
    expect(b.edits()).toHaveLength(0);
  });

  it("a failed live-row snapshot classifies nothing and writes nothing; C1 is not rolled forward", async () => {
    const b = bot();
    await install(b);
    const c0a = shapes.c0a(b.store());
    const c1 = shapes.c1(b.store());
    const before = [b.raw(c0a), b.raw(c1)];
    vi.spyOn(CardStore.prototype, "liveAutomaticCards").mockImplementation(() => { throw new Error("read"); });
    const inc = await b.start();
    expect(await recovered(inc)).toEqual({ scan: "failed" });
    expect(b.edits()).toHaveLength(0);
    expect([b.raw(c0a), b.raw(c1)]).toEqual(before);
  });
});

// ─── NB-2: shutdown inputs ──────────────────────────────────────────────────

describe("NB-2 shutdown variants through real turns (in-process restart)", () => {
  it("NB-2a: progress acked, then shutdown mid-turn → cancelled terminal → restart sends exactly one Error/interrupted edit", async () => {
    const b = bot();
    await install(b);
    const first = await b.start();
    const turn = await turnWithAckedProgress(first);
    // index.ts order: stopTurns → cardRuntime.close → gateway.stop. The aborted handler unwinds after the
    // card registry is fenced, so its terminal arrives after close() and resolves `cancelled` with no reservation.
    const closing = first.runtime!.close("shutdown");
    turn.signal({ t: "shutdown" });
    await first.time.advance(3_000);
    const drain = await closing;
    expect(drain?.unresolved).toBe(0);
    expect(first.net.edits().map(seqOf)).toEqual([1]);
    const [id] = liveIds(b);
    expect(row(b, id)).toMatchObject({ state: "active", seqReserved: 1, seqAcked: 1, terminalIntent: null });

    const second = await b.start();
    expect(okReport(await recovered(second))).toEqual(report({ scanned: 1, restored: 1 }));
    expect(second.net.edits().map(seqOf)).toEqual([2]);
    expect(row(b, id)).toMatchObject({ state: "error", terminalReason: "interrupted" });
    const third = await b.start();
    expect(okReport(await recovered(third))).toEqual(ZERO);
    expect(b.edits().map(seqOf)).toEqual([1, 2]);
  });

  it("NB-2b: a progress edit in flight at shutdown → unresolved → restart sends nothing and counts it uncertain", async () => {
    const b = bot();
    await install(b);
    const first = await b.start();
    const turn = await turnWithAckedProgress(first);
    first.net.reply({ hold: true });
    turn.observe(cmd("d-1-b"));
    await first.time.advance(800);
    expect(first.net.heldCount()).toBe(1);
    turn.signal({ t: "shutdown" });
    const closing = first.runtime!.close("shutdown");
    await first.time.advance(3_000);
    expect((await closing)?.unresolved).toBeGreaterThan(0);
    const [id] = liveIds(b);
    expect(row(b, id)).toMatchObject({ state: "active", seqReserved: 2, seqAcked: 1, terminalIntent: null });
    const before = b.raw(id);

    for (let i = 0; i < 3; i++) {
      const next = await b.start();
      expect(okReport(await recovered(next))).toEqual(report({ scanned: 1, uncertain: 1 }));
      expect(b.raw(id)).toEqual(before);
    }
    expect(b.edits().map(seqOf)).toEqual([1, 2]);
  });

  it("NB-2c: a terminal edit in flight at the drain deadline → unresolved → restart sends nothing and counts it uncertain", async () => {
    const b = bot();
    await install(b);
    const first = await b.start();
    const turn = await turnWithAckedProgress(first);
    first.net.reply({ hold: true });
    turn.signal({ t: "shutdown" });
    await first.time.advance(0);
    expect(first.net.heldCount()).toBe(1);
    const closing = first.runtime!.close("shutdown");
    await first.time.advance(3_000);
    expect((await closing)?.unresolved).toBeGreaterThan(0);
    const [id] = liveIds(b);
    expect(row(b, id)).toMatchObject({ state: "active", seqReserved: 2, seqAcked: 1, terminalIntent: "interrupted" });
    const before = b.raw(id);

    for (let i = 0; i < 3; i++) {
      const next = await b.start();
      expect(okReport(await recovered(next))).toEqual(report({ scanned: 1, uncertain: 1 }));
      expect(b.raw(id)).toEqual(before);
    }
    expect(b.edits().map(seqOf)).toEqual([1, 2]);
  });

  it("a turn that is simply abandoned (process gone, no shutdown) is C0a and is closed once at the next start", async () => {
    const b = bot();
    await install(b);
    const first = await b.start();
    await turnWithAckedProgress(first);
    const second = await b.start();
    expect(okReport(await recovered(second))).toEqual(report({ scanned: 1, restored: 1 }));
    expect(b.edits().map(seqOf)).toEqual([1, 2]);
  });
});

// ─── Kill matrix during the recovery closure ───────────────────────────────

describe("recovery kill matrix k1–k5 with three further restarts each (in-process restart, store-boundary faults)", () => {
  async function matrix(setup: (b: Bot) => Promise<void>, expected: {
    readonly next: AutomaticRecoveryReport; readonly classAfter: string; readonly totalEdits: number; readonly final: Partial<CardMessageRecord> }) {
    const b = bot();
    await install(b);
    const id = shapes.c0a(b.store());
    await setup(b);
    const nextOf = (): string => {
      const live = b.store().liveAutomaticCards().find((c) => c.record.cardId === id);
      return live ? classifyAutomaticRow(live) : "terminal";
    };
    expect(nextOf()).toBe(expected.classAfter);
    const counts: AutomaticRecoveryReport[] = [];
    for (let i = 0; i < 3; i++) {
      const inc = await b.start();
      counts.push(okReport(await recovered(inc)));
    }
    expect(counts[0]).toEqual(expected.next);
    expect(b.edits()).toHaveLength(expected.totalEdits);
    expect(new Set(b.edits().map(seqOf))).toEqual(new Set(expected.totalEdits === 0 ? [] : [2]));
    expect(row(b, id)).toMatchObject(expected.final);
    return { b, id, counts };
  }

  it("k1: the intent commit fails (stands in for a kill before it) → still C0a → the next start sends exactly one edit", async () => {
    let first: AutomaticRecoveryResult | undefined;
    const { counts } = await matrix(async (b) => {
      const spy = vi.spyOn(CardStore.prototype, "reserveTerminalSequence").mockImplementationOnce(() => { throw new Error("kill"); });
      const inc = await b.start();
      first = await recovered(inc);
      spy.mockRestore();
      expect(inc.net.edits()).toHaveLength(0);
    }, { next: report({ scanned: 1, restored: 1 }), classAfter: "c0a", totalEdits: 1,
      final: { state: "error", terminalReason: "interrupted", seqReserved: 2, seqAcked: 2 } });
    // A store failure before reservation has no seq: counted deferred, not failed.
    expect(okReport(first!)).toEqual(report({ scanned: 1, deferred: 1 }));
    expect(counts.slice(1)).toEqual([ZERO, ZERO]);
  });

  it("k2: killed after the intent commit with the transport in flight → C2 → never edited again", async () => {
    const { counts } = await matrix(async (b) => {
      const inc = await b.start({ script: [{ hold: true }] });
      await inc.time.advance(0);
      expect(inc.net.heldCount()).toBe(1);
      // The process is gone: its clock never runs again and the held request never settles.
    }, { next: report({ scanned: 1, uncertain: 1 }), classAfter: "c2", totalEdits: 1,
      final: { state: "active", terminalIntent: "interrupted", seqReserved: 2, seqAcked: 1 } });
    expect(counts).toEqual([report({ scanned: 1, uncertain: 1 }), report({ scanned: 1, uncertain: 1 }), report({ scanned: 1, uncertain: 1 })]);
  });

  it("k3: remote ack, then ackSequence fails before it persists → C2 → never edited again", async () => {
    let first: AutomaticRecoveryResult | undefined;
    await matrix(async (b) => {
      const spy = vi.spyOn(CardStore.prototype, "ackSequence").mockImplementationOnce(() => { throw new Error("kill"); });
      const inc = await b.start();
      first = await recovered(inc);
      spy.mockRestore();
    }, { next: report({ scanned: 1, uncertain: 1 }), classAfter: "c2", totalEdits: 1,
      final: { state: "active", terminalIntent: "interrupted", seqReserved: 2, seqAcked: 1 } });
    expect(okReport(first!)).toEqual(report({ scanned: 1, failed: 1 }));
  });

  it("k4: ackSequence persisted, markTerminal fails → C1 → the next start rolls forward with no transport", async () => {
    let first: AutomaticRecoveryResult | undefined;
    const { counts } = await matrix(async (b) => {
      const real = CardStore.prototype.markTerminal;
      let calls = 0;
      const spy = vi.spyOn(CardStore.prototype, "markTerminal").mockImplementation(function (this: CardStore, ...args) {
        if (calls++ === 0) throw new Error("kill");
        return real.apply(this, args);
      });
      const inc = await b.start();
      first = await recovered(inc);
      spy.mockRestore();
    }, { next: report({ scanned: 1, rolledForward: 1 }), classAfter: "c1", totalEdits: 1,
      final: { state: "error", terminalReason: "interrupted", seqReserved: 2, seqAcked: 2 } });
    expect(okReport(first!)).toEqual(report({ scanned: 1, failed: 1 }));
    expect(counts.slice(1)).toEqual([ZERO, ZERO]);
  });

  it("k5: the closure completes → terminal → later starts see nothing", async () => {
    let first: AutomaticRecoveryResult | undefined;
    const { counts } = await matrix(async (b) => {
      const inc = await b.start();
      first = await recovered(inc);
    }, { next: ZERO, classAfter: "terminal", totalEdits: 1,
      final: { state: "error", terminalReason: "interrupted", seqReserved: 2, seqAcked: 2 } });
    expect(okReport(first!)).toEqual(report({ scanned: 1, restored: 1 }));
    expect(counts).toEqual([ZERO, ZERO, ZERO]);
  });

  it("a recovery closure in flight at shutdown is drained by the recovery owner and counted failed, never restored", async () => {
    const b = bot();
    await install(b);
    const id = shapes.c0a(b.store());
    const inc = await b.start({ script: [{ hold: true }] });
    await inc.time.advance(0);
    expect(inc.net.heldCount()).toBe(1);
    const closing = inc.runtime!.close("shutdown");
    await inc.time.advance(3_000);
    const drain = await closing;
    expect(drain?.unresolved).toBeGreaterThan(0);
    expect(okReport(await inc.runtime!.recovery)).toEqual(report({ scanned: 1, failed: 1 }));
    expect(classifyAutomaticRow(b.store().liveAutomaticCards().find((c) => c.record.cardId === id)!)).toBe("c2");
  });
});

// ─── Ownership, parity and isolation ────────────────────────────────────────

describe("ownership, card-off parity and two-Bot isolation", () => {
  it("recovery runs before the first turn: a new turn in the same session gets its own new card and the old card gets only its closure", async () => {
    const b = bot();
    await install(b);
    const old = shapes.c0a(b.store());
    const inc = await b.start();
    const result = (inc.runtime as CardRuntime).recovery;
    const turn = await turnWithAckedProgress(inc, "d-2");
    expect(okReport(await result)).toEqual(report({ scanned: 1, restored: 1 }));
    const oldMessage = row(b, old).messageId;
    const edits = inc.net.edits().map((e) => [JSON.parse(e.body).message_id as string, seqOf(e)]);
    expect(edits.filter(([m]) => m === oldMessage)).toEqual([[oldMessage, 2]]);
    expect(row(b, old)).toMatchObject({ state: "error", terminalReason: "interrupted" });
    const fresh = liveIds(b);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe(old);
    turn.settle();
  });

  it("a reset-epoch-behind or other-generation row is closed only through its own binding", async () => {
    const b = bot();
    await install(b);
    const id = progressed(b.store(), 1, { binding: { generation: "gen-old", resetEpoch: 0, sessionKey: "dm:u9", channelId: "u9", channelType: 1 } });
    const inc = await b.start();
    expect(okReport(await recovered(inc))).toEqual(report({ scanned: 1, restored: 1 }));
    const [edit] = inc.net.edits();
    expect(JSON.parse(edit.body)).toMatchObject({ channel_id: "u9", channel_type: 1, message_id: row(b, id).messageId });
  });

  it("card-off: an unprovisioned restart is card-inert; no recovery read or write happens and the rows are unchanged", async () => {
    const b = bot();
    await install(b);
    const id = shapes.c0a(b.store());
    const c1 = shapes.c1(b.store());
    const before = [b.raw(id), b.raw(c1)];
    rmSync(cardSubsystemPaths(b.dataDir).installationRefPath);
    const inc = await b.start();
    expect(inc.runtime).toBeUndefined();
    expect(inc.profileReads()).toBe(0);
    expect(inc.net.requests).toHaveLength(0);
    expect([b.raw(id), b.raw(c1)]).toEqual(before);
  });

  it("two Bots on one origin recover only their own rows", async () => {
    const a = bot("a");
    const c = bot("c");
    await install(a);
    await install(c);
    const mine = shapes.c0a(a.store());
    const theirs = shapes.c0a(c.store());
    const theirsBefore = c.raw(theirs);
    const inc = await a.start();
    expect(okReport(await recovered(inc))).toEqual(report({ scanned: 1, restored: 1 }));
    expect(row(a, mine)).toMatchObject({ state: "error", terminalReason: "interrupted" });
    expect(c.raw(theirs)).toEqual(theirsBefore);
    expect(c.edits()).toHaveLength(0);
  });
});

// ─── Operating-system process kill ──────────────────────────────────────────

/**
 * The child loads the real source through a transpiling loader hook (no build
 * needed), opens the Bot with a scripted transport and prints one line per
 * event. The parent kills it with SIGKILL; nothing in the child gets to run a
 * shutdown path.
 */
const typescriptEntry = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
const hooksSource = String.raw`
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ts = (await import(${JSON.stringify(typescriptEntry)})).default;
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL && context.parentURL.startsWith('file:') && context.parentURL.endsWith('.ts')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const path = fileURLToPath(url);
    const out = ts.transpileModule(readFileSync(path, 'utf8'), { fileName: path,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}`;
const childSource = String.raw`
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(process.argv[1]));
const [, , runtimeUrl, adapterUrl, dataDir, mode, profileJson] = process.argv;
const { openCardRuntime } = await import(runtimeUrl);
const { createAdapter } = await import(adapterUrl);
const adapter = createAdapter(dataDir + '/cc-octo.db');
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchImpl = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/v1/bot/card/profile')) return reply(JSON.parse(profileJson));
  if (path.endsWith('/v1/bot/message/edit')) {
    const body = JSON.parse(init.body);
    const seq = typeof body.card_seq === 'number' ? body.card_seq : JSON.parse(body.content_edit).card_seq;
    process.stdout.write('EDIT ' + seq + '\n');
    if (mode === 'hold') return new Promise(() => {});
    return reply({ message_id: body.message_id, card_seq: seq });
  }
  return new Response('{}', { status: 500 });
};
const runtime = await openCardRuntime({ adapter, dataDir, apiUrl: 'https://api.example.com', botToken: 'token-a', fetchImpl });
if (runtime === undefined) process.stdout.write('INERT\n');
else process.stdout.write('RESULT ' + JSON.stringify(await runtime.recovery) + '\n');
setInterval(() => {}, 1000);
`;

interface Killed { readonly lines: readonly string[]; readonly signal: NodeJS.Signals | null }

/** Run the child until `until` matches a stdout line, then SIGKILL it. */
function runAndKill(dataDir: string, mode: "hold" | "ack", until: RegExp, deadlineMs = 20_000): Promise<Killed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, hooksSource,
      new URL("../cards/runtime.ts", import.meta.url).href, new URL("../db-adapter.ts", import.meta.url).href,
      dataDir, mode, JSON.stringify(profile())], { stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let buffer = "";
    let errors = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child deadline: ${lines.join("|")} ${errors.slice(0, 400)}`)); }, deadlineMs);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        lines.push(line);
        if (until.test(line)) child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (_code, signal) => { clearTimeout(timer); resolve({ lines, signal }); });
  });
}

describe("operating-system process kill (child process, SIGKILL)", () => {
  it("killed while the recovery edit is in flight → C2 on the file → later starts never edit it", async () => {
    const b = bot();
    await install(b);
    const id = shapes.c0a(b.store());
    const killed = await runAndKill(b.dataDir, "hold", /^EDIT /);
    expect(killed.signal).toBe("SIGKILL");
    expect(killed.lines).toEqual(["EDIT 2"]);
    expect(row(b, id)).toMatchObject({ state: "active", terminalIntent: "interrupted", seqReserved: 2, seqAcked: 1 });
    const before = b.raw(id);
    for (let i = 0; i < 3; i++) {
      const inc = await b.start();
      expect(okReport(await recovered(inc))).toEqual(report({ scanned: 1, uncertain: 1 }));
      expect(b.raw(id)).toEqual(before);
    }
    expect(b.edits()).toHaveLength(0);
  }, 30_000);

  it("killed right after the closure was recorded → terminal on the file → later starts see nothing", async () => {
    const b = bot();
    await install(b);
    const id = shapes.c0a(b.store());
    const killed = await runAndKill(b.dataDir, "ack", /^RESULT /);
    expect(killed.signal).toBe("SIGKILL");
    expect(killed.lines[0]).toBe("EDIT 2");
    expect(JSON.parse(killed.lines[1].slice("RESULT ".length))).toEqual({ scan: "ok", report: report({ scanned: 1, restored: 1 }) });
    expect(row(b, id)).toMatchObject({ state: "error", terminalReason: "interrupted", seqReserved: 2, seqAcked: 2 });
    const inc = await b.start();
    expect(okReport(await recovered(inc))).toEqual(ZERO);
    expect(b.edits()).toHaveLength(0);
  }, 30_000);

  it("the child fixture loads the real source, not a build", () => {
    expect(existsSync(fileURLToPath(new URL("../cards/runtime.ts", import.meta.url)))).toBe(true);
  });
});
