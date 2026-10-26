/**
 * Per-Bot card resource registry (§4.5, WP-13A-1).
 *
 * Implements the existing `CardResourceRegistry` port over
 * `CardResourceOwner`/`ShutdownFence`. One `closeAll` per Bot builds a single
 * fence with one aggregate 3 s deadline, closes every registered owner
 * synchronously (intake and authority stop at once), then drains them all
 * against that same deadline. Work whose outcome is unknown, owners that do
 * not report in time and owners that break the port contract are all counted
 * as unresolved, and any unresolved work makes the result ambiguous, never a
 * clean drain.
 *
 * The registry never touches the shared pacer. A write queue's drain settles
 * inside `closeAll` (bounded by the deadline), so a caller that releases the
 * pacer only after `closeAll` resolves keeps the N5(c) order: queues drain no
 * later than the pacer release. Nothing here is wired into the runtime.
 */

import type {
  CardResourceOwner,
  CardResourceRegistry,
  MonotonicClock,
  ResourceDrainReport,
  ResourceRegistration,
  ShutdownFence,
  ShutdownReason,
} from "./contracts.js";
import { systemTimers, type TimerPort } from "./pacer.js";

/** Single aggregate card drain budget per Bot. */
export const CARD_DRAIN_BUDGET_MS = 3000;

const OWNER_KINDS: ReadonlySet<string> = new Set<CardResourceOwner["kind"]>([
  "tool_host", "write_queue", "event_consumer", "policy", "recovery", "store_lease",
]);

export interface CardDrainResult extends ResourceDrainReport {
  readonly reason: ShutdownReason;
  /** Owners registered when closing began. */
  readonly owners: number;
  /** Owners that had not reported when the deadline passed; each counts as one unresolved task. */
  readonly overdue: number;
  /** Owners that threw from close, rejected or threw from drain, or returned a malformed report; each counts as one unresolved task. */
  readonly faulted: number;
  /** `ambiguous` whenever `unresolved > 0`. */
  readonly outcome: "drained" | "ambiguous";
}

export interface CardResourceDrainRegistry extends CardResourceRegistry {
  /** True once `closeAll` has begun; registration is then refused. */
  readonly closing: boolean;
  /** Fence, close and drain every registered owner once; later calls return the first result. */
  closeAll(reason: ShutdownReason): Promise<CardDrainResult>;
}

export interface ResourceRegistryOptions {
  readonly clock: MonotonicClock;
  readonly timers?: TimerPort;
}

type OwnerReport =
  | { readonly kind: "report"; readonly report: ResourceDrainReport }
  | { readonly kind: "fault" }
  | { readonly kind: "overdue" };

function count(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function validReport(r: unknown): r is ResourceDrainReport {
  if (r === null || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return count(o.settled) && count(o.aborted) && count(o.unresolved);
}

export function createResourceRegistry(options: ResourceRegistryOptions): CardResourceDrainRegistry {
  const { clock } = options;
  const timers = options.timers ?? systemTimers;
  const owners = new Set<CardResourceOwner>();
  let began = false;
  let result: Promise<CardDrainResult> | undefined;

  function nowMono(): number {
    const t = clock.nowMono();
    if (typeof t !== "number" || !Number.isFinite(t)) throw new TypeError("monotonic clock returned a non-finite value");
    return t;
  }

  async function closeAll(reason: ShutdownReason): Promise<CardDrainResult> {
    began = true;
    const snapshot = [...owners];
    const controller = new AbortController();
    let start: number;
    try { start = nowMono(); } catch { start = 0; }
    const fence: ShutdownFence = Object.freeze({ reason, deadlineMono: start + CARD_DRAIN_BUDGET_MS, signal: controller.signal });

    // One deadline for the whole Bot. After it fires, owners reporting at the
    // same instant get one more timer turn before the rest count as overdue.
    let expire!: () => void;
    const expired = new Promise<"overdue">((resolve) => { expire = () => resolve("overdue"); });
    let graceHandle: unknown;
    const deadlineHandle = timers.setTimeout(() => {
      controller.abort();
      graceHandle = timers.setTimeout(expire, 0);
    }, CARD_DRAIN_BUDGET_MS);

    // Close every owner before any drain starts.
    const closeFaults = new Set<CardResourceOwner>();
    for (const owner of snapshot) {
      try { owner.close(fence); } catch { closeFaults.add(owner); }
    }

    const reports = snapshot.map(async (owner): Promise<OwnerReport> => {
      let drained: Promise<ResourceDrainReport>;
      try { drained = Promise.resolve(owner.drain(fence)); } catch { return { kind: "fault" }; }
      const settled = drained.then(
        (report): OwnerReport => (validReport(report) ? { kind: "report", report } : { kind: "fault" }),
        (): OwnerReport => ({ kind: "fault" }),
      );
      const first = await Promise.race([settled, expired]);
      return first === "overdue" ? { kind: "overdue" } : first;
    });
    const outcomes = await Promise.all(reports);
    timers.clearTimeout(deadlineHandle);
    if (graceHandle !== undefined) timers.clearTimeout(graceHandle);

    let settled = 0, aborted = 0, unresolved = 0, overdue = 0, faulted = 0;
    outcomes.forEach((o, i) => {
      if (closeFaults.has(snapshot[i] as CardResourceOwner)) { faulted++; unresolved++; }
      if (o.kind === "overdue") { overdue++; unresolved++; return; }
      if (o.kind === "fault") { faulted++; unresolved++; return; }
      settled += o.report.settled;
      aborted += o.report.aborted;
      unresolved += o.report.unresolved;
    });
    return Object.freeze({
      reason, owners: snapshot.length, settled, aborted, unresolved, overdue, faulted,
      outcome: unresolved > 0 ? "ambiguous" : "drained",
    });
  }

  const registry: CardResourceDrainRegistry = {
    get closing() { return began; },

    register(owner): ResourceRegistration | null {
      if (owner === null || typeof owner !== "object" || !OWNER_KINDS.has(owner.kind)
        || typeof owner.close !== "function" || typeof owner.drain !== "function") {
        throw new TypeError("invalid card resource owner");
      }
      if (began) return null;
      owners.add(owner);
      return Object.freeze({
        unregister(): void {
          // A snapshot taken by closeAll is final; unregistering afterwards changes nothing.
          if (!began) owners.delete(owner);
        },
      });
    },

    closeAll(reason) {
      result ??= closeAll(reason);
      return result;
    },
  };
  return Object.freeze(registry);
}
