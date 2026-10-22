/**
 * Per-Bot card runtime facade (TD v3 §5.4 / E.1, WP-06 C08b; automatic only).
 *
 * Built only when `openCardSubsystem` is `ready`. It owns this Bot's Card API
 * client, policy, write queue, resource registry and turn coordinators; the
 * origin pacer is shared across Bots of one process (timing only, §3.5).
 * - `beginTurn` freezes a `TrustedTurnContext` from router-verified fields
 *   and returns the turn's coordinator; a newer generation of the same
 *   session supersedes the older one;
 * - `onTimeout` is the router's `DispatchObserver`: it addresses the exact
 *   dispatch handle, never the latest turn of a session;
 * - `close(reason)` runs the single aggregate drain, retires the card store
 *   lease, and only then releases the shared pacer (N5(c)).
 *
 * At open, automatic restart recovery (WP-13A-2) runs before the write queue
 * exists: the live automatic rows are classified and C1 rows rolled forward,
 * the policy is read fresh, and only C0a rows that pass every precondition
 * get a startup adoption grant. The queue is built with those grants, every
 * row is adopted and its Error/interrupted closure enqueued before the
 * runtime is returned, so no turn can open a card first. Recovery registers
 * as the `recovery` resource owner and drains with the rest on shutdown.
 *
 * Nothing here can throw into the ordinary path, and every failure leaves the
 * Bot card-inert. Telemetry is an optional injected port; no telemetry module
 * is imported (N6).
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AgentFailure, TurnFailure, classifyFailure } from "../agent-failure.js";
import type { DbAdapter } from "../db-adapter.js";
import { createCardApi, type CardApi } from "./api.js";
import type {
  BotRef,
  CardChannelType,
  CardResourceOwner,
  DispatchObserver,
  MonotonicClock,
  PolicySnapshot,
  ResourceDrainReport,
  RouteKind,
  RuntimeErrorCategory,
  ShutdownFence,
  ShutdownReason,
  TrustedTurnContext,
  WallClock,
} from "./contracts.js";
import { createClosureGrants, createTurnCoordinator, type AutomaticTurn } from "./lifecycle.js";
import { createPacer, systemTimers, type Pacer, type TimerPort } from "./pacer.js";
import { createPolicy, type CardPolicy } from "./policy.js";
import {
  openCardSubsystem,
  prepareAutomaticRecovery,
  recoveryGrants,
  runAutomaticRecovery,
  scanAutomaticRecovery,
  type AutomaticRecoveryResult,
  type CardQueueFactory,
  type CardSubsystem,
  type PreparedAutomaticRecovery,
} from "./recovery.js";
import { createResourceRegistry, type CardDrainResult } from "./resource-registry.js";
import type { CardBinding } from "./store.js";

type ReadySubsystem = Extract<CardSubsystem, { state: "ready" }>;
type WriteTelemetry = NonNullable<Parameters<CardQueueFactory>[0]["telemetry"]>;

/** Fresh per process run; any other incarnation's live handler generations are closed at open. */
const RUNTIME_INCARNATION = randomUUID();
/** Keys the opaque credential reference; never persisted or logged. */
const PROCESS_KEY = randomBytes(32);

const MONOTONIC: MonotonicClock = Object.freeze({ nowMono: () => performance.now() });
const WALL: WallClock = Object.freeze({ nowUtcMs: () => Date.now() });

// ─── shared origin pacer (§3.5) ─────────────────────────────────────────────

let shared: { pacer: Pacer; refs: number } | undefined;

function acquireSharedPacer(): Pacer {
  shared ??= { pacer: createPacer({ clock: MONOTONIC }), refs: 0 };
  shared.refs++;
  return shared.pacer;
}

function releaseSharedPacer(pacer: Pacer): void {
  if (shared === undefined || shared.pacer !== pacer) return;
  shared.refs--;
  if (shared.refs > 0) return;
  shared = undefined;
  try { pacer.close(); } catch { /* timers only */ }
}

// ─── public surface ─────────────────────────────────────────────────────────

export interface CardTurnInput {
  /** The router's dispatch handle id for this turn (`TurnContext.turnId`). */
  readonly dispatchId: string;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly channelType: number;
  readonly requesterUid: string;
  readonly resetEpoch: number;
  /** Authenticated in-process cron fire. */
  readonly cron: boolean;
}

