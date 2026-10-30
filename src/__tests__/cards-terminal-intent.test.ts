/**
 * WP-13A-2P: durable automatic terminal intent (DTI-2.1 §3, §6 T1–T13).
 *
 * Every test runs on a real SQLite file in WAL mode. A "restart" abandons the
 * old adapter, store and queue without `close()` and opens new ones on the
 * same file, so only committed rows survive. Faults are injected at the exact
 * store boundary (a method that throws) or in the scripted transport (held,
 * rejected or acknowledged requests).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_ENVELOPE_MAX_BYTES, createCardApi, type CardApi } from "../cards/api.js";
import type {
  BotRef, CardObservableEvent, ItemState, Limits, PinnedTemplate, PolicySnapshot, RegistryData, SafeProgram,
  TrustedTurnContext, WireState,
} from "../cards/contracts.js";
import { createClosureGrants, createTurnCoordinator } from "../cards/lifecycle.js";
import { checkCardInvariants, migrateCardSchema, serializeIntentLegacy } from "../cards/migrations.js";
import { createPacer } from "../cards/pacer.js";
import { createPolicy, type Authorization, type CardPolicy } from "../cards/policy.js";
import { buildClosureFrame, type BuildOptions } from "../cards/registry-builder.js";
import {
  CardStore, CardStoreError, compareProtectedGraph, readProtectedGraph,
  type CardBinding, type CardMessageRecord, type LiveAutomaticCard, type ProtectedGraphRows,
} from "../cards/store.js";
import { createWriteQueue, type CardFrame, type CardSpec, type RecoveryGrant } from "../cards/write-queue.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { profile } from "./fixtures/card-profile.js";
import { json, manualTime, scriptedFetch, seqOf, type ManualTime, type RecordedRequest } from "./fixtures/card-write-harness.js";

// ─── File database and restart harness ─────────────────────────────────────

const API = "https://api.example.com";
const TEMPLATE_ID = "ai.reasoning-process";
const TEMPLATE_VERSION = "0.4.0";
const roots: string[] = [];
const handles: DbAdapter[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const a of handles.splice(0)) { try { a.close(); } catch { /* already closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Incarnation { readonly adapter: DbAdapter; readonly store: CardStore }

/** One SQLite file; `open()` is a new process incarnation and never closes the previous one. */
function fileDb(time: ManualTime) {
  const root = mkdtempSync(join(tmpdir(), "cards-intent-"));
  roots.push(root);
  const path = join(root, "cc-octo.db");
  let created = false;
  return {
    path,
    open(): Incarnation {
      const adapter = createAdapter(path);
      handles.push(adapter);
      if (!created) {
        new SessionStore(adapter).init();
        migrateCardSchema(adapter, { installationRef: "install-a", lineageId: "lineage-1", nowMs: time.wall.nowUtcMs() });
        created = true;
      }
      return { adapter, store: new CardStore(adapter, { clock: time.wall, newId: () => `card-${randomUUID()}` }) };
    },
  };
}

const BINDING: CardBinding = { sessionKey: "group:g1", channelId: "g1", channelType: 2, topicScope: null, generation: "gen-1", resetEpoch: 0 };
let messageNo = 0;
const nextMessageId = (): string => `8${String(++messageNo).padStart(17, "0")}`;

interface RowOptions {
  readonly kind?: "automatic" | "display";
  readonly templateId?: string;
  readonly templateVersion?: string;
  readonly profile?: string;
  readonly pinnedLimitsJson?: string;
}

function reserveRow(store: CardStore, o: RowOptions = {}): string {
  const r = store.reserveMessage({
    kind: o.kind ?? "automatic", binding: BINDING, bodyDigest: "digest", clientMsgNo: randomUUID(),
    templateId: "templateId" in o ? o.templateId : TEMPLATE_ID,
    templateVersion: "templateVersion" in o ? o.templateVersion : TEMPLATE_VERSION,
    ...(o.profile !== undefined ? { profile: o.profile } : {}),
    ...(o.pinnedLimitsJson !== undefined ? { pinnedLimitsJson: o.pinnedLimitsJson } : {}),
  });
  if (r.kind !== "reserved") throw new Error("reservation failed");
  return r.cardId;
}

/** A bound live row (`active`), as left by an acknowledged initial send. */
function boundRow(store: CardStore, o: RowOptions = {}): string {
  const id = reserveRow(store, o);
  expect(store.ackMessage({ cardId: id, messageId: nextMessageId(), currentResetEpoch: 0, policyAllows: true }).kind).toBe("bound");
  return id;
}

/** A bound row with one acknowledged progress edit (S = A = 1). */
function progressedRow(store: CardStore, o: RowOptions = {}): string {
  const id = boundRow(store, o);
  expect(store.reserveSequence(id)).toEqual({ kind: "reserved", seq: 1 });
  expect(store.ackSequence(id, 1)).toEqual({ kind: "acked", seqAcked: 1 });
  return id;
}

function markLegacy(adapter: DbAdapter, ids: readonly string[]): void {
  adapter.prepare(`UPDATE card_meta SET v = ? WHERE k = 'intent_legacy'`).run(serializeIntentLegacy(ids));
}

function rawRow(adapter: DbAdapter, id: string): Record<string, unknown> {
  return adapter.prepare("SELECT * FROM card_messages WHERE card_id = ?").get(id) as Record<string, unknown>;
}

/** DTI-2.1 §4 recovery classes of a live automatic row. */
function classify(c: LiveAutomaticCard): "legacy" | "C0a" | "C0b" | "C1" | "C2" {
  if (c.legacy) return "legacy";
  const r = c.record;
  if (r.terminalIntent === null) return r.seqAcked === r.seqReserved ? "C0a" : "C0b";
  return r.seqAcked === r.seqReserved ? "C1" : "C2";
}

function classOf(store: CardStore, id: string): string {
  const live = store.liveAutomaticCards().find((c) => c.record.cardId === id);
  if (live) return classify(live);
  return store.getMessage(id)?.terminalAt != null ? "terminal" : "absent";
}

