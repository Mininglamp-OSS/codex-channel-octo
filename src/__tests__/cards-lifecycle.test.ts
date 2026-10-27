/**
 * Automatic-card turn coordinator (WP-06 C08b, TD v3 §3.2 / PRD §7.4).
 *
 * Real card store, write queue, policy, pacer and Card API client over a
 * scripted transport and a controlled clock. Covers the lazy first frame
 * (AC-005.2), ordered writes and absorbing terminals (AC-007.1/.2/.3), the
 * expired-snapshot closure (AC-007.5), truthful Error terminals (AC-008.2),
 * generation fencing (AC-005.3/AC-008.4), the exhaustive `OpenResult` branch
 * (N1), `status()` disambiguation of `finalize` (NB2) and the D-A report rules.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCardApi } from "../cards/api.js";
import type {
  BotRef, CardObservableEvent, DeliveryReport, ItemState, SafeProgram, TrustedTurnContext,
} from "../cards/contracts.js";
import { createClosureGrants, createTurnCoordinator, type AutomaticTurn, type LifecycleQueue } from "../cards/lifecycle.js";
import { migrateCardSchema } from "../cards/migrations.js";
import { createPacer } from "../cards/pacer.js";
import { createPolicy } from "../cards/policy.js";
import { CardStore, type CardBinding } from "../cards/store.js";
import { createWriteQueue, type CardFrame, type OpenResult } from "../cards/write-queue.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { profile } from "./fixtures/card-profile.js";
import { json, manualTime, scriptedFetch, seqOf, type ManualTime } from "./fixtures/card-write-harness.js";
import { reasoningSchemaErrors } from "./fixtures/reasoning-schema.js";

const API = "https://api.example.com";
const roots: string[] = [];
const adapters: DbAdapter[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const a of adapters.splice(0)) { try { a.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newStore(time: ManualTime): CardStore {
  const root = mkdtempSync(join(tmpdir(), "cards-lifecycle-"));
  roots.push(root);
  const adapter = createAdapter(join(root, "cc-octo.db"));
  adapters.push(adapter);
  new SessionStore(adapter).init();
  migrateCardSchema(adapter, { installationRef: "install-a", lineageId: "lineage-1", nowMs: time.wall.nowUtcMs() });
  let id = 0;
  return new CardStore(adapter, { clock: time.wall, newId: () => `id-${++id}` });
}

interface Metric { name: string; labels: Readonly<Record<string, string>> }

function rig(o: { warm?: boolean } = {}) {
  const time = manualTime();
  const net = scriptedFetch(time);
  const profileCalls = { n: 0 };
  let profileReply: () => Response | Promise<Response> = () => json(200, profile());
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/v1/bot/card/profile")) { profileCalls.n++; return profileReply(); }
    return net.fetchImpl(input, init);
  }) as typeof fetch;
  const api = createCardApi({ apiUrl: API, credential: "token-a", fetchImpl, nowUtcMs: time.wall.nowUtcMs });
  const botRef: BotRef = { originKey: api.origin.key, credentialRef: "cred-a" };
  const policy = createPolicy({ botRef, api, clock: time.clock });
  const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
  const store = newStore(time);
  const grants = createClosureGrants(policy);
  const metrics: Metric[] = [];
  const queue = createWriteQueue({ api, store, policy: grants, pacer, clock: time.clock, timers: time.timers,
    telemetry: { sink: { emit: (name, labels) => { metrics.push({ name, labels }); } }, botRef: "b", originRef: "o" } });
  const tracked: Promise<unknown>[] = [];
  let n = 0;

  function ctxFor(gen: string, sessionKey = "group:g1"): TrustedTurnContext {
    return Object.freeze({
      botRef, route: Object.freeze({ channelId: "g1", channelType: 2 }), requesterUid: "u1", sessionKey,
      turnGeneration: gen, resetEpoch: 0, policyIdentity: "cred-a", runtimeIncarnation: "inc-1",
      routeEligibility: Object.freeze({ kind: "group" as const, obo: false, docTask: false, cron: false }),
      origin: Object.freeze({ kind: "user" as const }),
    });
  }

  function turn(over: { queue?: LifecycleQueue; sessionKey?: string } = {}): AutomaticTurn {
    const i = ++n;
    const gen = `gen-${i}`;
    const ctx = ctxFor(gen, over.sessionKey);
    const binding: CardBinding = { sessionKey: ctx.sessionKey, channelId: "g1", channelType: 2, topicScope: null, generation: gen, resetEpoch: 0 };
    return createTurnCoordinator({
      ctx, binding, cardId: `card-${i}`, clientMsgNo: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      queue: over.queue ?? queue, policy, closure: grants, clock: time.clock,
      refresh: () => policy.snapshot().catch(() => undefined),
      track: (p) => { tracked.push(p); },
    });
  }

  async function settleAll(): Promise<void> {
    await time.advance(0);
    await Promise.all(tracked);
    await time.advance(0);
  }

  const sends = () => net.sends().map((r) => JSON.parse(r.body) as { payload: { state: string; data: Record<string, unknown> } });
  const edits = () => net.edits().map((r) => ({ ...(JSON.parse(r.body) as { state: string; data: Record<string, unknown>; transient?: boolean }), seq: seqOf(r) }));
  const warm = async () => { await policy.snapshot(); };
  if (o.warm !== false) void warm();
  return {
    time, net, api, botRef, policy, queue, store, grants, metrics, profileCalls, turn, settleAll, sends, edits, warm, tracked,
    setProfile(reply: () => Response | Promise<Response>) { profileReply = reply; },
  };
}

type Rig = ReturnType<typeof rig>;

let seq = 0;
const start = (attempt = 0): CardObservableEvent => ({ kind: "attempt_start", attempt, reason: attempt === 0 ? "initial" : "request_retry", continues: null });
const end = (attempt = 0, terminal: "completed" | "no_terminal" = "completed"): CardObservableEvent => ({ kind: "attempt_end", attempt, terminal });
function cmd(id: string, phase: ItemState["phase"] = "started", status?: ItemState["status"], attempt = 0): ItemState {
  return { kind: "item_state", attempt, itemId: id, seq: seq++, itemType: "command_execution", phase,
    ...(status ? { status } : {}), safe: { category: "command", program: "git" as SafeProgram } };
}
const reasoning = (): ItemState => ({ kind: "item_state", attempt: 0, itemId: "r", seq: -1, itemType: "reasoning", phase: "started", safe: { category: "activity" } });
const report = (expected: number, acked: number, emptyNotice = false): DeliveryReport =>
  ({ expected, acked, failed: expected - acked, messageIds: Array.from({ length: acked }, (_, i) => String(100 + i)), emptyNotice });

/** Card active with its first frame acknowledged. */
async function activeTurn(r: Rig, t = r.turn()): Promise<AutomaticTurn> {
  await r.time.advance(0);
  t.observe(start());
  t.observe(cmd("c1"));
  await r.time.advance(800);
  expect(r.sends()).toHaveLength(1);
  return t;
}

