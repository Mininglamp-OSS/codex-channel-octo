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
  EVENT_SCOPE_PREFIX,
  INTENT_LEGACY_KEY,
  LEGACY_IDS_SQL,
  RETENTION_MS,
  SESSION_TTL_MS,
  UPGRADE_V2_BACKUP_LABEL,
  UPGRADE_V3_BACKUP_LABEL,
  UPGRADE_V4_BACKUP_LABEL,
  backupBeforeMigration,
  checkCardInvariants,
  countProtectedRows,
  inspectCardSchema,
  isSafeStoreRef,
  migrateCardSchema,
  referenceSchema,
  serializeActivationMarker,
  upgradeCardSchemaV1toV2,
  upgradeCardSchemaV2toV3,
  upgradeCardSchemaV3toV4,
  cardTablesFor,
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

export type CardStoreErrorCode = 'storage_failure' | 'nested_transaction' | 'async_transaction' | 'invalid_input' | 'closed' | 'scope_conflict';

/**
 * Card rows whose edit sequence fences may still move: bound to a message and
 * not in an absorbing terminal state ('done', 'error', 'expired', 'abandoned').
 */
const SEQUENCE_WRITABLE = "message_id IS NOT NULL AND state NOT IN ('done','error','expired','abandoned')";

/** Not a legacy automatic card recorded by the version 2 upgrade (DTI-2.1 §2.2). */
const NOT_LEGACY = `card_id NOT IN (${LEGACY_IDS_SQL})`;

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
  /** Recorded terminal outcome; `null` while the row is live. */
  readonly terminalReason: CardTerminalReason | null;
  /** Durable terminal intent of a live automatic card; `null` once terminal or without intent. */
  readonly terminalIntent: CardTerminalReason | null;
  readonly templateId: string | null;
  readonly templateVersion: string | null;
  readonly profile: string | null;
  readonly pinnedLimitsJson: string | null;
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
  /** `app_server` when the app-server dispatcher finished the row (SC-1). */
  readonly settledBy: 'app_server' | null;
  /** Late transport outcome after an app-server `ambiguous` settlement; audit only. */
  readonly lateOutcome: 'acked' | 'failed' | null;
  readonly lateMessageId: string | null;
  readonly lateAt: number | null;
}

// ─── Store options ──────────────────────────────────────────────────────────

export interface CardStoreOptions {
  readonly clock: WallClock;
  /** Opaque identifier factory for card/session/admission/client ids. */
  readonly newId?: () => string;
  /** Active interactive session capacity (T-reserve). */
  readonly sessionCapacity?: number;
  /** Trusted independent source/restore authority. Never supplied by an event or cleanup request. */
  readonly retirementVerifier?: RetirementVerifier;
}

/** Authenticated evidence, obtained independently of the party requesting cleanup. */
export interface RetirementWitness {
  readonly installationRef: string;
  readonly lineageId: string;
  readonly protectedGraphSha256: string;
  readonly identity: AttemptStartInput | SettingsEventIdentity;
  readonly outcome: FinalDisposition | 'invalidated';
  readonly createdAt: number;
  readonly retainUntil: number;
  readonly topology: CursorTopology;
  readonly confirmedPosition: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Opaque, independently checked fences; elapsed time/ACK alone cannot mint them. */
  readonly sourceFence: string;
  readonly restoreFence: string;
  readonly ownerFence: string;
  readonly replayExcluded: true;
  readonly restoreExcluded: true;
  readonly activeOwnersExcluded: true;
}

export interface RetirementVerifier {
  /** Synchronous current authentication of source, restore and owner fences; undefined means retain. */
  verify(reference: string): RetirementWitness | undefined;
}

// ─── Row mapping ────────────────────────────────────────────────────────────

interface MessageRow {
  card_id: string; kind: CardKind; session_key: string; channel_id: string; channel_type: number;
  generation: string; topic_scope: string | null; reset_epoch: number; body_digest: string;
  client_msg_no: string; message_id: string | null; template_id: string | null; template_version: string | null;
  profile: string | null; pinned_limits_json: string | null; seq_reserved: number; seq_acked: number;
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
  settled_by: 'app_server' | null; late_outcome: 'acked' | 'failed' | null; late_message_id: string | null; late_at: number | null;
}