// ─── Queue rig ─────────────────────────────────────────────────────────────

const LIMITS: Limits = { maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384, maxInputTextBytes: 4096, maxInputsBytes: 16384 };
const view = (name: "active" | "error" | "result", version: string) => ({ view: name, version, controlFree: true as const });
const TEMPLATE: PinnedTemplate = Object.freeze({
  id: TEMPLATE_ID, version: TEMPLATE_VERSION, controlFree: true,
  views: Object.freeze({ active: view("active", "v2"), error: view("error", "v2"), result: view("result", "v1") }),
});
const DATA: RegistryData = {
  reasoningId: "octo-progress", state: "reasoning", title: "Reasoning", statusLabel: "Working", statusTone: "Accent",
  timerText: "Reasoning", traceExpanded: true, traceCollapsed: false, collapsedSummary: "Reasoning in progress",
  phases: [{ thought: "Working", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
};

function frame(label: string, state: WireState = "reasoning"): CardFrame {
  return { k: "registry", ref: { id: TEMPLATE_ID, version: TEMPLATE_VERSION }, state,
    data: { ...DATA, state, progressText: label, ...(state === "error" ? { errorTitle: "Failed", errorMessage: "Failed" } : {}) } };
}
const done = (label = "done"): CardFrame => frame(label, "completed");

interface StubPolicy extends Pick<CardPolicy, "authorize"> {
  allowed: boolean;
  template: PinnedTemplate | undefined;
  maxPayloadBytes: number;
}

function stubPolicy(bot: BotRef): StubPolicy {
  const p: StubPolicy = {
    allowed: true,
    template: TEMPLATE,
    maxPayloadBytes: 16384,
    authorize(_op, ctx): Authorization {
      if (!p.allowed || ctx.botRef.credentialRef !== bot.credentialRef) return { allowed: false, reason: "policy_revoked" };
      const snapshot = { automatic: { state: "enabled", template: p.template, maxPayloadBytes: p.maxPayloadBytes } } as unknown as PolicySnapshot;
      return { allowed: true, snapshot, limits: { ...LIMITS, maxPayloadBytes: p.maxPayloadBytes } };
    },
  };
  return p;
}

interface QueueRigOptions {
  readonly net?: ReturnType<typeof scriptedFetch>;
  readonly fetchImpl?: typeof fetch;
  readonly grants?: readonly RecoveryGrant[];
}

function queueRig(time: ManualTime, store: CardStore, o: QueueRigOptions = {}) {
  const net = o.net ?? scriptedFetch(time);
  const api = createCardApi({ apiUrl: API, credential: "token-a", fetchImpl: o.fetchImpl ?? net.fetchImpl, nowUtcMs: time.wall.nowUtcMs });
  const bot: BotRef = { originKey: api.origin.key, credentialRef: "cred-a" };
  const policy = stubPolicy(bot);
  const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
  const queue = createWriteQueue({ api, store, policy, pacer, clock: time.clock, timers: time.timers,
    ...(o.grants !== undefined ? { recoveryGrants: o.grants } : {}) });
  let n = 0;
  const spec = (over: Partial<CardSpec> = {}): CardSpec => ({
    cardId: `q-${++n}`, kind: "automatic", capability: "automatic", ctx: { botRef: bot }, binding: BINDING,
    clientMsgNo: randomUUID(), presentation: { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION }, ...over,
  });
  return { net, api, bot, policy, queue, spec };
}

type QueueRig = ReturnType<typeof queueRig>;

/** Open a card through the queue and bring it to `active` (initial send acknowledged). */
async function activeCard(time: ManualTime, q: QueueRig, over: Partial<CardSpec> = {}): Promise<{ cardId: string; storeCardId: string }> {
  const s = q.spec(over);
  expect(q.queue.open(s)).toBe("opened");
  q.queue.enqueue(s.cardId, frame("first"));
  await time.advance(800);
  const status = q.queue.status(s.cardId);
  expect(status?.phase).toBe("active");
  return { cardId: s.cardId, storeCardId: status?.storeCardId as string };
}

const fenceAt = (time: ManualTime, ms: number) => ({ reason: "shutdown" as const, deadlineMono: time.now() + ms, signal: new AbortController().signal });

// ─── T1–T5: store primitives ───────────────────────────────────────────────

describe("T1: reserveTerminalSequence records the terminal seq and its intent together", () => {
  it("commits the seq and the intent in one write, visible to a new connection", () => {
    const time = manualTime();
    const db = fileDb(time);
    const { store } = db.open();
    const id = progressedRow(store);
    expect(store.reserveTerminalSequence(id, "completed")).toEqual({ kind: "reserved", seq: 2 });
    const restarted = db.open();
    expect(restarted.store.getMessage(id)).toMatchObject({ seqReserved: 2, seqAcked: 1, terminalIntent: "completed", terminalReason: null, state: "active", terminalAt: null });
  });

  it("a repeat reports the recorded intent and writes nothing, even with another reason", () => {
    const time = manualTime();
    const db = fileDb(time);
    const { adapter, store } = db.open();
    const id = boundRow(store);
    expect(store.reserveTerminalSequence(id, "failed")).toEqual({ kind: "reserved", seq: 1 });
    const before = rawRow(adapter, id);
    expect(store.reserveTerminalSequence(id, "failed")).toEqual({ kind: "intent_exists", reason: "failed", seq: 1 });
    expect(store.reserveTerminalSequence(id, "completed")).toEqual({ kind: "intent_exists", reason: "failed", seq: 1 });
    expect(rawRow(adapter, id)).toEqual(before);
  });

  it("refuses terminal, sending, ambiguous, display, unbound and legacy rows without writing", () => {
    const time = manualTime();
    const db = fileDb(time);
    const { adapter, store } = db.open();
    const terminal = boundRow(store);
    expect(store.markTerminal(terminal, "completed").kind).toBe("updated");
    const sending = reserveRow(store);
    const ambiguous = reserveRow(store);
    store.markSendAmbiguous(ambiguous);
    const display = boundRow(store, { kind: "display" });
    const legacy = boundRow(store);
    markLegacy(adapter, [legacy]);
    const cases: Array<[string, string]> = [
      [terminal, "done"], [sending, "sending"], [ambiguous, "ambiguous"], [display, "active"], [legacy, "active"],
    ];
    for (const [id, state] of cases) {
      const before = rawRow(adapter, id);
      expect(store.reserveTerminalSequence(id, "interrupted")).toEqual({ kind: "invalid_state", state });
      expect(rawRow(adapter, id)).toEqual(before);
    }
    expect(store.reserveTerminalSequence("missing", "completed")).toEqual({ kind: "not_found" });
  });

  it("rejects a reason an automatic card cannot record", () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = boundRow(store);
    for (const reason of ["expired", "bogus", undefined]) {
      expect(() => store.reserveTerminalSequence(id, reason as never)).toThrow(CardStoreError);
      try { store.reserveTerminalSequence(id, reason as never); } catch (err) { expect((err as CardStoreError).code).toBe("invalid_input"); }
    }
    expect(store.getMessage(id)).toMatchObject({ seqReserved: 0, terminalIntent: null });
  });
});

describe("T2: reserveSequence never moves after an intent, nor on a legacy row", () => {
  it("is refused once the intent exists", () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = progressedRow(store);
    store.reserveTerminalSequence(id, "completed");
    expect(store.reserveSequence(id)).toEqual({ kind: "invalid_state", state: "active" });
    expect(store.getMessage(id)?.seqReserved).toBe(2);
  });

  it("is refused on a legacy row and still works on an ordinary one", () => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const legacy = boundRow(store);
    const ordinary = boundRow(store);
    markLegacy(adapter, [legacy]);
    expect(store.reserveSequence(legacy)).toEqual({ kind: "invalid_state", state: "active" });
    expect(store.reserveSequence(ordinary)).toEqual({ kind: "reserved", seq: 1 });
  });
});

