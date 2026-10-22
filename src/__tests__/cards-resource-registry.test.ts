/**
 * Card resource registry (§4.5, WP-13A-1): one aggregate 3 s drain budget per
 * Bot, synchronous close of every owner before any drain, unresolved work
 * reported as ambiguous, and write-queue drain complete before the pacer is
 * released.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCardApi } from "../cards/api.js";
import type {
  BotRef, CardResourceOwner, CardResourceRegistry, Limits, PolicySnapshot, RegistryData, ResourceDrainReport, ShutdownFence,
} from "../cards/contracts.js";
import { migrateCardSchema } from "../cards/migrations.js";
import { normalizeOrigin } from "../cards/origin.js";
import { createPacer } from "../cards/pacer.js";
import { CARD_DRAIN_BUDGET_MS, createResourceRegistry } from "../cards/resource-registry.js";
import { CardStore } from "../cards/store.js";
import { createWriteQueue, type CardFrame } from "../cards/write-queue.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, scriptedFetch, type ManualTime } from "./fixtures/card-write-harness.js";

type Kind = CardResourceOwner["kind"];

interface FakeOwner extends CardResourceOwner {
  readonly fences: ShutdownFence[];
  readonly log: string[];
  settle(report?: ResourceDrainReport): void;
}

/** Owner whose drain settles when the test says so, or on its fence signal. */
function owner(kind: Kind, log: string[], opts: { onAbort?: ResourceDrainReport; closeThrows?: boolean } = {}): FakeOwner {
  const fences: ShutdownFence[] = [];
  let settle: (report: ResourceDrainReport) => void = () => undefined;
  return {
    kind,
    fences,
    log,
    close(f) {
      fences.push(f);
      log.push(`close:${kind}`);
      if (opts.closeThrows) throw new Error("close failed");
    },
    drain(f) {
      fences.push(f);
      log.push(`drain:${kind}`);
      return new Promise<ResourceDrainReport>((resolve) => {
        settle = (r) => { log.push(`drained:${kind}`); resolve(r); };
        if (opts.onAbort) f.signal.addEventListener("abort", () => settle(opts.onAbort as ResourceDrainReport), { once: true });
      });
    },
    settle(report = { settled: 1, aborted: 0, unresolved: 0 }) { settle(report); },
  };
}

function registry(time: ManualTime = manualTime()) {
  return { time, reg: createResourceRegistry({ clock: time.clock, timers: time.timers }) };
}

describe("register", () => {
  it("implements the existing CardResourceRegistry port", () => {
    const { reg } = registry();
    const port: CardResourceRegistry = reg;
    const handle = port.register(owner("write_queue", []));
    expect(handle).not.toBeNull();
    expect(typeof handle?.unregister).toBe("function");
  });

  it("returns null once closing has begun, and the late owner is never closed or drained", async () => {
    const { time, reg } = registry();
    const log: string[] = [];
    const early = owner("write_queue", log);
    reg.register(early);
    const done = reg.closeAll("shutdown");
    const late = owner("tool_host", log);
    expect(reg.register(late)).toBeNull();
    early.settle();
    await time.advance(0);
    await done;
    expect(late.fences).toHaveLength(0);
    expect(log.filter((l) => l.endsWith("tool_host"))).toEqual([]);
  });

  it("an unregistered owner is not closed or drained", async () => {
    const { time, reg } = registry();
    const log: string[] = [];
    const a = owner("write_queue", log);
    const b = owner("policy", log);
    reg.register(a);
    reg.register(b)?.unregister();
    const done = reg.closeAll("shutdown");
    a.settle();
    await time.advance(0);
    expect(await done).toMatchObject({ owners: 1 });
    expect(b.fences).toHaveLength(0);
  });

  it("refuses registration from inside an owner's close", async () => {
    const { time, reg } = registry();
    const late = owner("tool_host", []);
    let inside: unknown = "unset";
    const reentrant: CardResourceOwner = {
      kind: "write_queue",
      close() { inside = reg.register(late); },
      drain: () => Promise.resolve({ settled: 0, aborted: 0, unresolved: 0 }),
    };
    reg.register(reentrant);
    expect(reg.closing).toBe(false);
    const done = reg.closeAll("shutdown");
    expect(reg.closing).toBe(true);
    expect(inside).toBeNull();
    await time.advance(0);
    expect(await done).toMatchObject({ owners: 1 });
    expect(late.fences).toHaveLength(0);
  });

  it("rejects an owner outside the closed resource-class set", () => {
    const { reg } = registry();
    const bad = { ...owner("write_queue", []), kind: "pacer" } as unknown as CardResourceOwner;
    expect(() => reg.register(bad)).toThrow(TypeError);
  });
});