async function finish(r: Rig, t: AutomaticTurn, rep: DeliveryReport | undefined, more: (t: AutomaticTurn) => void = () => {}): Promise<void> {
  t.observe(end());
  if (rep) t.signal({ t: "delivery_report", report: rep });
  more(t);
  t.settle();
  await r.settleAll();
}

describe("lazy first frame (AC-005.2)", () => {
  it("a thinking-only turn sends no card", async () => {
    const r = rig();
    const t = r.turn();
    await r.time.advance(0);
    t.observe(start()); t.observe(reasoning()); t.observe(end());
    t.signal({ t: "delivery_report", report: report(1, 1) });
    t.settle();
    await r.time.advance(5000); await r.settleAll();
    expect(r.net.requests).toHaveLength(0);
    expect(t.inspect()).toMatchObject({ opened: false, settled: true });
  });

  it("an empty turn sends no card, and settle is idempotent", async () => {
    const r = rig();
    const t = r.turn();
    t.settle(); t.settle();
    await r.settleAll();
    expect(r.net.requests).toHaveLength(0);
  });

  it("the first displayable row sends one card after the 800 ms debounce, coalescing newer state", async () => {
    const r = rig();
    const t = r.turn();
    await r.time.advance(0);
    t.observe(start());
    t.observe(cmd("c1"));
    await r.time.advance(400);
    t.observe(cmd("c1", "completed", "completed"));
    t.observe(cmd("c2"));
    await r.time.advance(399);
    expect(r.sends()).toHaveLength(0);
    await r.time.advance(1);
    expect(r.sends()).toHaveLength(1);
    const payload = r.sends()[0]!.payload;
    expect(payload.state).toBe("reasoning");
    const actions = (payload.data.phases as { actions: { statusGlyph: string }[] }[]).flatMap((p) => p.actions);
    expect(actions.map((a) => a.statusGlyph)).toEqual(["✓", "…"]);
  });
});