describe("T3: ackSequence acknowledges the terminal seq of an intent row", () => {
  it("acks S and keeps the intent", () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = progressedRow(store);
    store.reserveTerminalSequence(id, "timed_out");
    expect(store.ackSequence(id, 2)).toEqual({ kind: "acked", seqAcked: 2 });
    expect(store.getMessage(id)).toMatchObject({ seqReserved: 2, seqAcked: 2, terminalIntent: "timed_out", state: "active" });
  });
});

describe("T4: markTerminal on an intent row needs the same reason and a durable ack", () => {
  it("intent and acked → updated with the intent's reason", () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = boundRow(store);
    store.reserveTerminalSequence(id, "completed");
    store.ackSequence(id, 1);
    expect(store.markTerminal(id, "completed")).toEqual({ kind: "updated" });
    expect(store.getMessage(id)).toMatchObject({ state: "done", terminalReason: "completed", terminalIntent: null });
    expect(store.markTerminal(id, "completed")).toEqual({ kind: "already_terminal" });
  });

  it("a different reason → invalid_state, nothing written", () => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const id = boundRow(store);
    store.reserveTerminalSequence(id, "completed");
    store.ackSequence(id, 1);
    const before = rawRow(adapter, id);
    expect(store.markTerminal(id, "failed")).toEqual({ kind: "invalid_state", state: "active" });
    expect(rawRow(adapter, id)).toEqual(before);
  });

  it("A < S → invalid_state, nothing written", () => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const id = progressedRow(store);
    store.reserveTerminalSequence(id, "interrupted");
    const before = rawRow(adapter, id);
    expect(store.markTerminal(id, "interrupted")).toEqual({ kind: "invalid_state", state: "active" });
    expect(rawRow(adapter, id)).toEqual(before);
  });

  it("the no-intent path is unchanged", () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = progressedRow(store);
    expect(store.markTerminal(id, "failed")).toEqual({ kind: "updated" });
    expect(store.getMessage(id)).toMatchObject({ state: "error", terminalReason: "failed", terminalIntent: null });
  });
});

describe("T5: terminalIntent / terminalReason projection", () => {
  it("projects live, intent and terminal rows, plus the stored presentation", () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = boundRow(store);
    expect(store.getMessage(id)).toMatchObject({
      terminalReason: null, terminalIntent: null, templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION,
      profile: null, pinnedLimitsJson: null,
    });
    store.reserveTerminalSequence(id, "policy_revoked");
    expect(store.getMessage(id)).toMatchObject({ terminalReason: null, terminalIntent: "policy_revoked" });
    store.ackSequence(id, 1);
    store.markTerminal(id, "policy_revoked");
    expect(store.getMessage(id)).toMatchObject({ terminalReason: "policy_revoked", terminalIntent: null, state: "error" });
    const failed = reserveRow(store);
    store.markSendFailed(failed);
    expect(store.getMessage(failed)).toMatchObject({ state: "error", terminalReason: "failed", terminalIntent: null });
  });
});

// ─── T6: restore comparison ────────────────────────────────────────────────

