/**
 * D-B/N2 reconstruction (XIN-2275 R1 C1/C4): every write-queue construction
 * re-derives capability suspension from unresolved `card_messages` rows.
 * Real SQLite, controlled clock and scripted transport.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCardApi } from "../cards/api.js";
import type { BotRef, Limits, PolicySnapshot, RegistryData } from "../cards/contracts.js";
import { migrateCardSchema } from "../cards/migrations.js";
import { normalizeOrigin } from "../cards/origin.js";
import { createPacer } from "../cards/pacer.js";
import type { Authorization, CardPolicy } from "../cards/policy.js";
import { CardStore, CardStoreError, type CardBinding } from "../cards/store.js";
import { createWriteQueue, type CardFrame, type CardSpec, type CardWriteQueue } from "../cards/write-queue.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, scriptedFetch, type ManualTime } from "./fixtures/card-write-harness.js";

const API = "https://api.example.com";
const LIMITS: Limits = { maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384, maxInputTextBytes: 4096, maxInputsBytes: 16384 };
const DATA: RegistryData = {
  reasoningId: "octo-progress", state: "reasoning", title: "Reasoning", statusLabel: "Working", statusTone: "Accent",
  timerText: "Reasoning", traceExpanded: true, traceCollapsed: false, collapsedSummary: "Reasoning in progress",
  phases: [{ thought: "Working", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
};
const frame = (label: string): CardFrame =>
  ({ k: "registry", ref: { id: "ai.reasoning-process", version: "0.4.0" }, state: "reasoning", data: { ...DATA, progressText: label } });
const BOTH = ["automatic", "display"];

const roots: string[] = [];
const adapters: DbAdapter[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const a of adapters.splice(0)) { try { a.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** One Bot: its own per-Bot database, store, transport and policy. */
function bot(time: ManualTime, name = "a") {
  const root = mkdtempSync(join(tmpdir(), `cards-n2-${name}-`));
  roots.push(root);
  const adapter = createAdapter(join(root, "cc-octo.db"));
  adapters.push(adapter);
  new SessionStore(adapter).init();
  migrateCardSchema(adapter, { installationRef: `install-${name}`, lineageId: `lineage-${name}`, nowMs: time.wall.nowUtcMs() });
  let id = 0;
  const newStore = () => new CardStore(adapter, { clock: time.wall, newId: () => `${name}-${++id}-${randomUUID()}` });
  const store = newStore();
  const net = scriptedFetch(time);
  const api = createCardApi({ apiUrl: API, credential: `token-${name}`, fetchImpl: net.fetchImpl, nowUtcMs: time.wall.nowUtcMs });
  const ref: BotRef = { originKey: normalizeOrigin(API).key, credentialRef: `opaque-${name}` };
  const policy = {
    allowed: true as boolean,
    authorize(): Authorization {
      if (!this.allowed) return { allowed: false, reason: "policy_revoked" };
      return { allowed: true, snapshot: {} as PolicySnapshot, limits: LIMITS };
    },
  } satisfies Pick<CardPolicy, "authorize"> & { allowed: boolean };
  const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
  const queue = (s: CardStore = store): CardWriteQueue =>
    createWriteQueue({ api, store: s, policy, pacer, clock: time.clock, timers: time.timers });
  const binding: CardBinding = { sessionKey: "group:g1", channelId: "g1", channelType: 2, topicScope: null, generation: "turn-1", resetEpoch: 0 };
  let n = 0;
  const spec = (capability: "automatic" | "display" = "automatic"): CardSpec =>
    ({ cardId: `card-${++n}`, kind: capability, capability, ctx: { botRef: ref }, binding, clientMsgNo: randomUUID() });
  /** A reserved row left in `sending`, as after a crash mid-send. */
  const sendingRow = (kind: "automatic" | "display"): string => {
    const r = store.reserveMessage({ kind, binding, bodyDigest: "d".repeat(64), clientMsgNo: randomUUID() });
    if (r.kind !== "reserved") throw new Error("fixture");
    return r.cardId;
  };
  const ambiguousRow = (kind: "automatic" | "display"): string => {
    const cardId = sendingRow(kind);
    store.markSendAmbiguous(cardId);
    return cardId;
  };
  const interactiveRow = (): string => {
    const r = store.reserveSession({ binding, bodyDigest: "e".repeat(64), clientMsgNo: randomUUID(),
      contract: { requesterUid: "u1", contractVersion: 1, authoredContractJson: "{}", authoredDataHash: "h" } });
    if (r.kind !== "reserved") throw new Error("fixture");
    return r.cardId;
  };
  /** Operator-clearance fixture only: the store primitive is not authorized by this package. */
  const clearRow = (cardId: string): void => {
    const now = time.wall.nowUtcMs();
    adapter.prepare(`UPDATE card_messages SET state = 'abandoned', terminal_reason = 'interrupted', terminal_at = ?, retain_until = ?,
      updated_at = ? WHERE card_id = ?`).run(now, now + 86_400_000, now, cardId);
  };
  return { adapter, store, newStore, net, policy, pacer, queue, spec, sendingRow, ambiguousRow, interactiveRow, clearRow };
}

