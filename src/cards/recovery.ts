/**
 * Card subsystem startup for one Bot (§4.3, WP-13A-1; pre-wiring only).
 *
 * `openCardSubsystem` binds the existing startup contracts and adds no
 * parallel algorithm:
 * - provenance: the deployment-provisioned `<dataDir>/cards/installation-ref`
 *   (a private regular file holding one safe store reference) and the
 *   `FileActivationMarker` at `<dataDir>/cards/activation.json`, written by
 *   `provisionFirstInstallMarker` and never overwritten here;
 * - store: `initializeCardStore` over the Bot's existing database adapter,
 *   which alone owns marker/lineage checks, the pre-migration backup into
 *   `<dataDir>/cards/backups`, migration and invariants, in its own order.
 *
 * A missing or unsafe installation reference disables cards before any
 * database access. Every disabled result leaves the Bot card-inert: no store,
 * no queue, and the ordinary path untouched. On `ready`, the explicit ledger
 * of earlier runtime incarnations is recovered before the queue factory is
 * handed out, so no queue or tool host can exist before it. Queues built by
 * the factory re-derive D-B/N2 suspension from the store; startup never
 * resends, edits or abandons an unresolved send. The explicit tool host
 * (WP-08) asserts `ledgerRecovered(store)` before it creates any listener.
 *
 * Automatic card restart recovery (WP-13A-2, DTI-2.1 §4) classifies the live
 * automatic rows of earlier incarnations: C0a rows get exactly one minimal
 * Error/interrupted closure through a startup adoption grant, C1 rows record
 * their durable intent locally with no transport, and C0b, C2 and legacy
 * rows are retained untouched. No row ever becomes Done through recovery, and
 * sending/ambiguous (N2) and terminal rows are never read for editing.
 */

import { join } from "node:path";
import type { DbAdapter } from "../db-adapter.js";
import { CARD_ENVELOPE_MAX_BYTES } from "./api.js";
import type {
  BotRef,
  CardChannelType,
  CardResourceOwner,
  MonotonicClock,
  PolicySnapshot,
  ResourceDrainReport,
  ShutdownFence,
  TrustedTurnContext,
} from "./contracts.js";
import type { BackupReceipt, CardMeta, InvariantViolation } from "./migrations.js";
import { FileActivationMarker, isSafeStoreRef } from "./migrations.js";
import type { TimerPort } from "./pacer.js";
import type { Authorization, CardPolicy } from "./policy.js";
import { reconcileActionAdmission } from './action-admission.js';
import { buildClosureFrame, type RegistryFrame } from "./registry-builder.js";
import { decodeStrictUtf8, readPrivateRegularFile } from "./safe-file.js";
import {
  initializeCardStore,
  readProtectedGraph,
  type CardMessageRecord,
  type CardStore,
  type CardStoreDisabledReason,
  type CardStoreOptions,
  type CardTerminalReason,
  type LedgerRecovery,
  type LiveAutomaticCard,
  type ProtectedGraphRows,
} from "./store.js";
import {
  createWriteQueue,
  type CardWriteQueue,
  type RecoveryGrant,
  type TerminalResult,
  type WriteQueueOptions,
} from "./write-queue.js";

export interface CardSubsystemPaths {
  readonly cardsDir: string;
  readonly markerPath: string;
  readonly installationRefPath: string;
  readonly backupDir: string;
}

export function cardSubsystemPaths(dataDir: string): CardSubsystemPaths {
  const cardsDir = join(dataDir, "cards");
  return Object.freeze({
    cardsDir,
    markerPath: join(cardsDir, "activation.json"),
    installationRefPath: join(cardsDir, "installation-ref"),
    backupDir: join(cardsDir, "backups"),
  });
}

export interface CardSubsystemOptions extends CardStoreOptions {
  /** The Bot's already-open ordinary database adapter (`<dataDir>/cc-octo.db`). */
  readonly adapter: DbAdapter;
  readonly dataDir: string;
  /** Identity of this process run; live handler generations of any other incarnation are closed. */
  readonly runtimeIncarnation: string;
  readonly newLineageId?: () => string;
}

