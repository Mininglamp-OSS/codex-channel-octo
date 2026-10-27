import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createCardApi, serializeEditAuthored, type StaleSequenceMatcher } from "../cards/api.js";
import type { BotRef, Limits, PolicySnapshot, RegistryData, WireState } from "../cards/contracts.js";
import { migrateCardSchema } from "../cards/migrations.js";
import { normalizeOrigin } from "../cards/origin.js";
import { createPacer, type Pacer } from "../cards/pacer.js";
import { createPolicy, type Authorization, type CardPolicy } from "../cards/policy.js";
import { CardStore, type CardBinding } from "../cards/store.js";
import { botRefOf, createTelemetrySink, originRefOf } from "../cards/telemetry.js";
import { createWriteQueue, type CardFrame, type CardSpec, type OpenResult } from "../cards/write-queue.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { profile } from "./fixtures/card-profile.js";
import { manualTime, scriptedFetch, seqOf, type ManualTime } from "./fixtures/card-write-harness.js";

// ─── Rig ────────────────────────────────────────────────────────────────────

const API = "https://api.example.com";
const LIMITS: Limits = { maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384, maxInputTextBytes: 4096, maxInputsBytes: 16384 };
const DATA: RegistryData = {
  reasoningId: "octo-progress",
  state: "reasoning",
  title: "Reasoning",
  statusLabel: "Working",
  statusTone: "Accent",
  timerText: "Reasoning",
  traceExpanded: true,
  traceCollapsed: false,
  collapsedSummary: "Reasoning in progress",
  phases: [{ thought: "Working", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
};

function frame(label: string, state: WireState = "reasoning"): CardFrame {
  return { k: "registry", ref: { id: "ai.reasoning-process", version: "0.4.0" }, state,
    data: { ...DATA, state, progressText: label, ...(state === "error" ? { errorTitle: "Failed", errorMessage: "Failed" } : {}) } };
}
const done = (label = "done") => frame(label, "completed");
const progressOf = (body: string): string => {
  const parsed = JSON.parse(body) as { data?: { progressText?: string }; payload?: { data?: { progressText?: string } } };
  return (parsed.data ?? parsed.payload?.data)?.progressText as string;
};

const roots: string[] = [];
const adapters: DbAdapter[] = [];
afterEach(() => {
  for (const a of adapters.splice(0)) { try { a.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newStore(time: ManualTime): CardStore {
  const root = mkdtempSync(join(tmpdir(), "cards-wq-"));
  roots.push(root);
  const adapter = createAdapter(join(root, "cc-octo.db"));
  adapters.push(adapter);
  new SessionStore(adapter).init();
  migrateCardSchema(adapter, { installationRef: "install-a", lineageId: "lineage-1", nowMs: time.wall.nowUtcMs() });
  let id = 0;
  return new CardStore(adapter, { clock: time.wall, newId: () => `id-${++id}` });
}

interface StubPolicy extends Pick<CardPolicy, "authorize"> {
  allowed: boolean;
  maxPayloadBytes: number;
  readonly calls: { op: string; credentialRef: string }[];
}

function stubPolicy(bot: BotRef): StubPolicy {
  const p: StubPolicy = {
    allowed: true,
    maxPayloadBytes: 16384,
    calls: [],
    authorize(op, ctx): Authorization {
      p.calls.push({ op, credentialRef: ctx.botRef.credentialRef });
      if (!p.allowed || ctx.botRef.credentialRef !== bot.credentialRef) return { allowed: false, reason: "policy_revoked" };
      return { allowed: true, snapshot: {} as PolicySnapshot, limits: { ...LIMITS, maxPayloadBytes: p.maxPayloadBytes } };
    },
  };
  return p;
}

interface RigOptions {
  time?: ManualTime;
  pacer?: Pacer;
  apiUrl?: string;
  credential?: string;
  credentialRef?: string;
  staleSequence?: StaleSequenceMatcher;
  ignoreAbort?: boolean;
  lines?: string[];
}

function rig(o: RigOptions = {}) {
  const time = o.time ?? manualTime();
  const lines = o.lines ?? [];
  const sink = createTelemetrySink({ wall: time.wall, mono: time.clock, write: (l) => { lines.push(l); } });
  const pacer = o.pacer ?? createPacer({ clock: time.clock, timers: time.timers, rng: () => 0, telemetry: { sink, originRef: originRefOf } });
  const net = scriptedFetch(time, { ignoreAbort: o.ignoreAbort });
  const apiUrl = o.apiUrl ?? API;
  const api = createCardApi({ apiUrl, credential: o.credential ?? "token-a", fetchImpl: net.fetchImpl,
    nowUtcMs: time.wall.nowUtcMs, ...(o.staleSequence ? { staleSequence: o.staleSequence } : {}) });
  const bot: BotRef = { originKey: normalizeOrigin(apiUrl).key, credentialRef: o.credentialRef ?? "opaque-a" };
  const store = newStore(time);
  const policy = stubPolicy(bot);
  let gateCount = 0;
  const counted: Pacer = { ...pacer, gate: (origin) => { gateCount++; return pacer.gate(origin); } };
  const gateCalls = () => gateCount;
  const queue = createWriteQueue({ api, store, policy, pacer: counted, clock: time.clock, timers: time.timers,
    telemetry: { sink, botRef: botRefOf(bot), originRef: originRefOf(apiUrl) } });
  let n = 0;
  const generation = "turn-1";
  const spec = (over: Partial<CardSpec> = {}): CardSpec => {
    const binding: CardBinding = { sessionKey: "group:g1", channelId: "g1", channelType: 2, topicScope: null, generation, resetEpoch: 0 };
    return { cardId: `card-${++n}`, kind: "automatic", capability: "automatic", ctx: { botRef: bot }, binding,
      clientMsgNo: randomUUID(), ...over };
  };
  const metrics = () => lines.map((l) => JSON.parse(l.slice("[cards-metric] ".length)) as
    { name: string; labels: Record<string, string>; value: number });
  return { time, net, api, bot, store, policy, pacer, gateCalls, queue, spec, metrics, lines, sink };
}

type Rig = ReturnType<typeof rig>;

/** Open a card and bring it to `active` with its first frame acknowledged. */
async function activeCard(r: Rig, over: Partial<CardSpec> = {}): Promise<string> {
  const s = r.spec(over);
  expect(r.queue.open(s)).toBe("opened");
  r.queue.enqueue(s.cardId, frame("first"));
  await r.time.advance(800);
  expect(r.queue.status(s.cardId)?.phase).toBe("active");
  return s.cardId;
}

function storeRow(r: Rig, cardId: string) {
  return r.store.getMessage(r.queue.status(cardId)?.storeCardId as string);
}

// ─── T1 debounce ────────────────────────────────────────────────────────────

describe("T1: 800 ms debounce with the newest coalesced state", () => {
  it("sends no first frame at 799 ms and exactly one at 800 ms carrying the newest state", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    const t0 = r.time.now();
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advanceTo(t0 + 300);
    r.queue.enqueue(s.cardId, frame("b"));
    await r.time.advanceTo(t0 + 700);
    r.queue.enqueue(s.cardId, frame("c"));
    await r.time.advanceTo(t0 + 799);
    expect(r.net.requests).toHaveLength(0);
    await r.time.advanceTo(t0 + 800);
    expect(r.net.sends()).toHaveLength(1);
    expect(r.net.sends()[0].at).toBe(t0 + 800);
    expect(progressOf(r.net.sends()[0].body)).toBe("c");
  });

  it("coalesces progress edits the same way: one transient edit at +800 with the newest state", async () => {
    const r = rig();
    const id = await activeCard(r);
    const t1 = r.time.now();
    r.queue.enqueue(id, frame("p1"));
    await r.time.advanceTo(t1 + 500);
    r.queue.enqueue(id, frame("p2"));
    await r.time.advanceTo(t1 + 799);
    expect(r.net.edits()).toHaveLength(0);
    await r.time.advanceTo(t1 + 800);
    expect(r.net.edits()).toHaveLength(1);
    const body = JSON.parse(r.net.edits()[0].body) as { transient?: boolean };
    expect(body.transient).toBe(true);
    expect(progressOf(r.net.edits()[0].body)).toBe("p2");
    await r.time.advance(5000);
    expect(r.net.edits()).toHaveLength(1);
  });
});

// ─── T2 / T12 retries and sequences ─────────────────────────────────────────

describe("T2: edit retries reuse seq and body; 100 then 250 ms; 3 total attempts", () => {
  it("retries exactly at +100 and +250 and then reports retry_exhausted", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 503 }, { status: 503 }, { status: 503 });
    const t1 = r.time.now();
    r.queue.enqueue(id, frame("p"));
    await r.time.advanceTo(t1 + 800);
    expect(r.net.edits()).toHaveLength(1);
    await r.time.advanceTo(t1 + 899);
    expect(r.net.edits()).toHaveLength(1);
    await r.time.advanceTo(t1 + 900);
    expect(r.net.edits()).toHaveLength(2);
    await r.time.advanceTo(t1 + 1149);
    expect(r.net.edits()).toHaveLength(2);
    await r.time.advanceTo(t1 + 1150);
    const edits = r.net.edits();
    expect(edits).toHaveLength(3);
    expect(edits.map((e) => e.at)).toEqual([t1 + 800, t1 + 900, t1 + 1150]);
    expect(new Set(edits.map((e) => e.body)).size).toBe(1);
    expect(edits.map(seqOf)).toEqual([1, 1, 1]);
    await r.time.advance(10_000);
    expect(r.net.edits()).toHaveLength(3);
    const codes = r.metrics().filter((m) => m.name === "card_edit_total").map((m) => m.labels.code);
    expect(codes).toEqual(["retry_exhausted"]);
    expect(r.queue.status(id)?.phase).toBe("active");
  });

  it("a network fault then success acknowledges on the second attempt under the same seq", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ network: true });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(900);
    expect(r.net.edits().map(seqOf)).toEqual([1, 1]);
    expect(r.queue.status(id)).toMatchObject({ seqReserved: 1, seqAcked: 1 });
  });

  it("terminal edits follow the same retry budget", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 500 }, { status: 502 }, { status: 504 });
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(1000);
    expect(await result).toEqual({ outcome: "retry_exhausted", seq: 1 });
    expect(r.net.edits()).toHaveLength(3);
  });
});