describe("ordered writes and terminals (AC-007.1, AC-008.2)", () => {
  it("Answering on delivery_start, then Done after a final-attempt settle with a Done-shaped report", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.signal({ t: "delivery_start" });
    await r.time.advance(800);
    expect(r.edits().map((e) => [e.state, e.transient])).toEqual([["answering", true]]);
    await finish(r, t, report(2, 2));
    const last = r.edits().at(-1)!;
    expect(last.state).toBe("completed");
    expect(last.transient).toBeUndefined();
    expect(last.seq).toBeGreaterThan(r.edits()[0]!.seq);
    expect(t.inspect().terminal).toBe("completed");
  });

  it("a terminal is absorbing: later events, signals and settles add no writes", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(1, 1));
    const count = r.net.requests.length;
    t.observe(cmd("late")); t.signal({ t: "delivery_start" }); t.signal({ t: "dispatch_timeout" }); t.signal({ t: "shutdown" }); t.settle();
    await r.time.advance(5000); await r.settleAll();
    expect(r.net.requests).toHaveLength(count);
    expect(t.inspect().terminal).toBe("completed");
  });

  it("a runtime handler_error is Error/failed", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(0, 0), (x) => x.signal({ t: "handler_error", category: "runtime_failed" }));
    expect(r.edits().at(-1)!.data).toMatchObject({ state: "error", statusLabel: "Failed", errorTitle: "Failed" });
  });

  it("a lost stream is Error/interrupted", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(0, 0), (x) => x.signal({ t: "handler_error", category: "stream_interrupted" }));
    expect(r.edits().at(-1)!.data.statusLabel).toBe("Interrupted; needs review");
  });

  it("no completed final attempt is Error/interrupted, never Done", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.observe(end(0, "no_terminal"));
    t.signal({ t: "delivery_report", report: report(1, 1) });
    t.settle();
    await r.settleAll();
    expect(r.edits().at(-1)!.data.statusLabel).toBe("Interrupted; needs review");
  });

  it("Done needs the FINAL attempt to complete: an earlier completed attempt does not count", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.observe(end(0)); t.observe(start(1));
    t.signal({ t: "delivery_report", report: report(1, 1) });
    t.settle();
    await r.settleAll();
    expect(r.edits().at(-1)!.data.statusLabel).toBe("Interrupted; needs review");
  });

  it("a retried final attempt that completes is Done", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.observe(end(0, "no_terminal")); t.observe(start(1)); t.observe(cmd("c1", "started", undefined, 1)); t.observe(end(1));
    t.signal({ t: "delivery_report", report: report(1, 1) });
    t.settle();
    await r.settleAll();
    expect(r.edits().at(-1)!.state).toBe("completed");
  });

  it("shutdown is Error/interrupted", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.signal({ t: "shutdown" });
    await r.settleAll();
    expect(r.edits().at(-1)!.data.statusLabel).toBe("Interrupted; needs review");
  });

  it("settle before the first send begins skips the card entirely", async () => {
    const r = rig();
    const t = r.turn();
    await r.time.advance(0);
    t.observe(start()); t.observe(cmd("c1"));
    await r.time.advance(300);
    await finish(r, t, report(1, 1));
    await r.time.advance(5000);
    expect(r.net.requests).toHaveLength(0);
    expect(t.inspect().opened).toBe(true);
  });

  it("settle while the first send is in flight sends one higher-sequence terminal edit after the ack", async () => {
    const r = rig();
    r.net.reply({ hold: true });
    const t = r.turn();
    await r.time.advance(0);
    t.observe(start()); t.observe(cmd("c1"));
    await r.time.advance(800);
    expect(r.net.heldCount()).toBe(1);
    t.observe(end()); t.signal({ t: "delivery_report", report: report(1, 1) }); t.settle();
    await r.time.advance(0);
    expect(r.edits()).toHaveLength(0);
    r.net.release();
    await r.settleAll();
    expect(r.sends()).toHaveLength(1);
    expect(r.edits().map((e) => [e.state, e.seq])).toEqual([["completed", 1]]);
  });

  it("a 429 on a progress edit is retried after the cooldown without a new SDK event (AC-007.3)", async () => {
    const r = rig();
    const t = await activeTurn(r);
    r.net.reply({ status: 429, headers: { "retry-after": "2" } });
    t.observe(cmd("c1", "completed", "completed"));
    await r.time.advance(800);
    expect(r.edits()).toHaveLength(1);
    await r.time.advance(1999);
    expect(r.edits()).toHaveLength(1);
    await r.time.advance(1);
    expect(r.edits()).toHaveLength(2);
    expect(r.edits()[1]!.seq).toBe(r.edits()[0]!.seq);
  });
});

