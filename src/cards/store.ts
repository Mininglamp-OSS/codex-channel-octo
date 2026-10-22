/**
 * Durable card store — the sole SQL boundary of the card subsystem.
 *
 * Every mutation is one synchronous `BEGIN IMMEDIATE` transaction on the
 * existing per-Bot adapter (WAL, foreign keys on). No transaction may await:
 * a callback that returns a thenable is rolled back. Expected domain outcomes
 * are typed results; SQL failures throw `CardStoreError('storage_failure')`
 * and grant no transport authority.
 *
 * This module holds primitives only. Policy, pacing, lifecycle, recovery
 * orchestration, admission validation, event intake and builders live in
 * later packages and call into these ports.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db-adapter.js';
import type { CardChannelType, WallClock } from './contracts.js';
import {
  CARD_TABLES,
  RETENTION_MS,
  SESSION_TTL_MS,
  backupBeforeMigration,
  checkCardInvariants,
  countProtectedRows,
  inspectCardSchema,
  isSafeStoreRef,
  migrateCardSchema,
  referenceSchema,
  type ActivationMarkerPort,
  type BackupReceipt,
  type CardMeta,
  type CardTable,
  type InvariantViolation,
} from './migrations.js';

// ─── Limits ─────────────────────────────────────────────────────────────────

export const ACTIVE_SESSION_CAPACITY = 1000;
export const MAX_EXPLICIT_INVOCATIONS = 32;
export const MAX_EXPLICIT_SENDS = 10;
export const MAX_EVENT_ATTEMPTS = 3;
/** Eligibility waits after failed attempt 1 and 2 (§3.3). */
export const ATTEMPT_RETRY_DELAYS_MS: readonly [number, number] = [1000, 4000];
export const MAX_SAFE_RESULT_BYTES = 4096;

const ACTIVE_SESSION_SQL = `('sending','pending','retry_wait','admitted','ambiguous')`;

// ─── Errors ─────────────────────────────────────────────────────────────────

export type CardStoreErrorCode = 'storage_failure' | 'nested_transaction' | 'async_transaction' | 'invalid_input' | 'closed';

/**
 * Card rows whose edit sequence fences may still move: bound to a message and
 * not in an absorbing terminal state ('done', 'error', 'expired', 'abandoned').
 */
const SEQUENCE_WRITABLE = "message_id IS NOT NULL AND state NOT IN ('done','error','expired','abandoned')";

export class CardStoreError extends Error {
  constructor(
    readonly code: CardStoreErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`card store: ${code}`, options);
    this.name = 'CardStoreError';
  }
}

/** Thrown inside a transaction to roll it back and return a typed result. */
class Rollback<R> {
  constructor(readonly result: R) {}
}

// ─── Shared types ───────────────────────────────────────────────────────────

export type CardKind = 'automatic' | 'display' | 'interactive';
export type CardMessageState = 'sending' | 'ambiguous' | 'active' | 'answering' | 'done' | 'error' | 'expired' | 'abandoned';
export type CardTerminalReason = 'completed' | 'failed' | 'interrupted' | 'timed_out' | 'expired' | 'policy_revoked';
export type ActiveSessionStatus = 'sending' | 'pending' | 'retry_wait' | 'admitted' | 'ambiguous';
export type CardSessionStatus = ActiveSessionStatus | 'completed' | 'failed' | 'dead_letter' | 'expired';
export type AdmissionState = 'admitted' | 'completed' | 'failed' | 'ambiguous';
export type FinalDisposition =
  | 'admitted'
  | 'duplicate'
  | 'invalid'
  | 'unauthorized'
  | 'unknown'
  | 'poison'
  | 'expired'
  | 'rejected'
  | 'dead_letter'
  | 'unsupported_control';
export type CursorTopology = 'T-PART' | 'T-EXCL';
export type ExplicitOpcode = 'display' | 'interactive';
export type ExplicitRequestState = 'charged' | 'reserved' | 'acked' | 'failed' | 'ambiguous' | 'cancelled';

/** Trusted binding persisted with every card and session. */
export interface CardBinding {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly channelType: CardChannelType;
  readonly topicScope: string | null;
  readonly generation: string;
  readonly resetEpoch: number;
}

export interface CardPresentation {
  readonly templateId?: string;
  readonly templateVersion?: string;
  readonly profile?: string;
  readonly pinnedLimitsJson?: string;
}

/** Authored validation contract of an interactive card; never submitted values. */
export interface SessionContract {
  readonly requesterUid: string;
  readonly contractVersion: number;
  readonly authoredContractJson: string;
  readonly authoredDataHash: string;
}

export interface CursorAdvance {
  readonly scope: string;
  /** Contiguous owned boundary the event follows; `null` for the first event. */
  readonly expectedPrevious: string | null;
  readonly next: string;
}

export type CursorFailure = { readonly kind: 'cursor_conflict' } | { readonly kind: 'halted'; readonly reason: string } | { readonly kind: 'no_cursor' };

export interface CardMessageRecord {
  readonly cardId: string;
  readonly kind: CardKind;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly channelType: number;
  readonly generation: string;
  readonly topicScope: string | null;
  readonly resetEpoch: number;
  readonly bodyDigest: string;
  readonly clientMsgNo: string;
  readonly messageId: string | null;
  readonly seqReserved: number;
  readonly seqAcked: number;
  readonly state: CardMessageState;
  readonly terminalReason: CardTerminalReason | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly retainUntil: number | null;
}

export interface CardSessionRecord {
  readonly sessionId: string;
  readonly cardId: string;
  readonly requesterUid: string;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly channelType: number;
  readonly originGeneration: string;
  readonly topicScope: string | null;
  readonly resetEpoch: number;
  readonly contractVersion: number;
  readonly authoredContractJson: string;
  readonly authoredDataHash: string;
  readonly status: CardSessionStatus;
  readonly attempts: number;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly retainUntil: number | null;
}

export interface CardAdmissionRecord {
  readonly admissionId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly continuationGeneration: string;
  readonly submittedHash: string;
  readonly state: AdmissionState;
  readonly admittedAt: number;
  readonly settledAt: number | null;
}

export interface CursorRecord {
  readonly scope: string;
  readonly topology: CursorTopology;
  readonly cursor: string | null;
  readonly ackedThrough: string | null;
  readonly haltedReason: string | null;
  readonly haltedAt: number | null;
}

export interface HandlerGenerationRecord {
  readonly generation: string;
  readonly installationRef: string;
  readonly sessionKey: string;
  readonly runtimeIncarnation: string;
  readonly resetEpoch: number;
  readonly expiresAt: number;
  readonly contextDigest: string;
  readonly policyIdentity: string;
  readonly state: 'live' | 'closed';
  readonly invocationCount: number;
  readonly logicalSendCount: number;
  readonly closedAt: number | null;
}

export interface ExplicitRequestRecord {
  readonly generation: string;
  readonly requestId: string;
  readonly bodyDigest: string;
  readonly opcode: ExplicitOpcode;
  readonly state: ExplicitRequestState;
  readonly sendSlot: number | null;
  readonly clientMsgNo: string | null;
  readonly cardId: string | null;
  readonly safeResultJson: string | null;
}

// ─── Store options ──────────────────────────────────────────────────────────

export interface CardStoreOptions {
  readonly clock: WallClock;
  /** Opaque identifier factory for card/session/admission/client ids. */
  readonly newId?: () => string;
  /** Active interactive session capacity (T-reserve). */
  readonly sessionCapacity?: number;
}

// ─── Row mapping ────────────────────────────────────────────────────────────

interface MessageRow {
  card_id: string; kind: CardKind; session_key: string; channel_id: string; channel_type: number;
  generation: string; topic_scope: string | null; reset_epoch: number; body_digest: string;
  client_msg_no: string; message_id: string | null; seq_reserved: number; seq_acked: number;
  state: CardMessageState; terminal_reason: CardTerminalReason | null; created_at: number;
  terminal_at: number | null; retain_until: number | null;
}

interface SessionRow {
  session_id: string; card_id: string; requester_uid: string; session_key: string; channel_id: string;
  channel_type: number; origin_generation: string; topic_scope: string | null; reset_epoch: number;
  contract_version: number; authored_contract_json: string; authored_data_hash: string;
  status: CardSessionStatus; attempts: number; expires_at: number; created_at: number;
  terminal_at: number | null; retain_until: number | null;
}

interface AdmissionRow {
  admission_id: string; session_id: string; event_id: string; continuation_generation: string;
  submitted_hash: string; state: AdmissionState; admitted_at: number; settled_at: number | null;
}

interface AttemptRow {
  event_id: string; consumer_scope: string; event_class: string; session_id: string | null;
  message_id: string; position_ref: string; previous_position_ref: string | null;
  envelope_digest: string; attempt_no: number; phase: 'started' | 'failed' | 'send_wait';
  reason_code: string | null; next_eligible_at: number | null;
}

interface CursorRow {
  consumer_scope: string; topology: CursorTopology; cursor: string | null; acked_through: string | null;
  halted_reason: string | null; halted_at: number | null;
}

interface GenerationRow {
  generation: string; installation_ref: string; session_key: string; runtime_incarnation: string;
  reset_epoch: number; expires_at: number; context_digest: string; policy_identity: string;
  state: 'live' | 'closed'; invocation_count: number; logical_send_count: number; closed_at: number | null;
}

interface RequestRow {
  generation: string; request_id: string; body_digest: string; opcode: ExplicitOpcode;
  state: ExplicitRequestState; send_slot: number | null; client_msg_no: string | null;
  card_id: string | null; safe_result_json: string | null;
}

function toMessage(r: MessageRow): CardMessageRecord {
  return {
    cardId: r.card_id, kind: r.kind, sessionKey: r.session_key, channelId: r.channel_id,
    channelType: r.channel_type, generation: r.generation, topicScope: r.topic_scope,
    resetEpoch: r.reset_epoch, bodyDigest: r.body_digest, clientMsgNo: r.client_msg_no,
    messageId: r.message_id, seqReserved: r.seq_reserved, seqAcked: r.seq_acked, state: r.state,
    terminalReason: r.terminal_reason, createdAt: r.created_at, terminalAt: r.terminal_at,
    retainUntil: r.retain_until,
  };
}

function toSession(r: SessionRow): CardSessionRecord {
  return {
    sessionId: r.session_id, cardId: r.card_id, requesterUid: r.requester_uid, sessionKey: r.session_key,
    channelId: r.channel_id, channelType: r.channel_type, originGeneration: r.origin_generation,
    topicScope: r.topic_scope, resetEpoch: r.reset_epoch, contractVersion: r.contract_version,
    authoredContractJson: r.authored_contract_json, authoredDataHash: r.authored_data_hash,
    status: r.status, attempts: r.attempts, expiresAt: r.expires_at, createdAt: r.created_at,
    terminalAt: r.terminal_at, retainUntil: r.retain_until,
  };
}