async function sendOne(time: ManualTime, q: CardWriteQueue, s: CardSpec): Promise<void> {
  expect(q.open(s)).toBe("opened");
  q.enqueue(s.cardId, frame("first"));
  await time.advance(800);
}

const fence = (time: ManualTime) => ({ reason: "shutdown" as const, deadlineMono: time.now() + 3000, signal: new AbortController().signal });

// ─── store read ─────────────────────────────────────────────────────────────

describe("CardStore.unresolvedSendKinds", () => {
  it("returns the kinds of rows in sending or ambiguous only", async () => {
    const time = manualTime();
    const b = bot(time);
    expect(b.store.unresolvedSendKinds()).toEqual([]);
    const q = b.queue();
    await sendOne(time, q, b.spec("automatic"));
    const failed = b.sendingRow("display");
    b.store.markSendFailed(failed);
    const abandoned = b.sendingRow("display");
    b.clearRow(abandoned);
    expect(b.store.unresolvedSendKinds()).toEqual([]);
    b.ambiguousRow("display");
    b.sendingRow("automatic");
    b.ambiguousRow("automatic");
    expect([...b.store.unresolvedSendKinds()].sort()).toEqual(BOTH);
    b.interactiveRow();
    expect([...b.store.unresolvedSendKinds()].sort()).toEqual(["automatic", "display", "interactive"]);
  });

  it("is read-only", () => {
    const time = manualTime();
    const b = bot(time);
    b.ambiguousRow("automatic");
    const before = b.adapter.prepare("SELECT * FROM card_messages ORDER BY card_id").all();
    b.store.unresolvedSendKinds();
    expect(b.adapter.prepare("SELECT * FROM card_messages ORDER BY card_id").all()).toEqual(before);
  });

  it("fails closed by throwing when the store cannot be read", () => {
    const time = manualTime();
    const b = bot(time);
    b.store.retire();
    expect(() => b.store.unresolvedSendKinds()).toThrow(CardStoreError);
    const other = b.newStore();
    b.adapter.close();
    expect(() => other.unresolvedSendKinds()).toThrow(CardStoreError);
  });
});

// ─── C4 total mapping ───────────────────────────────────────────────────────

describe("C4: total reconstruction mapping, one case per row", () => {
  it("no unresolved rows -> nothing suspended", () => {
    const time = manualTime();
    expect(bot(time).queue().suspendedCapabilities()).toEqual([]);
  });

  it.each([["ambiguous"], ["sending"]] as const)("automatic (%s) -> automatic only", (state) => {
    const time = manualTime();
    const b = bot(time);
    if (state === "ambiguous") b.ambiguousRow("automatic"); else b.sendingRow("automatic");
    expect(b.queue().suspendedCapabilities()).toEqual(["automatic"]);
  });

  it.each([["ambiguous"], ["sending"]] as const)("display (%s) -> display only", (state) => {
    const time = manualTime();
    const b = bot(time);
    if (state === "ambiguous") b.ambiguousRow("display"); else b.sendingRow("display");
    expect(b.queue().suspendedCapabilities()).toEqual(["display"]);
  });

  it("interactive -> automatic and display", () => {
    const time = manualTime();
    const b = bot(time);
    b.interactiveRow();
    expect(b.queue().suspendedCapabilities()).toEqual(BOTH);
  });

  it.each([
    ["an unknown kind", ["bogus"]],
    ["a known kind next to an unknown one", ["automatic", "Automatic"]],
    ["a non-string value", [7]],
    ["a non-array result", "automatic"],
    ["a thenable result", Promise.resolve([])],
    ["undefined", undefined],
  ])("%s -> automatic and display", (_name, value) => {
    const time = manualTime();
    const b = bot(time);
    vi.spyOn(b.store, "unresolvedSendKinds").mockReturnValue(value as unknown as readonly string[]);
    expect(b.queue().suspendedCapabilities()).toEqual(BOTH);
  });

  it("read failure -> automatic and display", () => {
    const time = manualTime();
    const b = bot(time);
    vi.spyOn(b.store, "unresolvedSendKinds").mockImplementation(() => { throw new CardStoreError("storage_failure"); });
    expect(b.queue().suspendedCapabilities()).toEqual(BOTH);
  });
});