describe("closeAll", () => {
  it("builds one fence with an aggregate 3 s deadline and closes every owner before draining any", async () => {
    const { time, reg } = registry();
    const log: string[] = [];
    const owners = (["tool_host", "write_queue", "event_consumer", "policy", "recovery", "store_lease"] as const)
      .map((k) => owner(k, log));
    for (const o of owners) reg.register(o);
    const start = time.now();
    const done = reg.closeAll("bot_removed");
    const closes = log.filter((l) => l.startsWith("close:")).length;
    expect(closes).toBe(6);
    expect(log.slice(0, 6).every((l) => l.startsWith("close:"))).toBe(true);
    expect(CARD_DRAIN_BUDGET_MS).toBe(3000);
    const fences = new Set(owners.flatMap((o) => o.fences));
    expect(fences.size).toBe(1);
    const [fence] = [...fences];
    expect(fence).toMatchObject({ reason: "bot_removed", deadlineMono: start + 3000 });
    expect(Object.isFrozen(fence)).toBe(true);
    for (const o of owners) o.settle();
    await time.advance(0);
    expect(await done).toEqual({
      reason: "bot_removed", owners: 6, settled: 6, aborted: 0, unresolved: 0, overdue: 0, faulted: 0, outcome: "drained",
    });
    expect(fence.signal.aborted).toBe(false);
  });

  it("aborts the fence signal exactly at the aggregate deadline", async () => {
    const { time, reg } = registry();
    const log: string[] = [];
    const o = owner("write_queue", log, { onAbort: { settled: 0, aborted: 2, unresolved: 0 } });
    reg.register(o);
    const start = time.now();
    const done = reg.closeAll("shutdown");
    await time.advanceTo(start + 2999);
    expect(o.fences[0].signal.aborted).toBe(false);
    await time.advanceTo(start + 3000);
    expect(o.fences[0].signal.aborted).toBe(true);
    expect(await done).toMatchObject({ settled: 0, aborted: 2, unresolved: 0, outcome: "drained" });
  });

  it("reports unresolved work as ambiguous, never as drained", async () => {
    const { time, reg } = registry();
    const a = owner("write_queue", []);
    const b = owner("tool_host", []);
    reg.register(a);
    reg.register(b);
    const done = reg.closeAll("shutdown");
    a.settle({ settled: 2, aborted: 1, unresolved: 1 });
    b.settle({ settled: 1, aborted: 0, unresolved: 0 });
    await time.advance(0);
    expect(await done).toMatchObject({ settled: 3, aborted: 1, unresolved: 1, outcome: "ambiguous" });
  });

  it("an owner that never reports by the deadline is counted as unresolved and the total wait stays bounded", async () => {
    const { time, reg } = registry();
    const stuck = owner("event_consumer", []);
    const fine = owner("write_queue", []);
    reg.register(stuck);
    reg.register(fine);
    const start = time.now();
    let resolvedAt = -1;
    const done = reg.closeAll("shutdown").then((r) => { resolvedAt = time.now(); return r; });
    fine.settle();
    await time.advanceTo(start + 3000);
    expect(await done).toMatchObject({ settled: 1, unresolved: 1, overdue: 1, outcome: "ambiguous" });
    expect(resolvedAt).toBe(start + 3000);
  });

  it("a throwing close, a rejecting or throwing drain and a malformed report are faults counted as unresolved", async () => {
    const { time, reg } = registry();
    const log: string[] = [];
    const throwsOnClose = owner("policy", log, { closeThrows: true });
    const rejects: CardResourceOwner = { kind: "recovery", close() { /* no-op */ }, drain: () => Promise.reject(new Error("x")) };
    const throwsSync: CardResourceOwner = { kind: "store_lease", close() { /* no-op */ }, drain() { throw new Error("y"); } };
    const malformed: CardResourceOwner = { kind: "tool_host", close() { /* no-op */ },
      drain: () => Promise.resolve({ settled: -1, aborted: 0.5, unresolved: Number.NaN }) };
    const good = owner("write_queue", log);
    for (const o of [throwsOnClose, rejects, throwsSync, malformed, good]) reg.register(o);
    const done = reg.closeAll("shutdown");
    // A throwing close never prevents the other owners from being closed and drained.
    expect(log.filter((l) => l.startsWith("close:"))).toEqual(["close:policy", "close:write_queue"]);
    throwsOnClose.settle();
    good.settle();
    await time.advance(0);
    // The throwing close breached "must not throw", so its fence may not hold: counted as a fault too.
    expect(await done).toMatchObject({ owners: 5, settled: 2, unresolved: 4, faulted: 4, overdue: 0, outcome: "ambiguous" });
  });

  it("is idempotent: a second call returns the first result and never re-closes owners", async () => {
    const { time, reg } = registry();
    const log: string[] = [];
    const o = owner("write_queue", log);
    reg.register(o);
    const first = reg.closeAll("bot_removed");
    const second = reg.closeAll("shutdown");
    o.settle();
    await time.advance(0);
    expect(await second).toEqual(await first);
    expect((await first).reason).toBe("bot_removed");
    expect(log.filter((l) => l.startsWith("close:"))).toHaveLength(1);
  });

  it("with no owners resolves drained immediately", async () => {
    const { reg } = registry();
    expect(await reg.closeAll("shutdown")).toMatchObject({ owners: 0, outcome: "drained" });
  });
});

