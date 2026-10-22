/**
 * Ordered per-card write queue (§5.2 / §5.3 / §4.5).
 *
 * One queue per Bot card runtime and one worker per card:
 * - at most one initial send per card, never resent once it may have been
 *   accepted (ambiguous sends are persisted and suspend the sender);
 * - dirty progress frames coalesce under an 800 ms debounce so the newest
 *   state is the one sent;
 * - terminal frames purge queued progress, wait for older in-flight work,
 *   then are absorbing;
 * - each logical edit reserves its sequence in the store before transport
 *   and reuses the same sequence and serialized body on its retries
 *   (3 total attempts, 100/250 ms plus origin eligibility);
 * - policy is re-authorized after every wait, immediately before transport;
 * - the full envelope is serialized and checked against
 *   min(policy maxPayloadBytes, 16384) before transport.
 *
 * Every card request passes the shared origin pacer; terminal writes never
 * bypass it. Nothing here is wired into the runtime: lifecycle, recovery and
 * drain orchestration are later packages. Write outcomes are emitted through
 * an injected port shaped like the WP-14 sink; the telemetry modules are
 * never imported here.
 */

import { createHash } from "node:crypto";
import {
  CARD_API_DEADLINE_MS,
  CARD_ENVELOPE_MAX_BYTES,
  CardRequestError,
  OctoApiError,
  classifyEditFailure,
  classifySendFailure,
  serializeEditAuthored,
  serializeEditRegistry,
  serializeSendAuthored,
  serializeSendRegistry,
  type CardApi,
  type EditAuthoredRequest,
  type EditRegistryRequest,
  type FrozenRequest,
  type SendAuthoredRequest,
  type SendRegistryRequest,
} from "./api.js";
import type {
  AuthoredCard,
  CardResourceOwner,
  CardRoute,
  MonotonicClock,
  PolicySnapshot,
  RegistryData,
  ShutdownFence,
  TemplateRef,
  TrustedTurnContext,
  WireState,
  WriteOutcome,
} from "./contracts.js";
import type { Pacer, TimerPort } from "./pacer.js";
import { systemTimers } from "./pacer.js";
import type { CardPolicy, PolicyOperation } from "./policy.js";
import { DEBOUNCE_MS, EDIT_MAX_ATTEMPTS, editRetryWaitMs } from "./retry-schedule.js";
import type { CardBinding, CardPresentation, CardStore } from "./store.js";

// ─── Public types ───────────────────────────────────────────────────────────

/** Card state without transport identity; the queue adds message id and sequence. */
export type CardFrame =
  | { readonly k: "registry"; readonly ref: TemplateRef; readonly state: WireState; readonly data: RegistryData }
  | ({ readonly k: "authored"; readonly plain: string } & AuthoredCard);

export interface CardSpec {
  /** Queue-local card identity chosen by the caller. */
  readonly cardId: string;
  readonly kind: "automatic" | "display";
  readonly capability: Exclude<PolicyOperation, "interaction">;
  readonly ctx: Pick<TrustedTurnContext, "botRef">;
  readonly pinned?: PolicySnapshot;
  readonly binding: CardBinding;
  /** Persisted before the first send; never regenerated. */
  readonly clientMsgNo: string;
  readonly presentation?: CardPresentation;
}

/**
 * Terminal disposition of a card in this queue. `skipped`: settled before
 * the first send started, nothing left the process. `suspended`: refused
 * because the sender is suspended after an ambiguous send. `cancelled`: the
 * queue closed before the terminal frame could be sent, or the terminal was
 * requested only after close(); intent is retained in `status()`. `store_failed`: the durable store refused, so nothing was
 * sent. `unresolved`: transport outcome unknown after an abort-fence.
 */
export type CardOutcome = WriteOutcome | "skipped" | "suspended" | "cancelled" | "store_failed" | "unresolved";

export interface TerminalResult {
  readonly outcome: CardOutcome;
  /** Sequence of the terminal edit when one was reserved. */
  readonly seq?: number;
}

export type OpenResult = "opened" | "duplicate" | "suspended" | "closing";
/** `invalid`: the frame could not be snapshotted as plain data and was not queued. */
export type EnqueueResult = "queued" | "unknown" | "absorbed" | "fenced" | "closing" | "invalid";

