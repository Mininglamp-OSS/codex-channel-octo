/**
 * Process-wide same-origin 429 pacer (§3.5).
 *
 * One eligibility deadline `E` and one consecutive-429 count per normalized
 * API origin (scheme, IDNA host, effective port). Bots that share an origin
 * share `E`; different origins are independent. The pacer retains timing
 * numbers and transient wake callbacks only: never a Bot reference,
 * credential, policy, route or payload.
 *
 * Clock, timer and RNG are injected. A cooling origin owns at most one
 * pending timer (the wake at `E`, or the next telemetry slice boundary),
 * so waiting never spins. Telemetry is emitted per origin through an
 * injected port shaped like the WP-14 sink, with existing metric names
 * only, so a cooldown shared by several Bots is counted once. The telemetry
 * modules are never imported here; the runtime supplies the sink and the
 * opaque origin label derivation.
 */

import type { MonotonicClock } from "./contracts.js";
import { normalizeOrigin, type NormalizedOrigin } from "./origin.js";
import { clientCooldownMs, eligibilityDeadline, jitterFrom } from "./retry-schedule.js";

/** Injected timer port; production uses unref'd Node timers. */
export interface TimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: TimerPort = Object.freeze({
  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

/** Raw `cooldown_slice_ms` slices stay below the sink's 61 s bound. */
export const COOLDOWN_SLICE_MS = 60_000;
const SLICE_BACK_COVER_MS = 120_000;
const MAX_CONSECUTIVE = 1_000_000;

export type GateDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly eligibleAtMono: number };

/** Inspection view; numbers only. */
export interface OriginPacing {
  readonly consecutive: number;
  readonly eligibleAtMono: number;
  readonly cooling: boolean;
  readonly waiters: number;
  readonly timerPending: boolean;
}

type Labels = Readonly<Record<string, string>>;

/** Structural subset of the WP-14 `TelemetrySink` used for origin cooldowns. */
export interface CooldownTelemetrySink {
  emit(name: "cooldown_start_total" | "cooldown_end_total", labels: Labels, value: number): unknown;
  emitInterval(name: "cooldown_slice_ms" | "cooldown_mandated_ms", labels: Labels, ivStartMono: number, ivEndMono: number): unknown;
}

export interface CooldownTelemetry {
  readonly sink: CooldownTelemetrySink;
  /** WP-14 `originRefOf`: opaque `origin_ref` label for a normalized origin key. */
  readonly originRef: (originKey: string) => string;
}

export interface PacerOptions {
  readonly clock: MonotonicClock;
  readonly timers?: TimerPort;
  /** Uniform sample in [0, 1); deterministic in tests. */
  readonly rng?: () => number;
  readonly telemetry?: CooldownTelemetry;
}

export interface Pacer {
  /** Synchronous eligibility check at the current monotonic time. */
  gate(origin: NormalizedOrigin): GateDecision;
  /**
   * Record a 429. `retryAfterMs` is the already-parsed server delay
   * measured at receipt; it is anchored to `receiptMono` and never capped.
   */
  observe429(origin: NormalizedOrigin, retryAfterMs: number | undefined, receiptMono: number): void;
  /** A successful eligible request resets the consecutive count, never `E`. */
  observeSuccess(origin: NormalizedOrigin): void;
  /** One-shot wake when the origin becomes eligible; returns an unsubscribe. */
  subscribeWake(origin: NormalizedOrigin, listener: () => void): () => void;
  inspect(origin: NormalizedOrigin): OriginPacing | undefined;
  /** Process shutdown: close open cooldown telemetry and stop timers. `E` is retained. */
  close(): void;
}

interface OriginState {
  consecutive: number;
  eligibleAt: number;
  cooling: boolean;
  code: "client_backoff" | "server_retry_after";
  sliceStart: number;
  timer: unknown;
  timerPending: boolean;
  readonly waiters: Set<() => void>;
  readonly originRef: string | undefined;
}

export function createPacer(options: PacerOptions): Pacer {
  const clock = options.clock;
  const timers = options.timers ?? systemTimers;
  const rng = options.rng ?? Math.random;
  const sink = options.telemetry?.sink;
  const deriveRef = options.telemetry?.originRef;
  const states = new Map<string, OriginState>();
  const keys = new Map<string, string>();
  let highWater = 0;
  let closed = false;

  function now(): number {
    let value: number;
    try { value = clock.nowMono(); } catch { return highWater; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < highWater) return highWater;
    highWater = value;
    return value;
  }

  /** Re-normalize so the timing identity never depends on a caller's spelling. */
  function keyOf(origin: NormalizedOrigin): string {
    const raw = origin?.key;
    if (typeof raw !== "string") throw new TypeError("invalid_origin");
    let key = keys.get(raw);
    if (key === undefined) {
      key = normalizeOrigin(raw).key;
      if (keys.size < 1024) keys.set(raw, key);
    }
    return key;
  }

  function stateOf(key: string): OriginState {
    let st = states.get(key);
    if (st === undefined) {
      let originRef: string | undefined;
      try { originRef = sink && deriveRef ? deriveRef(key) : undefined; } catch { originRef = undefined; }
      if (typeof originRef !== "string") originRef = undefined;
      st = { consecutive: 0, eligibleAt: 0, cooling: false, code: "client_backoff", sliceStart: 0,
        timer: undefined, timerPending: false, waiters: new Set(), originRef };
      states.set(key, st);
    }
    return st;
  }

  function emitSlices(st: OriginState, until: number): void {
    if (!sink || st.originRef === undefined) { st.sliceStart = Math.max(st.sliceStart, until); return; }
    let start = Math.max(st.sliceStart, until - SLICE_BACK_COVER_MS);
    while (start < until) {
      const end = Math.min(start + COOLDOWN_SLICE_MS, until);
      try { sink.emitInterval("cooldown_slice_ms", { origin_ref: st.originRef, code: st.code }, start, end); } catch { /* sink is total */ }
      start = end;
    }
    st.sliceStart = until;
  }

  function emitCount(st: OriginState, name: "cooldown_start_total" | "cooldown_end_total", code: string): void {
    if (!sink || st.originRef === undefined) return;
    try { sink.emit(name, { origin_ref: st.originRef, code }, 1); } catch { /* sink is total */ }
  }

  function clearTimer(st: OriginState): void {
    if (st.timerPending) timers.clearTimeout(st.timer);
    st.timer = undefined;
    st.timerPending = false;
  }

  function notify(st: OriginState): void {
    const waiters = [...st.waiters];
    st.waiters.clear();
    for (const listener of waiters) {
      try { listener(); } catch { /* a waiter failure never affects other origins or Bots */ }
    }
  }

  function endCooldown(key: string, st: OriginState, at: number): void {
    clearTimer(st);
    emitSlices(st, Math.min(at, st.eligibleAt));
    st.cooling = false;
    emitCount(st, "cooldown_end_total", "elapsed");
    notify(st);
    if (st.consecutive === 0 && st.waiters.size === 0) states.delete(key);
  }

  function schedule(key: string, st: OriginState, at: number): void {
    clearTimer(st);
    if (closed || !st.cooling) return;
    const target = sink && st.originRef !== undefined ? Math.min(st.eligibleAt, st.sliceStart + COOLDOWN_SLICE_MS) : st.eligibleAt;
    st.timerPending = true;
    st.timer = timers.setTimeout(() => {
      st.timerPending = false;
      st.timer = undefined;
      if (closed || states.get(key) !== st || !st.cooling) return;
      const t = now();
      if (t >= st.eligibleAt) endCooldown(key, st, t);
      else {
        emitSlices(st, t);
        schedule(key, st, t);
      }
    }, Math.max(0, target - at));
  }

  const pacer: Pacer = {
    gate(origin) {
      const st = states.get(keyOf(origin));
      const t = now();
      if (st === undefined || st.eligibleAt <= t) return { eligible: true };
      return { eligible: false, eligibleAtMono: st.eligibleAt };
    },

    observe429(origin, retryAfterMs, receiptMono) {
      const key = keyOf(origin);
      const st = stateOf(key);
      const t = now();
      if (st.cooling && st.eligibleAt <= t) endCooldown(key, st, t);
      const live = states.get(key) === st ? st : stateOf(key);
      live.consecutive = Math.min(MAX_CONSECUTIVE, live.consecutive + 1);
      const dClient = clientCooldownMs(live.consecutive, jitterFrom(rng()));
      const receipt = typeof receiptMono === "number" && Number.isFinite(receiptMono) && receiptMono <= t ? receiptMono : t;
      const serverDeadline = typeof retryAfterMs === "number" && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? receipt + retryAfterMs : undefined;
      live.eligibleAt = eligibilityDeadline(live.eligibleAt, t, dClient, serverDeadline);
      if (!live.cooling) {
        live.cooling = true;
        live.sliceStart = t;
        live.code = serverDeadline !== undefined && serverDeadline > t + dClient ? "server_retry_after" : "client_backoff";
        emitCount(live, "cooldown_start_total", live.code);
      }
      if (sink && live.originRef !== undefined && serverDeadline !== undefined && serverDeadline > t) {
        try {
          sink.emitInterval("cooldown_mandated_ms", { origin_ref: live.originRef, code: "server_retry_after" }, t, serverDeadline);
        } catch { /* sink is total */ }
      }
      schedule(key, live, t);
    },

    observeSuccess(origin) {
      const key = keyOf(origin);
      const st = states.get(key);
      if (st === undefined) return;
      st.consecutive = 0;
      if (!st.cooling && st.waiters.size === 0) states.delete(key);
    },

    subscribeWake(origin, listener) {
      const key = keyOf(origin);
      const st = states.get(key);
      if (st === undefined || !st.cooling || st.eligibleAt <= now()) {
        let live = true;
        queueMicrotask(() => { if (live) listener(); });
        return () => { live = false; };
      }
      st.waiters.add(listener);
      return () => { st.waiters.delete(listener); };
    },

    inspect(origin) {
      const st = states.get(keyOf(origin));
      if (st === undefined) return undefined;
      return Object.freeze({ consecutive: st.consecutive, eligibleAtMono: st.eligibleAt, cooling: st.cooling,
        waiters: st.waiters.size, timerPending: st.timerPending });
    },

    close() {
      if (closed) return;
      closed = true;
      const t = now();
      for (const st of states.values()) {
        clearTimer(st);
        if (!st.cooling) continue;
        emitSlices(st, Math.min(t, st.eligibleAt));
        emitCount(st, "cooldown_end_total", t >= st.eligibleAt ? "elapsed" : "shutdown");
        st.cooling = t < st.eligibleAt;
      }
    },
  };
  return Object.freeze(pacer);
}