describe("T6: restore comparison treats the intent and the O2 meta as protected facts", () => {
  function withRow(g: ProtectedGraphRows, id: string, f: (r: Record<string, unknown>) => Record<string, unknown>): ProtectedGraphRows {
    return { ...g, card_messages: g.card_messages.map((r) => (r.card_id === id ? f({ ...r }) : r)) };
  }
  function withMeta(g: ProtectedGraphRows, f: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): ProtectedGraphRows {
    return { ...g, card_meta: f(g.card_meta.map((r) => ({ ...r }))) };
  }

  it("losing the intent revives work, changing it contradicts, a pre-intent backup regresses", () => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const id = progressedRow(store);
    const preIntent = readProtectedGraph(adapter);
    store.reserveTerminalSequence(id, "completed");
    const tail = readProtectedGraph(adapter);
    expect(compareProtectedGraph(tail, tail)).toEqual([]);
    expect(compareProtectedGraph(withRow(tail, id, (r) => ({ ...r, terminal_reason: null })), tail))
      .toContainEqual({ table: "card_messages", key: id, code: "revived_work" });
    expect(compareProtectedGraph(withRow(tail, id, (r) => ({ ...r, terminal_reason: "failed" })), tail))
      .toContainEqual({ table: "card_messages", key: id, code: "conflicting_fact" });
    expect(compareProtectedGraph(preIntent, tail)).toContainEqual({ table: "card_messages", key: id, code: "sequence_regression" });
  });

  it("a v1 candidate against a v2 tail, or a different legacy set, conflicts on card_meta", () => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const id = boundRow(store);
    const tail = readProtectedGraph(adapter);
    const v1 = withMeta(tail, (rows) => rows.filter((r) => r.k !== "intent_legacy").map((r) => (r.k === "schema_version" ? { ...r, v: "1" } : r)));
    expect(compareProtectedGraph(v1, tail)).toContainEqual({ table: "card_meta", key: "schema_version", code: "conflicting_fact" });
    const otherLegacy = withMeta(tail, (rows) => rows.map((r) => (r.k === "intent_legacy" ? { ...r, v: serializeIntentLegacy([id]) } : r)));
    expect(compareProtectedGraph(otherLegacy, tail)).toContainEqual({ table: "card_meta", key: "intent_legacy", code: "conflicting_fact" });
  });
});

// ─── T7–T9, T11: queue terminal path ───────────────────────────────────────

describe("T7: the blocker pair is distinguishable after a restart", () => {
  it("progress acked then kill is C0a; terminal acked + ackSequence then markTerminal failure is C1", async () => {
    const time = manualTime();
    const db = fileDb(time);
    const first = db.open();
    const q = queueRig(time, first.store);

    const a = await activeCard(time, q);
    q.queue.enqueue(a.cardId, frame("progress"));
    await time.advance(800);
    expect(q.net.edits().map(seqOf)).toEqual([1]);

    const b = await activeCard(time, q);
    vi.spyOn(first.store, "markTerminal").mockImplementation(() => { throw new Error("kill before markTerminal"); });
    expect(await q.queue.finalize(b.cardId, done(), "completed")).toEqual({ outcome: "store_failed", seq: 1 });

    const restarted = db.open().store;
    const rowA = restarted.getMessage(a.storeCardId) as CardMessageRecord;
    const rowB = restarted.getMessage(b.storeCardId) as CardMessageRecord;
    expect(rowA).toMatchObject({ state: "active", seqReserved: 1, seqAcked: 1, terminalIntent: null });
    expect(rowB).toMatchObject({ state: "active", seqReserved: 1, seqAcked: 1, terminalIntent: "completed" });
    expect(classOf(restarted, a.storeCardId)).toBe("C0a");
    expect(classOf(restarted, b.storeCardId)).toBe("C1");
  });
});

describe("T8: the intent is durable before the terminal request leaves the process", () => {
  it("inside the transport, a new connection already sees intent R at the request's card_seq", async () => {
    const time = manualTime();
    const db = fileDb(time);
    const { store } = db.open();
    const observer = db.open().store;
    const net = scriptedFetch(time);
    const seen: Array<{ seq: number; row: CardMessageRecord | null }> = [];
    let watched: string | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (watched !== undefined && path.endsWith("/v1/bot/message/edit")) {
        seen.push({ seq: seqOf({ body: init?.body as string } as RecordedRequest), row: observer.getMessage(watched) });
      }
      return net.fetchImpl(input, init);
    }) as typeof fetch;
    const q = queueRig(time, store, { net, fetchImpl });
    const card = await activeCard(time, q);
    q.queue.enqueue(card.cardId, frame("progress"));
    await time.advance(800);
    watched = card.storeCardId;
    net.reply({ status: 503 });
    const result = q.queue.finalize(card.cardId, frame("t", "error"), "interrupted");
    await time.advance(200);
    expect(await result).toEqual({ outcome: "acked", seq: 2 });
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.seq).toBe(2);
      expect(s.row).toMatchObject({ terminalIntent: "interrupted", seqReserved: 2, state: "active" });
    }
    expect(observer.getMessage(card.storeCardId)).toMatchObject({ state: "error", terminalReason: "interrupted", seqAcked: 2 });
  });
});

describe("T9: a terminal fenced before transport reserves nothing", () => {
  it("leaves seq_reserved unchanged and writes no intent", async () => {
    const time = manualTime();
    const db = fileDb(time);
    const { store } = db.open();
    const q = queueRig(time, store);
    const card = await activeCard(time, q);
    const result = q.queue.finalize(card.cardId, done(), "completed");
    // The worker has passed eligibility; the fence expires before it reserves.
    q.queue.close(fenceAt(time, 0));
    expect(await result).toEqual({ outcome: "cancelled" });
    await time.advance(1000);
    expect(q.net.edits()).toHaveLength(0);
    expect(db.open().store.getMessage(card.storeCardId)).toMatchObject({ seqReserved: 0, seqAcked: 0, terminalIntent: null, state: "active" });
  });
});

describe("T11: an automatic terminal without a reason is refused at runtime", () => {
  it("resolves contract with no reservation and no transport", async () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const q = queueRig(time, store);
    const card = await activeCard(time, q);
    const reserve = vi.spyOn(store, "reserveSequence");
    const reserveTerminal = vi.spyOn(store, "reserveTerminalSequence");
    expect(await q.queue.finalize(card.cardId, done())).toEqual({ outcome: "contract" });
    await time.advance(1000);
    expect(reserve).not.toHaveBeenCalled();
    expect(reserveTerminal).not.toHaveBeenCalled();
    expect(q.net.edits()).toHaveLength(0);
    expect(q.queue.status(card.cardId)?.phase).toBe("closed");
    expect(store.getMessage(card.storeCardId)).toMatchObject({ seqReserved: 0, terminalIntent: null, state: "active" });
  });

  it("a display card without a reason behaves as before", async () => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const q = queueRig(time, store);
    const card = await activeCard(time, q, { kind: "display", capability: "display" });
    const reserveTerminal = vi.spyOn(store, "reserveTerminalSequence");
    expect(await q.queue.finalize(card.cardId, done())).toEqual({ outcome: "acked", seq: 1 });
    expect(reserveTerminal).not.toHaveBeenCalled();
    expect(q.net.edits().map(seqOf)).toEqual([1]);
    expect(store.getMessage(card.storeCardId)).toMatchObject({ kind: "display", state: "active", seqAcked: 1, terminalIntent: null });
  });
});