/** Builds a write queue over the recovered store; each call re-derives suspension. */
export type CardQueueFactory = (options: Omit<WriteQueueOptions, "store">) => CardWriteQueue;

export type CardSubsystemDisabledReason = CardStoreDisabledReason | "ledger_recovery_failed" | "startup_failed";

export type CardSubsystem =
  | {
      readonly state: "ready";
      readonly store: CardStore;
      readonly meta: CardMeta;
      readonly provenance: "first_install" | "reopened" | "activation_reconciled";
      readonly backup?: BackupReceipt;
      readonly ledger: LedgerRecovery;
      readonly queueFactory: CardQueueFactory;
    }
  | { readonly state: "disabled"; readonly reason: CardSubsystemDisabledReason; readonly violations?: readonly InvariantViolation[] };

/** Upper bound on the reference file; a safe reference is far shorter. */
const MAX_REF_FILE_BYTES = 1024;

type RefRead = { readonly kind: "ok"; readonly ref: string } | { readonly kind: "missing" } | { readonly kind: "invalid" };

/**
 * Read the installation reference through the shared provenance reader
 * (`readPrivateRegularFile`): a private regular file, never followed through a
 * symlink and never blocking on a FIFO, holding one safe reference with at
 * most one trailing newline. Decoding is strict UTF-8 with any BOM kept, so a
 * BOM-prefixed reference fails the safe-reference check.
 */
function readInstallationRef(path: string): RefRead {
  const file = readPrivateRegularFile(path, MAX_REF_FILE_BYTES);
  if (file.kind !== "ok") return file;
  const text = decodeStrictUtf8(file.bytes);
  if (text === null) return { kind: "invalid" };
  const ref = text.endsWith("\n") ? text.slice(0, -1) : text;
  return isSafeStoreRef(ref) ? { kind: "ok", ref } : { kind: "invalid" };
}

/** Stores whose explicit ledger of earlier incarnations was recovered by `openCardSubsystem`. */
const recoveredLedgers = new WeakSet<object>();

/**
 * Ordering assertion (WP-08): true only for a store whose
 * `recoverExplicitLedger` ran and passed its invariants in this process.
 */
export function ledgerRecovered(store: object): boolean {
  return recoveredLedgers.has(store);
}

function disabled(reason: CardSubsystemDisabledReason, violations?: readonly InvariantViolation[]): CardSubsystem {
  return Object.freeze(violations ? { state: "disabled", reason, violations } : { state: "disabled", reason });
}

/**
 * Open the card subsystem of one Bot after its ordinary store is initialized
 * and before the gateway connects. Never throws.
 */
export async function openCardSubsystem(options: CardSubsystemOptions): Promise<CardSubsystem> {
  let paths: CardSubsystemPaths;
  try {
    paths = cardSubsystemPaths(options.dataDir);
  } catch {
    return disabled("startup_failed");
  }
  const ref = readInstallationRef(paths.installationRefPath);
  if (ref.kind === "missing") return disabled("provenance_missing");
  if (ref.kind === "invalid") return disabled("provenance_invalid");

  let init;
  try {
    init = await initializeCardStore({
      adapter: options.adapter,
      marker: new FileActivationMarker(paths.markerPath),
      installationRef: ref.ref,
      backupDir: paths.backupDir,
      clock: options.clock,
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
      ...(options.sessionCapacity !== undefined ? { sessionCapacity: options.sessionCapacity } : {}),
      ...(options.newLineageId !== undefined ? { newLineageId: options.newLineageId } : {}),
    });
  } catch {
    return disabled("startup_failed");
  }
  if (init.state !== "ready") return disabled(init.reason, init.violations);

  const { store } = init;
  let ledger: LedgerRecovery;
  try {
    ledger = store.recoverExplicitLedger(options.runtimeIncarnation);
  } catch {
    store.retire();
    return disabled("ledger_recovery_failed");
  }
  if (ledger.violations.length > 0) {
    store.retire();
    return disabled("invariant_failed", ledger.violations);
  }
  try {
    // Local interaction reconciliation follows provenance/ledger recovery and
    // precedes every queue, tool host and consumer. No source or dispatch call.
    recoverInteractions(store, readProtectedGraph(options.adapter));
  } catch {
    store.retire();
    return disabled("startup_failed");
  }
  recoveredLedgers.add(store);

  const queueFactory: CardQueueFactory = (queueOptions) => createWriteQueue({ ...queueOptions, store });
  return Object.freeze({
    state: "ready",
    store,
    meta: init.meta,
    provenance: init.provenance,
    ...(init.backup !== undefined ? { backup: init.backup } : {}),
    ledger,
    queueFactory,
  });
}