describe("durable terminal rows (WP-06 correction)", () => {
  const row = (r: Rig, t: AutomaticTurn) => {
    const id = r.queue.status(`card-${t.generation.slice(4)}`)?.storeCardId;
    return id === undefined ? undefined : r.store.getMessage(id);
  };

  it("Done persists done/completed after the terminal edit is acknowledged", async () => {
    const r = rig();
    const t = await activeTurn(r);
    expect(row(r, t)?.state).toBe("active");
    await finish(r, t, report(1, 1));
    expect(row(r, t)).toMatchObject({ state: "done", terminalReason: "completed" });
  });

  it("each Error reason persists its own terminal_reason", async () => {
    for (const [signal, reason] of [
      [{ t: "handler_error", category: "runtime_failed" }, "failed"],
      [{ t: "handler_error", category: "stream_interrupted" }, "interrupted"],
      [{ t: "dispatch_timeout" }, "timed_out"],
      [{ t: "shutdown" }, "interrupted"],
    ] as const) {
      const r = rig();
      const t = await activeTurn(r);
      t.signal(signal);
      t.settle();
      await r.settleAll();
      expect(row(r, t)).toMatchObject({ state: "error", terminalReason: reason });
    }
  });

  it("a revoked terminal is never persisted as terminal", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await r.time.advance(61_000);
    r.setProfile(() => json(200, profile({ config: { card_enabled: false, reasoning_enabled: false, reasoning_template_ref: null, display_enabled: false, interaction_enabled: false } })));
    await finish(r, t, report(1, 1));
    expect(row(r, t)).toMatchObject({ state: "active", terminalReason: null, terminalAt: null });
  });

  it("the expired-snapshot minimal closure is persisted once acknowledged", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await r.time.advance(61_000);
    r.setProfile(() => { throw new TypeError("fetch failed"); });
    await finish(r, t, report(1, 1));
    expect(row(r, t)).toMatchObject({ state: "done", terminalReason: "completed" });
  });
});