// ─── T12: normal-terminal kill matrix ──────────────────────────────────────

describe("T12: normal-terminal kill matrix k1–k5 across three real restarts", () => {
  type Kill = "k1" | "k2" | "k3" | "k4" | "k5";
  const expected: Record<Kill, { readonly cls: string; readonly edits: number }> = {
    k1: { cls: "C0a", edits: 0 },
    k2: { cls: "C2", edits: 1 },
    k3: { cls: "C2", edits: 1 },
    k4: { cls: "C1", edits: 1 },
    k5: { cls: "terminal", edits: 1 },
  };

  it.each(Object.keys(expected) as Kill[])("%s", async (kill) => {
    const time = manualTime();
    const db = fileDb(time);
    const first = db.open();
    const net = scriptedFetch(time);
    const q = queueRig(time, first.store, { net });
    const card = await activeCard(time, q);
    if (kill === "k1") vi.spyOn(first.store, "reserveTerminalSequence").mockImplementation(() => { throw new Error("kill before the intent commit"); });
    if (kill === "k2") net.reply({ hold: true });
    if (kill === "k3") vi.spyOn(first.store, "ackSequence").mockImplementation(() => { throw new Error("kill after the remote ack"); });
    if (kill === "k4") vi.spyOn(first.store, "markTerminal").mockImplementation(() => { throw new Error("kill after ackSequence"); });
    const result = q.queue.finalize(card.cardId, done(), "completed");
    await time.advance(0);
    if (kill !== "k2") {
      expect((await result).outcome).toBe(kill === "k5" ? "acked" : "store_failed");
    } else {
      expect(net.heldCount()).toBe(1);
    }
    // The process dies here: nothing is closed or drained.
    const afterKill = db.open().store.getMessage(card.storeCardId);
    expect(net.edits()).toHaveLength(expected[kill].edits);

    for (let restart = 1; restart <= 3; restart++) {
      const next = db.open();
      const nextQueue = queueRig(time, next.store, { net });
      await time.advance(5000);
      expect(net.edits()).toHaveLength(expected[kill].edits);
      expect(net.sends()).toHaveLength(1);
      expect(next.store.getMessage(card.storeCardId)).toEqual(afterKill);
      expect(classOf(next.store, card.storeCardId)).toBe(expected[kill].cls);
      expect(nextQueue.queue.suspendedCapabilities()).toEqual([]);
    }
    const row = afterKill as CardMessageRecord;
    if (kill === "k1") expect(row).toMatchObject({ seqReserved: 0, seqAcked: 0, terminalIntent: null });
    if (kill === "k2" || kill === "k3") expect(row).toMatchObject({ seqReserved: 1, seqAcked: 0, terminalIntent: "completed" });
    if (kill === "k4") expect(row).toMatchObject({ seqReserved: 1, seqAcked: 1, terminalIntent: "completed" });
    if (kill === "k5") expect(row).toMatchObject({ state: "done", terminalReason: "completed", seqAcked: 1 });
  });
});

// ─── T10: adoption ─────────────────────────────────────────────────────────

/**
 * Recovery-side preconditions P1–P5 (DTI-2.1 §3.4). The production recovery
 * owner lands in WP-13A-2; this model pins the policy and builder facts the
 * grant depends on, using the real `buildClosureFrame`.
 */
type RecoveryPolicy = Pick<CardPolicy, "snapshot" | "authorize">;

async function recoveryGrant(policy: RecoveryPolicy, botRef: BotRef, row: CardMessageRecord, opts: BuildOptions):
  Promise<{ readonly kind: "granted"; readonly grant: RecoveryGrant; readonly closure: CardFrame } | { readonly kind: "deferred" }> {
  try { await policy.snapshot(); } catch { return { kind: "deferred" }; }
  const auth = policy.authorize("automatic", { botRef }, undefined);
  if (!auth.allowed) return { kind: "deferred" };
  const t = auth.snapshot.automatic.template;
  if (t === undefined || t.controlFree !== true) return { kind: "deferred" };
  if (t.id !== row.templateId || t.version !== row.templateVersion) return { kind: "deferred" };
  const closure = buildClosureFrame("interrupted", t, opts);
  if (closure === undefined) return { kind: "deferred" };
  return { kind: "granted", grant: { storeCardId: row.cardId, messageId: row.messageId as string }, closure };
}

function bindingOf(row: CardMessageRecord): CardBinding {
  return { sessionKey: row.sessionKey, channelId: row.channelId, channelType: row.channelType as CardBinding["channelType"],
    topicScope: row.topicScope, generation: row.generation, resetEpoch: row.resetEpoch };
}

const buildOptions = (row: CardMessageRecord): BuildOptions => ({
  reasoningId: row.cardId, elapsedMs: 0, route: { channelId: row.channelId, channelType: row.channelType as CardBinding["channelType"] },
  clientMsgNo: row.clientMsgNo, maxEnvelopeBytes: CARD_ENVELOPE_MAX_BYTES,
});