describe("T12: store sequence reservation", () => {
  it("reserves before transport, starts at 1, increases strictly and never moves the ack fence back", async () => {
    const r = rig();
    const id = await activeCard(r);
    const reserve = vi.spyOn(r.store, "reserveSequence");
    const ack = vi.spyOn(r.store, "ackSequence");
    for (const label of ["p1", "p2", "p3"]) {
      r.queue.enqueue(id, frame(label));
      await r.time.advance(800);
    }
    expect(r.net.edits().map(seqOf)).toEqual([1, 2, 3]);
    expect(reserve).toHaveBeenCalledTimes(3);
    // Each reservation happened before its edit request was recorded.
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    expect(ack.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
    const row = storeRow(r, id);
    expect(row).toMatchObject({ seqReserved: 3, seqAcked: 3 });
    // An out-of-order (older) acknowledgement never moves the fence backwards.
    expect(r.store.ackSequence(row!.cardId, 2)).toEqual({ kind: "acked", seqAcked: 3 });
  });

  it("a retried edit keeps its seq while a new logical edit gets the next one", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 503 }, { status: 503 }, { status: 503 });
    r.queue.enqueue(id, frame("p1"));
    await r.time.advance(1200);
    r.queue.enqueue(id, frame("p2"));
    await r.time.advance(800);
    expect(r.net.edits().map(seqOf)).toEqual([1, 1, 1, 2]);
    expect(storeRow(r, id)).toMatchObject({ seqReserved: 2, seqAcked: 2 });
  });
});

// ─── T5 / T7 pacing in the queue ────────────────────────────────────────────

describe("T5: server Retry-After 900 s through the queue", () => {
  it("sends zero card requests before 900000 ms and only the eligible dirty work at 900000", async () => {
    const r = rig();
    const id = await activeCard(r);
    const other = await activeCard(r);
    r.net.reply({ status: 429, headers: { "retry-after": "900" } });
    const t1 = r.time.now();
    r.queue.enqueue(id, frame("p"));
    await r.time.advanceTo(t1 + 800);
    const receipt = r.time.now();
    const before = r.net.requests.length;
    r.queue.enqueue(other, frame("q"));
    await r.time.advanceTo(receipt + 899_999);
    expect(r.net.requests.length).toBe(before);
    await r.time.advanceTo(receipt + 900_000);
    const after = r.net.edits().slice(-2);
    expect(after.map((e) => e.at)).toEqual([receipt + 900_000, receipt + 900_000]);
    // The retried edit is byte-identical to the rate-limited attempt.
    const retried = r.net.edits().filter((e) => progressOf(e.body) === "p");
    expect(retried).toHaveLength(2);
    expect(retried[0].body).toBe(retried[1].body);
    expect(r.queue.status(id)?.seqAcked).toBe(1);
  });
});

describe("T7: wake without any SDK event", () => {
  it("sends a pending frame when E passes, by timer only, without spinning", async () => {
    const r = rig();
    const id = await activeCard(r);
    const other = await activeCard(r);
    r.net.reply({ status: 429, headers: { "retry-after": "30" } });
    r.queue.enqueue(other, frame("trigger"));
    await r.time.advance(800);
    const e = r.time.now() + 30_000;
    r.queue.enqueue(id, frame("pending"));
    const timers = r.time.scheduled();
    await r.time.advanceTo(e - 1);
    expect(r.net.edits().filter((x) => progressOf(x.body) === "pending")).toHaveLength(0);
    await r.time.advanceTo(e);
    const sent = r.net.edits().filter((x) => progressOf(x.body) === "pending");
    expect(sent).toHaveLength(1);
    expect(sent[0].at).toBe(e);
    expect(r.time.scheduled() - timers).toBeLessThanOrEqual(8);
  });
});

// ─── T8 / T9 / T10 origin sharing and Bot isolation ─────────────────────────

describe("T8/T9/T10: shared origin cooldown with per-Bot isolation", () => {
  function pair() {
    const time = manualTime();
    const lines: string[] = [];
    const sink = createTelemetrySink({ wall: time.wall, mono: time.clock, write: (l) => { lines.push(l); } });
    const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0, telemetry: { sink, originRef: originRefOf } });
    const a = rig({ time, pacer, lines, apiUrl: "https://API.Example.com", credential: "token-a", credentialRef: "opaque-a" });
    const b = rig({ time, pacer, lines, apiUrl: "https://api.example.com:443/base", credential: "token-b", credentialRef: "opaque-b" });
    const c = rig({ time, pacer, lines, apiUrl: "https://other.example.com", credential: "token-c", credentialRef: "opaque-c" });
    return { time, pacer, a, b, c, lines };
  }

  it("T8: Bot B on the same normalized origin waits for Bot A's eligibility deadline", async () => {
    const { time, a, b } = pair();
    const ida = await activeCard(a);
    const idb = await activeCard(b);
    a.net.reply({ status: 429, headers: { "retry-after": "30" } });
    a.queue.enqueue(ida, frame("a"));
    await time.advance(800);
    const e = time.now() + 30_000;
    b.queue.enqueue(idb, frame("b"));
    await time.advanceTo(e - 1);
    expect(b.net.edits()).toHaveLength(0);
    await time.advanceTo(e);
    expect(b.net.edits()).toHaveLength(1);
    expect(b.net.edits()[0].at).toBe(e);
  });

  it("T9: Bot C on a different origin is unaffected by the cooldown", async () => {
    const { time, a, c } = pair();
    const ida = await activeCard(a);
    const idc = await activeCard(c);
    a.net.reply({ status: 429, headers: { "retry-after": "300" } });
    a.queue.enqueue(ida, frame("a"));
    await time.advance(800);
    const t = time.now();
    c.queue.enqueue(idc, frame("c"));
    await time.advance(800);
    expect(c.net.edits()).toHaveLength(1);
    expect(c.net.edits()[0].at).toBe(t + 800);
  });

  it("T10: no credential, policy, payload or ownership crosses Bots during a shared cooldown", async () => {
    const { time, pacer, a, b } = pair();
    const ida = await activeCard(a);
    const idb = await activeCard(b, { cardId: "bot-b-card" });
    a.net.reply({ status: 429, headers: { "retry-after": "30" } });
    a.queue.enqueue(ida, frame("secret-of-a"));
    await time.advance(800);
    b.queue.enqueue(idb, frame("b-state"));
    const view = JSON.stringify(pacer.inspect(normalizeOrigin("https://api.example.com")));
    expect(view).toContain("eligibleAtMono");
    await time.advance(30_000);
    for (const req of b.net.requests) {
      expect(req.authorization).toBe("Bearer token-b");
      expect(req.body).not.toContain("secret-of-a");
      expect(req.url.startsWith("https://api.example.com/base/")).toBe(true);
    }
    for (const req of a.net.requests) expect(req.authorization).toBe("Bearer token-a");
    expect(new Set(b.policy.calls.map((c) => c.credentialRef))).toEqual(new Set(["opaque-b"]));
    expect(new Set(a.policy.calls.map((c) => c.credentialRef))).toEqual(new Set(["opaque-a"]));
    // Ownership stays per Bot: A's queue does not know B's card and vice versa.
    expect(a.queue.status(idb)).toBeUndefined();
    expect(b.queue.enqueue(ida, frame("x"))).toBe("unknown");
    for (const secret of ["token-a", "token-b", "opaque-a", "opaque-b", "secret-of-a", "b-state"]) expect(view).not.toContain(secret);
  });

  it("T20: a cooldown shared by two Bots is counted once for the origin", async () => {
    const { time, a, b, lines } = pair();
    const ida = await activeCard(a);
    const idb = await activeCard(b, { cardId: "bot-b-card" });
    // Both edits are in flight before either 429 arrives.
    a.net.reply({ hold: true });
    b.net.reply({ hold: true });
    a.queue.enqueue(ida, frame("a"));
    b.queue.enqueue(idb, frame("b"));
    await time.advance(800);
    expect(a.net.heldCount() + b.net.heldCount()).toBe(2);
    a.net.release({ status: 429, headers: { "retry-after": "5" } });
    b.net.release({ status: 429, headers: { "retry-after": "5" } });
    await time.advance(10_000);
    const m = lines.map((l) => JSON.parse(l.slice("[cards-metric] ".length)) as { name: string; labels: Record<string, string> });
    expect(m.filter((x) => x.name === "cooldown_start_total")).toHaveLength(1);
    expect(m.filter((x) => x.name === "cooldown_end_total")).toHaveLength(1);
    expect(m.find((x) => x.name === "cooldown_start_total")?.labels.origin_ref).toBe(originRefOf("https://api.example.com"));
  });
});