// ─── XIN-2275 R1 tests 2, 3, 6, 11, 12, 13 ──────────────────────────────────

describe("R1 test 2: restart over an ambiguous automatic row", () => {
  it("open() returns suspended for automatic with 0 transport calls; display opens and sends", async () => {
    const time = manualTime();
    const b = bot(time);
    b.ambiguousRow("automatic");
    const q = b.queue();
    const reserve = vi.spyOn(b.store, "reserveMessage");
    const s = b.spec("automatic");
    expect(q.open(s)).toBe("suspended");
    expect(q.enqueue(s.cardId, frame("a"))).toBe("unknown");
    await time.advance(5000);
    expect(b.net.requests).toHaveLength(0);
    expect(reserve).not.toHaveBeenCalled();
    const d = b.spec("display");
    await sendOne(time, q, d);
    expect(b.net.sends()).toHaveLength(1);
    expect(q.status(d.cardId)?.phase).toBe("active");
  });
});

describe("R1 test 3: restart over a sending row whose persistence threw", () => {
  it("suspends without calling abandonUnsent, and the row stays sending", async () => {
    const time = manualTime();
    const first = bot(time);
    const q1 = first.queue();
    const ambiguous = vi.spyOn(first.store, "markSendAmbiguous").mockImplementation(() => { throw new Error("storage"); });
    first.net.reply({ status: 503 });
    const s = first.spec();
    await sendOne(time, q1, s);
    expect(ambiguous).toHaveBeenCalledTimes(1);
    const row = first.store.getMessage(q1.status(s.cardId)?.storeCardId as string);
    expect(row?.state).toBe("sending");
    const abandon = vi.spyOn(CardStore.prototype, "abandonUnsent");
    const restarted = first.newStore();
    const q2 = first.queue(restarted);
    expect(q2.suspendedCapabilities()).toEqual(["automatic"]);
    expect(q2.open(first.spec())).toBe("suspended");
    await time.advance(5000);
    expect(abandon).not.toHaveBeenCalled();
    expect(first.net.sends()).toHaveLength(1);
    expect(restarted.getMessage(row?.cardId as string)?.state).toBe("sending");
  });
});

describe("R1 test 6: clearance fixture lifts only at the next construction", () => {
  it("existing queue stays suspended; a new queue sends a new card once; the old card is never resent or edited", async () => {
    const time = manualTime();
    const b = bot(time);
    const old = b.ambiguousRow("automatic");
    const oldRow = b.store.getMessage(old);
    const existing = b.queue();
    expect(existing.suspendedCapabilities()).toEqual(["automatic"]);
    b.clearRow(old);
    const cleared = b.store.getMessage(old);
    expect(cleared).toMatchObject({ state: "abandoned", terminalReason: "interrupted", clientMsgNo: oldRow?.clientMsgNo });
    expect(cleared?.retainUntil).toBeGreaterThanOrEqual((cleared?.terminalAt as number) + 86_400_000);
    expect(b.store.reserveMessage({ kind: "automatic", binding: b.spec().binding, bodyDigest: "f".repeat(64),
      clientMsgNo: oldRow?.clientMsgNo as string })).toEqual({ kind: "duplicate_client_msg_no" });
    expect(existing.open(b.spec())).toBe("suspended");
    expect(existing.suspendedCapabilities()).toEqual(["automatic"]);
    const fresh = b.queue();
    expect(fresh.suspendedCapabilities()).toEqual([]);
    const s = b.spec();
    await sendOne(time, fresh, s);
    await time.advance(5000);
    expect(b.net.sends()).toHaveLength(1);
    expect(JSON.parse(b.net.sends()[0].body).client_msg_no).toBe(s.clientMsgNo);
    expect(b.net.edits()).toHaveLength(0);
    expect(b.store.getMessage(old)).toEqual(cleared);
  });

  it("two unresolved rows: clearing one keeps the capability suspended, clearing both lifts it", () => {
    const time = manualTime();
    const b = bot(time);
    const one = b.ambiguousRow("automatic");
    const two = b.sendingRow("automatic");
    b.clearRow(one);
    expect(b.queue().suspendedCapabilities()).toEqual(["automatic"]);
    b.clearRow(two);
    expect(b.queue().suspendedCapabilities()).toEqual([]);
  });
});