function toAdmission(r: AdmissionRow): CardAdmissionRecord {
  return {
    admissionId: r.admission_id, sessionId: r.session_id, eventId: r.event_id,
    continuationGeneration: r.continuation_generation, submittedHash: r.submitted_hash,
    state: r.state, admittedAt: r.admitted_at, settledAt: r.settled_at,
  };
}

function toCursor(r: CursorRow): CursorRecord {
  return {
    scope: r.consumer_scope, topology: r.topology, cursor: r.cursor, ackedThrough: r.acked_through,
    haltedReason: r.halted_reason, haltedAt: r.halted_at,
  };
}

function toGeneration(r: GenerationRow): HandlerGenerationRecord {
  return {
    generation: r.generation, installationRef: r.installation_ref, sessionKey: r.session_key,
    runtimeIncarnation: r.runtime_incarnation, resetEpoch: r.reset_epoch, expiresAt: r.expires_at,
    contextDigest: r.context_digest, policyIdentity: r.policy_identity, state: r.state,
    invocationCount: r.invocation_count, logicalSendCount: r.logical_send_count, closedAt: r.closed_at,
  };
}

function toRequest(r: RequestRow): ExplicitRequestRecord {
  return {
    generation: r.generation, requestId: r.request_id, bodyDigest: r.body_digest, opcode: r.opcode,
    state: r.state, sendSlot: r.send_slot, clientMsgNo: r.client_msg_no, cardId: r.card_id,
    safeResultJson: r.safe_result_json,
  };
}

// ─── Input guards ───────────────────────────────────────────────────────────

const MAX_TEXT = 1024;
const MAX_CONTRACT_BYTES = 65536;

function text(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== 'string' || v.length === 0 || Buffer.byteLength(v, 'utf8') > max) {
    throw new CardStoreError('invalid_input');
  }
  return v;
}

function optText(v: unknown): string | null {
  return v === undefined || v === null ? null : text(v);
}

function int(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new CardStoreError('invalid_input');
  return v;
}

function checkBinding(b: CardBinding): void {
  text(b.sessionKey);
  text(b.channelId);
  if (b.channelType !== 1 && b.channelType !== 2 && b.channelType !== 5) throw new CardStoreError('invalid_input');
  optText(b.topicScope);
  text(b.generation);
  if (int(b.resetEpoch) < 0) throw new CardStoreError('invalid_input');
}

function safeResult(v: unknown): string {
  const s = text(v, MAX_SAFE_RESULT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new CardStoreError('invalid_input');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CardStoreError('invalid_input');
  return s;
}

// ─── Result unions ──────────────────────────────────────────────────────────

export type ReserveMessageResult =
  | { readonly kind: 'reserved'; readonly cardId: string }
  | { readonly kind: 'duplicate_client_msg_no' };

export type ReserveSessionResult =
  | { readonly kind: 'reserved'; readonly cardId: string; readonly sessionId: string; readonly expiresAt: number }
  | { readonly kind: 'capacity_full' }
  | { readonly kind: 'duplicate_client_msg_no' };

export interface AckMessageInput {
  readonly cardId: string;
  readonly messageId: string;
  /** Current persisted reset epoch of the session key. */
  readonly currentResetEpoch: number;
  /** Current policy decision for exposing an actionable card. */
  readonly policyAllows: boolean;
}

export type AckMessageResult =
  | { readonly kind: 'bound'; readonly admittable: boolean; readonly reason?: 'expired' | 'reset_fenced' | 'policy_revoked' }
  | { readonly kind: 'already_bound' }
  | { readonly kind: 'identity_conflict' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

export type SendOutcomeResult =
  | { readonly kind: 'updated' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

export type ReserveSequenceResult =
  | { readonly kind: 'reserved'; readonly seq: number }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

export type AckSequenceResult =
  | { readonly kind: 'acked'; readonly seqAcked: number }
  | { readonly kind: 'not_reserved' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

export interface EventIdentity {
  readonly eventId: string;
  readonly scope: string;
  readonly eventClass: string;
  readonly sessionId: string | null;
}

export interface AttemptStartInput extends EventIdentity {
  readonly messageId: string;
  readonly positionRef: string;
  readonly previousPositionRef: string | null;
  readonly envelopeDigest: string;
}

export type AttemptStartResult =
  | { readonly kind: 'started'; readonly attemptNo: 1 | 2 | 3 }
  | { readonly kind: 'in_progress'; readonly attemptNo: number }
  | { readonly kind: 'not_eligible'; readonly attemptNo: number; readonly nextEligibleAt: number }
  | { readonly kind: 'final'; readonly disposition: FinalDisposition }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'halted'; readonly reason: string };

export type AttemptFailureResult =
  | { readonly kind: 'retry_wait'; readonly attemptNo: number; readonly nextEligibleAt: number }
  | { readonly kind: 'dead_letter' }
  | { readonly kind: 'not_started' }
  | CursorFailure;

export type DispositionResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'already_final'; readonly disposition: FinalDisposition }
  | CursorFailure;

export interface AdmitInput extends EventIdentity {
  readonly sessionId: string;
  readonly continuationGeneration: string;
  readonly submittedHash: string;
  readonly currentResetEpoch: number;
  /** Required: T2 always commits the event's own contiguous cursor position. */
  readonly cursor: CursorAdvance;
}

export type AdmitResult =
  | { readonly kind: 'admitted'; readonly admissionId: string }
  | { readonly kind: 'duplicate'; readonly recorded: CardSessionStatus | FinalDisposition }
  | { readonly kind: 'expired' }
  | { readonly kind: 'rejected'; readonly reason: 'reset_fenced' | 'unknown_session' }
  | CursorFailure;

export type SettleResult =
  | { readonly kind: 'settled'; readonly state: 'completed' | 'failed' }
  | { readonly kind: 'already'; readonly state: AdmissionState }
  | { readonly kind: 'not_found' };

export type AmbiguousResult =
  | { readonly kind: 'marked' }
  | { readonly kind: 'already'; readonly state: AdmissionState }
  | { readonly kind: 'not_found' };

export interface RegisterHandlerInput {
  readonly generation: string;
  readonly installationRef: string;
  readonly sessionKey: string;
  readonly runtimeIncarnation: string;
  readonly resetEpoch: number;
  readonly expiresAt: number;
  readonly contextDigest: string;
  readonly policyIdentity: string;
}

/** Trusted authority the caller authenticated before touching the ledger. */
export interface HandlerFence {
  readonly generation: string;
  readonly runtimeIncarnation: string;
  readonly resetEpoch: number;
}

export type RegisterHandlerResult = { readonly kind: 'registered' } | { readonly kind: 'generation_exists' };

export type HandlerRejection = 'unknown_generation' | 'closed' | 'expired' | 'incarnation_mismatch' | 'reset_fenced';

export type ChargeResult =
  | { readonly kind: 'charged'; readonly invocationCount: number }
  | { readonly kind: 'joined'; readonly request: ExplicitRequestRecord }
  | { readonly kind: 'body_mismatch' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'rejected'; readonly reason: HandlerRejection };

export type ExplicitCard =
  | ({ readonly opcode: 'display'; readonly binding: CardBinding; readonly bodyDigest: string } & CardPresentation)
  | ({ readonly opcode: 'interactive'; readonly binding: CardBinding; readonly bodyDigest: string; readonly contract: SessionContract } & CardPresentation);

export type ReserveExplicitResult =
  | { readonly kind: 'reserved'; readonly slot: number; readonly clientMsgNo: string; readonly cardId: string; readonly sessionId: string | null }
  | { readonly kind: 'already_reserved'; readonly request: ExplicitRequestRecord }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'capacity_full' }
  | { readonly kind: 'not_chargeable'; readonly state: ExplicitRequestState }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'rejected'; readonly reason: HandlerRejection };

export type ExplicitFinish = 'acked' | 'failed' | 'ambiguous' | 'cancelled';

export interface FinishExplicitInput {
  readonly generation: string;
  readonly requestId: string;
  readonly outcome: ExplicitFinish;
  readonly safeResultJson: string;
  /** Card transition committed in the same transaction (T-bind / failure / ambiguity). */
  readonly message?:
    | { readonly kind: 'ack'; readonly messageId: string; readonly currentResetEpoch: number; readonly policyAllows: boolean }
    | { readonly kind: 'failed' }
    | { readonly kind: 'ambiguous' }
    | { readonly kind: 'abandoned' };
}

export type FinishExplicitResult =
  | { readonly kind: 'finished'; readonly ack?: AckMessageResult }
  | { readonly kind: 'already'; readonly state: ExplicitRequestState }
  | { readonly kind: 'invalid_transition'; readonly from: ExplicitRequestState }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'card_transition_failed'; readonly detail: AckMessageResult | SendOutcomeResult };

export interface LedgerRecovery {
  readonly closedGenerations: number;
  /** Charged/reserved/ambiguous work retained for lookup or quarantine; never resubmitted. */
  readonly unresolved: ReadonlyArray<{ readonly generation: string; readonly requestId: string; readonly state: ExplicitRequestState }>;
  readonly violations: readonly InvariantViolation[];
}

export interface CleanupReport {
  readonly attempts: number;
  readonly dispositions: number;
  readonly admissions: number;
  readonly requests: number;
  readonly sessions: number;
  readonly messages: number;
  readonly generations: number;
}

/** Fixed-path exhaustion diagnostic (§1.4 step 6). */
export const EXPLICIT_BUDGET_EXHAUSTED = Object.freeze({
  status: 'error',
  error: { code: 'limit_exceeded', diagnostics: [{ path: '$', rule: 'explicit_card_budget_exhausted' }] },
} as const);

const EXHAUSTED_JSON = JSON.stringify(EXPLICIT_BUDGET_EXHAUSTED);
const CAPACITY_FULL_JSON = JSON.stringify({ status: 'error', error: { code: 'capacity_full' } });

// ─── Store ──────────────────────────────────────────────────────────────────

export class CardStore {
  private readonly clock: WallClock;
  private readonly newId: () => string;
  private readonly capacity: number;
  private closed = false;

  constructor(
    private readonly adapter: DbAdapter,
    options: CardStoreOptions,
  ) {
    this.clock = options.clock;
    this.newId = options.newId ?? randomUUID;
    this.capacity = options.sessionCapacity ?? ACTIVE_SESSION_CAPACITY;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new CardStoreError('invalid_input');
  }

  /** Revoke the store lease; later calls throw `closed` and never touch SQL. */
  retire(): void {
    this.closed = true;
  }

  get retired(): boolean {
    return this.closed;
  }

  // ── transaction core ──