describe("D-A report rules (R1 C2/C3)", () => {
  it("a Done-shaped catch-path report followed by handler_error is Error", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(3, 3), (x) => x.signal({ t: "handler_error", category: "unknown" }));
    expect(r.edits().at(-1)!.state).toBe("error");
  });

  it("a partial report on the normal path is Error/failed", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(3, 1));
    expect(r.edits().at(-1)!.data.statusLabel).toBe("Failed");
  });

  it("the fail-closed report {0,0,0,[],false} is never Done", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(0, 0));
    expect(r.edits().at(-1)!.state).toBe("error");
  });

  it("an acknowledged empty notice with no parts is Done", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, report(0, 0, true));
    expect(r.edits().at(-1)!.state).toBe("completed");
  });

  it("no report at all is never Done", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await finish(r, t, undefined);
    expect(r.edits().at(-1)!.state).toBe("error");
  });
});

describe("dispatch timeout (B3 card terminal)", () => {
  it("closes the generation with Error/timed_out and absorbs every later event", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.signal({ t: "dispatch_timeout" });
    await r.settleAll();
    const terminal = r.edits().at(-1)!;
    expect(terminal.state).toBe("error");
    expect(terminal.data.statusLabel).toBe("Timed out");
    expect(JSON.stringify(terminal).toLowerCase()).not.toContain("later");
    const count = r.net.requests.length;
    t.observe(cmd("late")); t.signal({ t: "delivery_start" });
    t.observe(end()); t.signal({ t: "delivery_report", report: report(1, 1) }); t.settle();
    await r.time.advance(5000); await r.settleAll();
    expect(r.net.requests).toHaveLength(count);
    expect(t.inspect().terminal).toBe("timed_out");
  });

  it("a timeout before any displayable row leaves no card", async () => {
    const r = rig();
    const t = r.turn();
    await r.time.advance(0);
    t.signal({ t: "dispatch_timeout" });
    t.observe(cmd("late"));
    await r.time.advance(5000); await r.settleAll();
    expect(r.net.requests).toHaveLength(0);
    expect(t.claimsNotices()).toBe(false);
  });
});

describe("policy gates and notice mode", () => {
  it("claims notices (card mode) only when the fresh snapshot permits automatic cards", async () => {
    const r = rig();
    await r.warm();
    expect(r.turn().claimsNotices()).toBe(true);
    const off = rig({ warm: false });
    off.setProfile(() => json(200, profile({ config: { card_enabled: true, reasoning_enabled: false, reasoning_template_ref: null, display_enabled: true, interaction_enabled: false } })));
    await off.warm();
    const t = off.turn();
    expect(t.claimsNotices()).toBe(false);
    t.observe(start()); t.observe(cmd("c1"));
    await off.time.advance(5000);
    expect(off.net.requests).toHaveLength(0);
  });

  it("an unresolved policy at the first item stays in notice mode for the whole turn", async () => {
    const r = rig({ warm: false });
    let release!: () => void;
    r.setProfile(() => new Promise<Response>((res) => { release = () => res(json(200, profile())); }));
    const t = r.turn();
    expect(r.profileCalls.n).toBe(1);
    expect(t.claimsNotices()).toBe(false);
    release(); await r.time.advance(0);
    t.observe(start()); t.observe(cmd("c1"));
    await r.time.advance(5000);
    expect(r.sends()).toHaveLength(0);
    expect(t.claimsNotices()).toBe(false);
  });

  it("a suspended automatic sender keeps the turn in notice mode", async () => {
    const r = rig();
    await r.warm();
    const suspended: LifecycleQueue = { ...r.queue, suspendedCapabilities: () => ["automatic"] };
    expect(r.turn({ queue: suspended }).claimsNotices()).toBe(false);
  });

  const members: OpenResult[] = ["duplicate", "suspended", "closing", "contract"];
  for (const member of members) {
    it(`open() → "${member}" means no card for this turn and notices resume (N1)`, async () => {
      const r = rig();
      await r.warm();
      const fake: LifecycleQueue = { ...r.queue, open: vi.fn(() => member), enqueue: vi.fn(() => "unknown" as const) };
      const t = r.turn({ queue: fake });
      expect(t.claimsNotices()).toBe(true);
      t.observe(start()); t.observe(cmd("c1")); t.observe(cmd("c2"));
      expect(fake.open).toHaveBeenCalledTimes(1);
      expect(fake.enqueue).not.toHaveBeenCalled();
      expect(t.claimsNotices()).toBe(false);
      await finish(r, t, report(1, 1));
      expect(r.net.requests).toHaveLength(0);
    });
  }

  it("the queue spec pins the authorized snapshot and the template, with kind === capability", async () => {
    const r = rig();
    await r.warm();
    const open = vi.fn((spec: Parameters<LifecycleQueue["open"]>[0]) => r.queue.open(spec));
    const t = r.turn({ queue: { ...r.queue, open } });
    t.observe(start()); t.observe(cmd("c1"));
    const spec = open.mock.calls[0]![0];
    expect(spec).toMatchObject({ kind: "automatic", capability: "automatic", presentation: { templateId: "ai.reasoning-process", templateVersion: "0.4.0" } });
    expect(spec.pinned?.automatic.state).toBe("enabled");
    expect(spec.binding.generation).toBe(t.generation);
  });
});