describe("R1 test 11: in-process rebuild without restart", () => {
  it("queue B over the same store stays suspended after queue A was closed and drained", async () => {
    const time = manualTime();
    const b = bot(time);
    const a = b.queue();
    b.net.reply({ status: 503 });
    await sendOne(time, a, b.spec());
    expect(a.suspendedCapabilities()).toEqual(["automatic"]);
    const report = a.drain(fence(time));
    await time.advance(3000);
    await report;
    const sends = b.net.sends().length;
    const rebuilt = b.queue();
    expect(rebuilt.open(b.spec())).toBe("suspended");
    // A Bot re-add constructs a fresh store object over the same per-Bot database.
    const readded = b.queue(b.newStore());
    expect(readded.open(b.spec())).toBe("suspended");
    await time.advance(5000);
    expect(b.net.sends()).toHaveLength(sends);
    expect(rebuilt.open(b.spec("display"))).toBe("opened");
  });

  it("reads the store exactly once per construction, inside the factory", () => {
    const time = manualTime();
    const b = bot(time);
    const read = vi.spyOn(b.store, "unresolvedSendKinds");
    const q = b.queue();
    expect(read).toHaveBeenCalledTimes(1);
    q.open(b.spec());
    q.suspendedCapabilities();
    expect(read).toHaveBeenCalledTimes(1);
    b.queue();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("R1 test 12: the reconstruction read throws during construction", () => {
  it("suspends both capabilities with 0 transport calls and still returns a usable queue", async () => {
    const time = manualTime();
    const b = bot(time);
    vi.spyOn(b.store, "unresolvedSendKinds").mockImplementation(() => { throw new Error("disk"); });
    const q = b.queue();
    expect(q.open(b.spec("automatic"))).toBe("suspended");
    expect(q.open(b.spec("display"))).toBe("suspended");
    await time.advance(5000);
    expect(b.net.requests).toHaveLength(0);
    expect(await q.drain(fence(time))).toEqual({ settled: 0, aborted: 0, unresolved: 0 });
  });
});

describe("R1 test 13: no in-process lift", () => {
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const surface: Exact<keyof CardWriteQueue,
    "kind" | "close" | "drain" | "open" | "enqueue" | "finalize" | "cancelNonterminal" | "status" | "suspendedCapabilities"> = true;

  it("exposes no method that removes a capability from the suspended set", () => {
    const time = manualTime();
    const q = bot(time).queue();
    expect(surface).toBe(true);
    expect(Object.keys(q).sort()).toEqual(
      ["cancelNonterminal", "close", "drain", "enqueue", "finalize", "kind", "open", "status", "suspendedCapabilities"]);
    expect(Object.keys(q).filter((k) => /lift|clear|reset|resume|unsuspend|restore/i.test(k))).toEqual([]);
    expect(Object.isFrozen(q)).toBe(true);
  });

  it("suspendedCapabilities() is a read-only snapshot", () => {
    const time = manualTime();
    const b = bot(time);
    b.ambiguousRow("automatic");
    const q = b.queue();
    const view = q.suspendedCapabilities();
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => { (view as string[]).length = 0; }).toThrow(TypeError);
    expect(q.suspendedCapabilities()).toEqual(["automatic"]);
    expect(q.open(b.spec())).toBe("suspended");
  });

  it("suspension is monotonic within an instance: clock, policy, other-capability success and drain never lift it", async () => {
    const time = manualTime();
    const b = bot(time);
    const row = b.ambiguousRow("automatic");
    const q = b.queue();
    await time.advance(24 * 60 * 60 * 1000 + 1);
    b.policy.allowed = false;
    b.policy.allowed = true;
    await sendOne(time, q, b.spec("display"));
    expect(b.net.sends()).toHaveLength(1);
    b.clearRow(row);
    expect(q.open(b.spec())).toBe("suspended");
    expect(q.suspendedCapabilities()).toEqual(["automatic"]);
  });
});

// ─── isolation ──────────────────────────────────────────────────────────────

describe("per-Bot isolation", () => {
  it("an unresolved row in Bot A's store never suspends Bot B, even on a shared origin", async () => {
    const time = manualTime();
    const a = bot(time, "a");
    const b = bot(time, "b");
    a.ambiguousRow("automatic");
    const qa = a.queue();
    const qb = b.queue();
    expect(qa.suspendedCapabilities()).toEqual(["automatic"]);
    expect(qb.suspendedCapabilities()).toEqual([]);
    await sendOne(time, qb, b.spec());
    expect(b.net.sends()).toHaveLength(1);
    expect(a.net.sends()).toHaveLength(0);
  });
});