function adoptSpec(bot: BotRef, row: CardMessageRecord, grant: RecoveryGrant, over: Partial<CardSpec> = {}): CardSpec {
  return {
    cardId: "recovery-1", kind: "automatic", capability: "automatic", ctx: { botRef: bot }, binding: bindingOf(row),
    clientMsgNo: row.clientMsgNo,
    presentation: {
      ...(row.templateId !== null ? { templateId: row.templateId } : {}),
      ...(row.templateVersion !== null ? { templateVersion: row.templateVersion } : {}),
      ...(row.profile !== null ? { profile: row.profile } : {}),
    },
    adopt: grant, ...over,
  };
}

describe("T10: adoption of a lifecycle-created row after a restart (positive case)", () => {
  let seq = 0;
  const start: CardObservableEvent = { kind: "attempt_start", attempt: 0, reason: "initial", continues: null };
  const cmd = (id: string, phase: ItemState["phase"] = "started", status?: ItemState["status"]): ItemState => ({
    kind: "item_state", attempt: 0, itemId: id, seq: seq++, itemType: "command_execution", phase,
    ...(status ? { status } : {}), safe: { category: "command", program: "git" as SafeProgram },
  });

  function realApi(time: ManualTime, net: ReturnType<typeof scriptedFetch>): CardApi {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname.endsWith("/v1/bot/card/profile") ? json(200, profile()) : net.fetchImpl(input, init)) as typeof fetch;
    return createCardApi({ apiUrl: API, credential: "token-a", fetchImpl, nowUtcMs: time.wall.nowUtcMs });
  }

  it("P1–P5 pass, the grant is consumed and exactly one closure edit is sent at seq 2", async () => {
    // First incarnation: the real lifecycle opens the card and sends one progress edit.
    const time1 = manualTime();
    const db = fileDb(time1);
    const first = db.open();
    const net1 = scriptedFetch(time1);
    const api1 = realApi(time1, net1);
    const botRef: BotRef = { originKey: api1.origin.key, credentialRef: "cred-a" };
    const policy1 = createPolicy({ botRef, api: api1, clock: time1.clock });
    const grants1 = createClosureGrants(policy1);
    const queue1 = createWriteQueue({ api: api1, store: first.store, policy: grants1,
      pacer: createPacer({ clock: time1.clock, timers: time1.timers, rng: () => 0 }), clock: time1.clock, timers: time1.timers });
    await policy1.snapshot();
    const ctx: TrustedTurnContext = Object.freeze({
      botRef, route: Object.freeze({ channelId: "g1", channelType: 2 as const }), requesterUid: "u1", sessionKey: "group:g1",
      turnGeneration: "gen-1", resetEpoch: 0, policyIdentity: "cred-a", runtimeIncarnation: "inc-1",
      routeEligibility: Object.freeze({ kind: "group" as const, obo: false, docTask: false, cron: false }),
      origin: Object.freeze({ kind: "user" as const }),
    });
    const turn = createTurnCoordinator({
      ctx, binding: BINDING, cardId: "card-1", clientMsgNo: "00000000-0000-4000-8000-000000000001", queue: queue1,
      policy: policy1, closure: grants1, clock: time1.clock, refresh: () => policy1.snapshot().catch(() => undefined), track: () => {},
    });
    await time1.advance(0);
    turn.observe(start);
    turn.observe(cmd("c1"));
    await time1.advance(800);
    turn.observe(cmd("c1", "completed", "completed"));
    await time1.advance(800);
    expect(net1.sends()).toHaveLength(1);
    expect(net1.edits().map(seqOf)).toEqual([1]);
    const storeCardId = queue1.status("card-1")?.storeCardId as string;
    // The process dies mid-turn: no settle, no close, and its clock never runs again.

    const time2 = manualTime(1_000, time1.wall.nowUtcMs() + 60_000);
    const second = db.open();
    const row = second.store.getMessage(storeCardId) as CardMessageRecord;
    expect(row).toMatchObject({ kind: "automatic", state: "active", seqReserved: 1, seqAcked: 1, terminalIntent: null,
      templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, profile: null, pinnedLimitsJson: null });
    expect(classOf(second.store, storeCardId)).toBe("C0a");

    const net2 = scriptedFetch(time2);
    const api2 = realApi(time2, net2);
    const policy2 = createPolicy({ botRef, api: api2, clock: time2.clock });
    const pre = await recoveryGrant(policy2, botRef, row, buildOptions(row));
    if (pre.kind !== "granted") throw new Error("P1–P5 must pass");
    const snapshot = await policy2.snapshot();
    expect(snapshot.automatic.template).toMatchObject({ id: row.templateId, version: row.templateVersion });

    const caps: number[] = [];
    const api2w: Pick<CardApi, "origin" | "sendRegistry" | "sendAuthored" | "editRegistry" | "editAuthored"> = {
      origin: api2.origin, sendRegistry: api2.sendRegistry, sendAuthored: api2.sendAuthored, editAuthored: api2.editAuthored,
      editRegistry: (req, opts) => { caps.push(req.maxEnvelopeBytes as number); return api2.editRegistry(req, opts); },
    };
    const make = (grants?: readonly RecoveryGrant[]) => createWriteQueue({ api: api2w, store: second.store,
      policy: createClosureGrants(policy2), pacer: createPacer({ clock: time2.clock, timers: time2.timers, rng: () => 0 }),
      clock: time2.clock, timers: time2.timers, ...(grants ? { recoveryGrants: grants } : {}) });
    const queue2 = make([pre.grant]);
    expect(Object.keys(queue2)).toEqual(Object.keys(make()));
    const suspendedBefore = queue2.suspendedCapabilities();

    expect(queue2.open(adoptSpec(botRef, row, pre.grant))).toBe("opened");
    expect(queue2.open(adoptSpec(botRef, row, pre.grant, { cardId: "recovery-2" }))).toBe("contract");
    expect(queue2.enqueue("recovery-1", frame("late progress"))).toBe("absorbed");
    const result = queue2.finalize("recovery-1", pre.closure, "interrupted");
    await time2.advance(0);
    expect(await result).toEqual({ outcome: "acked", seq: 2 });
    expect(net2.sends()).toHaveLength(0);
    expect(net2.edits().map(seqOf)).toEqual([2]);
    expect(pre.closure).toMatchObject({ k: "registry", ref: { id: row.templateId, version: row.templateVersion }, state: "error" });
    expect(caps).toEqual([Math.min(snapshot.automatic.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES)]);
    expect(queue2.suspendedCapabilities()).toEqual(suspendedBefore);
    expect(second.store.getMessage(storeCardId)).toMatchObject({ state: "error", terminalReason: "interrupted", seqReserved: 2, seqAcked: 2 });
    await time2.advance(5000);
    expect(net2.requests.filter((r) => !r.path.endsWith("/v1/bot/card/profile"))).toHaveLength(1);
  });
});