// ─── T11 policy after wait ──────────────────────────────────────────────────

describe("T11: policy is re-authorized after every wait", () => {
  function realPolicyRig() {
    const r = rig();
    const policy = createPolicy({ botRef: r.bot, api: { origin: r.api.origin, getProfile: async () => profile() }, clock: r.time.clock });
    const closure = vi.fn(policy.closureDisposition);
    const exposed: CardPolicy = { ...policy, closureDisposition: closure };
    const queue = createWriteQueue({ api: r.api, store: r.store, policy: exposed, pacer: r.pacer, clock: r.time.clock, timers: r.time.timers });
    return { ...r, realPolicy: policy, queue, closure };
  }

  it("drops a write with policy when the snapshot expires during a cooldown, without the closure exception", async () => {
    const r = realPolicyRig();
    const pinned = await r.realPolicy.snapshot();
    const s = r.spec({ pinned });
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("first"));
    await r.time.advance(800);
    expect(r.queue.status(s.cardId)?.phase).toBe("active");
    r.net.reply({ status: 429, headers: { "retry-after": "120" } });
    r.queue.enqueue(s.cardId, frame("p"));
    await r.time.advance(800);
    expect(r.net.edits()).toHaveLength(1);
    const result = r.queue.finalize(s.cardId, done(), "completed");
    await r.time.advance(130_000);
    expect(await result).toMatchObject({ outcome: "policy" });
    expect(r.net.edits()).toHaveLength(1);
    expect(r.closure).not.toHaveBeenCalled();
  });

  it("drops a write when the policy is revoked (invalidated) while waiting for eligibility", async () => {
    const r = realPolicyRig();
    const pinned = await r.realPolicy.snapshot();
    const s = r.spec({ pinned });
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("first"));
    await r.time.advance(800);
    r.net.reply({ status: 429, headers: { "retry-after": "10" } });
    r.queue.enqueue(s.cardId, frame("p"));
    await r.time.advance(800);
    r.realPolicy.invalidate("bot_setting");
    await r.time.advance(11_000);
    expect(r.net.edits()).toHaveLength(1);
    // Only the write is dropped; the acknowledged card stays open for an independently authorized terminal.
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "active" });
    const result = r.queue.finalize(s.cardId, done(), "completed");
    await r.time.advance(1000);
    // Still revoked: the terminal is re-authorized on its own and denied, with no closure exception.
    expect(await result).toEqual({ outcome: "policy" });
    expect(r.net.edits()).toHaveLength(1);
  });

  it("checks authorization after the debounce: a denial before the first send sends nothing", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(400);
    r.policy.allowed = false;
    await r.time.advance(400);
    expect(r.net.requests).toHaveLength(0);
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "policy" });
    expect(r.queue.status(s.cardId)?.storeCardId).toBeUndefined();
  });

  it("authorizes once per attempt, including after each retry wait", async () => {
    const r = rig();
    const id = await activeCard(r);
    const before = r.policy.calls.length;
    r.net.reply({ status: 503 }, { status: 503 });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(1200);
    expect(r.net.edits()).toHaveLength(3);
    expect(r.policy.calls.length - before).toBe(3);
  });
});

// ─── T13 / T14 terminal priority and races ──────────────────────────────────

describe("T13: terminal priority and absorbing terminal state", () => {
  it("finalize purges queued progress and sends the terminal frame without the debounce", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.queue.enqueue(id, frame("stale-progress"));
    await r.time.advance(300);
    const t = r.time.now();
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "acked", seq: 1 });
    const edits = r.net.edits();
    expect(edits).toHaveLength(1);
    expect(edits[0].at).toBe(t);
    expect(progressOf(edits[0].body)).toBe("done");
    expect((JSON.parse(edits[0].body) as { transient?: boolean }).transient).toBeUndefined();
    await r.time.advance(5000);
    expect(r.net.edits()).toHaveLength(1);
  });

  it("waits for an older in-flight edit, then sends a higher-seq terminal; later frames are absorbed", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    r.queue.enqueue(id, frame("older"));
    await r.time.advance(800);
    expect(r.net.heldCount()).toBe(1);
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(100);
    expect(r.net.edits()).toHaveLength(1);
    r.net.release();
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "acked", seq: 2 });
    expect(r.net.edits().map(seqOf)).toEqual([1, 2]);
    expect(r.queue.enqueue(id, frame("late"))).toBe("absorbed");
    expect(await r.queue.finalize(id, done("again"), "completed")).toEqual({ outcome: "acked", seq: 2 });
    await r.time.advance(5000);
    expect(r.net.edits()).toHaveLength(2);
    expect(storeRow(r, id)).toMatchObject({ seqReserved: 2, seqAcked: 2 });
  });

  it("a progress edit waiting to retry is fenced by finalize; the terminal gets a newer seq", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 503 });
    r.queue.enqueue(id, frame("older"));
    await r.time.advance(850);
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(1000);
    expect(await result).toEqual({ outcome: "acked", seq: 2 });
    expect(r.net.edits().map((e) => [seqOf(e), progressOf(e.body)])).toEqual([[1, "older"], [2, "done"]]);
  });

  it("terminal never bypasses the origin gate", async () => {
    const r = rig();
    const id = await activeCard(r);
    const other = await activeCard(r);
    r.net.reply({ status: 429, headers: { "retry-after": "60" } });
    r.queue.enqueue(other, frame("x"));
    await r.time.advance(800);
    const e = r.time.now() + 60_000;
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advanceTo(e - 1);
    expect(r.net.edits().filter((x) => progressOf(x.body) === "done")).toHaveLength(0);
    await r.time.advanceTo(e);
    expect(await result).toMatchObject({ outcome: "acked" });
  });
});

describe("T14: lazy/finalize race", () => {
  it("settle before the first send starts skips the first frame entirely", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(500);
    expect(await r.queue.finalize(s.cardId, done(), "completed")).toEqual({ outcome: "skipped" });
    await r.time.advance(5000);
    expect(r.net.requests).toHaveLength(0);
    expect(r.queue.status(s.cardId)?.storeCardId).toBeUndefined();
  });

  it("settle after the send starts keeps terminal intent until ack, then a higher-seq terminal edit", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.net.reply({ hold: true });
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    expect(r.net.sends()).toHaveLength(1);
    const result = r.queue.finalize(s.cardId, done(), "completed");
    await r.time.advance(200);
    expect(r.net.edits()).toHaveLength(0);
    expect(r.queue.status(s.cardId)?.terminalPending).toBe(true);
    r.net.release();
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "acked", seq: 1 });
    expect(r.net.edits().map(seqOf)).toEqual([1]);
    expect(storeRow(r, s.cardId)).toMatchObject({ state: "done", terminalReason: "completed", seqAcked: 1 });
  });
});

// ─── T15 / T16 classification ───────────────────────────────────────────────

describe("T15: ambiguous initial sends are never resent", () => {
  it.each([
    ["429", { status: 429, headers: { "retry-after": "1" } }],
    ["500", { status: 500 }],
    ["503", { status: 503 }],
    ["network", { network: true as const }],
    ["identity-less 2xx", { status: 200, body: {} }],
  ])("%s: one send, markSendAmbiguous, sender suspended", async (_name, reply) => {
    const r = rig();
    const ambiguous = vi.spyOn(r.store, "markSendAmbiguous");
    r.net.reply(reply);
    const s2 = r.spec();
    r.queue.open(s2);
    r.queue.enqueue(s2.cardId, frame("a"));
    await r.time.advance(800);
    const terminal = r.queue.finalize(s2.cardId, done(), "completed");
    r.queue.enqueue(s2.cardId, frame("b"));
    await r.time.advance(60_000);
    expect(await terminal).toEqual({ outcome: "ambiguous" });
    expect(r.net.sends()).toHaveLength(1);
    expect(r.net.edits()).toHaveLength(0);
    expect(ambiguous).toHaveBeenCalledTimes(1);
    expect(storeRow(r, s2.cardId)?.state).toBe("ambiguous");
    expect(r.queue.suspendedCapabilities()).toEqual(["automatic"]);
    expect(r.queue.open(r.spec())).toBe("suspended");
    expect(r.queue.open(r.spec({ capability: "display", kind: "display" }))).toBe("opened");
  });
});

