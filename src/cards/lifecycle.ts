/**
 * Automatic-card turn coordinator (TD v3 §3.2 / PRD §7.4, WP-06 C08b).
 *
 * One coordinator per turn generation and at most one automatic card:
 * - Lazy: nothing is sent until the first displayable row; reasoning/todo only
 *   raise activity, so thinking-only, empty and explicit-output-only turns get
 *   no card. Only an `mcp_tool_call` matched to this generation's trusted
 *   injected server is excluded from rows (WP-08); any other server id is
 *   dropped and the item stays a generic Tool row. The card mode is decided once, from a fresh policy snapshot;
 *   otherwise the turn keeps the ordinary sanitized notices.
 * - Active/Answering: newer frames are enqueued (the write queue debounces,
 *   coalesces and re-authorizes before every transport).
 * - Terminal: Done only after a completed final attempt plus a Done-shaped
 *   delivery report from the normal-return path (D-A, R1 C3); a handler error,
 *   a failed delivery, a lost stream, shutdown and a dispatch timeout are
 *   Error. Terminals are absorbing.
 *
 * Effects are enqueue-only: `observe`/`signal`/`settle` never await, never
 * throw into the handler, and never touch the ordinary turn. The coordinator
 * holds no reference to the turn's publication guard: its terminal write is
 * authorized only by its own generation and the policy closure rules, so a
 * cancelled turn can neither fence nor be revived by it.
 */

import type {
  CardObservableEvent,
  DeliveryReport,
  ItemState,
  MonotonicClock,
  PinnedTemplate,
  PolicySnapshot,
  RuntimeErrorCategory,
  TrustedTurnContext,
  TurnCoordinator,
  TurnSignal,
} from "./contracts.js";
import { reportAllowsDone } from "./delivery-report.js";
import type { Authorization, CardPolicy, PolicyOperation } from "./policy.js";
import { EMPTY_PROGRESS, hasDisplayableRow, reduceProgress, type ProgressModel } from "./progress-model.js";
import type { CardQueueFactory } from "./recovery.js";
import {
  buildClosureFrame,
  buildProgressFrame,
  type AutomaticReason,
  type BuildOptions,
  type RegistryFrame,
  type TerminalReason,
} from "./registry-builder.js";
import type { CardBinding } from "./store.js";

type CardWriteQueue = ReturnType<CardQueueFactory>;
type CardSpec = Parameters<CardWriteQueue["open"]>[0];
type OpenResult = ReturnType<CardWriteQueue["open"]>;

/** The write-queue surface a coordinator uses. */
export type LifecycleQueue = Pick<CardWriteQueue, "open" | "enqueue" | "finalize" | "cancelNonterminal" | "status" | "suspendedCapabilities">;

/** Envelope cap shared with the write queue. */
const ENVELOPE_CAP = 16_384;

// ─── closure grants (AC-007.5) ──────────────────────────────────────────────

export interface ClosureGrants extends Pick<CardPolicy, "authorize"> {
  /** Permit one card context's terminal write under its expired pinned snapshot. */
  grant(ctx: object, pinned: PolicySnapshot, current: PolicySnapshot): void;
  revoke(ctx: object): void;
}

/**
 * Policy port for the write queue. It delegates to the real policy and adds
 * one narrow exception: a card context granted an expired-snapshot closure may
 * write under its own pinned snapshot, for the automatic capability only.
 * Only the coordinator grants it, after `closureDisposition` classified the
 * moment as `expired_closure_only`, and only for a minimal closure frame.
 * Retain that proof and revalidate it on every use, including queue retries;
 * a later invalidation or resolved disable must revoke the exception.
 */