describe("T10: recovery-side preconditions defer with zero grants and zero writes", () => {
  function recoveryPolicy(over: { snapshot?: () => Promise<PolicySnapshot>; allowed?: boolean; template?: unknown }): RecoveryPolicy {
    const template = "template" in over ? over.template : TEMPLATE;
    const snap = { automatic: { state: "enabled", template, maxPayloadBytes: 16384 } } as unknown as PolicySnapshot;
    return {
      snapshot: over.snapshot ?? (() => Promise.resolve(snap)),
      authorize: () => (over.allowed === false
        ? { allowed: false, reason: "capability_disabled" }
        : { allowed: true, snapshot: snap, limits: { ...LIMITS } }),
    };
  }

  const cases: Array<[string, RecoveryPolicy]> = [
    ["policy snapshot throws", recoveryPolicy({ snapshot: () => Promise.reject(new Error("unavailable")) })],
    ["automatic capability not enabled", recoveryPolicy({ allowed: false })],
    ["no current template", recoveryPolicy({ template: undefined })],
    ["template not control-free", recoveryPolicy({ template: { ...TEMPLATE, controlFree: false } })],
    ["template id differs from the row", recoveryPolicy({ template: { ...TEMPLATE, id: "ai.other" } })],
    ["template version differs from the row", recoveryPolicy({ template: { ...TEMPLATE, version: "0.5.0" } })],
  ];

  it.each(cases)("%s", async (_name, policy) => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = progressedRow(store);
    const row = store.getMessage(id) as CardMessageRecord;
    const pre = await recoveryGrant(policy, { originKey: "o", credentialRef: "cred-a" }, row, buildOptions(row));
    expect(pre).toEqual({ kind: "deferred" });
    const grants: RecoveryGrant[] = pre.kind === "granted" ? [pre.grant] : [];
    const q = queueRig(time, store, { grants });
    expect(q.queue.open(adoptSpec(q.bot, row, { storeCardId: id, messageId: row.messageId as string }))).toBe("contract");
    await time.advance(5000);
    expect(q.net.requests).toHaveLength(0);
    expect(store.getMessage(id)).toEqual(row);
  });
});

describe("T10: queue-side adoption checks refuse with contract and write nothing", () => {
  interface Case {
    readonly row?: RowOptions & { readonly shape?: "bound" | "sending" | "ambiguous" };
    readonly prepare?: (c: { store: CardStore; adapter: DbAdapter; id: string }) => void;
    readonly grants?: (g: RecoveryGrant) => readonly RecoveryGrant[];
    readonly before?: (c: { q: QueueRig; time: ManualTime; row: CardMessageRecord; grant: RecoveryGrant }) => void;
    readonly spec?: (row: CardMessageRecord, grant: RecoveryGrant) => Partial<CardSpec>;
  }

  const cases: Array<[string, Case]> = [
    ["no grant", { grants: () => [] }],
    ["mismatched messageId", { spec: (_r, g) => ({ adopt: { storeCardId: g.storeCardId, messageId: "899999999999999999" } }) }],
    ["second adoption of the same grant", { before: ({ q, row, grant }) => { expect(q.queue.open(adoptSpec(q.bot, row, grant, { cardId: "first" }))).toBe("opened"); } }],
    ["a duplicated grant still adopts the row once", { grants: (g) => [g, g], before: ({ q, row, grant }) => { expect(q.queue.open(adoptSpec(q.bot, row, grant, { cardId: "first" }))).toBe("opened"); } }],
    ["adoption after the first ordinary open", { before: ({ q }) => { expect(q.queue.open(q.spec())).toBe("opened"); } }],
    ["adoption after close", { before: ({ q, time }) => { q.queue.close(fenceAt(time, 3000)); } }],
    ["sessionKey differs", { spec: (r) => ({ binding: { ...bindingOf(r), sessionKey: "group:g2" } }) }],
    ["channelId differs", { spec: (r) => ({ binding: { ...bindingOf(r), channelId: "g2" } }) }],
    ["channelType differs", { spec: (r) => ({ binding: { ...bindingOf(r), channelType: 1 } }) }],
    ["topicScope differs", { spec: (r) => ({ binding: { ...bindingOf(r), topicScope: "topic-1" } }) }],
    ["generation differs", { spec: (r) => ({ binding: { ...bindingOf(r), generation: "gen-2" } }) }],
    ["resetEpoch differs", { spec: (r) => ({ binding: { ...bindingOf(r), resetEpoch: 1 } }) }],
    ["clientMsgNo differs", { spec: () => ({ clientMsgNo: randomUUID() }) }],
    ["templateId differs", { spec: () => ({ presentation: { templateId: "ai.other", templateVersion: TEMPLATE_VERSION } }) }],
    ["templateVersion differs", { spec: () => ({ presentation: { templateId: TEMPLATE_ID, templateVersion: "0.5.0" } }) }],
    ["templateId absent against a stored id", { spec: () => ({ presentation: { templateVersion: TEMPLATE_VERSION } }) }],
    ["templateId supplied against a NULL row", { row: { templateId: undefined }, spec: () => ({ presentation: { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION } }) }],
    ["profile supplied against a NULL row", { spec: () => ({ presentation: { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, profile: "octo/v1" } }) }],
    ["profile absent against a stored profile", { row: { profile: "octo/v1" }, spec: () => ({ presentation: { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION } }) }],
    ["spec pinnedLimitsJson supplied", { spec: () => ({ presentation: { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, pinnedLimitsJson: "{}" } }) }],
    ["row pinned_limits_json is not NULL", { row: { pinnedLimitsJson: "{\"maxPayloadBytes\":16384}" } }],
    ["pinned snapshot supplied", { spec: () => ({ pinned: {} as PolicySnapshot }) }],
    ["row already has an intent", { prepare: ({ store, id }) => { store.reserveTerminalSequence(id, "completed"); } }],
    ["row is terminal", { prepare: ({ store, id }) => { store.markTerminal(id, "failed"); } }],
    ["row is sending", { row: { shape: "sending" } }],
    ["row is ambiguous", { row: { shape: "ambiguous" } }],
    ["row is display kind", { row: { kind: "display" } }],
    ["spec is display kind", { spec: () => ({ kind: "display", capability: "display" }) }],
    ["row is O2 legacy", { prepare: ({ adapter, id }) => { markLegacy(adapter, [id]); } }],
  ];

  it.each(cases)("%s", async (_name, c) => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const shape = c.row?.shape ?? "bound";
    let id: string;
    if (shape === "bound") id = progressedRow(store, c.row);
    else {
      id = reserveRow(store, c.row);
      if (shape === "ambiguous") store.markSendAmbiguous(id);
    }
    c.prepare?.({ store, adapter, id });
    const row = store.getMessage(id) as CardMessageRecord;
    const grant: RecoveryGrant = { storeCardId: id, messageId: row.messageId ?? "800000000000000000" };
    const q = queueRig(time, store, { grants: c.grants ? c.grants(grant) : [grant] });
    c.before?.({ q, time, row, grant });
    const before = store.getMessage(id);
    const reserve = vi.spyOn(store, "reserveSequence");
    const reserveTerminal = vi.spyOn(store, "reserveTerminalSequence");
    expect(q.queue.open(adoptSpec(q.bot, row, grant, c.spec?.(row, grant)))).toBe("contract");
    expect(await q.queue.finalize("recovery-1", buildClosureFrame("interrupted", TEMPLATE, buildOptions(row)) as CardFrame, "interrupted"))
      .toEqual({ outcome: "skipped" });
    await time.advance(5000);
    expect(q.net.requests).toHaveLength(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(reserveTerminal).not.toHaveBeenCalled();
    expect(store.getMessage(id)).toEqual(before);
  });
});