  private now(): number {
    const t = this.clock.nowUtcMs();
    if (!Number.isSafeInteger(t) || t < 0) throw new CardStoreError('invalid_input');
    return t;
  }

  private tx<R>(fn: () => R): R {
    if (this.closed) throw new CardStoreError('closed');
    if (this.adapter.inTransaction) throw new CardStoreError('nested_transaction');
    try {
      this.adapter.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw new CardStoreError('storage_failure', { cause: err });
    }
    let result: R;
    try {
      result = fn();
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        throw new CardStoreError('async_transaction');
      }
    } catch (err) {
      this.rollback();
      if (err instanceof Rollback) return err.result as R;
      if (err instanceof CardStoreError) throw err;
      throw new CardStoreError('storage_failure', { cause: err });
    }
    try {
      this.adapter.exec('COMMIT');
    } catch (err) {
      this.rollback();
      throw new CardStoreError('storage_failure', { cause: err });
    }
    return result;
  }

  private rollback(): void {
    try {
      if (this.adapter.inTransaction) this.adapter.exec('ROLLBACK');
    } catch {
      // The connection is unusable; the caller already receives a failure.
    }
  }

  private read<R>(fn: () => R): R {
    if (this.closed) throw new CardStoreError('closed');
    try {
      return fn();
    } catch (err) {
      if (err instanceof CardStoreError) throw err;
      throw new CardStoreError('storage_failure', { cause: err });
    }
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.adapter.prepare(sql).get(...params) as T | undefined;
  }

  private run(sql: string, ...params: unknown[]): number {
    return this.adapter.prepare(sql).run(...params).changes;
  }

  // ── cursor (inside transactions) ──

  private static checkCursorInput(c: CursorAdvance): void {
    if (c === null || typeof c !== 'object') throw new CardStoreError('invalid_input');
    text(c.scope);
    if (c.expectedPrevious !== null) text(c.expectedPrevious);
    text(c.next);
  }

  /**
   * Event-scope boundary check, run before any T1/T2 mutation: the cursor must
   * belong to the event's own consumer scope, and that scope must have a live,
   * unhalted cursor row. A halt can never be crossed through another scope.
   */
  private checkCursorBoundary(eventScope: string, c: CursorAdvance): void {
    if (c.scope !== eventScope) throw new Rollback<CursorFailure>({ kind: 'cursor_conflict' });
    const row = this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', eventScope);
    if (!row) throw new Rollback<CursorFailure>({ kind: 'no_cursor' });
    if (row.halted_reason !== null) throw new Rollback<CursorFailure>({ kind: 'halted', reason: row.halted_reason });
  }

  private advanceCursor(c: CursorAdvance, now: number): void {
    const row = this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', text(c.scope));
    if (!row) throw new Rollback<CursorFailure>({ kind: 'no_cursor' });
    if (row.halted_reason !== null) throw new Rollback<CursorFailure>({ kind: 'halted', reason: row.halted_reason });
    // Opaque positions are compared for identity only, never ordered.
    if (row.cursor !== (c.expectedPrevious === null ? null : text(c.expectedPrevious))) {
      throw new Rollback<CursorFailure>({ kind: 'cursor_conflict' });
    }
    this.run(
      'UPDATE card_event_cursor SET cursor = ?, updated_at = ? WHERE consumer_scope = ? AND cursor IS ?',
      text(c.next),
      now,
      c.scope,
      row.cursor,
    );
  }

  private finalDisposition(eventId: string): FinalDisposition | undefined {
    return this.get<{ disposition: FinalDisposition }>(
      'SELECT disposition FROM card_event_dispositions WHERE event_id = ?',
      eventId,
    )?.disposition;
  }

  private insertDisposition(e: EventIdentity, d: FinalDisposition, reason: string | null, attempts: number, now: number): void {
    this.run(
      `INSERT INTO card_event_dispositions
         (event_id, consumer_scope, event_class, session_id, disposition, reason_code, attempts, created_at, retain_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.eventId,
      e.scope,
      e.eventClass,
      e.sessionId,
      d,
      reason,
      Math.min(Math.max(attempts, 1), MAX_EVENT_ATTEMPTS),
      now,
      now + RETENTION_MS,
    );
  }

  // ── cards and sessions (T-reserve) ──

  private activeSessionCount(): number {
    return (this.get<{ c: number }>(`SELECT count(*) AS c FROM card_sessions WHERE status IN ${ACTIVE_SESSION_SQL}`) as { c: number }).c;
  }

  private insertMessage(kind: CardKind, binding: CardBinding, bodyDigest: string, clientMsgNo: string, p: CardPresentation, now: number): string | null {
    if (this.get('SELECT 1 FROM card_messages WHERE client_msg_no = ?', clientMsgNo)) return null;
    const cardId = this.newId();
    this.run(
      `INSERT INTO card_messages
         (card_id, kind, session_key, channel_id, channel_type, generation, topic_scope, reset_epoch,
          body_digest, client_msg_no, template_id, template_version, profile, pinned_limits_json,
          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      cardId, kind, binding.sessionKey, binding.channelId, binding.channelType, binding.generation,
      binding.topicScope, binding.resetEpoch, bodyDigest, clientMsgNo, p.templateId ?? null,
      p.templateVersion ?? null, p.profile ?? null, p.pinnedLimitsJson ?? null, now, now,
    );
    return cardId;
  }

  private insertSession(cardId: string, binding: CardBinding, c: SessionContract, now: number): { sessionId: string; expiresAt: number } {
    const sessionId = this.newId();
    const expiresAt = now + SESSION_TTL_MS;
    this.run(
      `INSERT INTO card_sessions
         (session_id, card_id, requester_uid, session_key, channel_id, channel_type, origin_generation,
          topic_scope, reset_epoch, contract_version, authored_contract_json, authored_data_hash,
          status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      sessionId, cardId, c.requesterUid, binding.sessionKey, binding.channelId, binding.channelType,
      binding.generation, binding.topicScope, binding.resetEpoch, c.contractVersion,
      c.authoredContractJson, c.authoredDataHash, expiresAt, now,
    );
    return { sessionId, expiresAt };
  }

  private checkContract(c: SessionContract): void {
    text(c.requesterUid);
    if (int(c.contractVersion) < 1) throw new CardStoreError('invalid_input');
    text(c.authoredContractJson, MAX_CONTRACT_BYTES);
    text(c.authoredDataHash);
  }

  private checkPresentation(p: CardPresentation): void {
    optText(p.templateId);
    optText(p.templateVersion);
    optText(p.profile);
    if (p.pinnedLimitsJson !== undefined) text(p.pinnedLimitsJson, MAX_SAFE_RESULT_BYTES);
  }

  /** Reserve an automatic or display card before its first send. */
  reserveMessage(input: { kind: 'automatic' | 'display'; binding: CardBinding; bodyDigest: string; clientMsgNo: string } & CardPresentation): ReserveMessageResult {
    if (input.kind !== 'automatic' && input.kind !== 'display') throw new CardStoreError('invalid_input');
    checkBinding(input.binding);
    this.checkPresentation(input);
    const bodyDigest = text(input.bodyDigest);
    const clientMsgNo = text(input.clientMsgNo);
    return this.tx(() => {
      const cardId = this.insertMessage(input.kind, input.binding, bodyDigest, clientMsgNo, input, this.now());
      return cardId === null ? { kind: 'duplicate_client_msg_no' } : { kind: 'reserved', cardId };
    });
  }

  /**
   * T-reserve: count active sessions and insert the interactive card plus its
   * session contract in one write transaction. The 1001st concurrent author
   * gets `capacity_full` before any transport.
   */
  reserveSession(input: { binding: CardBinding; bodyDigest: string; clientMsgNo: string; contract: SessionContract } & CardPresentation): ReserveSessionResult {
    checkBinding(input.binding);
    this.checkContract(input.contract);
    this.checkPresentation(input);
    const bodyDigest = text(input.bodyDigest);
    const clientMsgNo = text(input.clientMsgNo);
    return this.tx(() => {
      const now = this.now();
      if (this.activeSessionCount() >= this.capacity) return { kind: 'capacity_full' };
      const cardId = this.insertMessage('interactive', input.binding, bodyDigest, clientMsgNo, input, now);
      if (cardId === null) return { kind: 'duplicate_client_msg_no' };
      const s = this.insertSession(cardId, input.binding, input.contract, now);
      return { kind: 'reserved', cardId, sessionId: s.sessionId, expiresAt: s.expiresAt };
    });
  }

  private ackInTx(input: AckMessageInput, now: number): AckMessageResult {
    const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', input.cardId);
    if (!msg) return { kind: 'not_found' };
    if (msg.message_id !== null) {
      return msg.message_id === input.messageId ? { kind: 'already_bound' } : { kind: 'identity_conflict' };
    }
    if (msg.state !== 'sending' && msg.state !== 'ambiguous') return { kind: 'invalid_state', state: msg.state };
    if (this.get('SELECT 1 FROM card_messages WHERE message_id = ?', input.messageId)) return { kind: 'identity_conflict' };

    const session = this.get<SessionRow>('SELECT * FROM card_sessions WHERE card_id = ?', input.cardId);
    if (!session) {
      this.run(
        `UPDATE card_messages SET message_id = ?, state = 'active', updated_at = ? WHERE card_id = ?`,
        input.messageId, now, input.cardId,
      );
      return { kind: 'bound', admittable: false };
    }
    if (session.status !== 'sending' && session.status !== 'ambiguous') {
      throw new Rollback<AckMessageResult>({ kind: 'invalid_state', state: msg.state });
    }
    let reason: 'expired' | 'reset_fenced' | 'policy_revoked' | undefined;
    if (now >= session.expires_at) reason = 'expired';
    else if (session.reset_epoch !== input.currentResetEpoch) reason = 'reset_fenced';
    else if (!input.policyAllows) reason = 'policy_revoked';

    if (reason === undefined) {
      this.run(
        `UPDATE card_messages SET message_id = ?, state = 'active', updated_at = ? WHERE card_id = ?`,
        input.messageId, now, input.cardId,
      );
      this.run(`UPDATE card_sessions SET status = 'pending' WHERE session_id = ?`, session.session_id);
      return { kind: 'bound', admittable: true };
    }
    // The card exists remotely but must never become admittable.
    const sessionStatus = reason === 'expired' ? 'expired' : 'failed';
    const msgState = reason === 'expired' ? 'expired' : 'error';
    const terminalReason = reason === 'expired' ? 'expired' : reason === 'policy_revoked' ? 'policy_revoked' : 'failed';
    this.run(
      `UPDATE card_messages SET message_id = ?, state = ?, terminal_reason = ?, terminal_at = ?, retain_until = ?, updated_at = ?
       WHERE card_id = ?`,
      input.messageId, msgState, terminalReason, now, now + RETENTION_MS, now, input.cardId,
    );
    this.run(
      `UPDATE card_sessions SET status = ?, terminal_at = ?, retain_until = ? WHERE session_id = ?`,
      sessionStatus, now, now + RETENTION_MS, session.session_id,
    );
    return { kind: 'bound', admittable: false, reason };
  }

  /** T-bind: bind the correlated acknowledged identity and expose pending only if still admittable. */
  ackMessage(input: AckMessageInput): AckMessageResult {
    text(input.cardId);
    text(input.messageId);
    int(input.currentResetEpoch);
    return this.tx(() => this.ackInTx(input, this.now()));
  }

  private sendOutcomeInTx(cardId: string, outcome: 'failed' | 'ambiguous' | 'abandoned', now: number): SendOutcomeResult {
    const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
    if (!msg) return { kind: 'not_found' };
    if (outcome === 'abandoned') {
      // Never sent: closed before transport. Retains the reservation as evidence.
      if (msg.state !== 'sending') return { kind: 'invalid_state', state: msg.state };
      this.run(
        `UPDATE card_messages SET state = 'abandoned', terminal_reason = 'interrupted', terminal_at = ?, retain_until = ?, updated_at = ?
         WHERE card_id = ?`,
        now, now + RETENTION_MS, now, cardId,
      );
      this.run(
        `UPDATE card_sessions SET status = 'failed', terminal_at = ?, retain_until = ? WHERE card_id = ? AND status = 'sending'`,
        now, now + RETENTION_MS, cardId,
      );
      return { kind: 'updated' };
    }
    if (outcome === 'ambiguous') {
      if (msg.state !== 'sending') return { kind: 'invalid_state', state: msg.state };
      this.run(`UPDATE card_messages SET state = 'ambiguous', updated_at = ? WHERE card_id = ?`, now, cardId);
      this.run(`UPDATE card_sessions SET status = 'ambiguous' WHERE card_id = ? AND status = 'sending'`, cardId);
      return { kind: 'updated' };
    }
    if (msg.state !== 'sending' && msg.state !== 'ambiguous') return { kind: 'invalid_state', state: msg.state };
    this.run(
      `UPDATE card_messages SET state = 'error', terminal_reason = 'failed', terminal_at = ?, retain_until = ?, updated_at = ?
       WHERE card_id = ?`,
      now, now + RETENTION_MS, now, cardId,
    );
    this.run(
      `UPDATE card_sessions SET status = 'failed', terminal_at = ?, retain_until = ?
       WHERE card_id = ? AND status IN ('sending','ambiguous')`,
      now, now + RETENTION_MS, cardId,
    );
    return { kind: 'updated' };
  }

  /** Definitive initial-send rejection: card and session fail together. */
  markSendFailed(cardId: string): SendOutcomeResult {
    text(cardId);
    return this.tx(() => this.sendOutcomeInTx(cardId, 'failed', this.now()));
  }

  /** Possibly accepted send: keeps the reservation counted and admission-ineligible. */
  markSendAmbiguous(cardId: string): SendOutcomeResult {
    text(cardId);
    return this.tx(() => this.sendOutcomeInTx(cardId, 'ambiguous', this.now()));
  }

  /** Closed before first transport: the card never left the process. */
  abandonUnsent(cardId: string): SendOutcomeResult {
    text(cardId);
    return this.tx(() => this.sendOutcomeInTx(cardId, 'abandoned', this.now()));
  }

  /**
   * Reserve the next edit sequence before the edit is sent. Only a bound,
   * non-terminal card can reserve: the guard is part of the UPDATE predicate,
   * so a terminal transition can never be followed by a sequence change.
   */
  reserveSequence(cardId: string): ReserveSequenceResult {
    text(cardId);
    return this.tx(() => {
      const changed = this.run(
        `UPDATE card_messages SET seq_reserved = seq_reserved + 1, updated_at = ?
         WHERE card_id = ? AND ${SEQUENCE_WRITABLE}`,
        this.now(), cardId,
      );
      const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
      if (!msg) return { kind: 'not_found' };
      if (changed === 0) return { kind: 'invalid_state', state: msg.state };
      return { kind: 'reserved', seq: msg.seq_reserved };
    });
  }

  /**
   * Correlated edit acknowledgement; never moves the acked fence backwards.
   * Like reservation, it only applies to a bound, non-terminal card, enforced
   * in the same UPDATE that moves the fence.
   */
  ackSequence(cardId: string, seq: number): AckSequenceResult {
    text(cardId);
    int(seq);
    return this.tx(() => {
      const changed = this.run(
        `UPDATE card_messages SET seq_acked = MAX(seq_acked, ?), updated_at = ?
         WHERE card_id = ? AND ? >= 1 AND ? <= seq_reserved AND ${SEQUENCE_WRITABLE}`,
        seq, this.now(), cardId, seq, seq,
      );
      const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
      if (!msg) return { kind: 'not_found' };
      if (changed === 1) return { kind: 'acked', seqAcked: msg.seq_acked };
      if (seq < 1 || seq > msg.seq_reserved) return { kind: 'not_reserved' };
      return { kind: 'invalid_state', state: msg.state };
    });
  }

  // ── event cursor ──

  /** Create the cursor row for a proven topology. Existing rows are returned unchanged. */
  initCursor(scope: string, topology: CursorTopology): CursorRecord {
    text(scope);
    if (topology !== 'T-PART' && topology !== 'T-EXCL') throw new CardStoreError('invalid_input');
    return this.tx(() => {
      this.run(
        'INSERT OR IGNORE INTO card_event_cursor (consumer_scope, topology, updated_at) VALUES (?, ?, ?)',
        scope, topology, this.now(),
      );
      return toCursor(this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', scope) as CursorRow);
    });
  }

  readCursor(scope: string): CursorRecord | null {
    text(scope);
    return this.read(() => {
      const row = this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', scope);
      return row ? toCursor(row) : null;
    });
  }

  /** Durable halt; the first reason is retained and restart preserves it. */
  haltCursor(scope: string, reason: string): CursorRecord | null {
    text(scope);
    text(reason, 64);
    return this.tx(() => {
      const now = this.now();
      this.run(
        `UPDATE card_event_cursor SET halted_reason = ?, halted_at = ?, updated_at = ?
         WHERE consumer_scope = ? AND halted_reason IS NULL`,
        reason, now, now, scope,
      );
      const row = this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', scope);
      return row ? toCursor(row) : null;
    });
  }

  /** Record the server ACK boundary after a committed final disposition. */
  recordAck(scope: string, position: string): boolean {
    text(scope);
    text(position);
    return this.tx(() => {
      const row = this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', scope);
      if (!row || row.cursor !== position) return false;
      this.run('UPDATE card_event_cursor SET acked_through = ?, updated_at = ? WHERE consumer_scope = ?', position, this.now(), scope);
      return true;
    });
  }

  // ── T0 / T1a attempts ──

  /** T0: persist an attempt start before any asynchronous pre-admission check. */
  recordAttemptStart(input: AttemptStartInput): AttemptStartResult {
    text(input.eventId); text(input.scope); text(input.eventClass); optText(input.sessionId);
    text(input.messageId); text(input.positionRef); optText(input.previousPositionRef); text(input.envelopeDigest);
    return this.tx(() => {
      const now = this.now();
      const final = this.finalDisposition(input.eventId);
      if (final !== undefined) return { kind: 'final', disposition: final };
      const cursor = this.get<CursorRow>('SELECT * FROM card_event_cursor WHERE consumer_scope = ?', input.scope);
      if (cursor?.halted_reason) return { kind: 'halted', reason: cursor.halted_reason };
      const row = this.get<AttemptRow>('SELECT * FROM card_event_attempts WHERE event_id = ?', input.eventId);
      if (!row) {
        this.run(
          `INSERT INTO card_event_attempts
             (event_id, consumer_scope, event_class, session_id, message_id, position_ref, previous_position_ref,
              envelope_digest, attempt_no, phase, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'started', ?)`,
          input.eventId, input.scope, input.eventClass, input.sessionId, input.messageId, input.positionRef,
          input.previousPositionRef, input.envelopeDigest, now,
        );
        return { kind: 'started', attemptNo: 1 };
      }
      if (
        row.consumer_scope !== input.scope || row.position_ref !== input.positionRef ||
        row.previous_position_ref !== input.previousPositionRef || row.envelope_digest !== input.envelopeDigest ||
        row.message_id !== input.messageId || row.session_id !== input.sessionId || row.event_class !== input.eventClass
      ) {
        return { kind: 'conflict' };
      }
      if (row.phase === 'started') return { kind: 'in_progress', attemptNo: row.attempt_no };
      let next: number;
      if (row.phase === 'send_wait') next = 1;
      else {
        if (row.attempt_no >= MAX_EVENT_ATTEMPTS) return { kind: 'conflict' };
        if (row.next_eligible_at !== null && now < row.next_eligible_at) {
          return { kind: 'not_eligible', attemptNo: row.attempt_no, nextEligibleAt: row.next_eligible_at };
        }
        next = row.attempt_no + 1;
      }
      this.run(
        `UPDATE card_event_attempts SET attempt_no = ?, phase = 'started', reason_code = NULL, next_eligible_at = NULL, updated_at = ?
         WHERE event_id = ?`,
        next, now, input.eventId,
      );
      return { kind: 'started', attemptNo: next as 1 | 2 | 3 };
    });
  }

  /**
   * T1a: an intermediate failure keeps cursor/ACK unchanged and parks the
   * session in `retry_wait`. Exactly the third failure commits dead-letter and
   * the final cursor disposition together.
   */
  recordAttemptFailure(input: { eventId: string; reasonCode: string; cursor: CursorAdvance }): AttemptFailureResult {
    text(input.eventId);
    text(input.reasonCode, 64);
    return this.tx<AttemptFailureResult>(() => {
      const now = this.now();
      const row = this.get<AttemptRow>('SELECT * FROM card_event_attempts WHERE event_id = ?', input.eventId);
      if (!row || row.phase !== 'started' || this.finalDisposition(input.eventId) !== undefined) return { kind: 'not_started' };
      if (row.attempt_no < MAX_EVENT_ATTEMPTS) {
        const nextEligibleAt = now + ATTEMPT_RETRY_DELAYS_MS[row.attempt_no - 1];
        this.run(
          `UPDATE card_event_attempts SET phase = 'failed', reason_code = ?, next_eligible_at = ?, updated_at = ? WHERE event_id = ?`,
          input.reasonCode, nextEligibleAt, now, input.eventId,
        );
        if (row.session_id !== null) {
          this.run(
            `UPDATE card_sessions SET status = 'retry_wait', attempts = ? WHERE session_id = ? AND status IN ('pending','retry_wait')`,
            row.attempt_no, row.session_id,
          );
        }
        return { kind: 'retry_wait', attemptNo: row.attempt_no, nextEligibleAt };
      }
      this.run(
        `UPDATE card_event_attempts SET phase = 'failed', reason_code = ?, next_eligible_at = NULL, updated_at = ? WHERE event_id = ?`,
        input.reasonCode, now, input.eventId,
      );
      this.insertDisposition(
        { eventId: row.event_id, scope: row.consumer_scope, eventClass: row.event_class, sessionId: row.session_id },
        'dead_letter', input.reasonCode, MAX_EVENT_ATTEMPTS, now,
      );
      if (row.session_id !== null) {
        this.run(
          `UPDATE card_sessions SET status = 'dead_letter', attempts = 3, terminal_at = ?, retain_until = ?
           WHERE session_id = ? AND status IN ('pending','retry_wait')`,
          now, now + RETENTION_MS, row.session_id,
        );
      }
      if (row.consumer_scope !== input.cursor.scope) throw new Rollback<CursorFailure>({ kind: 'cursor_conflict' });
      this.advanceCursor(input.cursor, now);
      return { kind: 'dead_letter' };
    });
  }

  /** Early callback held while its matching send is unresolved; not a failure attempt. */
  recordSendWait(input: AttemptStartInput): AttemptStartResult | { readonly kind: 'send_wait' } {
    text(input.eventId); text(input.scope); text(input.eventClass); optText(input.sessionId);
    text(input.messageId); text(input.positionRef); optText(input.previousPositionRef); text(input.envelopeDigest);
    return this.tx(() => {
      const final = this.finalDisposition(input.eventId);
      if (final !== undefined) return { kind: 'final', disposition: final };
      const row = this.get<AttemptRow>('SELECT * FROM card_event_attempts WHERE event_id = ?', input.eventId);
      if (row) return row.phase === 'send_wait' ? { kind: 'send_wait' } : { kind: 'conflict' };
      this.run(
        `INSERT INTO card_event_attempts
           (event_id, consumer_scope, event_class, session_id, message_id, position_ref, previous_position_ref,
            envelope_digest, attempt_no, phase, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'send_wait', ?)`,
        input.eventId, input.scope, input.eventClass, input.sessionId, input.messageId, input.positionRef,
        input.previousPositionRef, input.envelopeDigest, this.now(),
      );
      return { kind: 'send_wait' };
    });
  }

  // ── T1 final disposition ──

  /**
   * T1: immutable final disposition plus contiguous cursor advance. Admission
   * and dead-letter have their own transactions (T2/T1a). Replays of an
   * already-final event return it without advancing again (re-ACK only).
   */
  recordDisposition(input: EventIdentity & {
    disposition: Exclude<FinalDisposition, 'admitted' | 'dead_letter'>;
    reasonCode?: string;
    attempts?: number;
    cursor: CursorAdvance;
  }): DispositionResult {
    text(input.eventId); text(input.scope); text(input.eventClass); optText(input.sessionId);
    if (input.disposition === ('admitted' as string) || input.disposition === ('dead_letter' as string)) {
      throw new CardStoreError('invalid_input');
    }
    const reason = input.reasonCode === undefined ? null : text(input.reasonCode, 64);
    CardStore.checkCursorInput(input.cursor);
    return this.tx<DispositionResult>(() => {
      const now = this.now();
      const final = this.finalDisposition(input.eventId);
      if (final !== undefined) return { kind: 'already_final', disposition: final };
      this.checkCursorBoundary(input.scope, input.cursor);
      const sessionId = input.sessionId !== null && this.get('SELECT 1 FROM card_sessions WHERE session_id = ?', input.sessionId)
        ? input.sessionId
        : null;
      this.insertDisposition({ ...input, sessionId }, input.disposition, reason, input.attempts ?? 1, now);
      if (input.disposition === 'rejected' && sessionId !== null) {
        // Definitive pre-admission rejection releases the claim; controls are restored.
        this.run(`UPDATE card_sessions SET status = 'pending' WHERE session_id = ? AND status = 'retry_wait'`, sessionId);
      }
      this.advanceCursor(input.cursor, now);
      return { kind: 'recorded' };
    });
  }

  // ── T2 admission ──

  /**
   * T2: CAS the session to `admitted`, insert the single admission, its final
   * disposition and the cursor advance in one transaction. Dispatch may begin
   * only after this returns `admitted`. Every losing racer commits exactly one
   * final non-admission disposition for its own event.
   */
  admitOnce(input: AdmitInput): AdmitResult {
    text(input.eventId); text(input.scope); text(input.eventClass); text(input.sessionId);
    text(input.continuationGeneration); text(input.submittedHash); int(input.currentResetEpoch);
    CardStore.checkCursorInput(input.cursor);
    return this.tx<AdmitResult>(() => {
      const now = this.now();
      const final = this.finalDisposition(input.eventId);
      if (final !== undefined) return { kind: 'duplicate', recorded: final };
      this.checkCursorBoundary(input.scope, input.cursor);
      const changed = this.run(
        `UPDATE card_sessions SET status = 'admitted'
         WHERE session_id = ? AND status IN ('pending','retry_wait') AND expires_at > ? AND reset_epoch = ?`,
        input.sessionId, now, input.currentResetEpoch,
      );
      if (changed === 1) {
        const admissionId = this.newId();
        this.run(
          `INSERT INTO card_admissions
             (admission_id, session_id, event_id, continuation_generation, submitted_hash, state, admitted_at)
           VALUES (?, ?, ?, ?, ?, 'admitted', ?)`,
          admissionId, input.sessionId, input.eventId, input.continuationGeneration, input.submittedHash, now,
        );
        const attempts = this.get<{ attempt_no: number }>('SELECT attempt_no FROM card_event_attempts WHERE event_id = ?', input.eventId);
        this.insertDisposition(input, 'admitted', null, attempts?.attempt_no ?? 1, now);
        this.advanceCursor(input.cursor, now);
        return { kind: 'admitted', admissionId };
      }
      const s = this.get<SessionRow>('SELECT * FROM card_sessions WHERE session_id = ?', input.sessionId);
      let result: AdmitResult;
      let disposition: FinalDisposition;
      let sessionRef: string | null = input.sessionId;
      if (!s) {
        result = { kind: 'rejected', reason: 'unknown_session' };
        disposition = 'unknown';
        sessionRef = null;
      } else if ((s.status === 'pending' || s.status === 'retry_wait') && s.expires_at <= now) {
        result = { kind: 'expired' };
        disposition = 'expired';
      } else if ((s.status === 'pending' || s.status === 'retry_wait') && s.reset_epoch !== input.currentResetEpoch) {
        result = { kind: 'rejected', reason: 'reset_fenced' };
        disposition = 'rejected';
      } else {
        result = { kind: 'duplicate', recorded: s.status };
        disposition = 'duplicate';
      }
      this.insertDisposition({ ...input, sessionId: sessionRef }, disposition, null, 1, now);
      this.advanceCursor(input.cursor, now);
      return result;
    });
  }

  /** T3: actual settle of the continuation generation; idempotent. */
  settleAdmission(admissionId: string, outcome: 'completed' | 'failed'): SettleResult {
    text(admissionId);
    if (outcome !== 'completed' && outcome !== 'failed') throw new CardStoreError('invalid_input');
    return this.tx<SettleResult>(() => {
      const now = this.now();
      const a = this.get<AdmissionRow>('SELECT * FROM card_admissions WHERE admission_id = ?', admissionId);
      if (!a) return { kind: 'not_found' };
      if (a.state === 'completed' || a.state === 'failed') return { kind: 'already', state: a.state };
      this.run('UPDATE card_admissions SET state = ?, settled_at = ? WHERE admission_id = ?', outcome, now, admissionId);
      this.run(
        `UPDATE card_sessions SET status = ?, terminal_at = ?, retain_until = ? WHERE session_id = ? AND status IN ('admitted','ambiguous')`,
        outcome, now, now + RETENTION_MS, a.session_id,
      );
      return { kind: 'settled', state: outcome };
    });
  }

  /** Admitted work with no observed settle (timeout or restart) becomes ambiguous; never rerunnable. */
  markAdmissionAmbiguous(admissionId: string): AmbiguousResult {
    text(admissionId);
    return this.tx<AmbiguousResult>(() => {
      const a = this.get<AdmissionRow>('SELECT * FROM card_admissions WHERE admission_id = ?', admissionId);
      if (!a) return { kind: 'not_found' };
      if (a.state !== 'admitted') return { kind: 'already', state: a.state };
      this.run(`UPDATE card_admissions SET state = 'ambiguous' WHERE admission_id = ?`, admissionId);
      this.run(`UPDATE card_sessions SET status = 'ambiguous' WHERE session_id = ? AND status = 'admitted'`, a.session_id);
      return { kind: 'marked' };
    });
  }

  /**
   * `/reset` fence: terminalize older-epoch pending/retry sessions without
   * deleting evidence. Unresolved sends are fenced at T-bind by epoch.
   */
  fenceSessionKey(sessionKey: string, newResetEpoch: number): number {
    text(sessionKey);
    int(newResetEpoch);
    return this.tx(() => {
      const now = this.now();
      return this.run(
        `UPDATE card_sessions SET status = 'failed', terminal_at = ?, retain_until = ?
         WHERE session_key = ? AND reset_epoch < ? AND status IN ('pending','retry_wait')`,
        now, now + RETENTION_MS, sessionKey, newResetEpoch,
      );
    });
  }

  /**
   * T4: fixed-deadline expiry of pending/retry sessions, and of `sending`
   * sessions stranded by a crash between reservation and first transport,
   * which would otherwise hold active capacity forever. Ambiguous work is
   * never reclaimed. Returns cards owed a closure edit, i.e. those with an
   * acknowledged message identity; an expired stranded send has none.
   */
  expireSessions(): string[] {
    return this.tx(() => {
      const now = this.now();
      const rows = this.adapter
        .prepare(
          `SELECT s.session_id, s.card_id, m.message_id FROM card_sessions s JOIN card_messages m USING(card_id)
           WHERE s.status IN ('sending','pending','retry_wait') AND s.expires_at <= ?`,
        )
        .all(now) as Array<{ session_id: string; card_id: string; message_id: string | null }>;
      for (const r of rows) {
        this.run(
          `UPDATE card_sessions SET status = 'expired', terminal_at = ?, retain_until = ? WHERE session_id = ?`,
          now, now + RETENTION_MS, r.session_id,
        );
        this.run(
          `UPDATE card_messages SET state = 'expired', terminal_reason = 'expired', terminal_at = ?, retain_until = ?, updated_at = ?
           WHERE card_id = ? AND terminal_at IS NULL`,
          now, now + RETENTION_MS, now, r.card_id,
        );
      }
      return rows.filter((r) => r.message_id !== null).map((r) => r.card_id);
    });
  }

  /**
   * FK-safe child-first retention cleanup. Only definitively terminal facts
   * past `retain_until` are removed; ambiguous, admitted, charged/reserved or
   * otherwise unresolved records are never deleted to free capacity.
   */
  cleanup(): CleanupReport {
    return this.tx(() => {
      const now = this.now();
      const terminalSession = `s.status IN ('completed','failed','dead_letter','expired') AND s.retain_until < ${now}`;
      const attempts = this.run(
        `DELETE FROM card_event_attempts WHERE event_id IN (
           SELECT d.event_id FROM card_event_dispositions d WHERE d.retain_until < ?)`,
        now,
      );
      // Admitted dispositions leave together with their settled admission, and
      // only when no other retained event still pins the session, so the
      // session is pruned in the same pass and never outlives its admission.
      const admitted = this.adapter
        .prepare(
          `SELECT a.admission_id, a.event_id FROM card_admissions a
           JOIN card_sessions s USING(session_id)
           JOIN card_event_dispositions d ON d.event_id = a.event_id
           WHERE a.state IN ('completed','failed') AND ${terminalSession} AND d.retain_until < ?
             AND NOT EXISTS (SELECT 1 FROM card_event_dispositions d2
                             WHERE d2.session_id = a.session_id AND d2.event_id <> a.event_id)
             AND NOT EXISTS (SELECT 1 FROM card_event_attempts t
                             WHERE t.session_id = a.session_id AND t.event_id <> a.event_id)`,
        )
        .all(now) as Array<{ admission_id: string; event_id: string }>;
      for (const a of admitted) {
        this.run('DELETE FROM card_admissions WHERE admission_id = ?', a.admission_id);
        this.run('DELETE FROM card_event_dispositions WHERE event_id = ?', a.event_id);
      }
      const dispositions = admitted.length + this.run(
        `DELETE FROM card_event_dispositions AS d WHERE d.retain_until < ? AND d.disposition <> 'admitted'
           AND (d.session_id IS NULL OR EXISTS (SELECT 1 FROM card_sessions s WHERE s.session_id = d.session_id AND ${terminalSession}))`,
        now,
      );
      const requests = this.run(
        `DELETE FROM card_explicit_requests AS r WHERE
           (r.state IN ('acked','failed','cancelled'))
           AND EXISTS (SELECT 1 FROM card_handler_generations g WHERE g.generation = r.generation
                       AND g.state = 'closed' AND g.retain_until < ?)
           AND (r.card_id IS NULL OR EXISTS (SELECT 1 FROM card_messages m WHERE m.card_id = r.card_id
                       AND m.terminal_at IS NOT NULL AND m.retain_until < ?))
           AND (r.card_id IS NULL OR NOT EXISTS (SELECT 1 FROM card_sessions s WHERE s.card_id = r.card_id
                       AND NOT (${terminalSession})))`,
        now, now,
      );
      const sessions = this.run(
        `DELETE FROM card_sessions AS s WHERE ${terminalSession}
           AND NOT EXISTS (SELECT 1 FROM card_admissions a WHERE a.session_id = s.session_id)
           AND NOT EXISTS (SELECT 1 FROM card_event_dispositions d WHERE d.session_id = s.session_id)
           AND NOT EXISTS (SELECT 1 FROM card_event_attempts t WHERE t.session_id = s.session_id)`,
      );
      const messages = this.run(
        `DELETE FROM card_messages AS m WHERE m.terminal_at IS NOT NULL AND m.retain_until < ?
           AND NOT EXISTS (SELECT 1 FROM card_sessions s WHERE s.card_id = m.card_id)
           AND NOT EXISTS (SELECT 1 FROM card_explicit_requests r WHERE r.card_id = m.card_id)`,
        now,
      );
      const generations = this.run(
        `DELETE FROM card_handler_generations AS g WHERE g.state = 'closed' AND g.retain_until < ?
           AND NOT EXISTS (SELECT 1 FROM card_explicit_requests r WHERE r.generation = g.generation)`,
        now,
      );
      return {
        attempts,
        dispositions,
        admissions: admitted.length,
        requests,
        sessions,
        messages,
        generations,
      };
    });
  }

  // ── explicit-invocation ledger (§4.1a) ──

  private fenceCheck(f: HandlerFence, now: number): GenerationRow | HandlerRejection {
    const g = this.get<GenerationRow>('SELECT * FROM card_handler_generations WHERE generation = ?', f.generation);
    if (!g) return 'unknown_generation';
    if (g.state === 'closed') return 'closed';
    if (g.runtime_incarnation !== f.runtimeIncarnation) return 'incarnation_mismatch';
    if (g.reset_epoch !== f.resetEpoch) return 'reset_fenced';
    if (now >= g.expires_at) return 'expired';
    return g;
  }

  /** Mint a handler generation. Only the trusted inbound handler or an admitted continuation calls this. */
  registerHandler(input: RegisterHandlerInput): RegisterHandlerResult {
    text(input.generation); text(input.sessionKey); text(input.runtimeIncarnation);
    text(input.contextDigest); text(input.policyIdentity); int(input.resetEpoch); int(input.expiresAt);
    if (!isSafeStoreRef(input.installationRef)) throw new CardStoreError('invalid_input');
    return this.tx<RegisterHandlerResult>(() => {
      if (this.get('SELECT 1 FROM card_handler_generations WHERE generation = ?', input.generation)) {
        return { kind: 'generation_exists' };
      }
      this.run(
        `INSERT INTO card_handler_generations
           (generation, installation_ref, session_key, runtime_incarnation, reset_epoch, expires_at,
            context_digest, policy_identity, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
        input.generation, input.installationRef, input.sessionKey, input.runtimeIncarnation, input.resetEpoch,
        input.expiresAt, input.contextDigest, input.policyIdentity, this.now(),
      );
      return { kind: 'registered' };
    });
  }

  /** Close fence shared by every registration of the generation; idempotent. */
  closeHandler(generation: string): boolean {
    text(generation);
    return this.tx(() => {
      const now = this.now();
      return this.run(
        `UPDATE card_handler_generations SET state = 'closed', closed_at = ?, retain_until = ? WHERE generation = ? AND state = 'live'`,
        now, now + RETENTION_MS, generation,
      ) === 1;
    });
  }

  /**
   * Fence recheck plus `(generation, request_id, body digest)` deduplication.
   * A new id consumes one of 32 invocations even if later validation fails;
   * identical replay joins; changed-body reuse and closed authority never mutate.
   */
  chargeExplicitRequest(input: HandlerFence & { requestId: string; bodyDigest: string; opcode: ExplicitOpcode }): ChargeResult {
    text(input.generation); text(input.runtimeIncarnation); int(input.resetEpoch);
    text(input.requestId); text(input.bodyDigest);
    if (input.opcode !== 'display' && input.opcode !== 'interactive') throw new CardStoreError('invalid_input');
    return this.tx<ChargeResult>(() => {
      const now = this.now();
      const g = this.fenceCheck(input, now);
      if (typeof g === 'string') return { kind: 'rejected', reason: g };
      const existing = this.get<RequestRow>(
        'SELECT * FROM card_explicit_requests WHERE generation = ? AND request_id = ?',
        input.generation, input.requestId,
      );
      if (existing) {
        return existing.body_digest === input.bodyDigest && existing.opcode === input.opcode
          ? { kind: 'joined', request: toRequest(existing) }
          : { kind: 'body_mismatch' };
      }
      if (g.invocation_count >= MAX_EXPLICIT_INVOCATIONS) return { kind: 'exhausted' };
      this.run(
        `INSERT INTO card_explicit_requests (generation, request_id, body_digest, opcode, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'charged', ?, ?)`,
        input.generation, input.requestId, input.bodyDigest, input.opcode, now, now,
      );
      this.run(
        'UPDATE card_handler_generations SET invocation_count = invocation_count + 1 WHERE generation = ? AND invocation_count = ?',
        input.generation, g.invocation_count,
      );
      return { kind: 'charged', invocationCount: g.invocation_count + 1 };
    });
  }

  /**
   * Effect-admission linearization point: under the same generation fence,
   * reserve one of ten logical sends and its stable client identity, plus
   * T-reserve card/session insertion, in one transaction before transport.
   */
  reserveExplicitSend(input: HandlerFence & { requestId: string; card: ExplicitCard }): ReserveExplicitResult {
    text(input.generation); text(input.runtimeIncarnation); int(input.resetEpoch); text(input.requestId);
    const card = input.card;
    checkBinding(card.binding);
    text(card.bodyDigest);
    this.checkPresentation(card);
    if (card.opcode === 'interactive') this.checkContract(card.contract);
    else if (card.opcode !== 'display') throw new CardStoreError('invalid_input');
    return this.tx<ReserveExplicitResult>(() => {
      const now = this.now();
      const g = this.fenceCheck(input, now);
      if (typeof g === 'string') return { kind: 'rejected', reason: g };
      const req = this.get<RequestRow>(
        'SELECT * FROM card_explicit_requests WHERE generation = ? AND request_id = ?',
        input.generation, input.requestId,
      );
      if (!req) return { kind: 'not_found' };
      if (req.send_slot !== null) return { kind: 'already_reserved', request: toRequest(req) };
      if (req.state !== 'charged' || req.opcode !== card.opcode) return { kind: 'not_chargeable', state: req.state };
      if (g.logical_send_count >= MAX_EXPLICIT_SENDS) {
        this.finishCharged(req, EXHAUSTED_JSON, now);
        return { kind: 'exhausted' };
      }
      if (card.opcode === 'interactive' && this.activeSessionCount() >= this.capacity) {
        this.finishCharged(req, CAPACITY_FULL_JSON, now);
        return { kind: 'capacity_full' };
      }
      const slot = g.logical_send_count + 1;
      const clientMsgNo = this.newId();
      const cardId = this.insertMessage(card.opcode, card.binding, card.bodyDigest, clientMsgNo, card, now);
      if (cardId === null) throw new CardStoreError('storage_failure');
      const sessionId = card.opcode === 'interactive' ? this.insertSession(cardId, card.binding, card.contract, now).sessionId : null;
      this.run(
        `UPDATE card_handler_generations SET logical_send_count = logical_send_count + 1
         WHERE generation = ? AND logical_send_count = ?`,
        input.generation, g.logical_send_count,
      );
      this.run(
        `UPDATE card_explicit_requests SET state = 'reserved', send_slot = ?, client_msg_no = ?, card_id = ?, updated_at = ?
         WHERE generation = ? AND request_id = ? AND state = 'charged'`,
        slot, clientMsgNo, cardId, now, input.generation, input.requestId,
      );
      return { kind: 'reserved', slot, clientMsgNo, cardId, sessionId };
    });
  }

  private finishCharged(req: RequestRow, resultJson: string, now: number): void {
    this.run(
      `UPDATE card_explicit_requests SET state = 'failed', safe_result_json = ?, updated_at = ?
       WHERE generation = ? AND request_id = ? AND state = 'charged'`,
      resultJson, now, req.generation, req.request_id,
    );
  }

  /** Record a bounded safe outcome; optionally apply the card transition atomically. */
  finishExplicitRequest(input: FinishExplicitInput): FinishExplicitResult {
    text(input.generation); text(input.requestId);
    const resultJson = safeResult(input.safeResultJson);
    if (!['acked', 'failed', 'ambiguous', 'cancelled'].includes(input.outcome)) throw new CardStoreError('invalid_input');
    return this.tx<FinishExplicitResult>(() => {
      const now = this.now();
      const req = this.get<RequestRow>(
        'SELECT * FROM card_explicit_requests WHERE generation = ? AND request_id = ?',
        input.generation, input.requestId,
      );
      if (!req) return { kind: 'not_found' };
      if (req.state === input.outcome && (req.state === 'acked' || req.state === 'failed' || req.state === 'cancelled')) {
        return { kind: 'already', state: req.state };
      }
      const allowed: Record<ExplicitRequestState, readonly ExplicitFinish[]> = {
        charged: ['failed', 'cancelled'],
        reserved: ['acked', 'failed', 'ambiguous', 'cancelled'],
        ambiguous: ['acked', 'failed'],
        acked: [],
        failed: [],
        cancelled: [],
      };
      if (!allowed[req.state].includes(input.outcome)) return { kind: 'invalid_transition', from: req.state };
      if (input.outcome === 'acked' && input.message?.kind !== 'ack') return { kind: 'invalid_transition', from: req.state };
      if (req.state === 'reserved' && input.outcome === 'cancelled' && input.message?.kind !== 'abandoned') {
        return { kind: 'invalid_transition', from: req.state };
      }
      let ack: AckMessageResult | undefined;
      if (input.message && req.card_id !== null) {
        if (input.message.kind === 'ack') {
          if (input.outcome !== 'acked') return { kind: 'invalid_transition', from: req.state };
          ack = this.ackInTx(
            { cardId: req.card_id, messageId: text(input.message.messageId), currentResetEpoch: int(input.message.currentResetEpoch), policyAllows: input.message.policyAllows },
            now,
          );
          if (ack.kind !== 'bound') throw new Rollback<FinishExplicitResult>({ kind: 'card_transition_failed', detail: ack });
        } else {
          const r = this.sendOutcomeInTx(req.card_id, input.message.kind, now);
          if (r.kind !== 'updated') throw new Rollback<FinishExplicitResult>({ kind: 'card_transition_failed', detail: r });
        }
      } else if (input.message) {
        return { kind: 'invalid_transition', from: req.state };
      }
      this.run(
        `UPDATE card_explicit_requests SET state = ?, safe_result_json = ?, updated_at = ? WHERE generation = ? AND request_id = ?`,
        input.outcome, resultJson, now, input.generation, input.requestId,
      );
      return ack ? { kind: 'finished', ack } : { kind: 'finished' };
    });
  }

  /**
   * Startup ledger fence: close every live generation of an earlier runtime
   * incarnation before any tool registration. Charged/reserved/ambiguous
   * outcomes are preserved for lookup or quarantine, never resubmitted.
   */
  recoverExplicitLedger(currentIncarnation: string): LedgerRecovery {
    text(currentIncarnation);
    return this.tx<LedgerRecovery>(() => {
      const now = this.now();
      const closedGenerations = this.run(
        `UPDATE card_handler_generations SET state = 'closed', closed_at = ?, retain_until = ?
         WHERE state = 'live' AND runtime_incarnation <> ?`,
        now, now + RETENTION_MS, currentIncarnation,
      );
      const unresolved = (this.adapter
        .prepare(
          `SELECT generation, request_id, state FROM card_explicit_requests
           WHERE state IN ('charged','reserved','ambiguous') AND safe_result_json IS NULL
           ORDER BY generation, request_id`,
        )
        .all() as Array<{ generation: string; request_id: string; state: ExplicitRequestState }>)
        .map((r) => ({ generation: r.generation, requestId: r.request_id, state: r.state }));
      const violations = checkCardInvariants(this.adapter).filter((v) => v !== 'integrity_check');
      return { closedGenerations, unresolved, violations };
    });
  }

  // ── reads ──

  getMessage(cardId: string): CardMessageRecord | null {
    return this.read(() => {
      const r = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
      return r ? toMessage(r) : null;
    });
  }

  /** Admission lookup requires the exact acknowledged identity. */
  findSessionByMessageId(messageId: string): CardSessionRecord | null {
    return this.read(() => {
      const r = this.get<SessionRow>(
        `SELECT s.* FROM card_sessions s JOIN card_messages m USING(card_id) WHERE m.message_id = ?`,
        messageId,
      );
      return r ? toSession(r) : null;
    });
  }

  getSession(sessionId: string): CardSessionRecord | null {
    return this.read(() => {
      const r = this.get<SessionRow>('SELECT * FROM card_sessions WHERE session_id = ?', sessionId);
      return r ? toSession(r) : null;
    });
  }

  getAdmissionForSession(sessionId: string): CardAdmissionRecord | null {
    return this.read(() => {
      const r = this.get<AdmissionRow>('SELECT * FROM card_admissions WHERE session_id = ?', sessionId);
      return r ? toAdmission(r) : null;
    });
  }

  getDisposition(eventId: string): FinalDisposition | null {
    return this.read(() => this.finalDisposition(eventId) ?? null);
  }

  getHandler(generation: string): HandlerGenerationRecord | null {
    return this.read(() => {
      const r = this.get<GenerationRow>('SELECT * FROM card_handler_generations WHERE generation = ?', generation);
      return r ? toGeneration(r) : null;
    });
  }

  getExplicitRequest(generation: string, requestId: string): ExplicitRequestRecord | null {
    return this.read(() => {
      const r = this.get<RequestRow>(
        'SELECT * FROM card_explicit_requests WHERE generation = ? AND request_id = ?',
        generation, requestId,
      );
      return r ? toRequest(r) : null;
    });
  }

  activeSessions(): number {
    return this.read(() => this.activeSessionCount());
  }

  checkInvariants(): InvariantViolation[] {
    return this.read(() => checkCardInvariants(this.adapter));
  }
}