export interface CardStatus {
  readonly phase: "pending" | "active" | "closed";
  readonly storeCardId?: string;
  readonly messageId?: string;
  readonly seqReserved: number;
  readonly seqAcked: number;
  readonly dirty: boolean;
  readonly inflight: boolean;
  readonly terminalPending: boolean;
  readonly outcome?: CardOutcome;
}

type QueueStore = Pick<CardStore, "reserveMessage" | "ackMessage" | "markSendAmbiguous" | "markSendFailed"
  | "reserveSequence" | "ackSequence">;
type QueueApi = Pick<CardApi, "origin" | "sendRegistry" | "sendAuthored" | "editRegistry" | "editAuthored">;

/** Structural subset of the WP-14 `TelemetrySink` used for write outcomes. */
export interface WriteTelemetrySink {
  emit(name: "card_send_total" | "card_edit_total" | "stale_sequence_total", labels: Readonly<Record<string, string>>, value: number): unknown;
}

export interface WriteTelemetry {
  readonly sink: WriteTelemetrySink;
  /** WP-14 `botRefOf` of this queue's Bot. */
  readonly botRef: string;
  /** WP-14 `originRefOf` of this queue's API origin. */
  readonly originRef: string;
}

export interface WriteQueueOptions {
  readonly api: QueueApi;
  readonly store: QueueStore;
  readonly policy: Pick<CardPolicy, "authorize">;
  readonly pacer: Pacer;
  readonly clock: MonotonicClock;
  readonly timers?: TimerPort;
  readonly telemetry?: WriteTelemetry;
}