describe("finalize status disambiguation (NB2)", () => {
  it("a contract outcome on a still-open card retries once with the minimal closure frame", async () => {
    const r = rig();
    await r.warm();
    const finalize = vi.fn()
      .mockResolvedValueOnce({ outcome: "contract" })
      .mockResolvedValueOnce({ outcome: "acked", seq: 2 });
    const fake: LifecycleQueue = { ...r.queue, open: () => "opened", enqueue: () => "queued",
      finalize, status: () => ({ phase: "active", seqReserved: 1, seqAcked: 1, dirty: false, inflight: false, terminalPending: false }) };
    const t = r.turn({ queue: fake });
    t.observe(start()); t.observe(cmd("c1"));
    await finish(r, t, report(1, 1));
    expect(finalize).toHaveBeenCalledTimes(2);
    const second = finalize.mock.calls[1]![1] as Extract<CardFrame, { k: "registry" }>;
    expect(second.data.phases).toEqual([{ thought: "Completed", actions: [{ tool: "Status", detail: "Completed", statusGlyph: "✓", statusTone: "Good" }] }]);
  });

  it("a contract outcome on a closed card is final", async () => {
    const r = rig();
    await r.warm();
    const finalize = vi.fn().mockResolvedValue({ outcome: "contract" });
    const fake: LifecycleQueue = { ...r.queue, open: () => "opened", enqueue: () => "queued", finalize,
      status: () => ({ phase: "closed", seqReserved: 1, seqAcked: 1, dirty: false, inflight: false, terminalPending: false, outcome: "contract" }) };
    const t = r.turn({ queue: fake });
    t.observe(start()); t.observe(cmd("c1"));
    await finish(r, t, report(1, 1));
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

describe("expired-snapshot closure (AC-007.5)", () => {
  it("expired permission plus a failed refresh writes only the minimal terminal frame", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await r.time.advance(61_000);
    r.setProfile(() => { throw new TypeError("fetch failed"); });
    await finish(r, t, report(1, 1));
    const terminal = r.edits().at(-1)!;
    expect(terminal.state).toBe("completed");
    expect(terminal.data.phases).toEqual([{ thought: "Completed", actions: [{ tool: "Status", detail: "Completed", statusGlyph: "✓", statusTone: "Good" }] }]);
    expect(terminal.data.progressText).toBeUndefined();
    expect(terminal.transient).toBeUndefined();
  });

  it("explicit revocation never uses the closure exception: no transport, residue recorded", async () => {
    const r = rig();
    const t = await activeTurn(r);
    await r.time.advance(61_000);
    r.setProfile(() => json(200, profile({ config: { card_enabled: false, reasoning_enabled: false, reasoning_template_ref: null, display_enabled: false, interaction_enabled: false } })));
    const before = r.edits().length;
    await finish(r, t, report(1, 1));
    expect(r.edits()).toHaveLength(before);
    expect(r.metrics.filter((m) => m.name === "card_edit_total").map((m) => m.labels.code)).toContain("policy");
  });

  it("a closure grant is scoped to one card context, the automatic capability and its pinned snapshot", async () => {
    const r = rig();
    const pinned = await r.policy.snapshot();
    const a = { botRef: r.botRef }; const b = { botRef: r.botRef };
    await r.time.advance(61_000);
    expect(r.grants.authorize("automatic", a, pinned).allowed).toBe(false);
    r.grants.grant(a, pinned);
    expect(r.grants.authorize("automatic", a, pinned).allowed).toBe(true);
    expect(r.grants.authorize("automatic", b, pinned).allowed).toBe(false);
    expect(r.grants.authorize("display", a, pinned).allowed).toBe(false);
    expect(r.grants.authorize("automatic", a, undefined).allowed).toBe(false);
    r.grants.revoke(a);
    expect(r.grants.authorize("automatic", a, pinned).allowed).toBe(false);
  });
});

describe("generation fencing (AC-005.3, AC-008.4)", () => {
  it("each turn has a distinct card, client id and generation", async () => {
    const r = rig();
    const a = await activeTurn(r);
    await finish(r, a, report(1, 1));
    const b = r.turn();
    expect(b.generation).not.toBe(a.generation);
    b.observe(start()); b.observe(cmd("c9"));
    await r.time.advance(800);
    const sends = r.net.sends().map((s) => JSON.parse(s.body) as { client_msg_no: string; payload: { data: { reasoningId: string } } });
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((s) => s.client_msg_no)).size).toBe(2);
    expect(new Set(sends.map((s) => s.payload.data.reasoningId)).size).toBe(2);
  });

  it("a superseded generation sends no further progress; its own terminal still closes its own card", async () => {
    const r = rig();
    const a = await activeTurn(r);
    a.supersede();
    a.observe(cmd("late-a"));
    await r.time.advance(800);
    expect(r.edits()).toHaveLength(0);
    a.observe(end()); a.signal({ t: "delivery_report", report: report(1, 1) }); a.settle();
    await r.settleAll();
    expect(r.edits()).toHaveLength(1);
    expect(r.edits()[0]!.state).toBe("completed");
  });

  it("late events delivered to an older coordinator never touch a newer card", async () => {
    const r = rig();
    const a = await activeTurn(r);
    a.signal({ t: "dispatch_timeout" });
    await r.settleAll();
    const editsAfterA = r.edits().length;
    const b = r.turn();
    b.observe(start()); b.observe(cmd("c9"));
    await r.time.advance(800);
    expect(r.sends()).toHaveLength(2);
    a.observe(cmd("late")); a.signal({ t: "delivery_start" }); a.settle();
    await r.time.advance(5000); await r.settleAll();
    expect(r.edits()).toHaveLength(editsAfterA);
    expect(b.inspect().terminal).toBeUndefined();
  });
});

describe("robustness", () => {
  it("observe and signal never throw into the handler", async () => {
    const r = rig();
    const t = r.turn();
    for (const bad of [null, undefined, 42, {}, { kind: "item_state" }, { kind: "message_phase" }]) {
      expect(() => t.observe(bad as unknown as CardObservableEvent)).not.toThrow();
    }
    expect(() => t.signal(null as never)).not.toThrow();
    expect(() => t.signal({ t: "nope" } as never)).not.toThrow();
  });

  it("frames never carry controls (AC-018.5)", async () => {
    const r = rig();
    const t = await activeTurn(r);
    t.signal({ t: "delivery_start" });
    await r.time.advance(800);
    await finish(r, t, report(1, 1));
    for (const body of r.net.requests.map((q) => q.body)) {
      for (const control of ["Action.Submit", "reasoning_stop", "reasoning_retry", "\"actions\":[{\"type\""]) expect(body).not.toContain(control);
    }
  });
});

describe("every automatic frame on the wire satisfies the server 0.4.1 data schema (XIN-2423)", () => {
  async function wireData(r: Rig, run: (t: AutomaticTurn) => Promise<void>): Promise<Record<string, unknown>[]> {
    const t = await activeTurn(r);
    await run(t);
    return [...r.sends().map((s) => s.payload.data), ...r.edits().map((e) => e.data)];
  }

  it.each([
    ["working → answering → completed", async (r: Rig, t: AutomaticTurn) => {
      t.signal({ t: "delivery_start" }); await r.time.advance(800); await finish(r, t, report(1, 1));
    }],
    ["failed", async (r: Rig, t: AutomaticTurn) => {
      await finish(r, t, report(0, 0), (x) => x.signal({ t: "handler_error", category: "runtime_failed" }));
    }],
    ["interrupted (lost stream)", async (r: Rig, t: AutomaticTurn) => {
      await finish(r, t, report(0, 0), (x) => x.signal({ t: "handler_error", category: "stream_interrupted" }));
    }],
    ["interrupted (shutdown)", async (r: Rig, t: AutomaticTurn) => { t.signal({ t: "shutdown" }); await r.settleAll(); }],
    ["timed_out", async (r: Rig, t: AutomaticTurn) => { t.signal({ t: "dispatch_timeout" }); await r.settleAll(); }],
    ["no delivery report", async (r: Rig, t: AutomaticTurn) => { await finish(r, t, undefined); }],
  ])("%s", async (_name, run) => {
    const r = rig();
    const frames = await wireData(r, (t) => run(r, t));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const data of frames) expect(reasoningSchemaErrors(data)).toEqual([]);
  });
});