function toMessage(r: MessageRow): CardMessageRecord {
  return {
    cardId: r.card_id, kind: r.kind, sessionKey: r.session_key, channelId: r.channel_id,
    channelType: r.channel_type, generation: r.generation, topicScope: r.topic_scope,
    resetEpoch: r.reset_epoch, bodyDigest: r.body_digest, clientMsgNo: r.client_msg_no,
    messageId: r.message_id, seqReserved: r.seq_reserved, seqAcked: r.seq_acked, state: r.state,
    terminalReason: r.terminal_at === null ? null : r.terminal_reason,
    terminalIntent: r.terminal_at === null ? r.terminal_reason : null,
    templateId: r.template_id, templateVersion: r.template_version, profile: r.profile,
    pinnedLimitsJson: r.pinned_limits_json, createdAt: r.created_at, terminalAt: r.terminal_at,
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
    safeResultJson: r.safe_result_json, settledBy: r.settled_by, lateOutcome: r.late_outcome,
    lateMessageId: r.late_message_id, lateAt: r.late_at,
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

export type MarkTerminalResult =
  | { readonly kind: 'updated' }
  /** The same terminal outcome is already recorded; nothing changed. */
  | { readonly kind: 'already_terminal' }
  | { readonly kind: 'not_found' }
  /** Not an acknowledged live automatic card, or a different terminal outcome is recorded; nothing changed. */
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

/** Terminal reasons an automatic card can record; `expired` belongs to interactive cards. */
const AUTOMATIC_TERMINAL_REASONS: ReadonlySet<string> = new Set<CardTerminalReason>(['completed', 'failed', 'interrupted', 'timed_out', 'policy_revoked']);

export type ReserveSequenceResult =
  | { readonly kind: 'reserved'; readonly seq: number }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

export type ReserveTerminalResult =
  | { readonly kind: 'reserved'; readonly seq: number }
  /** A durable intent is already recorded; nothing was written. */
  | { readonly kind: 'intent_exists'; readonly reason: CardTerminalReason; readonly seq: number }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly state: CardMessageState };

/** A live, bound automatic card as seen by startup recovery. */
export interface LiveAutomaticCard {
  readonly record: CardMessageRecord;
  /** Written before durable intent existed (version 2 `intent_legacy`). */
  readonly legacy: boolean;
}

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

export interface SettingsEventIdentity {
  readonly eventId: string;
  readonly scope: string;
  readonly eventClass: 'bot_setting_updated';
  readonly settingsScope: 'bot_setting';
  readonly positionRef: string;
  readonly previousPositionRef: string | null;
  readonly envelopeDigest: string;
}

export type EventReplay =
  | { readonly kind: 'absent' }
  | { readonly kind: 'inconsistent'; readonly code: 'missing_identity' | 'ledger_conflict' | 'identity_conflict' }
  | { readonly kind: 'retained'; readonly identity: AttemptStartInput | SettingsEventIdentity;
      readonly attempt?: { readonly number: number; readonly phase: AttemptRow['phase']; readonly nextEligibleAt: number | null };
      readonly final?: { readonly outcome: FinalDisposition | 'invalidated'; readonly createdAt: number; readonly retainUntil: number } };

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
  | { readonly kind: 'conflict' }
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
  | { readonly kind: 'conflict' }
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
  | ({ readonly opcode: 'display'; readonly informational?: false; readonly binding: CardBinding; readonly bodyDigest: string } & CardPresentation)
  | ({ readonly opcode: 'interactive'; readonly informational?: false; readonly binding: CardBinding; readonly bodyDigest: string; readonly contract: SessionContract } & CardPresentation)
  | ({ readonly opcode: 'interactive'; readonly informational: true; readonly binding: CardBinding; readonly bodyDigest: string;
      readonly plain: string; readonly reason: 'profile_unavailable' | 'profile_incompatible' } & CardPresentation);

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
  /**
   * `app_server`: finished by the app-server dispatcher. Recorded on the row;
   * an `ambiguous` row so marked never accepts a later `acked`/`failed`
   * (SC-1a) — late outcomes go to {@link CardStore.recordLateExplicitOutcome}.
   */
  readonly settledBy?: 'app_server';
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

export interface LateExplicitOutcomeInput {
  readonly generation: string;
  readonly requestId: string;
  readonly outcome: 'acked' | 'failed';
  /**
   * For `acked`: the acknowledged identity, bound to the card through the
   * existing T-bind with the current reset epoch and a fresh policy decision
   * (SC-1b). The request row, its safe result and the budgets never change.
   */
  readonly ack?: { readonly messageId: string; readonly currentResetEpoch: number; readonly policyAllows: boolean };
}

export type LateExplicitOutcomeResult =
  | { readonly kind: 'recorded'; readonly ack?: AckMessageResult }
  | { readonly kind: 'already' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_applicable'; readonly state: ExplicitRequestState; readonly settledBy: 'app_server' | null };

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
  private readonly optionsRetirementVerifier: RetirementVerifier | undefined;
  private closed = false;

  constructor(
    private readonly adapter: DbAdapter,
    options: CardStoreOptions,
  ) {
    this.clock = options.clock;
    this.newId = options.newId ?? randomUUID;
    this.capacity = options.sessionCapacity ?? ACTIVE_SESSION_CAPACITY;
    this.optionsRetirementVerifier = options.retirementVerifier;
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
   * Record the acknowledged terminal of an automatic card: `completed` →
   * `done`, any other automatic reason → `error`, with the existing
   * retention. Only a bound live automatic card (`active`/`answering`) moves.
   * The same outcome again is idempotent; a different recorded outcome is
   * absorbing and nothing is written. Sending/ambiguous rows are refused, so
   * N2 suspension is never lifted here. A row with a durable intent moves
   * only to that intent's reason and only once its terminal sequence is
   * acknowledged (I3/I4).
   */
  markTerminal(cardId: string, reason: CardTerminalReason): MarkTerminalResult {
    text(cardId);
    if (typeof reason !== 'string' || !AUTOMATIC_TERMINAL_REASONS.has(reason)) throw new CardStoreError('invalid_input');
    const target = reason === 'completed' ? 'done' : 'error';
    return this.tx<MarkTerminalResult>(() => {
      const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
      if (!msg) return { kind: 'not_found' };
      // Only a bound automatic card: a send-failed or unsent row never had a terminal edit.
      if (msg.kind !== 'automatic' || msg.message_id === null) return { kind: 'invalid_state', state: msg.state };
      if (msg.state === 'done' || msg.state === 'error') {
        return msg.state === target && msg.terminal_reason === reason ? { kind: 'already_terminal' } : { kind: 'invalid_state', state: msg.state };
      }
      if (msg.state !== 'active' && msg.state !== 'answering') return { kind: 'invalid_state', state: msg.state };
      if (msg.terminal_reason !== null && (msg.terminal_reason !== reason || msg.seq_acked !== msg.seq_reserved)) {
        return { kind: 'invalid_state', state: msg.state };
      }
      const now = this.now();
      const changed = this.run(
        `UPDATE card_messages SET state = ?, terminal_reason = ?, terminal_at = ?, retain_until = ?, updated_at = ?
         WHERE card_id = ? AND state IN ('active','answering')
           AND (terminal_reason IS NULL OR (terminal_reason = ? AND seq_acked = seq_reserved))`,
        target, reason, now, now + RETENTION_MS, now, cardId, reason,
      );
      if (changed === 0) return { kind: 'invalid_state', state: msg.state };
      return { kind: 'updated' };
    });
  }

  /**
   * Reserve the next edit sequence before the edit is sent. Only a bound,
   * non-terminal card can reserve: the guard is part of the UPDATE predicate,
   * so a terminal transition can never be followed by a sequence change. A
   * card with a durable terminal intent never reserves again (I2), and a
   * legacy automatic card is frozen.
   */
  reserveSequence(cardId: string): ReserveSequenceResult {
    text(cardId);
    return this.tx(() => {
      const changed = this.run(
        `UPDATE card_messages SET seq_reserved = seq_reserved + 1, updated_at = ?
         WHERE card_id = ? AND ${SEQUENCE_WRITABLE} AND terminal_reason IS NULL AND ${NOT_LEGACY}`,
        this.now(), cardId,
      );
      const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
      if (!msg) return { kind: 'not_found' };
      if (changed === 0) return { kind: 'invalid_state', state: msg.state };
      return { kind: 'reserved', seq: msg.seq_reserved };
    });
  }

  /**
   * Reserve the terminal edit sequence of a live automatic card and record
   * its terminal intent in the same transaction, before any transport (I1).
   * The intent is absorbing (I3): a repeat writes nothing and reports the
   * recorded intent. Legacy, unbound, sending/ambiguous, terminal and
   * non-automatic rows are refused.
   */
  reserveTerminalSequence(cardId: string, reason: CardTerminalReason): ReserveTerminalResult {
    text(cardId);
    if (typeof reason !== 'string' || !AUTOMATIC_TERMINAL_REASONS.has(reason)) throw new CardStoreError('invalid_input');
    return this.tx<ReserveTerminalResult>(() => {
      const changed = this.run(
        `UPDATE card_messages SET seq_reserved = seq_reserved + 1, terminal_reason = ?, updated_at = ?
         WHERE card_id = ? AND kind = 'automatic' AND state IN ('active','answering')
           AND message_id IS NOT NULL AND terminal_at IS NULL AND terminal_reason IS NULL AND ${NOT_LEGACY}`,
        reason, this.now(), cardId,
      );
      const msg = this.get<MessageRow>('SELECT * FROM card_messages WHERE card_id = ?', cardId);
      if (!msg) return { kind: 'not_found' };
      if (changed === 1) return { kind: 'reserved', seq: msg.seq_reserved };
      if (msg.terminal_at === null && msg.terminal_reason !== null) {
        return { kind: 'intent_exists', reason: msg.terminal_reason, seq: msg.seq_reserved };
      }
      return { kind: 'invalid_state', state: msg.state };
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
      // One Bot store cannot silently open a new proof stream/environment/Bot
      // namespace over retained replay/ACK/halt facts. Reconciliation is external.
      if (scope.startsWith(EVENT_SCOPE_PREFIX) && this.get(
        `SELECT 1 FROM card_event_cursor WHERE substr(consumer_scope, 1, ?) = ? AND consumer_scope <> ? LIMIT 1`,
        EVENT_SCOPE_PREFIX.length, EVENT_SCOPE_PREFIX, scope,
      )) throw new CardStoreError('scope_conflict');
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
      if (!row || row.halted_reason !== null || row.cursor !== position) return false;
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
      if (!this.actionIdentityCompatible(input)) return { kind: 'conflict' };
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
      if (!this.actionIdentityCompatible(input)) return { kind: 'conflict' };
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
      if (!this.actionIdentityCompatible(input)) return { kind: 'conflict' };
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
      if (!this.actionIdentityCompatible(input)) return { kind: 'conflict' };
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
   * T4: fixed-deadline expiry of bound pending/retry sessions. Unresolved
   * initial sends retain ownership and N2 suspension regardless of age.
   * Returns acknowledged cards owed a best-effort closure edit.
   */
  expireSessions(): string[] {
    return this.tx(() => {
      const now = this.now();
      const rows = this.adapter
        .prepare(
          `SELECT s.session_id, s.card_id, m.message_id FROM card_sessions s JOIN card_messages m USING(card_id)
           WHERE s.status IN ('pending','retry_wait') AND s.expires_at <= ?
             AND m.message_id IS NOT NULL AND m.state NOT IN ('sending','ambiguous')`,
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
  cleanup(retirementReferences: readonly string[] = []): CleanupReport {
    if (!Array.isArray(retirementReferences) || retirementReferences.length > 1000) throw new CardStoreError('invalid_input');
    retirementReferences.forEach(ref => text(ref));
    return this.tx(() => {
      const now = this.now();
      const proven = this.retireProvenEvents(retirementReferences, now);
      const terminalSession = `s.status IN ('completed','failed','dead_letter','expired') AND s.retain_until < ${now}`;
      // No durable source replay/restore retirement proof exists yet. Keep all
      // replay identities and their finals, including confirmed older events;
      // timestamps and lexical cursor comparisons cannot establish safe pruning.
      const attempts = proven.attempts;
      // Admitted dispositions leave together with their settled admission, and
      // only when no other retained event still pins the session, so the
      // session is pruned in the same pass and never outlives its admission.
      const admitted = this.adapter
        .prepare(
          `SELECT a.admission_id, a.event_id FROM card_admissions a
           JOIN card_sessions s USING(session_id)
           JOIN card_event_dispositions d ON d.event_id = a.event_id
           WHERE a.state IN ('completed','failed') AND ${terminalSession} AND d.retain_until < ?
             AND substr(d.consumer_scope, 1, ${EVENT_SCOPE_PREFIX.length}) <> '${EVENT_SCOPE_PREFIX}'
             AND NOT EXISTS (SELECT 1 FROM card_event_attempts t WHERE t.event_id = a.event_id)
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
      const dispositions = proven.dispositions + admitted.length + this.run(
        `DELETE FROM card_event_dispositions AS d WHERE d.retain_until < ? AND d.disposition <> 'admitted'
           AND substr(d.consumer_scope, 1, ${EVENT_SCOPE_PREFIX.length}) <> '${EVENT_SCOPE_PREFIX}'
           AND NOT EXISTS (SELECT 1 FROM card_event_attempts t WHERE t.event_id = d.event_id)
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
        admissions: proven.admissions + admitted.length,
        requests: proven.requests + requests,
        sessions: proven.sessions + sessions,
        messages: proven.messages + messages,
        generations,
      };
    });
  }

  /** Runs only inside cleanup's single write transaction; never orders opaque positions. */
  private retireProvenEvents(references: readonly string[], now: number): CleanupReport {
    const counts = { attempts: 0, dispositions: 0, admissions: 0, requests: 0, sessions: 0, messages: 0, generations: 0 };
    const verifier = this.optionsRetirementVerifier;
    if (!verifier || references.length === 0) return counts;
    const graph = readProtectedGraph(this.adapter), manifest = manifestProtectedGraph(graph);
    const installationRef = graph.card_meta.find(r => r.k === 'installation_ref')?.v;
    const verified = new Map<string, { reference: string; witness: RetirementWitness; snapshot: string }>();
    for (const reference of new Set(references)) {
      let w: RetirementWitness | undefined;
      try { w = verifier.verify(reference); } catch { continue; }
      if (!w) continue;
      try {
        // Snapshot the verifier's result before inspecting it; never retain mutable authority.
        const snapshot = canonicalProof(w);
        w = JSON.parse(snapshot) as RetirementWitness;
        const replay = this.getEventReplay(w.identity.eventId);
        const cursor = this.readCursor(w.identity.scope);
        if (w.installationRef !== installationRef || w.lineageId !== manifest.lineageId
          || w.protectedGraphSha256 !== manifest.sha256 || !w.identity.scope.startsWith(EVENT_SCOPE_PREFIX)
          || replay.kind !== 'retained' || !replay.final || canonicalProof(w.identity) !== canonicalProof(replay.identity)
          || w.outcome !== replay.final.outcome || w.createdAt !== replay.final.createdAt || w.retainUntil !== replay.final.retainUntil
          || w.retainUntil > now || w.createdAt + RETENTION_MS > now
          || !Number.isSafeInteger(w.issuedAt) || w.issuedAt > now || w.issuedAt < 0
          || !Number.isSafeInteger(w.expiresAt) || w.expiresAt <= now
          || !cursor || cursor.haltedReason !== null || cursor.topology !== w.topology
          || cursor.cursor === null || cursor.cursor !== cursor.ackedThrough || w.confirmedPosition !== cursor.ackedThrough
          || w.replayExcluded !== true || w.restoreExcluded !== true || w.activeOwnersExcluded !== true
          || ![w.sourceFence, w.restoreFence, w.ownerFence].every(v => typeof v === 'string' && v.length > 0)) continue;
        // Conflicting references for an event cannot be combined into authority.
        const prior = verified.get(w.identity.eventId);
        if (prior && prior.snapshot !== snapshot) return counts;
        verified.set(w.identity.eventId, { reference, witness: w, snapshot });
      } catch { /* malformed or unavailable authority retains the graph */ }
    }
    const eligible = new Set<string>();
    const sessions = new Set<string>();
    for (const [id, { witness: w }] of verified) {
      const sessionId = 'sessionId' in w.identity ? w.identity.sessionId : null;
      if (sessionId !== null) {
        const s = this.getSession(sessionId);
        const a = this.getAdmissionForSession(sessionId);
        if (!s || !['completed', 'failed', 'dead_letter', 'expired'].includes(s.status)
          || s.terminalAt === null || s.terminalAt + RETENTION_MS > now || s.retainUntil === null || s.retainUntil > now
          || (a && (!['completed', 'failed'].includes(a.state) || a.settledAt === null || a.settledAt + RETENTION_MS > now))) continue;
        const m = this.getMessage(s.cardId);
        if (!m || m.messageId === null || m.state === 'sending' || m.state === 'ambiguous' || m.seqReserved !== m.seqAcked) continue;
        // Any other retained event, live generation or explicit send still pins the entire graph.
        const events = graph.card_event_attempts.filter(r => r.session_id === sessionId)
          .concat(graph.card_event_dispositions.filter(r => r.session_id === sessionId));
        if (events.some(r => !verified.has(String(r.event_id)))
          || graph.card_handler_generations.some(g => [s.originGeneration, a?.continuationGeneration].includes(String(g.generation))
            && (g.state !== 'closed' || typeof g.retain_until !== 'number' || g.retain_until > now))
          || graph.card_explicit_requests.some(r => {
            if (r.card_id !== s.cardId) return false;
            const g = graph.card_handler_generations.find(g => g.generation === r.generation);
            return !['acked', 'failed', 'cancelled'].includes(String(r.state)) || !g || g.state !== 'closed'
              || typeof g.retain_until !== 'number' || g.retain_until > now
              || typeof g.closed_at !== 'number' || g.closed_at + RETENTION_MS > now;
          })) continue;
        sessions.add(sessionId);
      }
      eligible.add(id);
    }
    // All proofs for a session must themselves have passed the terminal checks.
    for (const sessionId of [...sessions]) {
      if (graph.card_event_attempts.concat(graph.card_event_dispositions)
        .some(r => r.session_id === sessionId && !eligible.has(String(r.event_id)))) {
        sessions.delete(sessionId);
        for (const id of [...eligible]) {
          const w = verified.get(id)!.witness;
          if ('sessionId' in w.identity && w.identity.sessionId === sessionId) eligible.delete(id);
        }
      }
    }
    const current = (): boolean => {
      if (this.closed) return false;
      for (const id of eligible) {
        const v = verified.get(id)!;
        try {
          if (v.witness.expiresAt <= this.now() || canonicalProof(verifier.verify(v.reference)) !== v.snapshot) return false;
        } catch { return false; }
      }
      return true;
    };
    if (!current()) return counts;
    for (const sessionId of sessions) counts.admissions += this.run('DELETE FROM card_admissions WHERE session_id = ?', sessionId);
    for (const id of eligible) {
      counts.dispositions += this.run('DELETE FROM card_event_dispositions WHERE event_id = ?', id);
      counts.dispositions += this.run('DELETE FROM card_event_invalidations WHERE event_id = ?', id);
      counts.attempts += this.run('DELETE FROM card_event_attempts WHERE event_id = ?', id);
    }
    for (const sessionId of sessions) {
      const s = this.getSession(sessionId)!;
      counts.requests += this.run('DELETE FROM card_explicit_requests WHERE card_id = ?', s.cardId);
      counts.sessions += this.run('DELETE FROM card_sessions WHERE session_id = ?', sessionId);
      counts.messages += this.run('DELETE FROM card_messages WHERE card_id = ?', s.cardId);
    }
    // Lost authority after a deletion rolls back the entire cleanup, including its children.
    if (!current()) throw new Rollback<CleanupReport>({ attempts: 0, dispositions: 0, admissions: 0, requests: 0, sessions: 0, messages: 0, generations: 0 });
    return counts;
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
    if (card.opcode === 'interactive' && card.informational !== true) this.checkContract(card.contract);
    else if (card.opcode === 'interactive' && card.informational === true) {
      text(card.plain, 16_384);
      if (card.reason !== 'profile_unavailable' && card.reason !== 'profile_incompatible') throw new CardStoreError('invalid_input');
    }
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
      if (card.opcode === 'interactive' && card.informational !== true && this.activeSessionCount() >= this.capacity) {
        this.finishCharged(req, CAPACITY_FULL_JSON, now);
        return { kind: 'capacity_full' };
      }
      const slot = g.logical_send_count + 1;
      const clientMsgNo = this.newId();
      // Kind records the invocation, including informational degradation. Only
      // an actionable interactive send gets a session; kind alone never admits.
      const cardId = this.insertMessage(card.opcode, card.binding, card.bodyDigest, clientMsgNo, card, now);
      if (cardId === null) throw new CardStoreError('storage_failure');
      const sessionId = card.opcode === 'interactive' && card.informational !== true ? this.insertSession(cardId, card.binding, card.contract, now).sessionId : null;
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
      // SC-1a: an app-server ambiguous settlement is final for the request row.
      if (req.settled_by !== null && req.state === 'ambiguous') return { kind: 'invalid_transition', from: req.state };
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
        `UPDATE card_explicit_requests SET state = ?, safe_result_json = ?, settled_by = COALESCE(settled_by, ?), updated_at = ?
         WHERE generation = ? AND request_id = ?`,
        input.outcome, resultJson, input.settledBy === 'app_server' ? 'app_server' : null, now, input.generation, input.requestId,
      );
      return ack ? { kind: 'finished', ack } : { kind: 'finished' };
    });
  }

  /**
   * SC-1: record a late transport outcome for a request the app-server
   * dispatcher settled `ambiguous`. Written once to the `late_*` audit
   * columns; the request state, safe result, invocation and send counters are
   * never touched. A late ack may bind the card through the existing T-bind
   * (fresh policy, current reset epoch), in the same transaction (SC-1b).
   */
  recordLateExplicitOutcome(input: LateExplicitOutcomeInput): LateExplicitOutcomeResult {
    text(input.generation); text(input.requestId);
    if (input.outcome !== 'acked' && input.outcome !== 'failed') throw new CardStoreError('invalid_input');
    if (input.outcome === 'failed' && input.ack !== undefined) throw new CardStoreError('invalid_input');
    if (input.ack !== undefined) { text(input.ack.messageId); int(input.ack.currentResetEpoch); }
    return this.tx<LateExplicitOutcomeResult>(() => {
      const now = this.now();
      const req = this.get<RequestRow>(
        'SELECT * FROM card_explicit_requests WHERE generation = ? AND request_id = ?',
        input.generation, input.requestId,
      );
      if (!req) return { kind: 'not_found' };
      if (req.settled_by === null || req.state !== 'ambiguous') {
        return { kind: 'not_applicable', state: req.state, settledBy: req.settled_by };
      }
      if (req.late_outcome !== null) return { kind: 'already' };
      let ack: AckMessageResult | undefined;
      if (input.ack !== undefined && req.card_id !== null) {
        ack = this.ackInTx({ cardId: req.card_id, messageId: input.ack.messageId,
          currentResetEpoch: input.ack.currentResetEpoch, policyAllows: input.ack.policyAllows }, now);
      }
      this.run(
        `UPDATE card_explicit_requests SET late_outcome = ?, late_message_id = ?, late_at = ?
         WHERE generation = ? AND request_id = ?`,
        input.outcome, input.ack?.messageId ?? null, now, input.generation, input.requestId,
      );
      return ack ? { kind: 'recorded', ack } : { kind: 'recorded' };
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

  /** Coherent bounded replay read: one SQLite statement observes all three ledgers. */
  getEventReplay(eventId: string): EventReplay {
    text(eventId);
    return this.read(() => {
      const r = this.get<{ attempt: string | null; disposition: string | null; invalidation: string | null }>(
        `SELECT
          (SELECT json_object('event_id',event_id,'consumer_scope',consumer_scope,'event_class',event_class,
            'session_id',session_id,'message_id',message_id,'position_ref',position_ref,
            'previous_position_ref',previous_position_ref,'envelope_digest',envelope_digest,
            'attempt_no',attempt_no,'phase',phase,'next_eligible_at',next_eligible_at)
           FROM card_event_attempts WHERE event_id = ?) AS attempt,
          (SELECT json_object('consumer_scope',consumer_scope,'event_class',event_class,'session_id',session_id,
            'disposition',disposition,'created_at',created_at,'retain_until',retain_until)
           FROM card_event_dispositions WHERE event_id = ?) AS disposition,
          (SELECT json_object('eventId',event_id,'scope',consumer_scope,'eventClass',event_class,
            'settingsScope',settings_scope,'positionRef',position_ref,'previousPositionRef',previous_position_ref,
            'envelopeDigest',envelope_digest,'createdAt',created_at,'retainUntil',retain_until)
           FROM card_event_invalidations WHERE event_id = ?) AS invalidation`, eventId, eventId, eventId,
      )!;
      const a = r.attempt === null ? null : JSON.parse(r.attempt) as AttemptRow;
      const d = r.disposition === null ? null : JSON.parse(r.disposition) as {
        consumer_scope: string; event_class: string; session_id: string | null;
        disposition: FinalDisposition; created_at: number; retain_until: number;
      };
      const i = r.invalidation === null ? null : JSON.parse(r.invalidation) as SettingsEventIdentity & { createdAt: number; retainUntil: number };
      if (i && (a || d)) return { kind: 'inconsistent', code: 'ledger_conflict' };
      if (i) {
        const { createdAt, retainUntil, ...identity } = i;
        return { kind: 'retained', identity, final: { outcome: 'invalidated', createdAt, retainUntil } };
      }
      if (d && !a) return { kind: 'inconsistent', code: 'missing_identity' };
      if (!a) return { kind: 'absent' };
      if (d && (d.consumer_scope !== a.consumer_scope || d.event_class !== a.event_class || d.session_id !== a.session_id)) {
        return { kind: 'inconsistent', code: 'identity_conflict' };
      }
      return { kind: 'retained', identity: { eventId, scope: a.consumer_scope, eventClass: a.event_class,
        sessionId: a.session_id, messageId: a.message_id, positionRef: a.position_ref,
        previousPositionRef: a.previous_position_ref, envelopeDigest: a.envelope_digest },
        attempt: { number: a.attempt_no, phase: a.phase, nextEligibleAt: a.next_eligible_at },
        ...(d ? { final: { outcome: d.disposition, createdAt: d.created_at, retainUntil: d.retain_until } } : {}) };
    });
  }

  private actionIdentityCompatible(input: EventIdentity & Partial<AttemptStartInput>): boolean {
    if (this.get('SELECT 1 FROM card_event_invalidations WHERE event_id = ?', input.eventId)) return false;
    const a = this.get<AttemptRow>('SELECT * FROM card_event_attempts WHERE event_id = ?', input.eventId);
    const d = this.get<{ consumer_scope: string; event_class: string; session_id: string | null }>(
      'SELECT consumer_scope,event_class,session_id FROM card_event_dispositions WHERE event_id = ?', input.eventId);
    if (d && (d.consumer_scope !== input.scope || d.event_class !== input.eventClass || d.session_id !== input.sessionId)) return false;
    if (!a) return true;
    return a.consumer_scope === input.scope && a.event_class === input.eventClass && a.session_id === input.sessionId
      && (input.messageId === undefined || a.message_id === input.messageId)
      && (input.positionRef === undefined || a.position_ref === input.positionRef)
      && (input.previousPositionRef === undefined || a.previous_position_ref === input.previousPositionRef)
      && (input.envelopeDigest === undefined || a.envelope_digest === input.envelopeDigest);
  }

  recordEventInvalidation(input: SettingsEventIdentity & { readonly cursor: CursorAdvance }):
    { readonly kind: 'recorded' } | { readonly kind: 'already_final'; readonly disposition: 'invalidated' }
    | { readonly kind: 'conflict' } | CursorFailure {
    text(input.eventId); text(input.scope); text(input.positionRef); optText(input.previousPositionRef); text(input.envelopeDigest);
    CardStore.checkCursorInput(input.cursor);
    if (input.eventClass !== 'bot_setting_updated' || input.settingsScope !== 'bot_setting') throw new CardStoreError('invalid_input');
    return this.tx(() => {
      if (input.cursor.scope !== input.scope || input.cursor.next !== input.positionRef
        || input.cursor.expectedPrevious !== input.previousPositionRef) return { kind: 'cursor_conflict' };
      const replay = this.getEventReplay(input.eventId);
      if (replay.kind !== 'absent') {
        if (replay.kind !== 'retained' || replay.final?.outcome !== 'invalidated') return { kind: 'conflict' };
        const i = replay.identity;
        if (i.scope !== input.scope || i.eventClass !== input.eventClass || i.positionRef !== input.positionRef
          || i.previousPositionRef !== input.previousPositionRef || i.envelopeDigest !== input.envelopeDigest) return { kind: 'conflict' };
        return { kind: 'already_final', disposition: 'invalidated' };
      }
      this.checkCursorBoundary(input.scope, input.cursor);
      const now = this.now();
      this.run(`INSERT INTO card_event_invalidations (event_id,consumer_scope,event_class,settings_scope,
        position_ref,previous_position_ref,envelope_digest,created_at,retain_until) VALUES (?,?,?,?,?,?,?,?,?)`,
      input.eventId, input.scope, input.eventClass, input.settingsScope, input.positionRef, input.previousPositionRef,
      input.envelopeDigest, now, now + RETENTION_MS);
      this.advanceCursor(input.cursor, now);
      return { kind: 'recorded' };
    });
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

  /**
   * Kinds of cards whose initial send may have been accepted (`sending` or
   * `ambiguous`): the D-B/N2 suspension input of every write-queue
   * construction. Read-only; a read failure throws so callers fail closed.
   */
  unresolvedSendKinds(): readonly string[] {
    return this.read(() => {
      const rows = this.adapter
        .prepare(`SELECT DISTINCT kind FROM card_messages WHERE state IN ('ambiguous','sending') ORDER BY kind`)
        .all() as Array<{ kind: string }>;
      return Object.freeze(rows.map((r) => r.kind));
    });
  }

  /**
   * Live, bound automatic cards (`active`/`answering`) in creation order, the
   * input of startup recovery. Sending/ambiguous rows are excluded (N2). A
   * read failure throws so the caller fails closed.
   */
  liveAutomaticCards(): readonly LiveAutomaticCard[] {
    return this.read(() => {
      const rows = this.adapter
        .prepare(
          `SELECT *, card_id IN (${LEGACY_IDS_SQL}) AS legacy_flag FROM card_messages
           WHERE kind = 'automatic' AND terminal_at IS NULL AND state IN ('active','answering') AND message_id IS NOT NULL
           ORDER BY created_at, card_id`,
        )
        .all() as Array<MessageRow & { legacy_flag: number }>;
      return Object.freeze(rows.map((r) => Object.freeze({ record: toMessage(r), legacy: r.legacy_flag === 1 })));
    });
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
  card_event_invalidations: ['event_id'],
};

export type ProtectedGraphRows = Readonly<Record<CardTable, ReadonlyArray<Readonly<Record<string, unknown>>>>>;

/**
 * Strict canonical form of retirement evidence and replay identities, with
 * the same rules as the topology envelope (plain data only: no accessors,
 * symbols, cycles, non-finite numbers or lone surrogates). Kept local so the
 * store module has no runtime dependency outside its schema layer.
 */
function canonicalProof(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): string {
    if (++nodes > 10000 || depth > 32) throw new Error('invalid_envelope');
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) throw new Error('invalid_envelope');
      return JSON.stringify(v);
    }
    if (typeof v === 'string') {
      if (/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''))) throw new Error('invalid_envelope');
      return JSON.stringify(v);
    }
    if (typeof v !== 'object' || active.has(v)) throw new Error('invalid_envelope');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('invalid_envelope');
    if (Object.getOwnPropertySymbols(v).length) throw new Error('invalid_envelope');
    active.add(v);
    const keys = Object.keys(v);
    let out: string;
    if (array) {
      if (keys.length !== v.length || keys.some((k, i) => k !== String(i))) throw new Error('invalid_envelope');
      out = '[' + keys.map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !('value' in d)) throw new Error('invalid_envelope');
        return visit(d.value, depth + 1);
      }).join(',') + ']';
    } else {
      if (Object.getOwnPropertyNames(v).length !== keys.length) throw new Error('invalid_envelope');
      out = '{' + keys.sort().map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !('value' in d)) throw new Error('invalid_envelope');
        return JSON.stringify(k) + ':' + visit(d.value, depth + 1);
      }).join(',') + '}';
    }
    active.delete(v);
    if (Buffer.byteLength(out, 'utf8') > 65536) throw new Error('invalid_envelope');
    return out;
  }
  return visit(value, 0);
}