export interface InteractionRecoveryReport {
  readonly pending: number;
  readonly retryWait: number;
  readonly interrupted: number;
  readonly terminal: number;
  readonly unresolvedSend: number;
  /** Local expiry obligations only; a row id is never transport authorization. */
  readonly expiredCards: readonly string[];
}

export function recoverInteractions(store: CardStore, graph: ProtectedGraphRows): InteractionRecoveryReport {
  let pending = 0, retryWait = 0, interrupted = 0, terminal = 0, unresolvedSend = 0;
  for (const row of graph.card_sessions) {
    const state = reconcileActionAdmission(store, String(row.session_id));
    if (state === 'interrupted') interrupted++;
    else if (state === 'terminal') terminal++;
    else if (row.status === 'pending') pending++;
    else if (row.status === 'retry_wait') retryWait++;
    else if (row.status === 'sending' || row.status === 'ambiguous') unresolvedSend++;
  }
  return Object.freeze({ pending, retryWait, interrupted, terminal, unresolvedSend,
    expiredCards: Object.freeze(store.expireSessions()) });
}

/** Owns only local maintenance. Missing transport/retirement authority always retains evidence. */
export function runInteractionRecovery(store: CardStore, timers: TimerPort): CardResourceOwner {
  let closed = false, sweep: unknown, cleanup: unknown;
  const active = (): boolean => !closed && !store.retired;
  const scheduleSweep = (): void => {
    sweep = timers.setTimeout(() => {
      sweep = undefined;
      if (!active()) return;
      try { store.expireSessions(); } catch { /* a failed sweep grants no edit or admission */ }
      if (active()) scheduleSweep();
    }, 60_000);
  };
  const scheduleCleanup = (): void => {
    cleanup = timers.setTimeout(() => {
      cleanup = undefined;
      if (!active()) return;
      try { store.cleanup(); } catch { /* retain protected records on failure */ }
      if (active()) scheduleCleanup();
    }, 3_600_000);
  };
  scheduleSweep(); scheduleCleanup();
  return Object.freeze({ kind: 'recovery' as const,
    close(): void {
      if (closed) return;
      closed = true;
      if (sweep !== undefined) timers.clearTimeout(sweep);
      if (cleanup !== undefined) timers.clearTimeout(cleanup);
      sweep = cleanup = undefined;
    },
    async drain() { return Object.freeze({ settled: 0, aborted: 0, unresolved: 0 }); },
  });
}

// ─── automatic card restart recovery (WP-13A-2, DTI-2.1 §4) ─────────────────

/**
 * Recovery class of a live automatic row (DTI-2.1 §4). S is `seq_reserved`
 * and A is `seq_acked`:
 * - `legacy`: written before durable intent existed; retained;
 * - `c0a`: no intent, A = S; no terminal frame was ever transported, so the
 *   card may be closed with exactly one Error/interrupted edit;
 * - `c0b`: no intent, A < S; an unacknowledged edit may still land; retained;
 * - `c1`: intent R, A = S ≥ 1; the terminal edit was acknowledged and that
 *   acknowledgement persisted, so R is recorded locally without transport;
 * - `c2`: intent R, A < S; the terminal may or may not have applied; retained.
 *
 * Any shape outside that matrix falls into a retained class (`c0b`/`c2`):
 * recovery never edits a row it cannot place exactly.
 */
export type AutomaticRecoveryClass = "legacy" | "c0a" | "c0b" | "c1" | "c2";