// ─── N5(c): write queue drains no later than the pacer release ──────────────

describe("N5(c): write-queue drain completes before the pacer is released", () => {
  const roots: string[] = [];
  const adapters: DbAdapter[] = [];
  afterEach(() => {
    for (const a of adapters.splice(0)) { try { a.close(); } catch { /* closed */ } }
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const LIMITS: Limits = { maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384, maxInputTextBytes: 4096, maxInputsBytes: 16384 };
  const DATA: RegistryData = {
    reasoningId: "octo-progress", state: "reasoning", title: "Reasoning", statusLabel: "Working", statusTone: "Accent",
    timerText: "Reasoning", traceExpanded: true, traceCollapsed: false, collapsedSummary: "Reasoning in progress",
    phases: [{ thought: "Working", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
  };
  const frame = (label: string): CardFrame =>
    ({ k: "registry", ref: { id: "ai.reasoning-process", version: "0.4.0" }, state: "reasoning", data: { ...DATA, progressText: label } });

  it("a queue waiting on an origin cooldown settles inside closeAll; the caller releases the pacer only afterwards", async () => {
    const time = manualTime();
    const root = mkdtempSync(join(tmpdir(), "cards-reg-"));
    roots.push(root);
    const adapter = createAdapter(join(root, "cc-octo.db"));
    adapters.push(adapter);
    new SessionStore(adapter).init();
    migrateCardSchema(adapter, { installationRef: "install-a", lineageId: "lineage-1", nowMs: time.wall.nowUtcMs() });
    const store = new CardStore(adapter, { clock: time.wall });
    const net = scriptedFetch(time);
    const api = createCardApi({ apiUrl: "https://api.example.com", credential: "t", fetchImpl: net.fetchImpl, nowUtcMs: time.wall.nowUtcMs });
    const ref: BotRef = { originKey: normalizeOrigin("https://api.example.com").key, credentialRef: "opaque-a" };
    const policy = { authorize: () => ({ allowed: true as const, snapshot: {} as PolicySnapshot, limits: LIMITS }) };
    const events: string[] = [];
    const base = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
    const pacer = { ...base, close: () => { events.push("pacer:close"); base.close(); } };
    const queue = createWriteQueue({ api, store, policy, pacer, clock: time.clock, timers: time.timers });
    const drain = queue.drain.bind(queue);
    const tracked: CardResourceOwner = { kind: queue.kind, close: (f) => queue.close(f),
      drain: async (f) => { const r = await drain(f); events.push("queue:drained"); return r; } };

    // Active card, then a 429 with a long Retry-After puts the origin in cooldown.
    const binding = { sessionKey: "group:g1", channelId: "g1", channelType: 2 as const, topicScope: null, generation: "turn-1", resetEpoch: 0 };
    const spec = { cardId: "c1", kind: "automatic" as const, capability: "automatic" as const, ctx: { botRef: ref }, binding, clientMsgNo: randomUUID() };
    queue.open(spec);
    queue.enqueue("c1", frame("first"));
    await time.advance(800);
    net.reply({ status: 429, headers: { "retry-after": "900" } });
    queue.enqueue("c1", frame("p"));
    await time.advance(800);
    const terminal = queue.finalize("c1", frame("done"));
    await time.advance(10);
    expect(base.gate(normalizeOrigin("https://api.example.com")).eligible).toBe(false);

    const reg = createResourceRegistry({ clock: time.clock, timers: time.timers });
    reg.register(tracked);
    const result = reg.closeAll("shutdown").then(async (r) => { events.push("registry:resolved"); pacer.close(); return r; });
    await time.advance(3000);
    expect(await result).toMatchObject({ owners: 1, outcome: "drained" });
    expect(await terminal).toMatchObject({ outcome: "cancelled" });
    expect(events).toEqual(["queue:drained", "registry:resolved", "pacer:close"]);
  });

  it("an initial send still in flight at the deadline is reported ambiguous and its row stays sending", async () => {
    const time = manualTime();
    const root = mkdtempSync(join(tmpdir(), "cards-reg-"));
    roots.push(root);
    const adapter = createAdapter(join(root, "cc-octo.db"));
    adapters.push(adapter);
    new SessionStore(adapter).init();
    migrateCardSchema(adapter, { installationRef: "install-a", lineageId: "lineage-1", nowMs: time.wall.nowUtcMs() });
    const store = new CardStore(adapter, { clock: time.wall });
    const net = scriptedFetch(time);
    const api = createCardApi({ apiUrl: "https://api.example.com", credential: "t", fetchImpl: net.fetchImpl, nowUtcMs: time.wall.nowUtcMs });
    const ref: BotRef = { originKey: normalizeOrigin("https://api.example.com").key, credentialRef: "opaque-a" };
    const policy = { authorize: () => ({ allowed: true as const, snapshot: {} as PolicySnapshot, limits: LIMITS }) };
    const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
    const queue = createWriteQueue({ api, store, policy, pacer, clock: time.clock, timers: time.timers });
    const reg = createResourceRegistry({ clock: time.clock, timers: time.timers });
    reg.register(queue);
    const binding = { sessionKey: "group:g1", channelId: "g1", channelType: 2 as const, topicScope: null, generation: "turn-1", resetEpoch: 0 };
    queue.open({ cardId: "c1", kind: "automatic", capability: "automatic", ctx: { botRef: ref }, binding, clientMsgNo: randomUUID() });
    net.reply({ hold: true });
    queue.enqueue("c1", frame("first"));
    await time.advance(800);
    expect(net.heldCount()).toBe(1);
    const done = reg.closeAll("shutdown");
    await time.advance(3000);
    expect(await done).toMatchObject({ owners: 1, unresolved: 1, outcome: "ambiguous" });
    expect(queue.status("c1")).toMatchObject({ phase: "closed", outcome: "unresolved" });
    expect(store.getMessage(queue.status("c1")?.storeCardId as string)?.state).toBe("sending");
    // The next construction over the same store starts suspended (N2).
    expect(createWriteQueue({ api, store, policy, pacer, clock: time.clock, timers: time.timers }).suspendedCapabilities())
      .toEqual(["automatic"]);
  });
});