export interface CardRuntime extends DispatchObserver {
  readonly closing: boolean;
  /** Coordinator for one processed turn, or undefined when this turn gets no card. */
  beginTurn(input: CardTurnInput): AutomaticTurn | undefined;
  /** Resolves when tracked policy/terminal work has settled. */
  idle(): Promise<void>;
  /** Automatic restart recovery of this open; resolves once every recovery closure settled. Never rejects. */
  readonly recovery: Promise<AutomaticRecoveryResult>;
  /** Fence, close and drain every card resource of this Bot once; never rejects. */
  close(reason?: ShutdownReason): Promise<CardDrainResult | undefined>;
}

export interface CardRuntimeOptions {
  readonly apiUrl: string;
  readonly botToken: string;
  readonly clock?: MonotonicClock;
  readonly timers?: TimerPort;
  readonly fetchImpl?: typeof fetch;
  /** Wall clock for HTTP-date Retry-After values. */
  readonly nowUtcMs?: () => number;
  /** Defaults to the process-shared origin pacer (or a private one for an injected clock). */
  readonly pacer?: Pacer;
  readonly telemetry?: WriteTelemetry;
  readonly newId?: () => string;
}

export interface OpenCardRuntimeOptions extends CardRuntimeOptions {
  /** The Bot's already-open ordinary database adapter. */
  readonly adapter: DbAdapter;
  readonly dataDir: string;
  readonly wall?: WallClock;
}

const ROUTE_KINDS: Readonly<Record<CardChannelType, RouteKind>> = Object.freeze({ 1: "dm", 2: "group", 5: "topic" });

function isCardChannel(channelType: number): channelType is CardChannelType {
  return channelType === 1 || channelType === 2 || channelType === 5;
}

function credentialRef(token: string): string {
  return createHmac("sha256", PROCESS_KEY).update(token, "utf8").digest("base64url");
}

