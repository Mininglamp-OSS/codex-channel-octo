/**
 * Bounded delivery-report adapter (WP-07′, §3.3 / C2 / C3).
 *
 * Derives the card `DeliveryReport` from the durable `delivery_parts` ledger
 * of one exact turn. The relay, its ledger writes, its fail-fast sends and its
 * own `DeliveryReport { parts }` stay the protected latest-main baseline; this
 * module never re-classifies message ids and reuses the ledger's `confirmed`
 * state, which is what `commitTurnOutput` gates history on.
 *
 * Pure and synchronous. It never throws: any malformed input yields
 * `FAILED_CLOSED_REPORT`, which can never satisfy Done.
 */

import type { DeliveryReport } from "./contracts.js";

export type DeliveryPartState = "pending" | "unknown" | "confirmed";

export interface DeliveryPartRow {
  readonly index: number;
  readonly state: DeliveryPartState;
  readonly messageId: string | null;
}

/** Read port satisfied structurally by `SessionStore.readDeliveryParts`. */
export interface DeliveryPartsReader {
  readDeliveryParts(turnId: string): ReadonlyArray<DeliveryPartRow>;
}

export interface AdaptOptions {
  /**
   * `true` only on the normal-return empty branch, after the empty notice send
   * resolved (C2). Every other call site, including every catch path, passes
   * `false` (C3 rules 1–2).
   */
  readonly emptyNotice: boolean;
}

/** `{0,0,0,[],false}`: substituted on any fault; never Done (C3 rules 4–5). */
export const FAILED_CLOSED_REPORT: DeliveryReport = Object.freeze({
  expected: 0, acked: 0, failed: 0, messageIds: Object.freeze([]) as readonly string[], emptyNotice: false,
});

const STATES: ReadonlySet<string> = new Set<DeliveryPartState>(["pending", "unknown", "confirmed"]);

/**
 * `expected` = ledger parts, `acked` = `confirmed` parts, `failed` = the rest
 * (an `unknown` part plus never-sent `pending` parts), `messageIds` = the
 * confirmed ids in part order.
 */
export function adaptDeliveryReport(parts: ReadonlyArray<DeliveryPartRow>, opts: AdaptOptions): DeliveryReport {
  try {
    if (!Array.isArray(parts) || opts === null || typeof opts !== "object" || typeof opts.emptyNotice !== "boolean") return FAILED_CLOSED_REPORT;
    const emptyNotice = opts.emptyNotice;
    // The empty notice is only sent when selection produced no parts.
    if (emptyNotice && parts.length > 0) return FAILED_CLOSED_REPORT;
    const messageIds: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part: unknown = parts[i];
      if (part === null || typeof part !== "object") return FAILED_CLOSED_REPORT;
      const { index, state, messageId } = part as Record<string, unknown>;
      if (index !== i || typeof state !== "string" || !STATES.has(state)) return FAILED_CLOSED_REPORT;
      if (state === "confirmed") {
        // The relay never marks a part confirmed without an id; a row that does
        // is corrupt and must not count toward Done.
        if (typeof messageId !== "string" || messageId.length === 0) return FAILED_CLOSED_REPORT;
        messageIds.push(messageId);
      }
    }
    const expected = parts.length;
    const acked = messageIds.length;
    return Object.freeze({ expected, acked, failed: expected - acked, messageIds: Object.freeze(messageIds), emptyNotice });
  } catch {
    return FAILED_CLOSED_REPORT;
  }
}

/**
 * The coordinator composition over the exact turn (C3):
 * `adaptDeliveryReport(store.readDeliveryParts(turnId), { emptyNotice })`,
 * with a read fault substituting `FAILED_CLOSED_REPORT` (rule 5).
 */
export function readDeliveryReport(reader: DeliveryPartsReader, turnId: string, opts: AdaptOptions): DeliveryReport {
  if (typeof turnId !== "string" || turnId.length === 0) return FAILED_CLOSED_REPORT;
  let parts: ReadonlyArray<DeliveryPartRow>;
  try {
    parts = reader.readDeliveryParts(turnId);
  } catch {
    return FAILED_CLOSED_REPORT;
  }
  return adaptDeliveryReport(parts, opts);
}

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Whether a report has one of the two Done shapes (C3 rule 3):
 * - non-empty: `expected > 0`, `acked === expected`, `failed === 0`;
 * - empty: all counts 0, no ids, `emptyNotice === true`.
 *
 * Applies to the normal-return path only. A catch/error path is `Error`
 * regardless of this result (rule 2), and Done also needs a successful
 * final-attempt settle.
 */
export function reportAllowsDone(report: DeliveryReport): boolean {
  if (report === null || typeof report !== "object") return false;
  const { expected, acked, failed, messageIds, emptyNotice } = report;
  if (!count(expected) || !count(acked) || !count(failed) || !Array.isArray(messageIds) || typeof emptyNotice !== "boolean") return false;
  if (failed !== 0 || acked !== expected || messageIds.length !== acked) return false;
  // Indexed on purpose: every/some/forEach skip holes in a sparse array.
  for (let i = 0; i < messageIds.length; i++) {
    const id: unknown = messageIds[i];
    if (typeof id !== "string" || id.length === 0) return false;
  }
  return expected > 0 ? !emptyNotice : emptyNotice;
}