export function classifyAutomaticRow(card: LiveAutomaticCard): AutomaticRecoveryClass {
  if (card.legacy !== false) return "legacy";
  const r = card.record;
  if (r.terminalIntent === null) return r.seqAcked === r.seqReserved ? "c0a" : "c0b";
  return r.seqReserved >= 1 && r.seqAcked === r.seqReserved ? "c1" : "c2";
}

/** Typed recovery result (DTI-2.1 §4.3). `scanned` always equals the sum of the other counts. */
export interface AutomaticRecoveryReport {
  /** Rows returned by `liveAutomaticCards()`. */
  readonly scanned: number;
  /** C0a whose closure resolved `acked`. */
  readonly restored: number;
  /** C1 whose `markTerminal` returned `updated` or `already_terminal`. */
  readonly rolledForward: number;
  /** C0b + C2 (and any shape outside the reviewed matrix). */
  readonly uncertain: number;
  /** O2 legacy rows. */
  readonly legacy: number;
  /** C0a not attempted, or refused before any reservation. */
  readonly deferred: number;
  /** C0a after a reservation without `acked`, or a C1 `markTerminal` refusal or throw. */
  readonly failed: number;
}

/** `scan: "failed"`: `liveAutomaticCards()` threw; nothing was classified or written. */
export type AutomaticRecoveryResult =
  | { readonly scan: "ok"; readonly report: AutomaticRecoveryReport }
  | { readonly scan: "failed" };

type Counts = { -readonly [K in keyof AutomaticRecoveryReport]: number };

/**
 * Startup snapshot of the live automatic rows. C1 rows are rolled forward
 * here (local only, no transport); C0a rows are left for `prepare`.
 */
export interface AutomaticRecoveryScan {
  readonly scan: "ok" | "failed";
  readonly counts: Readonly<Counts>;
  /** C0a rows awaiting the policy preconditions, in snapshot order. */
  readonly candidates: readonly CardMessageRecord[];
}

/** The minimal Error/interrupted closure of one adoptable C0a row. */
export interface AutomaticClosure {
  readonly row: CardMessageRecord;
  /** Queue-local card id; also the closure's reasoning id. */
  readonly cardId: string;
  readonly frame: RegistryFrame;
}

export interface PreparedAutomaticRecovery {
  readonly scan: "ok" | "failed";
  readonly counts: Readonly<Counts>;
  readonly closures: readonly AutomaticClosure[];
}

/** The only reason recovery ever passes to `finalize`: no row becomes Done through recovery. */
const RECOVERY_REASON = "interrupted" as const;

function emptyCounts(): Counts {
  return { scanned: 0, restored: 0, rolledForward: 0, uncertain: 0, legacy: 0, deferred: 0, failed: 0 };
}

/**
 * Classify every live automatic row and roll C1 forward. Never throws: a
 * failed snapshot classifies nothing and writes nothing (fail-closed).
 */
export function scanAutomaticRecovery(store: Pick<CardStore, "liveAutomaticCards" | "markTerminal">): AutomaticRecoveryScan {
  const counts = emptyCounts();
  let live: readonly LiveAutomaticCard[];
  try {
    live = store.liveAutomaticCards();
    if (!Array.isArray(live)) throw new TypeError("live rows");
  } catch {
    return Object.freeze({ scan: "failed", counts: Object.freeze(counts), candidates: Object.freeze([]) });
  }
  const candidates: CardMessageRecord[] = [];
  for (const card of live) {
    counts.scanned++;
    let cls: AutomaticRecoveryClass;
    try { cls = classifyAutomaticRow(card); } catch { cls = "c2"; }
    switch (cls) {
      case "legacy": counts.legacy++; break;
      case "c0b":
      case "c2": counts.uncertain++; break;
      case "c0a": candidates.push(card.record); break;
      case "c1": {
        // Same evidence the live path requires before `markTerminal` (DTI-2.1 §4.1); never a transport.
        let ok = false;
        try {
          const r = store.markTerminal(card.record.cardId, card.record.terminalIntent as CardTerminalReason);
          ok = r.kind === "updated" || r.kind === "already_terminal";
        } catch { ok = false; }
        if (ok) counts.rolledForward++; else counts.failed++;
        break;
      }
      default: {
        const unreachable: never = cls;
        void unreachable;
        counts.uncertain++;
      }
    }
  }
  return Object.freeze({ scan: "ok", counts: Object.freeze(counts), candidates: Object.freeze(candidates) });
}

