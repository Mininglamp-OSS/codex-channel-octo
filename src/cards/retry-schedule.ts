/**
 * Pure pacing and retry schedule for card writes (§3.5 / §5.2).
 *
 * Constants and formulas only: no clocks, timers, I/O or state. The pacer
 * and the write queue are the only consumers.
 */

/** Coalescing window of a dirty card frame. */
export const DEBOUNCE_MS = 800;
/** Total transport attempts of one logical edit (same seq and body). */
export const EDIT_MAX_ATTEMPTS = 3;
/** Waits after failed attempt 1 and 2; origin eligibility is added on top. */
export const EDIT_RETRY_WAITS_MS: readonly [number, number] = Object.freeze([100, 250]) as readonly [number, number];
/** Client cooldown ceiling, jitter included. Server Retry-After is never capped by it. */
export const CLIENT_COOLDOWN_MAX_MS = 300_000;
export const BACKOFF_UNIT_MS = 1_000;
export const BACKOFF_MAX_EXPONENT = 9;
export const JITTER_MAX_MS = 500;

/** `B(n) = min(300000, 1000 * 2^min(n-1, 9))` for the nth consecutive 429 (n ≥ 1). */
export function backoffBase(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("invalid_consecutive_count");
  return Math.min(CLIENT_COOLDOWN_MAX_MS, BACKOFF_UNIT_MS * 2 ** Math.min(n - 1, BACKOFF_MAX_EXPONENT));
}

/**
 * Map an injected RNG sample in [0, 1) to an integer jitter in [0, 500]
 * inclusive. A broken RNG (non-finite or out of range) fails toward the
 * longer wait; the client cap still bounds the result.
 */
export function jitterFrom(sample: number): number {
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) return JITTER_MAX_MS;
  return Math.min(JITTER_MAX_MS, Math.floor(sample * (JITTER_MAX_MS + 1)));
}

/** `Dclient = min(300000, B(n) + J)`. */
export function clientCooldownMs(n: number, jitterMs: number): number {
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 0 || jitterMs > JITTER_MAX_MS) throw new RangeError("invalid_jitter");
  return Math.min(CLIENT_COOLDOWN_MAX_MS, backoffBase(n) + jitterMs);
}

/**
 * `E = max(existingE, now + Dclient, now + Dserver)` with
 * `Dserver = max(0, serverDeadline - now)`. The server deadline is anchored
 * to the monotonic receipt time and is never truncated to the client cap.
 */
export function eligibilityDeadline(existingE: number, nowMono: number, dClientMs: number, serverDeadlineMono?: number): number {
  const dServer = serverDeadlineMono === undefined ? 0 : Math.max(0, serverDeadlineMono - nowMono);
  return Math.max(existingE, nowMono + dClientMs, nowMono + dServer);
}

/** Wait after failed transport attempt `attempt` (1-based); undefined when the budget is spent. */
export function editRetryWaitMs(attempt: number): number | undefined {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt >= EDIT_MAX_ATTEMPTS) return undefined;
  return EDIT_RETRY_WAITS_MS[attempt - 1];
}