// ─── Protected graph snapshot and restore comparison ────────────────────────

export interface ProtectedGraphManifest {
  readonly schemaHash: string;
  readonly lineageId: string | null;
  readonly tables: Readonly<Record<CardTable, { readonly rows: number; readonly sha256: string }>>;
  readonly sha256: string;
}

const TABLE_KEYS: Readonly<Record<CardTable, readonly string[]>> = {
  card_meta: ['k'],
  card_messages: ['card_id'],
  card_sessions: ['session_id'],
  card_admissions: ['admission_id'],
  card_event_dispositions: ['event_id'],
  card_event_attempts: ['event_id'],
  card_event_cursor: ['consumer_scope'],
  card_handler_generations: ['generation'],
  card_explicit_requests: ['generation', 'request_id'],
};

export type ProtectedGraphRows = Readonly<Record<CardTable, ReadonlyArray<Readonly<Record<string, unknown>>>>>;

function canonical(row: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));
}

/** Read every card table in primary-key order. */
export function readProtectedGraph(adapter: DbAdapter): ProtectedGraphRows {
  const out = {} as Record<CardTable, Array<Record<string, unknown>>>;
  for (const table of CARD_TABLES) {
    out[table] = adapter.prepare(`SELECT * FROM ${table} ORDER BY ${TABLE_KEYS[table].join(', ')}`).all() as Array<Record<string, unknown>>;
  }
  return out;
}