export interface AutomaticRecoveryPolicyPorts {
  readonly botRef: BotRef;
  readonly policy: Pick<CardPolicy, "snapshot" | "authorize">;
  /** Shared origin gate; an ineligible origin is no policy read. */
  readonly eligible: () => boolean;
  /** Wall clock of the card store, for the closure's elapsed time. */
  readonly nowUtcMs: () => number;
  readonly newId: () => string;
}

function isCardChannel(channelType: number): channelType is CardChannelType {
  return channelType === 1 || channelType === 2 || channelType === 5;
}

/**
 * Apply the recovery preconditions P1–P5 (DTI-2.1 §3.4) to every C0a
 * candidate. A fresh policy snapshot is read first; without one every
 * candidate is deferred with no grant and no write. Each remaining row needs
 * the current automatic template, control-free and equal to the row's own
 * id/version, and a minimal Error/interrupted closure built with it under
 * `min(current automatic maxPayloadBytes, 16384)`. Never rejects.
 */
export async function prepareAutomaticRecovery(scan: AutomaticRecoveryScan, ports: AutomaticRecoveryPolicyPorts): Promise<PreparedAutomaticRecovery> {
  const counts: Counts = { ...scan.counts };
  const closures: AutomaticClosure[] = [];
  const done = (): PreparedAutomaticRecovery =>
    Object.freeze({ scan: scan.scan, counts: Object.freeze(counts), closures: Object.freeze(closures) });
  if (scan.scan !== "ok" || scan.candidates.length === 0) return done();

  // P1: a fresh snapshot, read through the shared origin gate.
  let snapshot: PolicySnapshot | undefined;
  try {
    if (ports.eligible()) snapshot = await ports.policy.snapshot();
  } catch {
    snapshot = undefined;
  }
  // P2: the automatic capability is authorized now, unpinned, by that same snapshot.
  let auth: Authorization | undefined;
  try {
    if (snapshot !== undefined) auth = ports.policy.authorize("automatic", { botRef: ports.botRef }, undefined);
  } catch {
    auth = undefined;
  }
  if (auth === undefined || !auth.allowed || auth.snapshot !== snapshot) {
    counts.deferred += scan.candidates.length;
    return done();
  }
  // P3: the current automatic template exists and is control-free.
  const template = auth.snapshot.automatic.template;
  const capBytes = Math.min(auth.limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES);
  for (const row of scan.candidates) {
    try {
      if (template === undefined || template.controlFree !== true
        // P4: the row's own template, exactly.
        || template.id !== row.templateId || template.version !== row.templateVersion
        || !isCardChannel(row.channelType)) {
        counts.deferred++;
        continue;
      }
      const cardId = ports.newId();
      const elapsedMs = Math.max(0, ports.nowUtcMs() - row.createdAt);
      // P5: the minimal closure, built with that same template.
      const frame = buildClosureFrame(RECOVERY_REASON, template, {
        reasoningId: cardId, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
        route: { channelId: row.channelId, channelType: row.channelType }, clientMsgNo: row.clientMsgNo, maxEnvelopeBytes: capBytes,
      });
      if (frame === undefined || typeof cardId !== "string" || cardId.length === 0) { counts.deferred++; continue; }
      closures.push(Object.freeze({ row, cardId, frame }));
    } catch {
      counts.deferred++;
    }
  }
  return done();
}

/** Grants for exactly the prepared closures; handed to the queue at construction. */
export function recoveryGrants(prepared: PreparedAutomaticRecovery): readonly RecoveryGrant[] {
  return Object.freeze(prepared.closures.map((c) => Object.freeze({ storeCardId: c.row.cardId, messageId: c.row.messageId as string })));
}

type RecoveryQueue = Pick<CardWriteQueue, "open" | "finalize">;