export function createClosureGrants(policy: Pick<CardPolicy, "authorize" | "closureDisposition">): ClosureGrants {
  const grants = new WeakMap<object, { pinned: PolicySnapshot; current: PolicySnapshot }>();
  return Object.freeze({
    authorize(op: PolicyOperation, ctx: Parameters<CardPolicy["authorize"]>[1], pinned?: PolicySnapshot): Authorization {
      const auth = policy.authorize(op, ctx, pinned);
      if (auth.allowed || op !== "automatic" || pinned === undefined) return auth;
      const granted = grants.get(ctx);
      if (granted === undefined || granted.pinned !== pinned
        || policy.closureDisposition(op, pinned, granted.current) !== "expired_closure_only") return auth;
      return Object.freeze({ allowed: true, snapshot: pinned,
        limits: { ...pinned.display.limits, maxPayloadBytes: pinned.automatic.maxPayloadBytes } });
    },
    grant(ctx: object, pinned: PolicySnapshot, current: PolicySnapshot): void { grants.set(ctx, { pinned, current }); },
    revoke(ctx: object): void { grants.delete(ctx); },
  });
}

// ─── coordinator ────────────────────────────────────────────────────────────

export interface CoordinatorDeps {
  /** Frozen trusted context of this turn generation. */
  readonly ctx: TrustedTurnContext;
  readonly binding: CardBinding;
  /** Queue-local card identity; opaque, also used as the template reasoning id. */
  readonly cardId: string;
  /** Persisted before the first send; never regenerated. */
  readonly clientMsgNo: string;
  readonly queue: LifecycleQueue;
  readonly policy: Pick<CardPolicy, "authorize" | "closureDisposition">;
  readonly closure: Pick<ClosureGrants, "grant" | "revoke">;
  /** Fresh policy read; resolves undefined when the read is not possible. Never rejects. */
  readonly refresh: () => Promise<PolicySnapshot | undefined>;
  readonly clock: MonotonicClock;
  /** Tracks asynchronous terminal work for the shutdown drain. */
  readonly track: (work: Promise<unknown>) => void;
  /** Called once when the coordinator has nothing left to do. */
  readonly onFinished?: () => void;
}

export type CoordinatorMode = "undecided" | "card" | "notice";

export interface CoordinatorState {
  readonly mode: CoordinatorMode;
  readonly opened: boolean;
  readonly answering: boolean;
  readonly superseded: boolean;
  readonly settled: boolean;
  readonly terminal?: TerminalReason;
}

export interface AutomaticTurn extends TurnCoordinator {
  readonly generation: string;
  readonly context: TrustedTurnContext;
  /** True when this turn shows an automatic card, so sanitized tool notices are suppressed. */
  claimsNotices(): boolean;
  /** A newer generation of the same session began: fence this generation's non-terminal writes. */
  supersede(): void;
  inspect(): CoordinatorState;
}

function runtimeReason(category: RuntimeErrorCategory): TerminalReason {
  return category === "stream_interrupted" ? "interrupted" : "failed";
}