describe("T10: transport-side fences on an adopted card refuse before any reservation", () => {
  const authored = { k: "authored", profile: "octo/v1", plain: "closed",
    card: { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "closed", wrap: true }] } } as unknown as CardFrame;

  const cases: Array<[string, { change?: (q: QueueRig) => void; frame?: (row: CardMessageRecord) => CardFrame; outcome: string }]> = [
    ["policy template changed between adoption and attempt 1", { change: (q) => { q.policy.template = { ...TEMPLATE, version: "0.5.0" }; }, outcome: "contract" }],
    ["policy template removed between adoption and attempt 1", { change: (q) => { q.policy.template = undefined; }, outcome: "contract" }],
    ["closure frame ref differs from the row's template", { frame: (row) => buildClosureFrame("interrupted", { ...TEMPLATE, version: "0.5.0" }, buildOptions(row)) as CardFrame, outcome: "contract" }],
    ["authored frame on an adopted card", { frame: () => authored, outcome: "contract" }],
    ["policy denied before reservation", { change: (q) => { q.policy.allowed = false; }, outcome: "policy" }],
  ];

  it.each(cases)("%s", async (_name, c) => {
    const time = manualTime();
    const { store } = fileDb(time).open();
    const id = progressedRow(store);
    const row = store.getMessage(id) as CardMessageRecord;
    const grant: RecoveryGrant = { storeCardId: id, messageId: row.messageId as string };
    const q = queueRig(time, store, { grants: [grant] });
    expect(q.queue.open(adoptSpec(q.bot, row, grant))).toBe("opened");
    c.change?.(q);
    const reserve = vi.spyOn(store, "reserveSequence");
    const reserveTerminal = vi.spyOn(store, "reserveTerminalSequence");
    const closure = c.frame ? c.frame(row) : buildClosureFrame("interrupted", TEMPLATE, buildOptions(row)) as CardFrame;
    expect(await q.queue.finalize("recovery-1", closure, "interrupted")).toEqual({ outcome: c.outcome });
    await time.advance(5000);
    expect(reserve).not.toHaveBeenCalled();
    expect(reserveTerminal).not.toHaveBeenCalled();
    expect(q.net.requests).toHaveLength(0);
    expect(store.getMessage(id)).toEqual(row);
  });
});

// ─── T13: no automatic card_sessions ───────────────────────────────────────

describe("T13: an automatic card can never own a card_sessions row", () => {
  it("the startup invariant session_card_kind rejects it", () => {
    const time = manualTime();
    const { adapter, store } = fileDb(time).open();
    const id = boundRow(store);
    store.reserveTerminalSequence(id, "completed");
    expect(checkCardInvariants(adapter)).toEqual([]);
    const now = time.wall.nowUtcMs();
    adapter.prepare(
      `INSERT INTO card_sessions (session_id, card_id, requester_uid, session_key, channel_id, channel_type, origin_generation,
         topic_scope, reset_epoch, contract_version, authored_contract_json, authored_data_hash, status, expires_at, created_at)
       VALUES ('session-1', ?, 'u1', 'group:g1', 'g1', 2, 'gen-1', NULL, 0, 1, '{}', 'hash', 'pending', ?, ?)`,
    ).run(id, now + 86_400_000, now);
    expect(checkCardInvariants(adapter)).toContain("session_card_kind");
  });
});

describe("harness: the file database runs in WAL mode", () => {
  it("uses journal_mode=wal", () => {
    const time = manualTime();
    const { adapter } = fileDb(time).open();
    expect((adapter.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  });
});