export function manifestProtectedGraph(rows: ProtectedGraphRows): ProtectedGraphManifest {
  const tables = {} as Record<CardTable, { rows: number; sha256: string }>;
  const all = createHash('sha256');
  for (const table of CARD_TABLES) {
    const h = createHash('sha256');
    for (const r of rows[table]) h.update(`${canonical(r)}\n`);
    tables[table] = { rows: rows[table].length, sha256: h.digest('hex') };
    all.update(`${table}:${tables[table].rows}:${tables[table].sha256}\n`);
  }
  const lineage = rows.card_meta.find((r) => r.k === 'lineage_id');
  return {
    schemaHash: referenceSchema().hash,
    lineageId: typeof lineage?.v === 'string' ? lineage.v : null,
    tables,
    sha256: all.digest('hex'),
  };
}

export type RestoreConflictCode =
  | 'lineage_mismatch'
  | 'missing_fact'
  | 'conflicting_fact'
  | 'sequence_regression'
  | 'counter_regression'
  | 'halt_lost'
  | 'cursor_regression'
  | 'revived_work';

export interface RestoreConflict {
  readonly table: CardTable;
  readonly key: string;
  readonly code: RestoreConflictCode;
}

const IMMUTABLE_FIELDS: Readonly<Partial<Record<CardTable, readonly string[]>>> = {
  card_messages: ['kind', 'session_key', 'channel_id', 'channel_type', 'generation', 'topic_scope', 'reset_epoch', 'body_digest', 'client_msg_no'],
  card_sessions: ['card_id', 'requester_uid', 'session_key', 'channel_id', 'channel_type', 'origin_generation', 'topic_scope', 'reset_epoch', 'contract_version', 'authored_contract_json', 'authored_data_hash', 'expires_at', 'created_at'],
  card_admissions: ['session_id', 'event_id', 'continuation_generation', 'submitted_hash', 'admitted_at'],
  card_event_dispositions: ['consumer_scope', 'event_class', 'session_id', 'disposition', 'reason_code', 'attempts', 'created_at'],
  card_handler_generations: ['installation_ref', 'session_key', 'runtime_incarnation', 'reset_epoch', 'context_digest', 'policy_identity'],
  card_explicit_requests: ['body_digest', 'opcode'],
};