/** Content-free classification of a handler error for the card terminal. */
export function classifyCardError(err: unknown): RuntimeErrorCategory {
  try {
    const failure = err instanceof TurnFailure ? err.report.final : err instanceof AgentFailure ? err.snapshot : classifyFailure(err);
    if (failure.category === "stream_interrupted") return "stream_interrupted";
    if (failure.stage === "jsonl_parse") return "sdk_parse_error";
    if (failure.stage === "inference" || failure.stage === "process_exit" || failure.stage === "spawn") return "runtime_failed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Open the card subsystem for one Bot and build its runtime. Resolves
 * undefined, never rejects, whenever the Bot stays card-inert.
 */
export async function openCardRuntime(options: OpenCardRuntimeOptions): Promise<CardRuntime | undefined> {
  let subsystem: CardSubsystem;
  try {
    subsystem = await openCardSubsystem({ adapter: options.adapter, dataDir: options.dataDir, clock: options.wall ?? WALL,
      runtimeIncarnation: RUNTIME_INCARNATION });
  } catch {
    return undefined;
  }
  if (subsystem.state !== "ready") return undefined;
  let runtime: CardRuntime | undefined;
  const base = createRuntimeBase(options);
  if (base !== undefined) {
    let prepared: PreparedAutomaticRecovery;
    try {
      // Before the queue exists: classify, roll C1 forward, then the P1–P5 preconditions.
      const scan = scanAutomaticRecovery(subsystem.store);
      const wall = options.wall ?? WALL;
      prepared = await prepareAutomaticRecovery(scan, { botRef: base.botRef, policy: base.policy,
        eligible: () => base.pacer.gate(base.api.origin).eligible, nowUtcMs: () => wall.nowUtcMs(), newId: base.newId });
    } catch {
      prepared = Object.freeze({ scan: "failed", counts: Object.freeze({ scanned: 0, restored: 0, rolledForward: 0, uncertain: 0,
        legacy: 0, deferred: 0, failed: 0 }), closures: Object.freeze([]) });
    }
    runtime = assembleRuntime(subsystem, options, base, prepared);
  }
  if (runtime === undefined) {
    try { subsystem.store.retire(); } catch { /* lease already gone */ }
  }
  return runtime;
}

interface RuntimeBase {
  readonly clock: MonotonicClock;
  readonly timers: TimerPort;
  readonly newId: () => string;
  readonly api: CardApi;
  readonly botRef: BotRef;
  readonly policy: CardPolicy;
  readonly pacer: Pacer;
  readonly ownsShared: boolean;
}

/** API client, policy and pacer of one Bot; undefined (never a throw) on any configuration fault. */
function createRuntimeBase(options: CardRuntimeOptions): RuntimeBase | undefined {
  const clock = options.clock ?? MONOTONIC;
  const timers = options.timers ?? systemTimers;
  const newId = options.newId ?? randomUUID;
  let api: CardApi;
  let botRef: BotRef;
  let policy: CardPolicy;
  try {
    api = createCardApi({ apiUrl: options.apiUrl, credential: options.botToken,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.nowUtcMs !== undefined ? { nowUtcMs: options.nowUtcMs } : {}) });
    botRef = Object.freeze({ originKey: api.origin.key, credentialRef: credentialRef(options.botToken) });
    policy = createPolicy({ botRef, api, clock });
  } catch {
    return undefined;
  }
  const ownsShared = options.pacer === undefined && options.clock === undefined;
  const pacer = options.pacer ?? (ownsShared ? acquireSharedPacer() : createPacer({ clock, timers }));
  return Object.freeze({ clock, timers, newId, api, botRef, policy, pacer, ownsShared });
}

/**
 * Build the runtime over a ready subsystem without restart recovery;
 * undefined (never a throw) on any configuration fault. `openCardRuntime` is
 * the production entry point and always runs recovery first.
 */
export function createCardRuntime(subsystem: ReadySubsystem, options: CardRuntimeOptions): CardRuntime | undefined {
  const base = createRuntimeBase(options);
  return base === undefined ? undefined : assembleRuntime(subsystem, options, base, undefined);
}

function assembleRuntime(subsystem: ReadySubsystem, options: CardRuntimeOptions, base: RuntimeBase,
  prepared: PreparedAutomaticRecovery | undefined): CardRuntime | undefined {
  const { clock, timers, newId, api, botRef, policy, pacer, ownsShared } = base;
  const grants = createClosureGrants(policy);
  const registry = createResourceRegistry({ clock, timers });
  let queue: ReturnType<CardQueueFactory>;
  try {
    queue = subsystem.queueFactory({ api, policy: grants, pacer, clock, timers,
      ...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
      ...(prepared !== undefined && prepared.closures.length > 0 ? { recoveryGrants: recoveryGrants(prepared) } : {}) });
  } catch {
    if (ownsShared) releaseSharedPacer(pacer);
    return undefined;
  }

  const inflight = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    const p = Promise.resolve(work).catch(() => undefined);
    inflight.add(p);
    void p.finally(() => { inflight.delete(p); });
  };
  const idle = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.all([...inflight]);
  };

  /** Tracked terminal/policy work, drained against the shared fence. */
  const policyOwner: CardResourceOwner = Object.freeze({
    kind: "policy" as const,
    close(): void { /* coordinators are fenced by the queue's close */ },
    async drain(fence: ShutdownFence): Promise<ResourceDrainReport> {
      const pending = [...inflight];
      if (pending.length === 0) return Object.freeze({ settled: 0, aborted: 0, unresolved: 0 });
      let handle: unknown;
      const deadline = new Promise<"deadline">((resolve) => {
        handle = timers.setTimeout(() => resolve("deadline"), Math.max(0, fence.deadlineMono - clock.nowMono()));
        fence.signal.addEventListener("abort", () => resolve("deadline"), { once: true });
      });
      const first = await Promise.race([Promise.all(pending).then(() => "settled" as const), deadline]);
      timers.clearTimeout(handle);
      const left = pending.filter((p) => inflight.has(p)).length;
      return Object.freeze(first === "settled" ? { settled: pending.length, aborted: 0, unresolved: 0 }
        : { settled: pending.length - left, aborted: 0, unresolved: left });
    },
  });
  registry.register(queue);
  registry.register(policyOwner);

  // Every adoption runs here, before the runtime can admit a turn (the queue's startup window).
  let recovery: Promise<AutomaticRecoveryResult>;
  if (prepared === undefined) {
    recovery = Promise.resolve(Object.freeze({ scan: "ok" as const, report: Object.freeze({ scanned: 0, restored: 0,
      rolledForward: 0, uncertain: 0, legacy: 0, deferred: 0, failed: 0 }) }));
  } else {
    const run = runAutomaticRecovery(prepared, queue, { botRef }, { clock, timers });
    registry.register(run.owner);
    recovery = run.result;
  }

  /** Permission reads consult the shared origin gate first; an ineligible origin is no read. */
  const refresh = async (): Promise<PolicySnapshot | undefined> => {
    if (!pacer.gate(api.origin).eligible) return undefined;
    try { return await policy.snapshot(); } catch { return undefined; }
  };

  const byDispatch = new Map<string, AutomaticTurn>();
  const bySession = new Map<string, AutomaticTurn>();
  /** Dispatches that timed out before their coordinator existed (bounded). */
  const timedOut = new Set<string>();
  const MAX_TIMED_OUT = 256;
  let closing = false;
  let closed: Promise<CardDrainResult | undefined> | undefined;

  // Warm the policy so the first turn's decision usually sees a resolved snapshot.
  track(refresh());

  const runtime: CardRuntime = {
    get closing() { return closing; },
    recovery,

    beginTurn(input) {
      try {
        if (closing || !isCardChannel(input.channelType) || typeof input.dispatchId !== "string" || input.dispatchId.length === 0) return undefined;
        const kind = ROUTE_KINDS[input.channelType];
        const turnGeneration = newId();
        const resetEpoch = Number.isSafeInteger(input.resetEpoch) && input.resetEpoch >= 0 ? input.resetEpoch : 0;
        const ctx: TrustedTurnContext = Object.freeze({
          botRef,
          route: Object.freeze({ channelId: input.channelId, channelType: input.channelType,
            ...(kind === "topic" ? { topicScope: input.channelId } : {}) }),
          requesterUid: input.requesterUid,
          sessionKey: input.sessionKey,
          turnGeneration,
          resetEpoch,
          policyIdentity: botRef.credentialRef,
          runtimeIncarnation: RUNTIME_INCARNATION,
          // No OBO or document-task targets exist on this path; both fail closed if ever set.
          routeEligibility: Object.freeze({ kind, obo: false, docTask: false, cron: input.cron === true }),
          origin: Object.freeze({ kind: "user" as const }),
        });
        const binding: CardBinding = Object.freeze({ sessionKey: input.sessionKey, channelId: input.channelId,
          channelType: input.channelType, topicScope: kind === "topic" ? input.channelId : null, generation: turnGeneration, resetEpoch });
        const dispatchId = input.dispatchId;
        const turn = createTurnCoordinator({
          ctx, binding, cardId: newId(), clientMsgNo: newId(), queue, policy, closure: grants, refresh, clock, track,
          onFinished: () => {
            if (byDispatch.get(dispatchId) === turn) byDispatch.delete(dispatchId);
            if (bySession.get(input.sessionKey) === turn) bySession.delete(input.sessionKey);
          },
        });
        bySession.get(input.sessionKey)?.supersede();
        bySession.set(input.sessionKey, turn);
        byDispatch.set(dispatchId, turn);
        if (timedOut.delete(dispatchId)) turn.signal({ t: "dispatch_timeout" });
        return turn;
      } catch {
        return undefined;
      }
    },

    onTimeout(dispatchId) {
      try {
        const turn = byDispatch.get(dispatchId);
        if (turn !== undefined) { turn.signal({ t: "dispatch_timeout" }); return; }
        if (closing) return;
        if (timedOut.size >= MAX_TIMED_OUT) timedOut.delete(timedOut.values().next().value as string);
        timedOut.add(dispatchId);
      } catch { /* the router's timeout path is never affected */ }
    },

    idle,

    close(reason = "shutdown") {
      closed ??= (async () => {
        closing = true;
        let result: CardDrainResult | undefined;
        try { result = await registry.closeAll(reason); } catch { result = undefined; }
        // The store lease is retired only after the queue drained; then the pacer may be released.
        try { subsystem.store.retire(); } catch { /* already retired */ }
        if (ownsShared) releaseSharedPacer(pacer);
        else if (options.pacer === undefined) { try { pacer.close(); } catch { /* timers only */ } }
        byDispatch.clear();
        bySession.clear();
        timedOut.clear();
        return result;
      })();
      return closed;
    },
  };
  return Object.freeze(runtime);
}