export function createTurnCoordinator(deps: CoordinatorDeps): AutomaticTurn {
  const { ctx, binding, cardId, clientMsgNo, queue, policy, closure, clock } = deps;
  const generation = binding.generation;
  // One context object per card: the queue's spec carries it, and a closure grant is keyed by it.
  const cardCtx: Pick<TrustedTurnContext, "botRef"> = Object.freeze({ botRef: ctx.botRef });

  let highWater = 0;
  const now = (): number => {
    let t: number;
    try { t = clock.nowMono(); } catch { return highWater; }
    if (typeof t === "number" && Number.isFinite(t) && t > highWater) highWater = t;
    return highWater;
  };
  const startedAt = now();

  let mode: CoordinatorMode = "undecided";
  let pinned: PolicySnapshot | undefined;
  let template: PinnedTemplate | undefined;
  let capBytes = ENVELOPE_CAP;
  let model: ProgressModel = EMPTY_PROGRESS;
  let opened = false;
  /** The queue closed the card before its terminal (e.g. a refused initial send). */
  let gone = false;
  let answering = false;
  let superseded = false;
  let settled = false;
  let terminal: TerminalReason | undefined;
  let finished = false;
  let finalAttempt: number | undefined;
  let finalTerminal: "completed" | "no_terminal" | undefined;
  let report: DeliveryReport | undefined;
  let handlerError: RuntimeErrorCategory | undefined;
  let refreshing: Promise<unknown> | undefined;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    try { deps.onFinished?.(); } catch { /* bookkeeping only */ }
  };

  const authorize = (snapshot?: PolicySnapshot): Authorization =>
    policy.authorize("automatic", cardCtx, snapshot);

  /** Single-flight refresh, used when permission is stale; never awaited by the handler. */
  const refreshOnce = (): void => {
    if (refreshing !== undefined) return;
    const work = deps.refresh().catch(() => undefined).finally(() => { refreshing = undefined; });
    refreshing = work;
    deps.track(work);
  };

  const options = (): BuildOptions => ({ reasoningId: cardId, elapsedMs: now() - startedAt, route: { channelId: binding.channelId, channelType: binding.channelType },
    clientMsgNo, maxEnvelopeBytes: capBytes });

  /** Decided once, at the first notice or the first displayable row. */
  function decide(): CoordinatorMode {
    if (mode !== "undecided") return mode;
    if (terminal !== undefined) { mode = "notice"; return mode; }
    let auth: Authorization;
    try { auth = authorize(); } catch { mode = "notice"; return mode; }
    const tpl = auth.allowed ? auth.snapshot.automatic.template : undefined;
    let suspended = true;
    try { suspended = queue.suspendedCapabilities().includes("automatic"); } catch { /* fail closed */ }
    if (!auth.allowed || tpl === undefined || tpl.controlFree !== true || suspended) {
      mode = "notice";
      return mode;
    }
    pinned = auth.snapshot;
    template = tpl;
    capBytes = Math.min(auth.limits.maxPayloadBytes, ENVELOPE_CAP);
    mode = "card";
    return mode;
  }

  /** N1: every `OpenResult` member is handled; anything but `opened` means no card for this turn. */
  function open(): boolean {
    const spec: CardSpec = {
      cardId, kind: "automatic", capability: "automatic", ctx: cardCtx, pinned, binding, clientMsgNo,
      presentation: { templateId: (template as PinnedTemplate).id, templateVersion: (template as PinnedTemplate).version },
    };
    const result: OpenResult = queue.open(spec);
    switch (result) {
      case "opened":
        opened = true;
        return true;
      case "duplicate":
      case "suspended":
      case "closing":
      case "contract":
        mode = "notice";
        return false;
      default: {
        const unreachable: never = result;
        void unreachable;
        mode = "notice";
        return false;
      }
    }
  }

  function currentReason(): AutomaticReason {
    return answering ? "answering" : "working";
  }

  /** Enqueue the newest progress frame; the queue debounces and re-authorizes before transport. */
  function progress(): void {
    if (terminal !== undefined || superseded || gone || !hasDisplayableRow(model)) return;
    if (decide() !== "card") return;
    if (!opened && !open()) return;
    if (!authorize(pinned).allowed) refreshOnce();
    const frame = buildProgressFrame(model, currentReason(), template as PinnedTemplate, options());
    if (frame === undefined) return;
    const r = queue.enqueue(cardId, frame);
    // NB2: the result alone does not say whether the card still exists; `status()` does.
    if (r !== "queued" && queue.status(cardId)?.phase === "closed") gone = true;
  }

  /** Keep `mcpServerId` only for the trusted injected server of this generation. */
  function trusted(ev: ItemState): ItemState {
    const id = ev.safe?.mcpServerId;
    if (id === undefined) return ev;
    if (ev.itemType === "mcp_tool_call" && ctx.injectedServerId !== undefined && id === ctx.injectedServerId) return ev;
    const { mcpServerId: _dropped, ...safe } = ev.safe;
    void _dropped;
    return { ...ev, safe };
  }

  function observe(ev: CardObservableEvent): void {
    if (ev === null || typeof ev !== "object" || terminal !== undefined) return;
    switch (ev.kind) {
      case "item_state": {
        const next = reduceProgress(model, trusted(ev));
        if (next === model) return;
        model = next;
        progress();
        return;
      }
      case "attempt_start":
        if (Number.isSafeInteger(ev.attempt)) { finalAttempt = ev.attempt; finalTerminal = undefined; }
        return;
      case "attempt_end":
        if (ev.attempt === finalAttempt && (ev.terminal === "completed" || ev.terminal === "no_terminal")) finalTerminal = ev.terminal;
        return;
      case "message_phase":
        if (ev.phase === "final_answer") startAnswering();
        return;
      default:
        return;
    }
  }

  function startAnswering(): void {
    if (terminal !== undefined || answering) return;
    answering = true;
    if (opened) progress();
  }

  /** NB2: a `contract` outcome on a card that is still open means the frame was not queued. */
  async function finalizeWith(frame: RegistryFrame, reason: TerminalReason): Promise<void> {
    try {
      // The queue records the durable terminal only once this edit is acknowledged.
      const result = await queue.finalize(cardId, frame, reason);
      if (result.outcome === "contract" && queue.status(cardId)?.phase !== "closed") {
        const minimal = buildClosureFrame(reason, template as PinnedTemplate, options());
        if (minimal !== undefined) await queue.finalize(cardId, minimal, reason);
      }
    } finally {
      closure.revoke(cardCtx);
      finish();
    }
  }

  function terminate(reason: TerminalReason): void {
    if (terminal !== undefined) return;
    terminal = reason;
    if (!opened || gone) { finish(); return; }
    const tpl = template as PinnedTemplate;
    const frame = buildProgressFrame(model, reason, tpl, options()) ?? buildClosureFrame(reason, tpl, options());
    if (frame === undefined) { queue.cancelNonterminal(generation); finish(); return; }
    if (authorize(pinned).allowed) { deps.track(finalizeWith(frame, reason)); return; }
    // Permission is stale: stop progress now, then decide the terminal after one fresh read.
    queue.cancelNonterminal(generation);
    deps.track((async () => {
      let current: PolicySnapshot | undefined;
      try { current = await deps.refresh(); } catch { current = undefined; }
      if (authorize(pinned).allowed) return finalizeWith(frame, reason);
      if (current !== undefined && pinned !== undefined
        && policy.closureDisposition("automatic", pinned, current) === "expired_closure_only") {
        const minimal = buildClosureFrame(reason, tpl, options());
        if (minimal !== undefined) {
          closure.grant(cardCtx, pinned, current);
          return finalizeWith(minimal, reason);
        }
      }
      // Denied: the queue records the policy outcome and sends nothing.
      return finalizeWith(frame, reason);
    })());
  }

  function settle(): void {
    if (settled) return;
    settled = true;
    if (terminal !== undefined) return;
    let reason: TerminalReason;
    if (handlerError !== undefined) reason = runtimeReason(handlerError);
    else if (finalAttempt === undefined || finalTerminal !== "completed" || report === undefined) reason = "interrupted";
    else reason = reportAllowsDone(report) ? "completed" : "failed";
    terminate(reason);
  }

  function signal(s: TurnSignal): void {
    if (s === null || typeof s !== "object") return;
    switch (s.t) {
      case "bridge": observe(s.ev); return;
      case "delivery_start": startAnswering(); return;
      case "delivery_report": if (terminal === undefined) report = s.report; return;
      case "handler_error": if (terminal === undefined) handlerError ??= s.category; return;
      case "dispatch_timeout": terminate("timed_out"); return;
      case "shutdown": terminate("interrupted"); return;
      case "settle": settle(); return;
      default: return;
    }
  }

  // Warm permission for the decision at the first item; the handler never waits for it.
  try { if (!authorize().allowed) refreshOnce(); } catch { /* notice mode */ }

  const turn: AutomaticTurn = {
    generation,
    context: ctx,
    observe(ev) { try { observe(ev); } catch { /* never into the handler */ } },
    signal(s) { try { signal(s); } catch { /* never into the handler */ } },
    settle() { try { settle(); } catch { /* never into the handler */ } },
    claimsNotices() {
      try { return terminal === undefined && decide() === "card"; } catch { return false; }
    },
    supersede() {
      if (superseded) return;
      superseded = true;
      try { if (opened && terminal === undefined) queue.cancelNonterminal(generation); } catch { /* fenced by the flag */ }
    },
    inspect() {
      return Object.freeze({ mode, opened, answering, superseded, settled, ...(terminal !== undefined ? { terminal } : {}) });
    },
  };
  return Object.freeze(turn);
}