/** Fields that are written once: a tail value is binding, a tail null may be filled in. */
const SET_ONCE_FIELDS: Readonly<Partial<Record<CardTable, readonly string[]>>> = {
  card_explicit_requests: ['send_slot', 'client_msg_no', 'card_id'],
};

const TERMINAL_MESSAGE = new Set(['done', 'error', 'expired', 'abandoned']);
/** Admission progress: admitted -> ambiguous -> completed|failed (rank 2, absorbing). */
const ADMISSION_RANK: Readonly<Record<string, number>> = {
  admitted: 0, ambiguous: 1, completed: 2, failed: 2,
};
/**
 * Session progress. `ambiguous` has two meanings: after an admission it sits
 * between admitted and terminal; without one it is an unconfirmed initial send
 * that T-bind may still legitimately reconcile to pending.
 */
function sessionRank(status: unknown, hasAdmission: boolean): number {
  switch (status) {
    case 'sending': return 0;
    case 'ambiguous': return hasAdmission ? 3 : 0.5;
    case 'pending':
    case 'retry_wait': return 1;
    case 'admitted': return 2;
    case 'completed':
    case 'failed':
    case 'dead_letter':
    case 'expired': return 4;
    default: return -1;
  }
}
/** Explicit request progress; acked/failed/cancelled are absorbing (rank 3). */
const REQUEST_RANK: Readonly<Record<string, number>> = {
  charged: 0, reserved: 1, ambiguous: 2, acked: 3, failed: 3, cancelled: 3,
};