describe("T16: §5.3 classification is preserved", () => {
  it("edit 404 -> gone without retry and the card record is closed", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 404 });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(2000);
    expect(r.net.edits()).toHaveLength(1);
    expect(r.queue.status(id)).toMatchObject({ phase: "closed", outcome: "gone" });
    expect(await r.queue.finalize(id, done(), "completed")).toEqual({ outcome: "gone" });
    expect(r.net.edits()).toHaveLength(1);
  });

  it.each([401, 403])("progress edit %i -> policy without retry; the write is dropped, not the card", async (status) => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(2000);
    expect(r.net.edits()).toHaveLength(1);
    expect(r.metrics().filter((m) => m.name === "card_edit_total").map((m) => m.labels.code)).toEqual(["policy"]);
    expect(r.queue.status(id)?.phase).toBe("active");
  });

  it.each([401, 403])("terminal edit %i -> policy without retry and the card is closed", async (status) => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status });
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(2000);
    expect(await result).toEqual({ outcome: "policy", seq: 1 });
    expect(r.net.edits()).toHaveLength(1);
    expect(r.queue.status(id)).toMatchObject({ phase: "closed", outcome: "policy" });
  });

  it.each([400, 422])("edit %i -> contract without retry; the card keeps its last frame and continues", async (status) => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(2000);
    expect(r.net.edits()).toHaveLength(1);
    expect(r.metrics().filter((m) => m.name === "card_edit_total").map((m) => m.labels.code)).toEqual(["contract"]);
    expect(r.queue.status(id)?.phase).toBe("active");
    expect(await (async () => { const p = r.queue.finalize(id, done(), "completed"); await r.time.advance(0); return p; })())
      .toEqual({ outcome: "acked", seq: 2 });
  });

  it("the P05a stale matcher yields stale without retry and counts a stale-sequence metric", async () => {
    const r = rig({ staleSequence: { status: 409, field: "code", value: "stale_card_seq" } });
    const id = await activeCard(r);
    r.net.reply({ status: 409, body: { code: "stale_card_seq" } });
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(2000);
    expect(await result).toEqual({ outcome: "stale", seq: 1 });
    expect(r.net.edits()).toHaveLength(1);
    const names = r.metrics().map((m) => m.name);
    expect(names).toContain("stale_sequence_total");
  });

  it.each([
    [400, "contract", "markSendFailed"], [422, "contract", "markSendFailed"], [404, "contract", "markSendFailed"],
    [401, "policy", "markSendFailed"], [403, "policy", "markSendFailed"],
  ] as const)("initial send %i -> %s and the reservation is failed", async (status, outcome, method) => {
    const r = rig();
    const spy = vi.spyOn(r.store, method);
    const s = r.spec();
    r.queue.open(s);
    r.net.reply({ status });
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(5000);
    expect(r.net.sends()).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome });
    expect(r.queue.suspendedCapabilities()).toEqual([]);
  });
});

// ─── T18 oversize ───────────────────────────────────────────────────────────

describe("T18: oversized envelopes are rejected before transport", () => {
  const big = (n: number): CardFrame => ({ ...frame("x"), data: { ...DATA, progressText: "x".repeat(n) } } as CardFrame);

  it("rejects an initial send above min(policy maxPayloadBytes, 16384) with zero fetch calls and no reservation", async () => {
    const r = rig();
    r.policy.maxPayloadBytes = 1000;
    const reserve = vi.spyOn(r.store, "reserveMessage");
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, big(2000));
    await r.time.advance(1000);
    expect(r.net.requests).toHaveLength(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "contract" });
  });

  it("caps at 16384 even when the policy allows more, for edits too", async () => {
    const r = rig();
    r.policy.maxPayloadBytes = 1_000_000;
    const id = await activeCard(r);
    r.queue.enqueue(id, big(17_000));
    await r.time.advance(1000);
    expect(r.net.edits()).toHaveLength(0);
    expect(r.metrics().filter((m) => m.name === "card_edit_total").map((m) => m.labels.code)).toEqual(["contract"]);
    // A normal-size frame afterwards still goes through.
    r.queue.enqueue(id, frame("ok"));
    await r.time.advance(1000);
    expect(r.net.edits()).toHaveLength(1);
  });

  it("re-checks the frozen body against narrowed limits before a retry", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 503 });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(800);
    r.policy.maxPayloadBytes = 100;
    await r.time.advance(500);
    expect(r.net.edits()).toHaveLength(1);
    expect(r.metrics().filter((m) => m.name === "card_edit_total").map((m) => m.labels.code)).toEqual(["contract"]);
  });
});

// ─── T19 ordinary paths ─────────────────────────────────────────────────────

describe("T19: the ordinary final/typing/apology paths never consult the pacer", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  it("no module outside the card writer imports the pacer or the write queue", () => {
    const src = join(process.cwd(), "src");
    const importers = sources(src).filter((path) => /from\s+["'][^"']*(?:pacer|write-queue)\.js["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(src, path).split("\\").join("/")).sort();
    // WP-13A-1: the startup queue factory and the drain registry's timer port; WP-09: the explicit card transport. All inside the card subsystem.
    expect(importers).toEqual(["cards/explicit-transport.ts", "cards/recovery.ts", "cards/resource-registry.ts", "cards/runtime.ts", "cards/write-queue.ts"]);
    const ordinary = sources(src).filter((path) => !relative(src, path).startsWith("cards"))
      .filter((path) => /from\s+["'][^"']*cards\/(?:recovery|resource-registry)\.js["']/.test(readFileSync(path, "utf8")));
    expect(ordinary).toEqual([]);
  });

  it("ordinary delivery proceeds during an active card cooldown with zero gate consultations", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 429, headers: { "retry-after": "600" } });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(800);
    expect(r.pacer.gate(r.api.origin).eligible).toBe(false);
    const gateCalls = r.gateCalls();
    // Stand-in for the unchanged ordinary sender: it has no pacer dependency at all.
    const ordinary = vi.fn(async (text: string) => ({ messageId: "1", text }));
    await ordinary("final answer");
    await ordinary("typing");
    await ordinary("apology");
    expect(ordinary).toHaveBeenCalledTimes(3);
    expect(r.gateCalls()).toBe(gateCalls);
  });
});

// ─── T20 write telemetry ────────────────────────────────────────────────────

describe("T20: write outcomes via the injected sink with existing names only", () => {
  it("emits card_send_total and card_edit_total with Bot, origin and capability labels", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(800);
    const m = r.metrics().filter((x) => x.name !== "telemetry_heartbeat_total");
    expect(m.map((x) => [x.name, x.labels.code])).toEqual([["card_send_total", "acked"], ["card_edit_total", "acked"]]);
    for (const x of m) {
      expect(x.labels).toMatchObject({ bot_ref: botRefOf(r.bot), origin_ref: originRefOf(API), capability: "automatic" });
    }
    expect(r.lines.join("\n")).not.toMatch(/token-a|opaque-a|progressText|first/);
  });
});

// ─── T21 drain ──────────────────────────────────────────────────────────────

describe("T21: bounded drain and abort fencing", () => {
  const fenceAt = (r: Rig, ms: number) => ({ reason: "shutdown" as const, deadlineMono: r.time.now() + ms, signal: new AbortController().signal });

  it("abort-fences an in-flight edit at the deadline and touches no store state afterwards", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(800);
    const ack = vi.spyOn(r.store, "ackSequence");
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 1 });
    await r.time.advance(1000);
    expect(r.queue.status(id)).toMatchObject({ phase: "closed", outcome: "unresolved" });
    expect(ack).not.toHaveBeenCalled();
  });

  it("returns at the deadline even when the transport ignores abort", async () => {
    const r = rig({ ignoreAbort: true });
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(800);
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 1 });
  });

  it("does not bypass eligibility: a terminal behind a longer cooldown keeps its intent and stops", async () => {
    const r = rig();
    const id = await activeCard(r);
    const other = await activeCard(r);
    r.net.reply({ status: 429, headers: { "retry-after": "60" } });
    r.queue.enqueue(other, frame("x"));
    await r.time.advance(800);
    const requests = r.net.requests.length;
    const terminal = r.queue.finalize(id, done(), "completed");
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(3000);
    expect(await report).toMatchObject({ unresolved: 0 });
    expect(await terminal).toEqual({ outcome: "cancelled" });
    expect(r.queue.status(id)?.terminalPending).toBe(true);
    expect(r.net.requests.length).toBe(requests);
  });

  it("sends an eligible terminal within the deadline, skips unsent cards and drops queued progress", async () => {
    const r = rig();
    const id = await activeCard(r);
    const lazy = r.spec();
    r.queue.open(lazy);
    r.queue.enqueue(lazy.cardId, frame("never"));
    r.queue.enqueue(id, frame("progress"));
    const terminal = r.queue.finalize(id, done(), "completed");
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(0);
    expect(await report).toEqual({ settled: 2, aborted: 0, unresolved: 0 });
    expect(await terminal).toEqual({ outcome: "acked", seq: 1 });
    expect(r.queue.status(lazy.cardId)).toMatchObject({ phase: "closed", outcome: "skipped" });
    expect(r.net.sends()).toHaveLength(1);
    expect(r.net.edits().map((e) => progressOf(e.body))).toEqual(["done"]);
    expect(r.queue.open(r.spec())).toBe("closing");
    expect(r.queue.enqueue(id, frame("late"))).toBe("closing");
  });

  it("cancelNonterminal fences progress of a superseded generation but still allows its terminal", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.queue.enqueue(id, frame("old-progress"));
    expect(r.queue.cancelNonterminal("turn-1")).toBe(1);
    expect(r.queue.enqueue(id, frame("more"))).toBe("fenced");
    await r.time.advance(2000);
    expect(r.net.edits()).toHaveLength(0);
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "acked", seq: 1 });
    expect(r.queue.cancelNonterminal("turn-1")).toBe(0);
    expect(r.queue.cancelNonterminal("other")).toBe(0);
  });
});