export interface AutomaticRecoveryRun {
  /** The `recovery` resource owner; registered so in-flight closures drain on shutdown. */
  readonly owner: CardResourceOwner;
  /** Resolves once every closure settled; never rejects. */
  readonly result: Promise<AutomaticRecoveryResult>;
}

function report(counts: Counts): AutomaticRecoveryReport {
  return Object.freeze({ ...counts });
}

/**
 * Adopt every prepared row and enqueue its Error/interrupted closure. Every
 * adoption runs synchronously here, before the runtime admits any turn, so
 * the queue's startup window is still open. Each closure is always the
 * minimal `interrupted` frame with the reason `interrupted`.
 */
export function runAutomaticRecovery(prepared: PreparedAutomaticRecovery, queue: RecoveryQueue,
  ctx: Pick<TrustedTurnContext, "botRef">, deps: { readonly clock: MonotonicClock; readonly timers: TimerPort }): AutomaticRecoveryRun {
  const counts: Counts = { ...prepared.counts };
  const pending = new Set<Promise<void>>();
  const cardCtx: Pick<TrustedTurnContext, "botRef"> = Object.freeze({ botRef: ctx.botRef });

  for (const c of prepared.closures) {
    const row = c.row;
    let opened: string;
    try {
      opened = queue.open({
        cardId: c.cardId, kind: "automatic", capability: "automatic", ctx: cardCtx,
        binding: Object.freeze({ sessionKey: row.sessionKey, channelId: row.channelId, channelType: row.channelType as CardChannelType,
          topicScope: row.topicScope, generation: row.generation, resetEpoch: row.resetEpoch }),
        clientMsgNo: row.clientMsgNo,
        presentation: Object.freeze({
          ...(row.templateId !== null ? { templateId: row.templateId } : {}),
          ...(row.templateVersion !== null ? { templateVersion: row.templateVersion } : {}),
          ...(row.profile !== null ? { profile: row.profile } : {}),
        }),
        adopt: Object.freeze({ storeCardId: row.cardId, messageId: row.messageId as string }),
      });
    } catch {
      opened = "contract";
    }
    if (opened !== "opened") { counts.deferred++; continue; }
    let work: Promise<TerminalResult>;
    try { work = queue.finalize(c.cardId, c.frame, RECOVERY_REASON); } catch { work = Promise.resolve({ outcome: "contract" }); }
    const settled = Promise.resolve(work).then(
      (r) => {
        if (r.outcome === "acked") counts.restored++;
        else if (r.seq === undefined) counts.deferred++;
        else counts.failed++;
      },
      // Unknown whether anything was reserved: never claimed restored; the next start re-evaluates.
      () => { counts.failed++; },
    );
    pending.add(settled);
    void settled.finally(() => { pending.delete(settled); });
  }

  const all = [...pending];
  const result: Promise<AutomaticRecoveryResult> = prepared.scan === "ok"
    ? Promise.all(all).then(() => Object.freeze({ scan: "ok" as const, report: report(counts) }))
    : Promise.resolve(Object.freeze({ scan: "failed" as const }));

  const owner: CardResourceOwner = Object.freeze({
    kind: "recovery" as const,
    close(): void { /* every adoption already ran; the queue's own close fences the closures */ },
    async drain(fence: ShutdownFence): Promise<ResourceDrainReport> {
      const left = [...pending];
      if (left.length === 0) return Object.freeze({ settled: 0, aborted: 0, unresolved: 0 });
      let handle: unknown;
      const deadline = new Promise<"deadline">((resolve) => {
        handle = deps.timers.setTimeout(() => resolve("deadline"), Math.max(0, fence.deadlineMono - deps.clock.nowMono()));
        fence.signal.addEventListener("abort", () => resolve("deadline"), { once: true });
      });
      const first = await Promise.race([Promise.all(left).then(() => "settled" as const), deadline]);
      deps.timers.clearTimeout(handle);
      const open = left.filter((p) => pending.has(p)).length;
      return Object.freeze(first === "settled" ? { settled: left.length, aborted: 0, unresolved: 0 }
        : { settled: left.length - open, aborted: 0, unresolved: open });
    },
  });
  return Object.freeze({ owner, result });
}