describe("real Bot API acknowledgements (server-assigned client_msg_no, bare edit status)", () => {
  const FIRST_ID = "900000000000000001";

  it("persists the exact int64 id, activates the card and completes ordered edits and the terminal", async () => {
    const r = rig();
    const t = await activeTurn(r);
    const status = r.queue.status("card-1")!;
    expect(status).toMatchObject({ phase: "active", messageId: FIRST_ID });
    const active = r.store.getMessage(status.storeCardId as string)!;
    expect(active).toMatchObject({ messageId: FIRST_ID, clientMsgNo: "00000000-0000-4000-8000-000000000001", state: "active" });

    t.signal({ t: "delivery_start" });
    await r.time.advance(800);
    await finish(r, t, report(2, 2));

    expect(r.sends()).toHaveLength(1);
    const edits = r.net.edits().map((e) => ({ ...(JSON.parse(e.body) as { message_id: string; state: string }), seq: seqOf(e) }));
    expect(edits.map((e) => [e.message_id, e.state, e.seq])).toEqual([[FIRST_ID, "answering", 1], [FIRST_ID, "completed", 2]]);
    expect(t.inspect().terminal).toBe("completed");
    expect(r.store.getMessage(status.storeCardId as string)).toMatchObject({
      messageId: FIRST_ID, seqReserved: 2, seqAcked: 2, state: "done", terminalReason: "completed",
    });
    const outcomes = r.metrics.filter((m) => m.name === "card_send_total" || m.name === "card_edit_total").map((m) => [m.name, m.labels.code]);
    expect(outcomes).toEqual([["card_send_total", "acked"], ["card_edit_total", "acked"], ["card_edit_total", "acked"]]);
  });

  it("a truly ambiguous 200 (no valid id) is never resent or edited and suspends later automatic cards", async () => {
    const r = rig();
    r.net.reply({ status: 200, body: { message_id: "abc", client_msg_no: "server-assigned" } });
    const t = r.turn();
    await r.time.advance(0);
    t.observe(start());
    t.observe(cmd("c1"));
    await r.time.advance(800);
    const storeCardId = r.queue.status("card-1")?.storeCardId as string;
    t.signal({ t: "delivery_start" });
    await finish(r, t, report(1, 1));
    expect(r.sends()).toHaveLength(1);
    expect(r.edits()).toHaveLength(0);
    expect(r.store.getMessage(storeCardId)).toMatchObject({ messageId: null, seqAcked: 0, state: "ambiguous" });

    const next = r.turn();
    await r.time.advance(0);
    next.observe(start());
    next.observe(cmd("c2"));
    await r.time.advance(800);
    await finish(r, next, report(1, 1));
    expect(r.sends()).toHaveLength(1);
    expect(r.edits()).toHaveLength(0);
  });
});