// ─── XIN-2263 review regressions ────────────────────────────────────────────

describe("B1: a non-terminal policy denial drops the write, never the acknowledged card", () => {
  it("deny a progress edit, re-allow, then the terminal is independently authorized and sent", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.policy.allowed = false;
    r.queue.enqueue(id, frame("denied"));
    await r.time.advance(800);
    expect(r.net.edits()).toHaveLength(0);
    expect(r.queue.status(id)).toMatchObject({ phase: "active", dirty: false });
    expect(r.metrics().filter((m) => m.name === "card_edit_total").map((m) => m.labels.code)).toEqual(["policy"]);
    r.policy.allowed = true;
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "acked", seq: 1 });
    expect(r.net.edits().map((e) => [seqOf(e), progressOf(e.body)])).toEqual([[1, "done"]]);
  });

  it("later progress is re-authorized on its own after a denied write", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.policy.allowed = false;
    r.queue.enqueue(id, frame("denied"));
    await r.time.advance(800);
    r.policy.allowed = true;
    r.queue.enqueue(id, frame("allowed"));
    await r.time.advance(800);
    expect(r.net.edits().map((e) => progressOf(e.body))).toEqual(["allowed"]);
  });

  it("a denial that persists to the terminal ends the card with policy and sends nothing", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.policy.allowed = false;
    r.queue.enqueue(id, frame("denied"));
    await r.time.advance(800);
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "policy" });
    expect(r.net.edits()).toHaveLength(0);
  });
});

describe("B2: retries carry the exact frozen body even if the caller mutates its frame", () => {
  type Mutable = { data: { progressText: string; phases: { actions: { detail: string }[] }[] } };

  it("a progress frame mutated between attempts is resent byte-identical under the same seq", async () => {
    const r = rig();
    const id = await activeCard(r);
    const f = frame("v1");
    r.net.reply({ status: 503 }, { status: 503 });
    r.queue.enqueue(id, f);
    await r.time.advance(800);
    expect(r.net.edits()).toHaveLength(1);
    const m = f as unknown as Mutable;
    m.data.progressText = "MUTATED";
    m.data.phases[0].actions[0].detail = "MUTATED-nested";
    await r.time.advance(400);
    const edits = r.net.edits();
    expect(edits).toHaveLength(3);
    expect(edits.map(seqOf)).toEqual([1, 1, 1]);
    expect(new Set(edits.map((e) => e.body)).size).toBe(1);
    expect(edits[2].body).not.toContain("MUTATED");
  });

  it("a frame mutated after enqueue but before the debounce elapses sends the enqueued snapshot", async () => {
    const r = rig();
    const id = await activeCard(r);
    const f = frame("snapshot");
    r.queue.enqueue(id, f);
    (f as unknown as Mutable).data.progressText = "MUTATED";
    await r.time.advance(800);
    expect(progressOf(r.net.edits()[0].body)).toBe("snapshot");
  });

  it("a terminal frame mutated between attempts keeps its exact body", async () => {
    const r = rig();
    const id = await activeCard(r);
    const f = done("final");
    r.net.reply({ network: true });
    const result = r.queue.finalize(id, f, "completed");
    await r.time.advance(0);
    (f as unknown as Mutable).data.progressText = "MUTATED";
    await r.time.advance(200);
    expect(await result).toEqual({ outcome: "acked", seq: 1 });
    const edits = r.net.edits();
    expect(edits).toHaveLength(2);
    expect(edits[0].body).toBe(edits[1].body);
    expect(progressOf(edits[1].body)).toBe("final");
  });

  it("an authored frame is snapshotted the same way and matches the real serializer output", async () => {
    const r = rig();
    const s = r.spec({ kind: "display", capability: "display" });
    r.queue.open(s);
    const card = { type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [{ type: "TextBlock", text: "hello", wrap: true }] };
    const authored = { k: "authored", profile: "octo/v1", card, plain: "hello" } as unknown as CardFrame;
    r.queue.enqueue(s.cardId, authored);
    await r.time.advance(800);
    r.net.reply({ status: 502 });
    const edit = { k: "authored", profile: "octo/v1", card: { ...card, body: [{ type: "TextBlock", text: "v1", wrap: true }] }, plain: "v1" };
    const result = r.queue.finalize(s.cardId, edit as unknown as CardFrame);
    await r.time.advance(0);
    (edit.card.body[0] as { text: string }).text = "MUTATED";
    edit.plain = "MUTATED";
    await r.time.advance(200);
    expect(await result).toEqual({ outcome: "acked", seq: 1 });
    const edits = r.net.edits();
    expect(edits).toHaveLength(2);
    expect(edits[0].body).toBe(edits[1].body);
    expect(edits[1].body).not.toContain("MUTATED");
    const expected = serializeEditAuthored({ route: { channelId: "g1", channelType: 2 }, messageId: r.queue.status(s.cardId)?.messageId as string,
      profile: "octo/v1", card: { ...card, body: [{ type: "TextBlock", text: "v1", wrap: true }] } as never, plain: "v1", seq: 1, transient: false });
    expect(edits[1].body).toBe(expected.body);
  });
});

describe("N3: no card reservation is left unsent", () => {
  it("a drain that starts during the debounce skips the card before any reservation", async () => {
    const r = rig();
    const reserve = vi.spyOn(r.store, "reserveMessage");
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(799);
    const report = r.queue.drain({ reason: "shutdown", deadlineMono: r.time.now() + 3000, signal: new AbortController().signal });
    await r.time.advance(3000);
    await report;
    expect(reserve).not.toHaveBeenCalled();
    expect(r.net.sends()).toHaveLength(0);
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "skipped" });
  });

  it("every reservation is followed by its transport attempt in the same turn", async () => {
    const r = rig();
    const reserve = vi.spyOn(r.store, "reserveMessage");
    let sendsAtReserve = -1;
    reserve.mockImplementation((input) => {
      sendsAtReserve = r.net.sends().length;
      return CardStore.prototype.reserveMessage.call(r.store, input);
    });
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    expect(sendsAtReserve).toBe(0);
    expect(r.net.sends()).toHaveLength(1);
  });

  it("an initial send aborted at the drain deadline keeps its row as possibly sent; no SQL after the deadline", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.net.reply({ hold: true });
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    const abandon = vi.spyOn(r.store, "abandonUnsent");
    const ambiguous = vi.spyOn(r.store, "markSendAmbiguous");
    const report = r.queue.drain({ reason: "shutdown", deadlineMono: r.time.now() + 3000, signal: new AbortController().signal });
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 1 });
    expect(abandon).not.toHaveBeenCalled();
    expect(ambiguous).not.toHaveBeenCalled();
    expect(storeRow(r, s.cardId)?.state).toBe("sending");
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "unresolved" });
  });
});

describe("N4: the initial-send binding uses the current policy decision", () => {
  it("passes the authorization at acknowledgement time to ackMessage", async () => {
    const r = rig();
    const ack = vi.spyOn(r.store, "ackMessage");
    const s = r.spec();
    r.queue.open(s);
    r.net.reply({ hold: true });
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    r.policy.allowed = false;
    r.net.release();
    await r.time.advance(0);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toMatchObject({ policyAllows: false });
  });
});

// ─── XIN-2267 R2: bind failure after an accepted send ───────────────────────