function canonical(row: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));
}

/** Read every card table in primary-key order. */
export function readProtectedGraph(adapter: DbAdapter): ProtectedGraphRows {
  const out = {} as Record<CardTable, Array<Record<string, unknown>>>;
  const version = Number((adapter.prepare("SELECT v FROM card_meta WHERE k = 'schema_version'").get() as { v: string } | undefined)?.v);
  const present = new Set(cardTablesFor(version));
  for (const table of CARD_TABLES) {
    out[table] = present.has(table) ? adapter.prepare(`SELECT * FROM ${table} ORDER BY ${TABLE_KEYS[table].join(', ')}`).all() as Array<Record<string, unknown>> : [];
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
    schemaHash: String(rows.card_meta.find((r) => r.k === 'schema_hash')?.v ?? referenceSchema().hash),
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
  card_event_dispositions: ['consumer_scope', 'event_class', 'session_id', 'disposition', 'reason_code', 'attempts', 'created_at', 'retain_until'],
  card_event_attempts: ['consumer_scope', 'event_class', 'session_id', 'message_id', 'position_ref', 'previous_position_ref', 'envelope_digest'],
  card_event_invalidations: ['consumer_scope', 'event_class', 'settings_scope', 'position_ref', 'previous_position_ref', 'envelope_digest', 'created_at', 'retain_until'],
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
  const metaOf = (rows: ProtectedGraphRows, k: string): unknown => rows.card_meta.find((r) => r.k === k)?.v;
  if (metaOf(candidate, 'lineage_id') !== metaOf(tail, 'lineage_id')) out.push({ table: 'card_meta', key: 'lineage_id', code: 'lineage_mismatch' });
  // The intent-capable version and its exact legacy set are facts of the lineage.
  if (metaOf(candidate, 'schema_version') !== metaOf(tail, 'schema_version')) {
    out.push({ table: 'card_meta', key: 'schema_version', code: 'conflicting_fact' });
  }
  const tailLegacy = metaOf(tail, INTENT_LEGACY_KEY);
  if (tailLegacy !== undefined && metaOf(candidate, INTENT_LEGACY_KEY) !== tailLegacy) {
    out.push({ table: 'card_meta', key: INTENT_LEGACY_KEY, code: 'conflicting_fact' });
  }
  const admittedSessions = (rows: ProtectedGraphRows): Set<unknown> => new Set(rows.card_admissions.map((r) => r.session_id));
  const candAdmitted = admittedSessions(candidate);
  const tailAdmitted = admittedSessions(tail);
  const candidateActions = new Set([...candidate.card_event_dispositions, ...candidate.card_event_attempts].map((r) => r.event_id));
  for (const i of candidate.card_event_invalidations) {
    if (candidateActions.has(i.event_id)) out.push({ table: 'card_event_invalidations', key: String(i.event_id), code: 'conflicting_fact' });
  }

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
        // A durable terminal intent is absorbing: losing it revives work, changing it contradicts.
        if (t.terminal_at === null && t.terminal_reason !== null && c.terminal_reason !== t.terminal_reason) {
          out.push({ table, key, code: c.terminal_reason === null ? 'revived_work' : 'conflicting_fact' });
        }
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
        if (t.cursor !== c.cursor || t.acked_through !== c.acked_through) out.push({ table, key, code: 'cursor_regression' });
        if (t.topology !== c.topology || (t.halted_reason !== null && c.halted_reason !== null
          && (t.halted_reason !== c.halted_reason || t.halted_at !== c.halted_at))) out.push({ table, key, code: 'conflicting_fact' });
      }
      if (table === 'card_event_attempts') {
        if (num(c.attempt_no) < num(t.attempt_no) || (c.attempt_no === t.attempt_no && t.phase === 'failed' && c.phase !== 'failed')) {
          out.push({ table, key, code: 'revived_work' });
        }
        if (c.attempt_no === t.attempt_no && t.phase === 'failed' && c.next_eligible_at !== t.next_eligible_at) {
          out.push({ table, key, code: 'conflicting_fact' });
        }
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
  /**
   * Open a complete store, upgrading it in place first: version 1 to the
   * intent-capable version 2 (DTI-2.1 §2.2), then version 2 to version 3
   * (SC-1). One backup before the first step, then for each step a
   * re-inspection, one upgrade transaction and the invariants. Any failure
   * leaves the store at the last committed version and cards disabled.
   */
  const open = async (meta: CardMeta, provenance: 'reopened' | 'activation_reconciled'): Promise<CardStoreInit> => {
    if (meta.schemaVersion === 4) return ready(meta, provenance);
    let backup: BackupReceipt;
    try {
      backup = await backupBeforeMigration(adapter, options.backupDir, nowMs,
        meta.schemaVersion === 1 ? UPGRADE_V2_BACKUP_LABEL : meta.schemaVersion === 2 ? UPGRADE_V3_BACKUP_LABEL : UPGRADE_V4_BACKUP_LABEL);
    } catch {
      return disabled('migration_failed');
    }
    let upgraded: CardMeta = meta;
    while (upgraded.schemaVersion !== 4) {
      const from = upgraded.schemaVersion;
      try {
        // Re-inspect after the await: the store must still be the same lineage at the same version.
        const again = inspectCardSchema(adapter);
        const markerAgain = marker.read();
        if (again.state !== 'complete' || again.meta.schemaVersion !== from || again.meta.lineageId !== meta.lineageId
          || again.meta.installationRef !== meta.installationRef || again.meta.schemaHash !== upgraded.schemaHash
          || markerAgain.state !== 'present' || serializeActivationMarker(markerAgain.marker) !== serializeActivationMarker(m)) {
          return disabled('provenance_conflict');
        }
        upgraded = from === 1 ? upgradeCardSchemaV1toV2(adapter, meta.lineageId)
          : from === 2 ? upgradeCardSchemaV2toV3(adapter, meta.lineageId) : upgradeCardSchemaV3toV4(adapter, meta.lineageId);
      } catch {
        return disabled('migration_failed');
      }
      const violations = validate();
      if (violations) return disabled(violations.includes('integrity_check') ? 'integrity_failed' : 'invariant_failed', violations);
    }
    if (!activate(upgraded.lineageId, backup.fileName, nowMs)) return disabled('marker_write_failed');
    return ready(upgraded, provenance, backup);
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
      return open(inspected.meta, 'reopened');
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
    // Keep the entry marker stable through a historical upgrade's backup and
    // mutations; publish activation only after its last committed step.
    if (inspected.meta.schemaVersion !== 4) return open(inspected.meta, 'activation_reconciled');
    if (!activate(inspected.meta.lineageId, m.backupRef, nowMs)) return disabled('marker_write_failed');
    return open(inspected.meta, 'activation_reconciled');
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