/**
 * Compare a candidate restore image against the protected tail. Fences and
 * final facts are constraints, never "newer timestamp wins": any lost or
 * contradicting fact quarantines the restore.
 */
export function compareProtectedGraph(candidate: ProtectedGraphRows, tail: ProtectedGraphRows): RestoreConflict[] {
  const out: RestoreConflict[] = [];
  const keyOf = (table: CardTable, r: Readonly<Record<string, unknown>>): string =>
    TABLE_KEYS[table].map((k) => String(r[k])).join('/');
  const lineage = (rows: ProtectedGraphRows): unknown => rows.card_meta.find((r) => r.k === 'lineage_id')?.v;
  if (lineage(candidate) !== lineage(tail)) out.push({ table: 'card_meta', key: 'lineage_id', code: 'lineage_mismatch' });
  const admittedSessions = (rows: ProtectedGraphRows): Set<unknown> => new Set(rows.card_admissions.map((r) => r.session_id));
  const candAdmitted = admittedSessions(candidate);
  const tailAdmitted = admittedSessions(tail);

  for (const table of CARD_TABLES) {
    if (table === 'card_meta') continue;
    const cand = new Map(candidate[table].map((r) => [keyOf(table, r), r]));
    for (const t of tail[table]) {
      const key = keyOf(table, t);
      const c = cand.get(key);
      if (!c) {
        out.push({ table, key, code: 'missing_fact' });
        continue;
      }
      const immutable = (IMMUTABLE_FIELDS[table] ?? []).some((f) => c[f] !== t[f]);
      const setOnce = (SET_ONCE_FIELDS[table] ?? []).some((f) => t[f] !== null && c[f] !== t[f]);
      if (immutable || setOnce) out.push({ table, key, code: 'conflicting_fact' });
      const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
      if (table === 'card_messages') {
        if (num(c.seq_reserved) < num(t.seq_reserved) || num(c.seq_acked) < num(t.seq_acked)) {
          out.push({ table, key, code: 'sequence_regression' });
        }
        if (t.message_id !== null && c.message_id !== t.message_id) out.push({ table, key, code: 'conflicting_fact' });
        if (t.terminal_at !== null && c.terminal_at === null) out.push({ table, key, code: 'revived_work' });
        // Absorbing terminal outcomes are final facts: a different terminal outcome contradicts.
        if (TERMINAL_MESSAGE.has(String(t.state)) && TERMINAL_MESSAGE.has(String(c.state))
            && (c.state !== t.state || c.terminal_reason !== t.terminal_reason)) {
          out.push({ table, key, code: 'conflicting_fact' });
        }
      }
      if (table === 'card_sessions') {
        const tr = sessionRank(t.status, tailAdmitted.has(t.session_id));
        const cr = sessionRank(c.status, candAdmitted.has(c.session_id));
        if (cr < tr) out.push({ table, key, code: 'revived_work' });
        else if (tr === 4 && c.status !== t.status) out.push({ table, key, code: 'conflicting_fact' });
      }
      if (table === 'card_admissions') {
        const tr = ADMISSION_RANK[String(t.state)] ?? -1;
        const cr = ADMISSION_RANK[String(c.state)] ?? -1;
        if (cr < tr) out.push({ table, key, code: 'revived_work' });
        else if (tr === 2 && c.state !== t.state) out.push({ table, key, code: 'conflicting_fact' });
      }
      if (table === 'card_handler_generations') {
        if (num(c.invocation_count) < num(t.invocation_count) || num(c.logical_send_count) < num(t.logical_send_count)) {
          out.push({ table, key, code: 'counter_regression' });
        }
        if (t.state === 'closed' && c.state !== 'closed') out.push({ table, key, code: 'revived_work' });
      }
      if (table === 'card_explicit_requests') {
        const tr = REQUEST_RANK[String(t.state)] ?? -1;
        const cr = REQUEST_RANK[String(c.state)] ?? -1;
        if (cr < tr) out.push({ table, key, code: 'revived_work' });
        else if (tr === 3 && (c.state !== t.state || c.safe_result_json !== t.safe_result_json)) {
          out.push({ table, key, code: 'conflicting_fact' });
        }
      }
      if (table === 'card_event_cursor') {
        if (t.halted_reason !== null && c.halted_reason === null) out.push({ table, key, code: 'halt_lost' });
        if (t.cursor !== c.cursor) out.push({ table, key, code: 'cursor_regression' });
      }
    }
  }
  return out;
}