describe("E2: an accepted send whose binding fails is persisted ambiguous and suspends its capability", () => {
  /** After card 1 is decided, the same capability is refused and another capability still works. */
  async function assertFenced(r: Rig, sendsBefore: number) {
    expect(r.queue.suspendedCapabilities()).toEqual(["automatic"]);
    expect(r.queue.open(r.spec())).toBe("suspended");
    await r.time.advance(5000);
    expect(r.net.sends()).toHaveLength(sendsBefore);
    const display = r.spec({ kind: "display", capability: "display" });
    expect(r.queue.open(display)).toBe("opened");
    r.queue.enqueue(display.cardId, frame("display"));
    await r.time.advance(800);
    expect(r.net.sends()).toHaveLength(sendsBefore + 1);
    expect(r.queue.status(display.cardId)?.phase).toBe("active");
  }

  it.each([false, true])("ackMessage throws (markSendAmbiguous throws: %s)", async (persistThrows) => {
    const r = rig();
    vi.spyOn(r.store, "ackMessage").mockImplementationOnce(() => { throw new Error("storage"); });
    const ambiguous = vi.spyOn(r.store, "markSendAmbiguous");
    if (persistThrows) ambiguous.mockImplementationOnce(() => { throw new Error("storage"); });
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    expect(r.net.sends()).toHaveLength(1);
    expect(ambiguous).toHaveBeenCalledTimes(1);
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "ambiguous" });
    expect(storeRow(r, s.cardId)?.state).toBe(persistThrows ? "sending" : "ambiguous");
    await assertFenced(r, 1);
  });

  it.each([false, true])("the server returns an already-bound message id: real identity_conflict (markSendAmbiguous throws: %s)",
    async (persistThrows) => {
      const r = rig();
      const first = await activeCard(r);
      const boundId = r.queue.status(first)?.messageId as string;
      const ack = vi.spyOn(r.store, "ackMessage");
      const ambiguous = vi.spyOn(r.store, "markSendAmbiguous");
      if (persistThrows) ambiguous.mockImplementationOnce(() => { throw new Error("storage"); });
      const s = r.spec();
      r.queue.open(s);
      r.net.reply({ status: 200, body: { message_id: boundId, client_msg_no: s.clientMsgNo } });
      r.queue.enqueue(s.cardId, frame("b"));
      await r.time.advance(800);
      expect(r.net.sends()).toHaveLength(2);
      expect(ack.mock.results[0]).toMatchObject({ type: "return", value: { kind: "identity_conflict" } });
      expect(ambiguous).toHaveBeenCalledTimes(1);
      expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "ambiguous" });
      expect(storeRow(r, s.cardId)?.state).toBe(persistThrows ? "sending" : "ambiguous");
      expect(r.queue.status(first)?.phase).toBe("active");
      await assertFenced(r, 2);
    });

  it.each([false, true])("the reserved row is no longer bindable: real invalid_state (markSendAmbiguous throws: %s)",
    async (persistThrows) => {
      const r = rig();
      const ack = vi.spyOn(r.store, "ackMessage");
      const ambiguous = vi.spyOn(r.store, "markSendAmbiguous");
      if (persistThrows) ambiguous.mockImplementationOnce(() => { throw new Error("storage"); });
      const s = r.spec();
      r.queue.open(s);
      r.net.reply({ hold: true });
      r.queue.enqueue(s.cardId, frame("a"));
      await r.time.advance(800);
      // The row reaches a terminal state while the accepted send is still in flight.
      const storeCardId = r.queue.status(s.cardId)?.storeCardId as string;
      expect(r.store.markSendFailed(storeCardId)).toEqual({ kind: "updated" });
      r.net.release();
      await r.time.advance(0);
      expect(r.net.sends()).toHaveLength(1);
      expect(ack.mock.results[0]).toMatchObject({ type: "return", value: { kind: "invalid_state" } });
      expect(ambiguous).toHaveBeenCalledTimes(1);
      expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "ambiguous" });
      // The store refuses to move a terminal row; the in-memory fence still applies.
      expect(storeRow(r, s.cardId)?.state).toBe("error");
      await assertFenced(r, 1);
    });
});

// ─── XIN-2267 R2: close or cancel in the microtask gap ──────────────────────

describe("NB1: close or cancel right after the debounce wait never reports a store failure", () => {
  function gapRig(depth: number, action: "close" | "cancel") {
    const r = rig();
    const reserve = vi.spyOn(r.store, "reserveMessage");
    let armed = false;
    let fired = false;
    const act = () => {
      if (action === "close") queue.close({ reason: "shutdown", deadlineMono: r.time.now() + 3000, signal: new AbortController().signal });
      else queue.cancelNonterminal("turn-1");
    };
    const timers = {
      setTimeout(callback: () => void, delayMs: number): unknown {
        return r.time.timers.setTimeout(() => {
          callback();
          if (!armed || fired) return;
          fired = true;
          let chain = Promise.resolve();
          for (let i = 1; i < depth; i++) chain = chain.then(() => undefined);
          if (depth === 0) act(); else void chain.then(act);
        }, delayMs);
      },
      clearTimeout(handle: unknown): void { r.time.timers.clearTimeout(handle); },
    };
    const queue = createWriteQueue({ api: r.api, store: r.store, policy: r.policy, pacer: r.pacer, clock: r.time.clock, timers });
    const s = r.spec();
    queue.open(s);
    armed = true;
    queue.enqueue(s.cardId, frame("a"));
    return { r, queue, s, reserve };
  }

  it.each([
    [0, "close"], [1, "close"], [2, "close"], [3, "close"],
    [0, "cancel"], [1, "cancel"], [2, "cancel"], [3, "cancel"],
  ] as const)("depth %i microtasks, %s", async (depth, action) => {
    const { r, queue, s, reserve } = gapRig(depth, action);
    await r.time.advance(800);
    await r.time.advance(3000);
    const status = queue.status(s.cardId);
    expect(status?.outcome).not.toBe("store_failed");
    if (status?.outcome === "skipped") {
      expect(reserve).not.toHaveBeenCalled();
      expect(r.net.sends()).toHaveLength(0);
    } else {
      // The send had already started before the fence: exactly one reservation and one transport.
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(r.net.sends()).toHaveLength(1);
    }
  });

  it("the one-microtask gap specifically yields skipped with zero reservations and sends", async () => {
    for (const action of ["close", "cancel"] as const) {
      const { r, queue, s, reserve } = gapRig(1, action);
      await r.time.advance(800);
      await r.time.advance(3000);
      expect(queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "skipped" });
      expect(reserve).not.toHaveBeenCalled();
      expect(r.net.sends()).toHaveLength(0);
    }
  });
});

// ─── XIN-2269 NB4: no new terminal authority after close or drain ───────────

describe("NB4: finalize after close or drain never starts new store or transport work", () => {
  const fenceAt = (r: Rig, ms: number) => ({ reason: "shutdown" as const, deadlineMono: r.time.now() + ms, signal: new AbortController().signal });

  it("post-close finalize on an idle acknowledged card settles cancelled with zero reserveSequence and zero transport", async () => {
    const r = rig();
    const id = await activeCard(r);
    const reserveSeq = vi.spyOn(r.store, "reserveSequence");
    const requests = r.net.requests.length;
    r.queue.close(fenceAt(r, 3000));
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "cancelled" });
    await r.time.advance(5000);
    expect(reserveSeq).not.toHaveBeenCalled();
    expect(r.net.requests.length).toBe(requests);
    expect(r.queue.status(id)).toMatchObject({ outcome: "cancelled", terminalPending: true, inflight: false });
    expect(storeRow(r, id)).toMatchObject({ state: "active", seqReserved: 0, seqAcked: 0 });
    // Absorbing: a repeated finalize returns the same settled result without new work.
    expect(await r.queue.finalize(id, done("again"), "completed")).toEqual({ outcome: "cancelled" });
    expect(r.net.requests.length).toBe(requests);
  });

  it("post-drain finalize on an idle acknowledged card settles cancelled with zero reserveSequence and zero transport", async () => {
    const r = rig();
    const id = await activeCard(r);
    const reserveSeq = vi.spyOn(r.store, "reserveSequence");
    const requests = r.net.requests.length;
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(0);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 0 });
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "cancelled" });
    await r.time.advance(5000);
    expect(reserveSeq).not.toHaveBeenCalled();
    expect(r.net.requests.length).toBe(requests);
    expect(r.queue.status(id)).toMatchObject({ terminalPending: true, inflight: false });
  });

  it("finalize after close while an older edit is in flight never adds a terminal edit; the owned edit still settles", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    r.queue.enqueue(id, frame("in-flight"));
    await r.time.advance(800);
    expect(r.net.heldCount()).toBe(1);
    const reserveSeq = vi.spyOn(r.store, "reserveSequence");
    const report = r.queue.drain(fenceAt(r, 3000));
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(await result).toEqual({ outcome: "cancelled" });
    r.net.release();
    await r.time.advance(0);
    expect(await report).toEqual({ settled: 1, aborted: 0, unresolved: 0 });
    await r.time.advance(5000);
    expect(reserveSeq).not.toHaveBeenCalled();
    expect(r.net.edits().map((e) => progressOf(e.body))).toEqual(["in-flight"]);
    expect(storeRow(r, id)).toMatchObject({ seqReserved: 1, seqAcked: 1 });
    expect(r.queue.status(id)?.terminalPending).toBe(true);
  });

  it("a terminal accepted before close still drains and is sent within the deadline", async () => {
    const r = rig();
    const id = await activeCard(r);
    const terminal = r.queue.finalize(id, done(), "completed");
    r.queue.close(fenceAt(r, 3000));
    await r.time.advance(0);
    expect(await terminal).toEqual({ outcome: "acked", seq: 1 });
    expect(r.net.edits().map((e) => progressOf(e.body))).toEqual(["done"]);
    expect(storeRow(r, id)).toMatchObject({ seqReserved: 1, seqAcked: 1 });
  });

  it("a terminal accepted before close behind an in-flight edit is sent after it within the deadline", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    r.queue.enqueue(id, frame("older"));
    await r.time.advance(800);
    const terminal = r.queue.finalize(id, done(), "completed");
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(100);
    r.net.release();
    await r.time.advance(0);
    expect(await terminal).toEqual({ outcome: "acked", seq: 2 });
    expect(await report).toEqual({ settled: 1, aborted: 0, unresolved: 0 });
    expect(r.net.edits().map((e) => [seqOf(e), progressOf(e.body)])).toEqual([[1, "older"], [2, "done"]]);
  });

  it("finalize after close on a never-sent card settles skipped with no reservation", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("never"));
    const reserve = vi.spyOn(r.store, "reserveMessage");
    r.queue.close(fenceAt(r, 3000));
    const result = r.queue.finalize(s.cardId, done(), "completed");
    await r.time.advance(5000);
    expect(await result).toEqual({ outcome: "skipped" });
    expect(reserve).not.toHaveBeenCalled();
    expect(r.net.requests).toHaveLength(0);
  });
});

