/**
 * Per-Bot card runtime facade (TD v3 §5.4 / E.1, WP-06 C08b; automatic only).
 *
 * Built only when `openCardSubsystem` is `ready`. It owns this Bot's Card API
 * client, policy, write queue, resource registry and turn coordinators; the
 * origin pacer is shared across Bots of one process (timing only, §3.5).
 * - `beginTurn` freezes a `TrustedTurnContext` from router-verified fields
 *   and returns the turn's coordinator; a newer generation of the same
 *   session supersedes the older one. Only when every explicit-tool gate
 *   G-a…G-g holds (AM-08 v4 §7.2), a transport exists and both route facts
 *   (OBO, document task) are proven false does it also register the
 *   generation's handler and return the authority-free `CardInjectionLaunch`.
 *   The op table is derived per runtime from `PRODUCTION_EXPLICIT_OPS`, with
 *   display capabilities read from this Bot's own policy; the explicit
 *   transport sends through this Bot's API client and the shared pacer;
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
import { createExplicitDisplay, type ExplicitDisplayCapabilities } from "./explicit-display.js";
import { createExplicitTransport } from "./explicit-transport.js";
import type { CardBinding } from "./store.js";
import {
  CALL_ADMISSION_MS,
  PRODUCTION_EXPLICIT_OPS,
  createToolHost,
  explicitPlatformCertified,
  gatewayAdmitsInjection,
  type CardInjectionLaunch,
  type ExplicitGeneration,
  type ExplicitOpHandler,
  type ExplicitOpTable,
  type ExplicitTransport,
  type ToolHost,
} from "./tool-host.js";
import { cardSubsystemPaths, ledgerRecovered } from "./recovery.js";
import type { CardObservableEvent, ToolOpcode, TurnSignal } from "./contracts.js";

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
  /**
   * On-behalf-of fact about the Bot's outbound identity (G-e reading (a)):
   * `true` for a delivery carrying a server-reserved OBO key, `false` only for
   * the adapter-owned WS IM origin with the Bot's own send identity, and
   * `undefined` (unknown) otherwise. An unknown or `true` fact offers no
   * explicit op (D-W1(b)); it is never guessed `false`. Derived by
   * `inbound-route-facts.ts`; requester attribution is a separate contract.
   */
  readonly obo: boolean | undefined;
  /** Document-task fact: `false` only for the WS IM origin, otherwise unknown; same offer rules as {@link CardTurnInput.obo}. */
  readonly docTask: boolean | undefined;
  /** Monotonic dispatch deadline (`TurnContext.deadline`); bounds explicit authority. */
  readonly deadlineMono?: number;
  /** Resolves the turn's Codex working directory, checked for project config layers (G-d); read only past G-b/G-c/G-e. */
  readonly sessionCwd?: () => string;
  /** Current durable reset epoch; a /reset fences explicit authority. */
  readonly currentResetEpoch?: () => number;
}

/** One processed turn: its automatic coordinator and, only when every gate holds, the explicit launch. */
export interface BegunTurn {
  readonly coordinator: AutomaticTurn;
  readonly injection?: CardInjectionLaunch;
}

export interface CardRuntime extends DispatchObserver {
  readonly closing: boolean;
  /** Coordinator (and optional explicit launch) for one processed turn, or undefined when this turn gets no card. */
  beginTurn(input: CardTurnInput): BegunTurn | undefined;
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
  /** Test-only explicit op table (G-b); never set by `index.ts`. */
  readonly explicitOpsForTest?: ExplicitOpTable;
  /** Test-only explicit transport; `null` builds none. Never set by `index.ts`. */
  readonly explicitTransportForTest?: ExplicitTransport | null;
}

