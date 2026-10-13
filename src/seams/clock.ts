/**
 * Clock seam (R8 §10.4). Components that need time accept a Clock through their
 * constructor; production code uses systemClock. Test clocks live under test/
 * and are never reachable from configuration.
 */

/** Opaque timer handle returned by Clock.setTimeout. */
export type TimerHandle = { readonly __clockTimer: unique symbol };

export interface Clock {
  /** Wall-clock epoch milliseconds. May jump (NTP, operator changes). */
  now(): number;
  /** Monotonic milliseconds; never jumps. Timers are measured against it. */
  monotonicNow(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as TimerHandle,
  clearTimeout: (handle) => {
    if (handle) clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};