// ─── XIN-2300: no nonterminal edit passes the shutdown fence after eligibility ─

describe("P1: close right after a progress edit becomes eligible never starts that edit", () => {
  function editGapRig(depth: number) {
    const r = rig();
    let closedAt: number | undefined;
    const afterClose: string[] = [];
    let armed = false;
    let fired = false;
    const act = () => {
      closedAt = r.time.now();
      queue.close({ reason: "shutdown", deadlineMono: r.time.now() + 3000, signal: new AbortController().signal });
    };
    const timers = {
      setTimeout(callback: () => void, delayMs: number): unknown {
        return r.time.timers.setTimeout(() => {
          callback();
          if (!armed || fired) return;
          fired = true;
          let chain = Promise.resolve();
          for (let i = 1; i < depth; i++) chain = chain.then(() => undefined);
          if (depth === 0) act(); else void chain.then(act);
        }, delayMs);
      },
      clearTimeout(handle: unknown): void { r.time.timers.clearTimeout(handle); },
    };
    const store = new Proxy(r.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "reserveSequence" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (closedAt !== undefined) afterClose.push("reserveSequence");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const api = {
      ...r.api,
      editRegistry: (...args: Parameters<typeof r.api.editRegistry>) => {
        if (closedAt !== undefined) afterClose.push("editRegistry");
        return r.api.editRegistry(...args);
      },
      editAuthored: (...args: Parameters<typeof r.api.editAuthored>) => {
        if (closedAt !== undefined) afterClose.push("editAuthored");
        return r.api.editAuthored(...args);
      },
    };
    const queue = createWriteQueue({ api, store, policy: r.policy, pacer: r.pacer, clock: r.time.clock, timers });
    const s = r.spec();
    queue.open(s);
    queue.enqueue(s.cardId, frame("first"));
    const arm = () => { armed = true; };
    return { r, queue, s, afterClose, arm, closed: () => closedAt !== undefined };
  }

  it.each([0, 1, 2, 3, 4, 5, 6, 8])("depth %i microtasks after the debounce wake", async (depth) => {
    const { r, queue, s, afterClose, arm, closed } = editGapRig(depth);
    await r.time.advance(800);
    expect(queue.status(s.cardId)?.phase).toBe("active");
    const editsBefore = r.net.edits().length;
    arm();
    queue.enqueue(s.cardId, frame("progress"));
    await r.time.advance(800);
    await r.time.advance(5000);
    expect(closed()).toBe(true);
    expect(afterClose).toEqual([]);
    // Either the edit started before close (one edit) or it was fenced (none); never one after close.
    expect(r.net.edits().length - editsBefore).toBeLessThanOrEqual(1);
  });
});

// ─── U1-a: kind/capability contract at open ─────────────────────────────────

describe("U1-a: open() rejects a spec whose kind and capability differ", () => {
  type Untyped = { kind: string; capability: string };
  const mismatched: ReadonlyArray<readonly [string, Untyped]> = [
    ["automatic kind on the display capability", { kind: "automatic", capability: "display" }],
    ["display kind on the automatic capability", { kind: "display", capability: "automatic" }],
    ["interactive kind on the automatic capability", { kind: "interactive", capability: "automatic" }],
    ["interactive kind on the interaction capability", { kind: "interactive", capability: "interaction" }],
    ["equal values outside the domain", { kind: "interaction", capability: "interaction" }],
  ];
  const contractMetrics = (r: Rig) => r.metrics().filter((m) => m.name === "card_send_total" && m.labels.code === "contract");

  it.each(mismatched)("%s -> contract with 0 reservations, 0 gate calls and 0 transport calls", async (_name, pair) => {
    const r = rig();
    const reserve = vi.spyOn(r.store, "reserveMessage");
    const s = r.spec(pair as unknown as Partial<CardSpec>);
    expect(r.queue.open(s)).toBe("contract");
    expect(r.queue.status(s.cardId)).toBeUndefined();
    expect(r.queue.enqueue(s.cardId, frame("a"))).toBe("unknown");
    await r.time.advance(5000);
    expect(reserve).not.toHaveBeenCalled();
    expect(r.gateCalls()).toBe(0);
    expect(r.net.requests).toHaveLength(0);
    expect(r.queue.suspendedCapabilities()).toEqual([]);
    expect(contractMetrics(r)).toHaveLength(1);
    expect(contractMetrics(r)[0].labels).toMatchObject({ bot_ref: botRefOf(r.bot), origin_ref: originRefOf(API), code: "contract" });
  });

  it("emits the contract metric through the existing reason set before open() returns", () => {
    const r = rig();
    const events: string[] = [];
    const sink = { emit: (name: string, labels: Readonly<Record<string, string>>) => { events.push(`${name}:${labels.code}`); } };
    const reserve = vi.spyOn(r.store, "reserveMessage").mockImplementation(() => { events.push("reserve"); throw new Error("unreachable"); });
    const queue = createWriteQueue({ api: r.api, store: r.store, policy: r.policy, pacer: r.pacer, clock: r.time.clock,
      timers: r.time.timers, telemetry: { sink, botRef: botRefOf(r.bot), originRef: originRefOf(API) } });
    const result = queue.open(r.spec({ kind: "display", capability: "automatic" }));
    events.push(`open:${result}`);
    expect(events).toEqual(["card_send_total:contract", "open:contract"]);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("the contract check precedes the suspension check", async () => {
    const r = rig();
    r.net.reply({ status: 503 });
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    expect(r.queue.suspendedCapabilities()).toEqual(["automatic"]);
    const sends = r.net.sends().length;
    expect(r.queue.open(r.spec({ kind: "display", capability: "automatic" }))).toBe("contract");
    expect(r.queue.open(r.spec({ kind: "automatic", capability: "display" }))).toBe("contract");
    expect(r.queue.open(r.spec())).toBe("suspended");
    expect(contractMetrics(r)).toHaveLength(2);
    expect(r.net.sends()).toHaveLength(sends);
  });

  it("a mismatched spec never replaces or disturbs an open card with the same id", async () => {
    const r = rig();
    const s = r.spec();
    expect(r.queue.open(s)).toBe("opened");
    expect(r.queue.open({ ...s, kind: "display" })).toBe("contract");
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    expect(r.queue.status(s.cardId)?.phase).toBe("active");
    expect(storeRow(r, s.cardId)?.kind).toBe("automatic");
  });

  it("matching specs keep every existing result", async () => {
    const r = rig();
    const a = r.spec();
    expect(r.queue.open(a)).toBe("opened");
    expect(r.queue.open(a)).toBe("duplicate");
    expect(r.queue.open(r.spec({ kind: "display", capability: "display" }))).toBe("opened");
    r.net.reply({ status: 503 });
    r.queue.enqueue(a.cardId, frame("a"));
    await r.time.advance(800);
    expect(r.queue.open(r.spec())).toBe("suspended");
    const report = r.queue.drain({ reason: "shutdown", deadlineMono: r.time.now() + 3000, signal: new AbortController().signal });
    expect(r.queue.open(r.spec({ kind: "display", capability: "display" }))).toBe("closing");
    await r.time.advance(3000);
    await report;
    expect(contractMetrics(r)).toHaveLength(0);
  });

  it("an exhaustive caller handles every OpenResult member", () => {
    const disposition = (result: OpenResult): "card" | "no_card" => {
      switch (result) {
        case "opened": return "card";
        case "duplicate":
        case "suspended":
        case "closing":
        case "contract": return "no_card";
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    const all: Record<OpenResult, true> = { opened: true, duplicate: true, suspended: true, closing: true, contract: true };
    expect(Object.keys(all).map((k) => [k, disposition(k as OpenResult)])).toEqual([
      ["opened", "card"], ["duplicate", "no_card"], ["suspended", "no_card"], ["closing", "no_card"], ["contract", "no_card"],
    ]);
  });
});

// ─── Shared fence: the registry's deadline signal ───────────────────────────

describe("drain under a shared fence whose signal aborts at the deadline", () => {
  /** Fence whose signal is aborted by a timer armed before drain(), as an aggregate registry does. */
  function sharedFence(r: Rig, ms: number) {
    const controller = new AbortController();
    r.time.timers.setTimeout(() => controller.abort(), ms);
    return { reason: "shutdown" as const, deadlineMono: r.time.now() + ms, signal: controller.signal };
  }

  it("an in-flight initial send is still reported unresolved", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.net.reply({ hold: true });
    r.queue.enqueue(s.cardId, frame("a"));
    await r.time.advance(800);
    const f = sharedFence(r, 3000);
    r.queue.close(f);
    const report = r.queue.drain(f);
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 1 });
    expect(r.queue.status(s.cardId)).toMatchObject({ phase: "closed", outcome: "unresolved" });
    expect(storeRow(r, s.cardId)?.state).toBe("sending");
  });

  it("an in-flight edit is still reported unresolved", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    r.queue.enqueue(id, frame("p"));
    await r.time.advance(800);
    const f = sharedFence(r, 3000);
    r.queue.close(f);
    const report = r.queue.drain(f);
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 1 });
    expect(r.queue.status(id)).toMatchObject({ phase: "closed", outcome: "unresolved" });
  });

  it("deadline-wins: mixed abort-honouring and abort-ignoring initial sends are both reported unresolved", async () => {
    const r = rig();
    // Self-contained transport: the first send settles on abort, the second never settles.
    const sends: string[] = [];
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const n = sends.push(typeof init?.body === "string" ? init.body : "");
      if (n === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return new Promise<Response>(() => { /* ignores abort */ });
    }) as typeof fetch;
    const api = createCardApi({ apiUrl: API, credential: "token-a", fetchImpl, nowUtcMs: r.time.wall.nowUtcMs });
    const queue = createWriteQueue({ api, store: r.store, policy: r.policy, pacer: r.pacer, clock: r.time.clock, timers: r.time.timers });
    const honours = r.spec();
    const ignores = r.spec();
    queue.open(honours);
    queue.open(ignores);
    queue.enqueue(honours.cardId, frame("a"));
    queue.enqueue(ignores.cardId, frame("b"));
    await r.time.advance(800);
    expect(sends).toHaveLength(2);
    const f = sharedFence(r, 3000);
    queue.close(f);
    const report = queue.drain(f);
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 2 });
    // The abort-settled send keeps its unresolved outcome; the abort-ignoring one is still in flight.
    expect(queue.status(honours.cardId)).toMatchObject({ phase: "closed", outcome: "unresolved" });
    expect(queue.status(ignores.cardId)).toMatchObject({ phase: "pending", inflight: true });
    expect(queue.status(ignores.cardId)?.outcome).toBeUndefined();
    for (const id of [honours.cardId, ignores.cardId]) {
      expect(r.store.getMessage(queue.status(id)?.storeCardId as string)?.state).toBe("sending");
    }
  });

  it("work that settles before the deadline is still reported settled", async () => {
    const r = rig();
    const id = await activeCard(r);
    const terminal = r.queue.finalize(id, done(), "completed");
    const f = sharedFence(r, 3000);
    const report = r.queue.drain(f);
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 1, aborted: 0, unresolved: 0 });
    expect(await terminal).toEqual({ outcome: "acked", seq: 1 });
  });
});