// ─── Startup and provenance (§4.3) ──────────────────────────────────────────

export type CardStoreDisabledReason =
  | 'provenance_missing'
  | 'provenance_invalid'
  | 'installation_mismatch'
  | 'prior_active_store_missing'
  | 'provenance_conflict'
  | 'lineage_mismatch'
  | 'partial_schema'
  | 'unknown_schema'
  | 'newer_schema'
  | 'integrity_failed'
  | 'invariant_failed'
  | 'backup_failed'
  | 'migration_failed'
  | 'marker_write_failed'
  | 'invalid_options';

export interface CardStoreInitOptions extends CardStoreOptions {
  readonly adapter: DbAdapter;
  readonly marker: ActivationMarkerPort;
  readonly installationRef: string;
  /** Directory for the pre-migration online backup (0700). */
  readonly backupDir: string;
  readonly newLineageId?: () => string;
}

export type CardStoreInit =
  | {
      readonly state: 'ready';
      readonly store: CardStore;
      readonly meta: CardMeta;
      readonly provenance: 'first_install' | 'reopened' | 'activation_reconciled';
      readonly backup?: BackupReceipt;
    }
  | { readonly state: 'disabled'; readonly reason: CardStoreDisabledReason; readonly violations?: readonly InvariantViolation[] };

/**
 * Run after ordinary store initialization and before any card consumer. Never
 * throws: every failure disables cards and leaves ordinary chat available.
 * Nothing is initialized over lost ownership or unknown provenance.
 */
export async function initializeCardStore(options: CardStoreInitOptions): Promise<CardStoreInit> {
  const disabled = (reason: CardStoreDisabledReason, violations?: readonly InvariantViolation[]): CardStoreInit =>
    violations ? { state: 'disabled', reason, violations } : { state: 'disabled', reason };
  const { adapter, marker, installationRef } = options;
  if (!isSafeStoreRef(installationRef)) return disabled('provenance_invalid');

  // Validate every option before any read or write so invalid configuration
  // resolves disabled with the DB, marker and backup directory untouched.
  let store: CardStore;
  let nowMs: number;
  let lineageId: string;
  try {
    store = new CardStore(adapter, options);
    nowMs = options.clock.nowUtcMs();
    lineageId = (options.newLineageId ?? randomUUID)();
  } catch {
    return disabled('invalid_options');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !isSafeStoreRef(lineageId)) return disabled('invalid_options');

  let read;
  try {
    read = marker.read();
  } catch {
    return disabled('provenance_invalid');
  }
  if (read.state === 'absent') return disabled('provenance_missing');
  if (read.state === 'invalid') return disabled('provenance_invalid');
  const m = read.marker;
  if (m.installationRef !== installationRef) return disabled('installation_mismatch');
  if (m.schemaFamily !== null && m.schemaFamily !== 'card_v1') return disabled('newer_schema');

  let inspected;
  try {
    inspected = inspectCardSchema(adapter);
  } catch {
    return disabled('integrity_failed');
  }
  if (inspected.state === 'partial') return disabled('partial_schema');
  if (inspected.state === 'unknown') return disabled('unknown_schema');
  if (inspected.state === 'newer') return disabled('newer_schema');

  const validate = (): InvariantViolation[] | null => {
    try {
      const v = checkCardInvariants(adapter);
      return v.length > 0 ? v : null;
    } catch {
      return ['integrity_check'];
    }
  };
  const ready = (meta: CardMeta, provenance: 'first_install' | 'reopened' | 'activation_reconciled', backup?: BackupReceipt): CardStoreInit => {
    return backup ? { state: 'ready', store, meta, provenance, backup } : { state: 'ready', store, meta, provenance };
  };
  const activate = (lineageId: string, backupRef: string | null, nowMs: number): boolean => {
    try {
      marker.write({
        installationRef,
        everActivated: true,
        schemaFamily: 'card_v1',
        lineageId,
        backupRef,
        recoveryClearanceRef: m.recoveryClearanceRef,
        updatedAt: nowMs,
      });
      return true;
    } catch {
      return false;
    }
  };

  if (inspected.state === 'complete') {
    if (inspected.meta.installationRef !== installationRef) return disabled('installation_mismatch');
    const violations = validate();
    if (violations) return disabled(violations.includes('integrity_check') ? 'integrity_failed' : 'invariant_failed', violations);
    if (m.everActivated) {
      if (m.lineageId !== inspected.meta.lineageId) return disabled('lineage_mismatch');
      return ready(inspected.meta, 'reopened');
    }
    // DB committed but the marker fsync never happened. No card effect can
    // precede activation, so only an empty graph is reconciled forward.
    let rows: number;
    try {
      rows = countProtectedRows(adapter);
    } catch {
      return disabled('integrity_failed');
    }
    if (rows !== 0) return disabled('provenance_conflict');
    if (!activate(inspected.meta.lineageId, m.backupRef, nowMs)) return disabled('marker_write_failed');
    return ready(inspected.meta, 'activation_reconciled');
  }

  // No card objects in the database.
  if (m.everActivated) return disabled('prior_active_store_missing');

  let backup: BackupReceipt;
  try {
    backup = await backupBeforeMigration(adapter, options.backupDir, nowMs);
  } catch {
    return disabled('backup_failed');
  }
  let meta: CardMeta;
  try {
    // Re-inspect after the await: nothing may have created card objects meanwhile.
    if (inspectCardSchema(adapter).state !== 'absent') return disabled('provenance_conflict');
    meta = migrateCardSchema(adapter, {
      installationRef,
      lineageId,
      nowMs,
    });
  } catch {
    return disabled('migration_failed');
  }
  const violations = validate();
  if (violations) return disabled('invariant_failed', violations);
  if (!activate(meta.lineageId, backup.fileName, nowMs)) return disabled('marker_write_failed');
  return ready(meta, 'first_install', backup);
}