export interface OpenCardRuntimeOptions extends CardRuntimeOptions {
  /** The Bot's already-open ordinary database adapter. */
  readonly adapter: DbAdapter;
  readonly dataDir: string;
  readonly wall?: WallClock;
  /** Roots the bootstrap directory must stay outside of (G-f); absent ⇒ no explicit injection. */
  readonly bootstrapExcludedRoots?: readonly string[];
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
 * Display capabilities of one call: this Bot's negotiated elements, advertised
 * actions and effective limits, plus the snapshot they came from; undefined unless the
 * Bot's current policy allows display.
 */
function displayCapabilities(policy: CardPolicy, botRef: BotRef): ExplicitDisplayCapabilities | undefined {
  const auth = policy.authorize("display", { botRef });
  if (!auth.allowed) return undefined;
  return Object.freeze({ elements: auth.snapshot.display.elements, actions: auth.snapshot.display.actions, limits: auth.limits,
    snapshot: auth.snapshot });
}

/**
 * Per-runtime op table derived from the registered keys: display gets a
 * handler bound to this Bot's capabilities. An op with no per-runtime
 * handler here is left out.
 */
function runtimeExplicitOps(registered: ExplicitOpTable, capabilities: () => ExplicitDisplayCapabilities | undefined): ExplicitOpTable {
  const table = new Map<ToolOpcode, ExplicitOpHandler>();
  for (const op of registered.keys()) {
    if (op === "display") table.set(op, createExplicitDisplay({ capabilities }) as ExplicitOpHandler);
  }
  return Object.freeze(table);
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

  // Explicit tools. G-b: with no op there is no host, listener or bootstrap
  // directory at all; G-g: the host also refuses a store whose ledger was not
  // recovered first. Only the production entry point supplies the data dir.
  const explicitOps = options.explicitOpsForTest ?? runtimeExplicitOps(PRODUCTION_EXPLICIT_OPS, () => displayCapabilities(policy, botRef));
  let transport: ExplicitTransport | undefined;
  try {
    transport = options.explicitTransportForTest === null ? undefined
      : options.explicitTransportForTest ?? createExplicitTransport({ api, pacer, policy, clock });
  } catch {
    transport = undefined;
  }
  const openOptions = "dataDir" in options ? options as OpenCardRuntimeOptions : undefined;
  let toolHost: ToolHost | undefined;
  if (explicitOps.size > 0 && openOptions?.bootstrapExcludedRoots !== undefined && ledgerRecovered(subsystem.store)) {
    try {
      toolHost = createToolHost({ store: subsystem.store, installationRef: subsystem.meta.installationRef,
        cardsDir: cardSubsystemPaths(openOptions.dataDir).cardsDir, ops: explicitOps,
        excludedRoots: openOptions.bootstrapExcludedRoots, clock, wall: openOptions.wall ?? WALL, timers, policy,
        ...(transport !== undefined ? { transport } : {}) });
    } catch {
      toolHost = undefined;
    }
    if (toolHost !== undefined && registry.register(toolHost) === null) { toolHost.close(Object.freeze({ reason: "shutdown" as const,
      deadlineMono: clock.nowMono(), signal: AbortSignal.abort() })); toolHost = undefined; }
  }

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
  const explicitByDispatch = new Map<string, ExplicitGeneration>();
  const explicitBySession = new Map<string, ExplicitGeneration>();
  /** Dispatches that timed out before their coordinator existed (bounded). */
  const timedOut = new Set<string>();
  const MAX_TIMED_OUT = 256;
  let closing = false;
  let closed: Promise<CardDrainResult | undefined> | undefined;

  // Warm the policy so the first turn's decision usually sees a resolved snapshot.
  track(refresh());

  /** Ops offered to one turn when G-a, G-c, G-d, G-e and G-g hold, a transport exists and the route is proven ordinary; empty otherwise. */
  const explicitOffer = (input: CardTurnInput): { readonly ops: readonly ToolOpcode[]; readonly cwd?: string } => {
    const none = { ops: [] };
    if (toolHost === undefined || closing || !ledgerRecovered(subsystem.store)) return none; // G-b, G-g
    if (transport === undefined) return none; // a call could only be charged and fail
    if (!explicitPlatformCertified()) return none; // G-c
    if (input.cron === true) return none; // G-e
    if (input.obo !== false || input.docTask !== false) return none; // D-W1(b): unknown or true is not offered
    if (typeof input.deadlineMono !== "number" || !Number.isFinite(input.deadlineMono)) return none;
    const remaining = input.deadlineMono - clock.nowMono();
    if (!Number.isFinite(remaining) || remaining < CALL_ADMISSION_MS) return none;
    if (typeof input.currentResetEpoch !== "function" || typeof input.sessionCwd !== "function") return none;
    let cwd: string;
    try { cwd = input.sessionCwd(); } catch { return none; }
    if (!gatewayAdmitsInjection(cwd)) return none; // G-d
    const offered: ToolOpcode[] = [];
    for (const op of explicitOps.keys()) {
      try { if (policy.authorize(op === "display" ? "display" : "interaction", { botRef }).allowed) offered.push(op); } // G-a
      catch { /* not offered */ }
    }
    return { ops: offered, cwd };
  };

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
          // Only a fact proven false is false; an unknown one counts as ineligible (D-W1(b)).
          routeEligibility: Object.freeze({ kind, obo: input.obo !== false, docTask: input.docTask !== false, cron: input.cron === true }),
          origin: Object.freeze({ kind: "user" as const }),
        });
        const binding: CardBinding = Object.freeze({ sessionKey: input.sessionKey, channelId: input.channelId,
          channelType: input.channelType, topicScope: kind === "topic" ? input.channelId : null, generation: turnGeneration, resetEpoch });
        const dispatchId = input.dispatchId;

        // Explicit injection: the server id is minted once here and frozen into the context.
        let turnCtx = ctx;
        let explicit: ExplicitGeneration | undefined;
        const offer = explicitOffer(input);
        if (toolHost !== undefined && offer.ops.length > 0) {
          const injected: TrustedTurnContext = Object.freeze({ ...ctx, injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}` });
          const readEpoch = input.currentResetEpoch as () => number;
          explicit = toolHost.openGeneration({
            ctx: injected, binding, expiresAtMono: input.deadlineMono as number, ops: offer.ops,
            currentResetEpoch: () => {
              try { const v = readEpoch(); return Number.isSafeInteger(v) && v >= 0 ? v : -1; } catch { return -1; }
            },
            admit: () => !closing && explicitPlatformCertified() && gatewayAdmitsInjection(offer.cwd),
          });
          if (explicit !== undefined) turnCtx = injected;
        }
        const closeExplicit = (): void => {
          if (explicit === undefined) return;
          try { explicit.close(); } catch { /* fenced in memory */ }
          if (explicitByDispatch.get(dispatchId) === explicit) explicitByDispatch.delete(dispatchId);
          if (explicitBySession.get(input.sessionKey) === explicit) explicitBySession.delete(input.sessionKey);
        };

        const turn = createTurnCoordinator({
          ctx: turnCtx, binding, cardId: newId(), clientMsgNo: newId(), queue, policy, closure: grants, refresh, clock, track,
          onFinished: () => {
            closeExplicit();
            if (byDispatch.get(dispatchId) === turn) byDispatch.delete(dispatchId);
            if (bySession.get(input.sessionKey) === turn) bySession.delete(input.sessionKey);
          },
        });
        // A newer generation of the session supersedes the older one, explicit authority included.
        const previous = explicitBySession.get(input.sessionKey);
        if (previous !== undefined) { try { previous.close(); } catch { /* fenced */ } explicitBySession.delete(input.sessionKey); }
        bySession.get(input.sessionKey)?.supersede();
        bySession.set(input.sessionKey, turn);
        byDispatch.set(dispatchId, turn);
        if (explicit !== undefined) { explicitByDispatch.set(dispatchId, explicit); explicitBySession.set(input.sessionKey, explicit); }
        if (timedOut.delete(dispatchId)) { closeExplicit(); turn.signal({ t: "dispatch_timeout" }); }
        if (explicit === undefined) return Object.freeze({ coordinator: turn });
        // Settle, timeout, shutdown and supersede fence the explicit generation first.
        const coordinator: AutomaticTurn = Object.freeze({
          generation: turn.generation,
          context: turn.context,
          observe: (ev: CardObservableEvent) => turn.observe(ev),
          signal: (sig: TurnSignal) => {
            if (sig !== null && typeof sig === "object" && (sig.t === "settle" || sig.t === "dispatch_timeout" || sig.t === "shutdown")) closeExplicit();
            turn.signal(sig);
          },
          settle: () => { closeExplicit(); turn.settle(); },
          claimsNotices: () => turn.claimsNotices(),
          supersede: () => { closeExplicit(); turn.supersede(); },
          inspect: () => turn.inspect(),
        });
        return Object.freeze({ coordinator, injection: explicit.launch });
      } catch {
        return undefined;
      }
    },

    onTimeout(dispatchId) {
      try {
        const explicit = explicitByDispatch.get(dispatchId);
        if (explicit !== undefined) { explicitByDispatch.delete(dispatchId); try { explicit.close(); } catch { /* fenced */ } }
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
        explicitByDispatch.clear();
        explicitBySession.clear();
        timedOut.clear();
        return result;
      })();
      return closed;
    },
  };
  return Object.freeze(runtime);
}