// ─── WP-06 correction: durable automatic terminal ───────────────────────────

describe("durable terminal: the row becomes terminal only after the terminal edit's ack is persisted", () => {
  const fenceAt = (r: Rig, ms: number) => ({ reason: "shutdown" as const, deadlineMono: r.time.now() + ms, signal: new AbortController().signal });

  it("an acknowledged completed terminal marks the row done/completed", async () => {
    const r = rig();
    const id = await activeCard(r);
    const result = await r.queue.finalize(id, done(), "completed");
    expect(result.outcome).toBe("acked");
    expect(storeRow(r, id)).toMatchObject({ state: "done", terminalReason: "completed", seqAcked: result.seq });
    expect(storeRow(r, id)?.terminalAt).not.toBeNull();
  });

  it("an acknowledged error terminal records its reason", async () => {
    const r = rig();
    const id = await activeCard(r);
    expect((await r.queue.finalize(id, frame("t", "error"), "timed_out")).outcome).toBe("acked");
    expect(storeRow(r, id)).toMatchObject({ state: "error", terminalReason: "timed_out" });
  });

  it("a retried terminal edit persists once, after the acknowledged attempt", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 503 });
    const pending = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    expect(storeRow(r, id)?.state).toBe("active");
    await r.time.advance(100);
    expect((await pending).outcome).toBe("acked");
    expect(r.net.edits()).toHaveLength(2);
    expect(storeRow(r, id)).toMatchObject({ state: "done", terminalReason: "completed" });
  });

  it("an automatic terminal without a reason is refused before reservation and transport", async () => {
    const r = rig();
    const id = await activeCard(r);
    const before = storeRow(r, id);
    expect(await r.queue.finalize(id, done())).toEqual({ outcome: "contract" });
    expect(r.net.edits()).toHaveLength(0);
    expect(storeRow(r, id)).toMatchObject({ seqReserved: before?.seqReserved, terminalIntent: null, state: "active" });
  });

  it("a policy-denied terminal sends nothing and leaves the row nonterminal", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.policy.allowed = false;
    expect((await r.queue.finalize(id, done(), "completed")).outcome).toBe("policy");
    expect(r.net.edits()).toHaveLength(0);
    expect(storeRow(r, id)).toMatchObject({ state: "active", terminalReason: null, terminalAt: null });
  });

  it("a terminal edit rejected by the server leaves the row nonterminal", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ status: 400, body: { code: "bad" } });
    expect((await r.queue.finalize(id, done(), "completed")).outcome).toBe("contract");
    expect(storeRow(r, id)?.state).toBe("active");
  });

  it("a terminal requested after close is cancelled and leaves the row nonterminal", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.queue.close(fenceAt(r, 3000));
    expect((await r.queue.finalize(id, done(), "completed")).outcome).toBe("cancelled");
    expect(storeRow(r, id)?.state).toBe("active");
  });

  it("a terminal edit still in flight at the drain deadline is unresolved and leaves the row nonterminal", async () => {
    const r = rig();
    const id = await activeCard(r);
    r.net.reply({ hold: true });
    const result = r.queue.finalize(id, done(), "completed");
    await r.time.advance(0);
    const report = r.queue.drain(fenceAt(r, 3000));
    await r.time.advance(3000);
    expect(await report).toEqual({ settled: 0, aborted: 0, unresolved: 1 });
    await r.time.advance(1000);
    expect((await result).outcome).toBe("unresolved");
    expect(storeRow(r, id)?.state).toBe("active");
  });

  it("a failed ack persistence is store_failed: acknowledged remotely, never claimed durable", async () => {
    const r = rig();
    const id = await activeCard(r);
    vi.spyOn(r.store, "ackSequence").mockImplementation(() => { throw new Error("disk"); });
    const mark = vi.spyOn(r.store, "markTerminal");
    expect((await r.queue.finalize(id, done(), "completed")).outcome).toBe("store_failed");
    expect(mark).not.toHaveBeenCalled();
    expect(storeRow(r, id)?.state).toBe("active");
  });

  it("a failed terminal persistence is store_failed and never reported as acked", async () => {
    const r = rig();
    const id = await activeCard(r);
    vi.spyOn(r.store, "markTerminal").mockImplementation(() => { throw new Error("disk"); });
    expect((await r.queue.finalize(id, done(), "completed")).outcome).toBe("store_failed");
    const r2 = rig();
    const id2 = await activeCard(r2);
    vi.spyOn(r2.store, "markTerminal").mockReturnValue({ kind: "invalid_state", state: "error" });
    expect((await r2.queue.finalize(id2, done(), "completed")).outcome).toBe("store_failed");
  });

  it("an idempotent repeat in the store still counts as durable", async () => {
    const r = rig();
    const id = await activeCard(r);
    vi.spyOn(r.store, "markTerminal").mockReturnValue({ kind: "already_terminal" });
    expect((await r.queue.finalize(id, done(), "completed")).outcome).toBe("acked");
  });

  it("a card closed before its first send leaves no row to mark", async () => {
    const r = rig();
    const s = r.spec();
    r.queue.open(s);
    r.queue.enqueue(s.cardId, frame("first"));
    const mark = vi.spyOn(r.store, "markTerminal");
    expect((await r.queue.finalize(s.cardId, done(), "completed")).outcome).toBe("skipped");
    expect(mark).not.toHaveBeenCalled();
  });
});