export interface CardWriteQueue extends CardResourceOwner {
  open(spec: CardSpec): OpenResult;
  /** Mark newer progress dirty; the worker sends the newest frame after the debounce. */
  enqueue(cardId: string, frame: CardFrame): EnqueueResult;
  /** Terminal intent; idempotent and absorbing. Never rejects. */
  finalize(cardId: string, frame: CardFrame): Promise<TerminalResult>;
  /** Fence non-terminal writes of a superseded generation; returns the number of cards fenced. */
  cancelNonterminal(generation: string): number;
  status(cardId: string): CardStatus | undefined;
  /** Capabilities whose new initial sends are refused after an ambiguous send. */
  suspendedCapabilities(): readonly string[];
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

interface CardState {
  readonly spec: CardSpec;
  readonly route: CardRoute;
  phase: "pending" | "active" | "closed";
  storeCardId?: string;
  messageId?: string;
  seqReserved: number;
  seqAcked: number;
  dirty?: CardFrame;
  dirtySince: number;
  terminal?: CardFrame;
  /** Terminal requested after close(): retained as intent, never sent by this queue. */
  fencedTerminal?: CardFrame;
  terminalResult?: Deferred<TerminalResult>;
  terminalSeq?: number;
  cancelled: boolean;
  inflight: boolean;
  running: boolean;
  worker?: Promise<void>;
  wake?: () => void;
  outcome?: CardOutcome;
}

type EditResult =
  | { readonly kind: "done"; readonly outcome: WriteOutcome; readonly seq?: number }
  | { readonly kind: "interrupted" }
  | { readonly kind: "store_failed" }
  /** Abort-fenced at the drain deadline; `unresolved` when a transport was in flight. */
  | { readonly kind: "fenced"; readonly unresolved: boolean };

const FENCED = Symbol("fenced");

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Deep, frozen copy of a caller frame taken at enqueue/finalize time, so a
 * caller that later mutates its own state can never change a queued body or
 * the body of a retry under the same sequence.
 */
function snapshotFrame(frame: CardFrame): CardFrame | undefined {
  try { return deepFreeze(structuredClone(frame)); } catch { return undefined; }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function isAbort(err: unknown): boolean {
  return err instanceof OctoApiError && err.transport === "abort";
}

export function createWriteQueue(options: WriteQueueOptions): CardWriteQueue {
  const { api, store, policy, pacer, clock } = options;
  const timers = options.timers ?? systemTimers;
  const telemetry = options.telemetry;
  const origin = api.origin;

  const cards = new Map<string, CardState>();
  const suspended = new Set<string>();
  const controller = new AbortController();
  let fence: ShutdownFence | undefined;
  /** Aggregate drain deadline reached: late continuations must not touch the store. */
  let fencedOut = false;
  let highWater = 0;

  function now(): number {
    let value: number;
    try { value = clock.nowMono(); } catch { return highWater; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < highWater) return highWater;
    highWater = value;
    return value;
  }

  const closing = (): boolean => fence !== undefined;

  // ── telemetry ──

  function emitOutcome(card: CardState, name: "card_send_total" | "card_edit_total", outcome: WriteOutcome): void {
    if (telemetry === undefined) return;
    const { sink, botRef, originRef } = telemetry;
    try {
      sink.emit(name, { bot_ref: botRef, origin_ref: originRef, capability: card.spec.capability, code: outcome }, 1);
      if (outcome === "stale") sink.emit("stale_sequence_total", { bot_ref: botRef, capability: card.spec.capability }, 1);
    } catch { /* the WP-14 sink is total; a foreign port must not break the write path */ }
  }

  // ── card state transitions ──

  function close(card: CardState, outcome: CardOutcome, seq?: number): void {
    if (card.phase === "closed") return;
    card.phase = "closed";
    card.outcome = outcome;
    card.dirty = undefined;
    const result: TerminalResult = Object.freeze(seq === undefined ? { outcome } : { outcome, seq });
    card.terminalResult?.resolve(result);
  }

  function interruptWait(card: CardState): void {
    const wake = card.wake;
    card.wake = undefined;
    wake?.();
  }

  function kick(card: CardState): void {
    if (card.running) { interruptWait(card); return; }
    card.running = true;
    const run = worker(card).catch(() => {
      // A worker never throws by contract; fail closed if it does.
      if (card.phase !== "closed") close(card, card.inflight ? "unresolved" : "store_failed");
    }).finally(() => {
      card.running = false;
      card.wake = undefined;
      if (hasWork(card)) kick(card);
    });
    card.worker = run;
  }

  function hasWork(card: CardState): boolean {
    if (card.phase === "closed") return false;
    if (closing()) return card.phase === "pending" || card.terminal !== undefined;
    return card.terminal !== undefined || card.dirty !== undefined || (card.cancelled && card.phase === "pending");
  }

  // ── waiting ──

  /** Interruptible sleep: resolves on the timer or on a card kick. */
  function sleep(card: CardState, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        timers.clearTimeout(handle);
        if (card.wake === finish) card.wake = undefined;
        resolve();
      };
      const handle = timers.setTimeout(finish, Math.max(0, ms));
      card.wake = finish;
    });
  }

  function waitWake(card: CardState): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        unsubscribe();
        if (card.wake === finish) card.wake = undefined;
        resolve();
      };
      const unsubscribe = pacer.subscribeWake(origin, finish);
      if (!done) card.wake = finish;
    });
  }

  /**
   * Wait until `notBefore` and origin eligibility. Gate waits consume no
   * retry budget. Returns false when interrupted, or when closing and the
   * eligibility time is at or past the aggregate drain deadline.
   */
  async function waitEligible(card: CardState, notBefore: number, interrupted: () => boolean): Promise<boolean> {
    for (;;) {
      if (interrupted() || fencedOut) return false;
      const t = now();
      const gate = pacer.gate(origin);
      const target = gate.eligible ? notBefore : Math.max(notBefore, gate.eligibleAtMono);
      if (fence !== undefined && target >= fence.deadlineMono) return false;
      if (t >= notBefore && gate.eligible) return true;
      if (t < notBefore) await sleep(card, notBefore - t);
      else await waitWake(card);
    }
  }

  function callOptions(): { signal: AbortSignal; deadlineMs: number } | typeof FENCED {
    if (fencedOut) return FENCED;
    if (fence === undefined) return { signal: controller.signal, deadlineMs: CARD_API_DEADLINE_MS };
    const remaining = fence.deadlineMono - now();
    if (remaining <= 0) return FENCED;
    return { signal: controller.signal, deadlineMs: Math.min(CARD_API_DEADLINE_MS, remaining) };
  }

  function authorize(card: CardState): { readonly capBytes: number } | undefined {
    const auth = policy.authorize(card.spec.capability, card.spec.ctx, card.spec.pinned);
    if (!auth.allowed) return undefined;
    return { capBytes: Math.min(auth.limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES) };
  }

  // ── request construction ──

  type SendRequest = { readonly k: "registry"; readonly req: SendRegistryRequest } | { readonly k: "authored"; readonly req: SendAuthoredRequest };
  type EditRequest = { readonly k: "registry"; readonly req: EditRegistryRequest } | { readonly k: "authored"; readonly req: EditAuthoredRequest };

  function sendRequest(card: CardState, frame: CardFrame, capBytes: number): SendRequest {
    const base = { route: card.route, clientMsgNo: card.spec.clientMsgNo, maxEnvelopeBytes: capBytes };
    if (frame.k === "registry") {
      return { k: "registry", req: Object.freeze({ ...base, ref: frame.ref, state: frame.state, data: frame.data }) };
    }
    return { k: "authored", req: Object.freeze({ ...base, profile: frame.profile, card: frame.card, plain: frame.plain }) as SendAuthoredRequest };
  }

  function editRequest(card: CardState, frame: CardFrame, seq: number, transient: boolean, capBytes: number): EditRequest {
    const base = { route: card.route, messageId: card.messageId as string, seq, transient, maxEnvelopeBytes: capBytes };
    if (frame.k === "registry") {
      return { k: "registry", req: Object.freeze({ ...base, ref: frame.ref, state: frame.state, data: frame.data }) };
    }
    return { k: "authored", req: Object.freeze({ ...base, profile: frame.profile, card: frame.card, plain: frame.plain }) as EditAuthoredRequest };
  }

  function freezeSend(r: SendRequest): FrozenRequest {
    return r.k === "registry" ? serializeSendRegistry(r.req) : serializeSendAuthored(r.req);
  }

  function freezeEdit(r: EditRequest): FrozenRequest {
    return r.k === "registry" ? serializeEditRegistry(r.req) : serializeEditAuthored(r.req);
  }

  // ── initial send ──

  async function sendInitial(card: CardState, frame: CardFrame): Promise<void> {
    if (suspended.has(card.spec.capability)) { close(card, "suspended"); return; }
    const auth = authorize(card);
    if (auth === undefined) { emitOutcome(card, "card_send_total", "policy"); close(card, "policy"); return; }
    const request = sendRequest(card, frame, auth.capBytes);
    let frozen: FrozenRequest;
    try { frozen = freezeSend(request); } catch {
      // Oversized or invalid envelope: rejected before reservation and transport.
      emitOutcome(card, "card_send_total", "contract");
      close(card, "contract");
      return;
    }
    let reserved;
    try {
      reserved = store.reserveMessage({ kind: card.spec.kind, binding: card.spec.binding, bodyDigest: digest(frozen.body),
        clientMsgNo: card.spec.clientMsgNo, ...card.spec.presentation });
    } catch { close(card, "store_failed"); return; }
    if (reserved.kind !== "reserved") {
      // The client id already has a durable reservation: a prior send may exist, never send again.
      emitOutcome(card, "card_send_total", "ambiguous");
      close(card, "ambiguous");
      return;
    }
    card.storeCardId = reserved.cardId;
    const opts = callOptions();
    if (opts === FENCED) { close(card, "cancelled"); return; }

    card.inflight = true;
    let messageId: string;
    try {
      const ack = request.k === "registry" ? await api.sendRegistry(request.req, opts) : await api.sendAuthored(request.req, opts);
      messageId = ack.messageId;
    } catch (err) {
      card.inflight = false;
      const receipt = now();
      if (fencedOut) { close(card, "unresolved"); return; }
      if (err instanceof OctoApiError && err.transport === "response" && err.status === 429) {
        pacer.observe429(origin, err.retryAfterMs, receipt);
      }
      const cls = err instanceof OctoApiError || err instanceof CardRequestError ? classifySendFailure(err) : "ambiguous";
      try {
        if (cls === "ambiguous") store.markSendAmbiguous(card.storeCardId);
        else store.markSendFailed(card.storeCardId);
      } catch { /* the ambiguous classification below still blocks any resend */ }
      if (cls === "ambiguous") suspended.add(card.spec.capability);
      emitOutcome(card, "card_send_total", cls);
      close(card, cls);
      return;
    }
    card.inflight = false;
    if (fencedOut) { close(card, "unresolved"); return; }
    pacer.observeSuccess(origin);
    let bound = false;
    try {
      // Current decision at binding time; automatic and display cards carry no admittable session.
      const policyAllows = authorize(card) !== undefined;
      const r = store.ackMessage({ cardId: card.storeCardId, messageId, currentResetEpoch: card.spec.binding.resetEpoch, policyAllows });
      bound = r.kind === "bound" || r.kind === "already_bound";
    } catch { bound = false; }
    if (!bound) {
      // The server accepted the send but its identity could not be bound: never edit an uncorrelated
      // card, persist the possibly-accepted send as ambiguous and suspend the sender (§5.2).
      try { store.markSendAmbiguous(card.storeCardId); } catch { /* the in-memory fence below still applies */ }
      suspended.add(card.spec.capability);
      emitOutcome(card, "card_send_total", "ambiguous");
      close(card, "ambiguous");
      return;
    }
    card.messageId = messageId;
    card.phase = "active";
    emitOutcome(card, "card_send_total", "acked");
  }

  // ── edits ──

  async function sendEdit(card: CardState, frame: CardFrame, terminal: boolean, firstNotBefore: number): Promise<EditResult> {
    const interrupted = terminal
      ? () => card.phase === "closed"
      : () => card.phase === "closed" || card.terminal !== undefined || card.cancelled || closing();
    let seq: number | undefined;
    let request: EditRequest | undefined;
    let frozen: FrozenRequest | undefined;
    let notBefore = firstNotBefore;
    for (let attempt = 1; attempt <= EDIT_MAX_ATTEMPTS; attempt++) {
      if (!(await waitEligible(card, notBefore, interrupted))) return fencedOut ? { kind: "fenced", unresolved: false } : { kind: "interrupted" };
      // close() may run between the eligible wake and this continuation: recheck before reservation and transport.
      if (interrupted() || fencedOut) return fencedOut ? { kind: "fenced", unresolved: false } : { kind: "interrupted" };
      const auth = authorize(card);
      if (auth === undefined) return { kind: "done", outcome: "policy", ...(seq !== undefined ? { seq } : {}) };
      if (seq === undefined) {
        let r;
        try { r = store.reserveSequence(card.storeCardId as string); } catch { return { kind: "store_failed" }; }
        if (r.kind !== "reserved") return { kind: "done", outcome: r.kind === "not_found" ? "gone" : "contract" };
        seq = r.seq;
        card.seqReserved = Math.max(card.seqReserved, seq);
        if (terminal) card.terminalSeq = seq;
        request = editRequest(card, frame, seq, !terminal, auth.capBytes);
        try { frozen = freezeEdit(request); } catch { return { kind: "done", outcome: "contract", seq }; }
      } else if ((frozen as FrozenRequest).bytes > auth.capBytes) {
        // Limits narrowed during the wait; the frozen body is never rebuilt for a retry.
        return { kind: "done", outcome: "contract", seq };
      }
      const req = request as EditRequest;
      // Every attempt must carry exactly the frozen body under the reserved seq.
      let current: string;
      try { current = freezeEdit(req).body; } catch { current = ""; }
      if (current !== (frozen as FrozenRequest).body) return { kind: "done", outcome: "contract", seq };
      const opts = callOptions();
      if (opts === FENCED) return { kind: "fenced", unresolved: false };
      card.inflight = true;
      try {
        const ack = req.k === "registry" ? await api.editRegistry(req.req, opts) : await api.editAuthored(req.req, opts);
        card.inflight = false;
        if (fencedOut) return { kind: "fenced", unresolved: true };
        pacer.observeSuccess(origin);
        try {
          const r = store.ackSequence(card.storeCardId as string, ack.seq);
          if (r.kind === "acked") card.seqAcked = Math.max(card.seqAcked, r.seqAcked);
        } catch { /* acknowledged remotely; the durable fence catches up on the next ack */ }
        return { kind: "done", outcome: "acked", seq };
      } catch (err) {
        card.inflight = false;
        const receipt = now();
        if (fencedOut || (isAbort(err) && closing())) return { kind: "fenced", unresolved: true };
        if (err instanceof OctoApiError && err.transport === "response" && err.status === 429) {
          pacer.observe429(origin, err.retryAfterMs, receipt);
        }
        const cls = err instanceof OctoApiError || err instanceof CardRequestError ? classifyEditFailure(err) : "retryable";
        if (cls !== "retryable") return { kind: "done", outcome: cls, seq };
        const wait = editRetryWaitMs(attempt);
        if (wait === undefined) return { kind: "done", outcome: "retry_exhausted", seq };
        notBefore = receipt + wait;
      }
    }
    return { kind: "done", outcome: "retry_exhausted", ...(seq !== undefined ? { seq } : {}) };
  }

  // ── worker ──

  async function worker(card: CardState): Promise<void> {
    for (;;) {
      if (card.phase === "closed") return;
      if (card.phase === "pending") {
        // Settle, cancellation or shutdown before the first send starts: skip the first frame.
        if (card.terminal !== undefined || card.cancelled || closing()) { close(card, "skipped"); return; }
        if (card.dirty === undefined) return;
        const ok = await waitEligible(card, card.dirtySince + DEBOUNCE_MS,
          () => card.terminal !== undefined || card.cancelled || closing());
        if (!ok) {
          if (fencedOut) { close(card, "skipped"); return; }
          continue;
        }
        // A close or cancel between the wake and this continuation clears the frame: re-evaluate.
        if (card.dirty === undefined) continue;
        const frame = card.dirty;
        card.dirty = undefined;
        await sendInitial(card, frame);
        continue;
      }
      // Active card.
      if (card.terminal !== undefined) {
        const result = await sendEdit(card, card.terminal, true, now());
        if (result.kind === "done") {
          emitOutcome(card, "card_edit_total", result.outcome);
          close(card, result.outcome, result.seq);
        } else if (result.kind === "store_failed") {
          close(card, "store_failed");
        } else {
          // Intent retained (status().terminalPending); no terminal bypass of eligibility.
          close(card, result.kind === "fenced" && result.unresolved ? "unresolved" : "cancelled", card.terminalSeq);
        }
        return;
      }
      if (card.cancelled || closing() || card.dirty === undefined) { card.dirty = undefined; return; }
      const frame = card.dirty;
      const due = card.dirtySince + DEBOUNCE_MS;
      if (!(await waitEligible(card, due, () => card.phase === "closed" || card.terminal !== undefined || card.cancelled || closing()))) continue;
      // Newest coalesced state at send time.
      const newest = card.dirty ?? frame;
      card.dirty = undefined;
      const result = await sendEdit(card, newest, false, now());
      if (result.kind === "fenced") { close(card, result.unresolved ? "unresolved" : "cancelled"); return; }
      if (result.kind === "store_failed") { close(card, "store_failed"); return; }
      if (result.kind === "interrupted") continue;
      emitOutcome(card, "card_edit_total", result.outcome);
      // A non-terminal policy outcome drops only this write; the acknowledged card stays open and its
      // terminal is authorized independently. `gone` closes the card record (§5.3).
      if (result.outcome === "gone") close(card, result.outcome, result.seq);
    }
  }

  // ── public surface ──

  const queue: CardWriteQueue = {
    kind: "write_queue",

    open(spec) {
      if (closing()) return "closing";
      if (cards.has(spec.cardId)) return "duplicate";
      if (suspended.has(spec.capability)) return "suspended";
      cards.set(spec.cardId, {
        spec: Object.freeze({ ...spec }),
        route: Object.freeze({ channelId: spec.binding.channelId, channelType: spec.binding.channelType }),
        phase: "pending", seqReserved: 0, seqAcked: 0, dirtySince: 0, cancelled: false, inflight: false,
        running: false,
      });
      return "opened";
    },

    enqueue(cardId, frame) {
      const card = cards.get(cardId);
      if (card === undefined) return "unknown";
      if (closing()) return "closing";
      if (card.phase === "closed" || card.terminal !== undefined) return "absorbed";
      if (card.cancelled) return "fenced";
      const snapshot = snapshotFrame(frame);
      if (snapshot === undefined) return "invalid";
      if (card.dirty === undefined) card.dirtySince = now();
      card.dirty = snapshot;
      kick(card);
      return "queued";
    },

    finalize(cardId, frame) {
      const card = cards.get(cardId);
      if (card === undefined) return Promise.resolve(Object.freeze({ outcome: "skipped" as const }));
      if (card.terminalResult !== undefined) return card.terminalResult.promise;
      const snapshot = card.phase === "closed" ? undefined : snapshotFrame(frame);
      if (card.phase !== "closed" && snapshot === undefined) {
        // Not queued and not absorbing: a valid terminal frame may still follow.
        return Promise.resolve(Object.freeze({ outcome: "contract" as const }));
      }
      card.terminalResult = deferred<TerminalResult>();
      if (card.phase === "closed") {
        card.terminalResult.resolve(Object.freeze({ outcome: card.outcome as CardOutcome }));
        return card.terminalResult.promise;
      }
      if (closing()) {
        // close() fenced intake and authority: a terminal requested now is retained as intent only.
        // It never reserves a sequence or starts a transport; owned in-flight work is left to drain.
        if (card.phase === "pending" && !card.inflight) {
          // Never sent: the closing worker settles it as skipped.
          if (!card.running) close(card, "skipped");
          return card.terminalResult.promise;
        }
        card.fencedTerminal = snapshot;
        if (card.running) card.terminalResult.resolve(Object.freeze({ outcome: "cancelled" as const }));
        else close(card, "cancelled");
        return card.terminalResult.promise;
      }
      card.terminal = snapshot;
      card.dirty = undefined;
      kick(card);
      return card.terminalResult.promise;
    },

    cancelNonterminal(generation) {
      let count = 0;
      for (const card of cards.values()) {
        if (card.spec.binding.generation !== generation || card.phase === "closed" || card.cancelled) continue;
        card.cancelled = true;
        card.dirty = undefined;
        count++;
        if (card.phase === "pending") kick(card);
        else interruptWait(card);
      }
      return count;
    },

    status(cardId) {
      const card = cards.get(cardId);
      if (card === undefined) return undefined;
      return Object.freeze({
        phase: card.phase,
        ...(card.storeCardId !== undefined ? { storeCardId: card.storeCardId } : {}),
        ...(card.messageId !== undefined ? { messageId: card.messageId } : {}),
        seqReserved: card.seqReserved,
        seqAcked: card.seqAcked,
        dirty: card.dirty !== undefined,
        inflight: card.inflight,
        terminalPending: card.fencedTerminal !== undefined
          || (card.terminal !== undefined && (card.phase !== "closed" || card.outcome === "cancelled" || card.outcome === "unresolved")),
        ...(card.outcome !== undefined ? { outcome: card.outcome } : {}),
      });
    },

    suspendedCapabilities() {
      return Object.freeze([...suspended].sort());
    },

    close(f) {
      if (fence !== undefined) return;
      fence = f;
      try { f.signal.addEventListener("abort", () => { fencedOut = true; controller.abort(); }, { once: true }); } catch { /* fence still applies */ }
      if (f.signal.aborted) { fencedOut = true; controller.abort(); }
      for (const card of cards.values()) {
        card.dirty = undefined;
        if (card.phase === "closed") continue;
        if (card.running) interruptWait(card);
        else if (hasWork(card)) kick(card);
      }
    },

    async drain(f) {
      queue.close(f);
      const active = [...cards.values()].filter((c) => c.running && c.worker !== undefined);
      const all = Promise.all(active.map((c) => c.worker as Promise<void>)).then(() => "settled" as const);
      const remaining = Math.max(0, (fence as ShutdownFence).deadlineMono - now());
      let handle: unknown;
      const deadline = new Promise<"deadline">((resolve) => {
        handle = timers.setTimeout(() => resolve("deadline"), remaining);
      });
      const first = await Promise.race([all, deadline]);
      timers.clearTimeout(handle);
      let settled = 0, aborted = 0, unresolved = 0;
      if (first === "deadline") {
        // Snapshot before aborting so in-flight transports are reported as unknown outcomes.
        for (const card of active) {
          if (!card.running) settled++;
          else if (card.inflight) unresolved++;
          else aborted++;
        }
        fencedOut = true;
        controller.abort();
        for (const card of active) interruptWait(card);
      } else {
        settled = active.length;
      }
      return Object.freeze({ settled, aborted, unresolved });
    },
  };
  return Object.freeze(queue);
}

/** Digest persisted with the reservation of an initial send (exact frozen body). */
export function bodyDigest(request: FrozenRequest): string {
  return digest(request.body);
}
