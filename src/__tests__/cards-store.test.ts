import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { FileActivationMarker, checkCardInvariants, migrateCardSchema, provisionFirstInstallMarker } from '../cards/migrations.js';
import {
  ACTIVE_SESSION_CAPACITY,
  CardStore,
  CardStoreError,
  EXPLICIT_BUDGET_EXHAUSTED,
  MAX_EXPLICIT_INVOCATIONS,
  MAX_EXPLICIT_SENDS,
  compareProtectedGraph,
  initializeCardStore,
  manifestProtectedGraph,
  readProtectedGraph,
  type CardBinding,
  type CursorAdvance,
  type SessionContract,
} from '../cards/store.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);

let root: string;
let adapter: DbAdapter;
let store: CardStore;
let now: number;
let seq: number;
const clock = { nowUtcMs: () => now };

const binding: CardBinding = {
  sessionKey: 'group:g1',
  channelId: 'g1',
  channelType: 2,
  topicScope: null,
  generation: 'turn-1',
  resetEpoch: 0,
};

const contract: SessionContract = {
  requesterUid: 'u1',
  contractVersion: 1,
  authoredContractJson: '{"buttons":[{"id":"ok"}]}',
  authoredDataHash: 'data-hash',
};

function newStore(options: { sessionCapacity?: number } = {}): CardStore {
  return new CardStore(adapter, { clock, newId: () => `id-${++seq}`, ...options });
}

function reserveInteractive(clientMsgNo: string, b: CardBinding = binding) {
  const r = store.reserveSession({ binding: b, bodyDigest: `digest-${clientMsgNo}`, clientMsgNo, contract });
  if (r.kind !== 'reserved') throw new Error(`reserve failed: ${r.kind}`);
  return r;
}

function pendingSession(name: string) {
  const r = reserveInteractive(`cmn-${name}`);
  const ack = store.ackMessage({ cardId: r.cardId, messageId: `msg-${name}`, currentResetEpoch: 0, policyAllows: true });
  expect(ack).toEqual({ kind: 'bound', admittable: true });
  return r;
}

function ev(eventId: string, sessionId: string | null) {
  return { eventId, scope: 'scope-a', eventClass: 'card_action', sessionId };
}

function cursor(expectedPrevious: string | null, next: string): CursorAdvance {
  return { scope: 'scope-a', expectedPrevious, next };
}

function count(table: string): number {
  return (adapter.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cards-store-'));
  adapter = createAdapter(join(root, 'cc-octo.db'));
  new SessionStore(adapter).init();
  migrateCardSchema(adapter, { installationRef: 'install-a', lineageId: 'lineage-1', nowMs: T0 });
  now = T0;
  seq = 0;
  store = newStore();
});

afterEach(() => {
  try {
    adapter.close();
  } catch {
    // closed by the test
  }
  rmSync(root, { recursive: true, force: true });
});

describe('declared constraints (real SQLite)', () => {
  it('enforces foreign keys from every child table', () => {
    const insertSession = () =>
      adapter.prepare(
        `INSERT INTO card_sessions (session_id, card_id, requester_uid, session_key, channel_id, channel_type,
           origin_generation, reset_epoch, contract_version, authored_contract_json, authored_data_hash, status, expires_at, created_at)
         VALUES ('s', 'no-card', 'u', 'k', 'c', 1, 'g', 0, 1, '{}', 'h', 'pending', ?, ?)`,
      ).run(T0 + DAY, T0);
    expect(insertSession).toThrow(/FOREIGN KEY/);
    expect(() =>
      adapter.prepare(
        `INSERT INTO card_admissions (admission_id, session_id, event_id, continuation_generation, submitted_hash, state, admitted_at)
         VALUES ('a', 'no-session', 'e', 'g', 'h', 'admitted', 1)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      adapter.prepare(
        `INSERT INTO card_event_dispositions (event_id, consumer_scope, event_class, session_id, disposition, created_at, retain_until)
         VALUES ('e', 's', 'c', 'no-session', 'invalid', 1, ?)`,
      ).run(1 + DAY),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      adapter.prepare(
        `INSERT INTO card_explicit_requests (generation, request_id, body_digest, opcode, state, created_at, updated_at)
         VALUES ('no-gen', 'r', 'd', 'display', 'charged', 1, 1)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/);
    // Parents cannot be deleted from under their children.
    const r = reserveInteractive('cmn-fk');
    expect(() => adapter.prepare('DELETE FROM card_messages WHERE card_id = ?').run(r.cardId)).toThrow(/FOREIGN KEY/);
  });

  it('enforces UNIQUE identities', () => {
    const r = reserveInteractive('cmn-1');
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'cmn-1', contract })).toEqual({ kind: 'duplicate_client_msg_no' });
    expect(() =>
      adapter.prepare(
        `INSERT INTO card_sessions (session_id, card_id, requester_uid, session_key, channel_id, channel_type,
           origin_generation, reset_epoch, contract_version, authored_contract_json, authored_data_hash, status, expires_at, created_at)
         VALUES ('s2', ?, 'u', 'k', 'c', 1, 'g', 0, 1, '{}', 'h', 'pending', ?, ?)`,
      ).run(r.cardId, T0 + DAY, T0),
    ).toThrow(/UNIQUE/);
    store.ackMessage({ cardId: r.cardId, messageId: 'msg-1', currentResetEpoch: 0, policyAllows: true });
    const other = reserveInteractive('cmn-2');
    expect(store.ackMessage({ cardId: other.cardId, messageId: 'msg-1', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'identity_conflict' });
  });

  it('enforces CHECK constraints on states, fixed expiry, retention and counters', () => {
    const r = reserveInteractive('cmn-1');
    expect(() => adapter.prepare(`UPDATE card_messages SET state = 'bogus' WHERE card_id = ?`).run(r.cardId)).toThrow(/CHECK/);
    expect(() => adapter.prepare(`UPDATE card_sessions SET status = 'claimed' WHERE session_id = ?`).run(r.sessionId)).toThrow(/CHECK/);
    // Active without a bound identity is not representable.
    expect(() => adapter.prepare(`UPDATE card_messages SET state = 'active' WHERE card_id = ?`).run(r.cardId)).toThrow(/CHECK/);
    // Terminal without retention is not representable.
    expect(() =>
      adapter.prepare(`UPDATE card_sessions SET status = 'failed', terminal_at = ?, retain_until = ? WHERE session_id = ?`).run(T0, T0 + 1, r.sessionId),
    ).toThrow(/CHECK/);
    expect(() => adapter.prepare(`UPDATE card_messages SET seq_acked = 1 WHERE card_id = ?`).run(r.cardId)).toThrow(/CHECK/);
    expect(() =>
      adapter.prepare(
        `INSERT INTO card_event_attempts (event_id, consumer_scope, event_class, message_id, position_ref, envelope_digest, attempt_no, phase, updated_at)
         VALUES ('e', 's', 'c', 'm', 'p', 'd', 4, 'failed', 1)`,
      ).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      adapter.prepare(
        `INSERT INTO card_event_attempts (event_id, consumer_scope, event_class, message_id, position_ref, envelope_digest, attempt_no, phase, updated_at)
         VALUES ('e', 's', 'c', 'm', 'p', 'd', 0, 'started', 1)`,
      ).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      adapter.prepare(`INSERT INTO card_event_cursor (consumer_scope, topology, updated_at) VALUES ('s', 'T-WS', 1)`).run(),
    ).toThrow(/CHECK/);
    store.registerHandler(handler('gen-1'));
    expect(() => adapter.prepare(`UPDATE card_handler_generations SET invocation_count = 33`).run()).toThrow(/CHECK/);
    expect(() => adapter.prepare(`UPDATE card_handler_generations SET logical_send_count = 11`).run()).toThrow(/CHECK/);
  });

  it('immutability triggers protect expiry, final dispositions, fences and settled admissions', () => {
    const r = pendingSession('t');
    expect(() => adapter.prepare(`UPDATE card_sessions SET expires_at = expires_at + 1 WHERE session_id = ?`).run(r.sessionId)).toThrow(/expiry is fixed/);
    store.initCursor('scope-a', 'T-EXCL');
    store.recordDisposition({ ...ev('e-1', r.sessionId), disposition: 'invalid', cursor: cursor(null, 'p1') });
    expect(() => adapter.prepare(`UPDATE card_event_dispositions SET disposition = 'admitted'`).run()).toThrow(/final/);
    expect(store.reserveSequence(r.cardId)).toEqual({ kind: 'reserved', seq: 1 });
    expect(() => adapter.prepare(`UPDATE card_messages SET seq_reserved = 0 WHERE card_id = ?`).run(r.cardId)).toThrow(/fence regression/);
    expect(() => adapter.prepare(`UPDATE card_messages SET message_id = 'other' WHERE card_id = ?`).run(r.cardId)).toThrow(/fence regression/);
    const adm = store.admitOnce({ ...ev('e-2', r.sessionId), sessionId: r.sessionId, continuationGeneration: 'cont-1', submittedHash: 'sub', currentResetEpoch: 0, cursor: cursor('p1', 'p2') });
    expect(adm.kind).toBe('admitted');
    if (adm.kind !== 'admitted') return;
    store.settleAdmission(adm.admissionId, 'completed');
    expect(() => adapter.prepare(`UPDATE card_admissions SET state = 'admitted'`).run()).toThrow(/immutable/);
    expect(() => adapter.prepare(`UPDATE card_sessions SET status = 'pending' WHERE session_id = ?`).run(r.sessionId)).toThrow(/absorbing/);
    store.registerHandler(handler('gen-1'));
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b', opcode: 'display' });
    expect(() => adapter.prepare(`UPDATE card_handler_generations SET invocation_count = 0`).run()).toThrow(/fence regression/);
    store.closeHandler('gen-1');
    expect(() => adapter.prepare(`UPDATE card_handler_generations SET state = 'live', closed_at = NULL, retain_until = NULL`).run()).toThrow(/fence regression/);
  });
});

describe('transaction boundaries', () => {
  it('a failure inside the transaction rolls back every write (cursor conflict during T2)', () => {
    const r = pendingSession('rb');
    store.initCursor('scope-a', 'T-EXCL');
    const res = store.admitOnce({ ...ev('e-1', r.sessionId), sessionId: r.sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor('wrong', 'p1') });
    expect(res).toEqual({ kind: 'cursor_conflict' });
    expect(store.getSession(r.sessionId)?.status).toBe('pending');
    expect(count('card_admissions')).toBe(0);
    expect(count('card_event_dispositions')).toBe(0);
    expect(store.readCursor('scope-a')?.cursor).toBeNull();
  });

  it('a SQL error mid-transaction rolls back earlier statements and surfaces storage_failure', () => {
    adapter.exec(`CREATE TEMP TRIGGER fail_session BEFORE INSERT ON card_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect(() => store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'cmn-x', contract })).toThrow(CardStoreError);
    expect(count('card_messages')).toBe(0);
    expect(adapter.inTransaction).toBe(false);
    adapter.exec('DROP TRIGGER temp.fail_session');
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'cmn-x', contract }).kind).toBe('reserved');
  });

  it('rejects nested transactions and retired leases without touching SQL', () => {
    adapter.exec('BEGIN');
    expect(() => store.reserveMessage({ kind: 'display', binding, bodyDigest: 'd', clientMsgNo: 'c' })).toThrow(/nested_transaction/);
    adapter.exec('ROLLBACK');
    store.retire();
    expect(() => store.activeSessions()).toThrow(/closed/);
    expect(() => store.reserveMessage({ kind: 'display', binding, bodyDigest: 'd', clientMsgNo: 'c' })).toThrow(/closed/);
    expect(count('card_messages')).toBe(0);
  });

  it('a closed adapter grants no authority: storage_failure', () => {
    adapter.close();
    expect(() => store.reserveMessage({ kind: 'display', binding, bodyDigest: 'd', clientMsgNo: 'c' })).toThrow(/storage_failure/);
  });

  it('rejects malformed inputs before any write', () => {
    expect(() => store.reserveMessage({ kind: 'display', binding: { ...binding, channelType: 3 as 1 }, bodyDigest: 'd', clientMsgNo: 'c' })).toThrow(/invalid_input/);
    expect(() => store.reserveMessage({ kind: 'display', binding, bodyDigest: '', clientMsgNo: 'c' })).toThrow(/invalid_input/);
    expect(() => store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'c', contract: { ...contract, contractVersion: 0 } })).toThrow(/invalid_input/);
    expect(count('card_messages')).toBe(0);
  });
});

describe('T-reserve capacity accounting (AC-012.4/.5, AC-018.2)', () => {
  it('counts sending/pending/retry/admitted/ambiguous and rejects the 1001st before transport', () => {
    for (let i = 0; i < ACTIVE_SESSION_CAPACITY; i++) reserveInteractive(`cap-${i}`);
    expect(store.activeSessions()).toBe(ACTIVE_SESSION_CAPACITY);
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'cap-x', contract })).toEqual({ kind: 'capacity_full' });
    expect(count('card_messages')).toBe(ACTIVE_SESSION_CAPACITY);
  });

  it('failed sends leave the count only after a definitive outcome; ambiguous sends keep it', () => {
    store = newStore({ sessionCapacity: 3 });
    const a = reserveInteractive('a');
    const b = reserveInteractive('b');
    reserveInteractive('c');
    expect(store.markSendAmbiguous(a.cardId)).toEqual({ kind: 'updated' });
    expect(store.getSession(a.sessionId)?.status).toBe('ambiguous');
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'd', contract })).toEqual({ kind: 'capacity_full' });
    expect(store.markSendFailed(b.cardId)).toEqual({ kind: 'updated' });
    expect(store.getSession(b.sessionId)?.status).toBe('failed');
    expect(store.getMessage(b.cardId)?.state).toBe('error');
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'd', contract }).kind).toBe('reserved');
    // Unresolved ambiguity is never evicted for space.
    now += 10 * DAY;
    store.expireSessions();
    store.cleanup();
    expect(store.getSession(a.sessionId)?.status).toBe('ambiguous');
  });

  it('display and automatic cards reserve messages without sessions', () => {
    const r = store.reserveMessage({ kind: 'automatic', binding, bodyDigest: 'd', clientMsgNo: 'auto-1', templateId: 'ai.reasoning-process', templateVersion: '2' });
    expect(r.kind).toBe('reserved');
    expect(store.activeSessions()).toBe(0);
    if (r.kind !== 'reserved') return;
    expect(store.ackMessage({ cardId: r.cardId, messageId: 'm-auto', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'bound', admittable: false });
    expect(store.getMessage(r.cardId)?.state).toBe('active');
  });
});

describe('T-bind', () => {
  it('binds the acknowledged identity and exposes pending; replay is idempotent', () => {
    const r = reserveInteractive('a');
    expect(store.findSessionByMessageId('m-a')).toBeNull();
    expect(store.ackMessage({ cardId: r.cardId, messageId: 'm-a', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'bound', admittable: true });
    expect(store.findSessionByMessageId('m-a')?.status).toBe('pending');
    expect(store.ackMessage({ cardId: r.cardId, messageId: 'm-a', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'already_bound' });
    expect(store.ackMessage({ cardId: r.cardId, messageId: 'm-b', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'identity_conflict' });
  });

  it('a reconciled ambiguous send binds the same card; never a new session', () => {
    const r = reserveInteractive('a');
    store.markSendAmbiguous(r.cardId);
    expect(store.ackMessage({ cardId: r.cardId, messageId: 'm-a', currentResetEpoch: 0, policyAllows: true }).kind).toBe('bound');
    expect(count('card_sessions')).toBe(1);
    expect(store.getSession(r.sessionId)?.status).toBe('pending');
  });

  it('expired, reset-fenced or revoked acknowledgements stay terminal and non-admittable', () => {
    const a = reserveInteractive('a');
    const b = reserveInteractive('b');
    const c = reserveInteractive('c');
    expect(store.ackMessage({ cardId: b.cardId, messageId: 'm-b', currentResetEpoch: 1, policyAllows: true })).toEqual({ kind: 'bound', admittable: false, reason: 'reset_fenced' });
    expect(store.ackMessage({ cardId: c.cardId, messageId: 'm-c', currentResetEpoch: 0, policyAllows: false })).toEqual({ kind: 'bound', admittable: false, reason: 'policy_revoked' });
    now = T0 + DAY;
    expect(store.ackMessage({ cardId: a.cardId, messageId: 'm-a', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'bound', admittable: false, reason: 'expired' });
    expect(store.getSession(a.sessionId)?.status).toBe('expired');
    expect(store.getSession(b.sessionId)?.status).toBe('failed');
    expect(store.getMessage(c.cardId)?.terminalReason).toBe('policy_revoked');
    expect(store.getMessage(a.cardId)?.messageId).toBe('m-a');
  });
});

describe('sequence reservation', () => {
  it('reserves before edits and acknowledges monotonically', () => {
    const r = reserveInteractive('a');
    expect(store.reserveSequence(r.cardId).kind).toBe('invalid_state');
    store.ackMessage({ cardId: r.cardId, messageId: 'm', currentResetEpoch: 0, policyAllows: true });
    expect(store.reserveSequence(r.cardId)).toEqual({ kind: 'reserved', seq: 1 });
    expect(store.reserveSequence(r.cardId)).toEqual({ kind: 'reserved', seq: 2 });
    expect(store.ackSequence(r.cardId, 3)).toEqual({ kind: 'not_reserved' });
    expect(store.ackSequence(r.cardId, 2)).toEqual({ kind: 'acked', seqAcked: 2 });
    expect(store.ackSequence(r.cardId, 1)).toEqual({ kind: 'acked', seqAcked: 2 });
  });

  type TerminalState = 'done' | 'error' | 'expired';
  const TERMINAL_STATES: readonly TerminalState[] = ['done', 'error', 'expired'];
  const REASON: Record<TerminalState, string> = { done: 'completed', error: 'failed', expired: 'expired' };

  function terminalize(db: DbAdapter, cardId: string, state: TerminalState): void {
    db.prepare(
      `UPDATE card_messages SET state = ?, terminal_reason = ?, terminal_at = ?, retain_until = ? WHERE card_id = ?`,
    ).run(state, REASON[state], now, now + DAY, cardId);
  }

  function fences(cardId: string) {
    return adapter.prepare('SELECT state, seq_reserved, seq_acked FROM card_messages WHERE card_id = ?').get(cardId);
  }

  /** A bound card with sequences 1..2 reserved and 1 acknowledged. */
  function editedCard(name: string) {
    const r = pendingSession(name);
    expect(store.reserveSequence(r.cardId)).toEqual({ kind: 'reserved', seq: 1 });
    expect(store.reserveSequence(r.cardId)).toEqual({ kind: 'reserved', seq: 2 });
    expect(store.ackSequence(r.cardId, 1)).toEqual({ kind: 'acked', seqAcked: 1 });
    return r;
  }

  it.each(TERMINAL_STATES)('rejects reservation and acknowledgement on a %s card without moving either fence', (state) => {
    const r = editedCard(state);
    terminalize(adapter, r.cardId, state);
    const before = fences(r.cardId);
    expect(before).toEqual({ state, seq_reserved: 2, seq_acked: 1 });
    expect(store.reserveSequence(r.cardId)).toEqual({ kind: 'invalid_state', state });
    expect(store.ackSequence(r.cardId, 2)).toEqual({ kind: 'invalid_state', state });
    expect(store.ackSequence(r.cardId, 3)).toEqual({ kind: 'not_reserved' });
    expect(fences(r.cardId)).toEqual(before);
  });

  it('rejects terminal cards reached through the store paths', () => {
    const revoked = reserveInteractive('revoked');
    expect(store.ackMessage({ cardId: revoked.cardId, messageId: 'm-revoked', currentResetEpoch: 0, policyAllows: false }))
      .toEqual({ kind: 'bound', admittable: false, reason: 'policy_revoked' });
    const expired = reserveInteractive('expired');
    now = T0 + DAY;
    expect(store.ackMessage({ cardId: expired.cardId, messageId: 'm-expired', currentResetEpoch: 0, policyAllows: true }))
      .toEqual({ kind: 'bound', admittable: false, reason: 'expired' });
    for (const [card, state] of [[revoked, 'error'], [expired, 'expired']] as const) {
      const before = fences(card.cardId);
      expect(store.reserveSequence(card.cardId)).toEqual({ kind: 'invalid_state', state });
      expect(store.ackSequence(card.cardId, 1)).toEqual({ kind: 'not_reserved' });
      expect(fences(card.cardId)).toEqual(before);
    }
  });

  it('keeps the unbound, abandoned and unknown-card outcomes', () => {
    const unbound = reserveInteractive('unbound');
    expect(store.reserveSequence(unbound.cardId)).toEqual({ kind: 'invalid_state', state: 'sending' });
    expect(store.ackSequence(unbound.cardId, 1)).toEqual({ kind: 'not_reserved' });
    const abandoned = reserveInteractive('abandoned');
    expect(store.abandonUnsent(abandoned.cardId).kind).toBe('updated');
    expect(store.reserveSequence(abandoned.cardId)).toEqual({ kind: 'invalid_state', state: 'abandoned' });
    expect(store.reserveSequence('missing')).toEqual({ kind: 'not_found' });
    expect(store.ackSequence('missing', 1)).toEqual({ kind: 'not_found' });
    expect(fences(unbound.cardId)).toEqual({ state: 'sending', seq_reserved: 0, seq_acked: 0 });
  });

  /** Delegates to the real adapter, but terminalizes the card right before any sequence UPDATE runs. */
  function racingAdapter(cardId: string, state: TerminalState): DbAdapter {
    return {
      exec: (sql) => adapter.exec(sql),
      close: () => adapter.close(),
      get inTransaction() { return adapter.inTransaction; },
      transaction: (fn) => adapter.transaction(fn),
      backup: (dest) => adapter.backup(dest),
      prepare: (sql) => {
        const stmt = adapter.prepare(sql);
        if (!/UPDATE card_messages SET seq_/.test(sql)) return stmt;
        return { ...stmt, run: (...params: unknown[]) => { terminalize(adapter, cardId, state); return stmt.run(...params); } };
      },
    };
  }

  it.each(TERMINAL_STATES)('does not move a fence when the card turns %s just before the sequence write', (state) => {
    // The card turns terminal inside the store's own transaction, immediately before its sequence
    // UPDATE: a guard evaluated earlier in that transaction would already have passed.
    const r = editedCard(`race-${state}`);
    expect(new CardStore(racingAdapter(r.cardId, state), { clock, newId: () => `id-${++seq}` }).reserveSequence(r.cardId))
      .toEqual({ kind: 'invalid_state', state });
    expect(fences(r.cardId)).toEqual({ state, seq_reserved: 2, seq_acked: 1 });

    const s = editedCard(`race-ack-${state}`);
    expect(new CardStore(racingAdapter(s.cardId, state), { clock, newId: () => `id-${++seq}` }).ackSequence(s.cardId, 2))
      .toEqual({ kind: 'invalid_state', state });
    expect(fences(s.cardId)).toEqual({ state, seq_reserved: 2, seq_acked: 1 });
  });
});

describe('T0/T1a retry, T1 final disposition and cursor (AC-016)', () => {
  const start = (eventId: string, sessionId: string, position = 'p1', previous: string | null = null) =>
    store.recordAttemptStart({ ...ev(eventId, sessionId), messageId: 'msg-x', positionRef: position, previousPositionRef: previous, envelopeDigest: 'env' });

  it('retries at 1 s then 4 s and dead-letters exactly at the third failure; no fourth attempt', () => {
    const r = pendingSession('x');
    store.initCursor('scope-a', 'T-EXCL');
    expect(start('e-1', r.sessionId)).toEqual({ kind: 'started', attemptNo: 1 });
    expect(start('e-1', r.sessionId)).toEqual({ kind: 'in_progress', attemptNo: 1 });
    expect(store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'membership_fetch', cursor: cursor(null, 'p1') })).toEqual({ kind: 'retry_wait', attemptNo: 1, nextEligibleAt: T0 + 1000 });
    expect(store.getSession(r.sessionId)).toMatchObject({ status: 'retry_wait', attempts: 1 });
    expect(store.readCursor('scope-a')?.cursor).toBeNull();
    now = T0 + 999;
    expect(start('e-1', r.sessionId).kind).toBe('not_eligible');
    now = T0 + 1000;
    expect(start('e-1', r.sessionId)).toEqual({ kind: 'started', attemptNo: 2 });
    expect(store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'policy_fetch', cursor: cursor(null, 'p1') })).toEqual({ kind: 'retry_wait', attemptNo: 2, nextEligibleAt: T0 + 5000 });
    now = T0 + 5000;
    expect(start('e-1', r.sessionId)).toEqual({ kind: 'started', attemptNo: 3 });
    expect(store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'policy_fetch', cursor: cursor(null, 'p1') })).toEqual({ kind: 'dead_letter' });
    expect(store.getDisposition('e-1')).toBe('dead_letter');
    expect(store.getSession(r.sessionId)).toMatchObject({ status: 'dead_letter', attempts: 3 });
    expect(store.readCursor('scope-a')?.cursor).toBe('p1');
    // Replay only re-ACKs.
    expect(start('e-1', r.sessionId)).toEqual({ kind: 'final', disposition: 'dead_letter' });
    expect(store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'x', cursor: cursor('p1', 'p2') })).toEqual({ kind: 'not_started' });
  });

  it('an interrupted started attempt is counted once on recovery', () => {
    const r = pendingSession('x');
    store.initCursor('scope-a', 'T-EXCL');
    start('e-1', r.sessionId);
    // Crash: replay cannot consume another attempt while it is started.
    expect(start('e-1', r.sessionId)).toEqual({ kind: 'in_progress', attemptNo: 1 });
    expect(store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'interrupted', cursor: cursor(null, 'p1') }).kind).toBe('retry_wait');
    expect(store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'interrupted', cursor: cursor(null, 'p1') })).toEqual({ kind: 'not_started' });
    expect(store.getSession(r.sessionId)?.attempts).toBe(1);
  });

  it('a conflicting replay identity halts for review instead of consuming attempts', () => {
    const r = pendingSession('x');
    start('e-1', r.sessionId, 'p1');
    expect(start('e-1', r.sessionId, 'p-other')).toEqual({ kind: 'conflict' });
    expect(store.recordAttemptStart({ ...ev('e-1', r.sessionId), messageId: 'msg-x', positionRef: 'p1', previousPositionRef: null, envelopeDigest: 'changed' })).toEqual({ kind: 'conflict' });
  });

  it('send_wait is not a failure attempt', () => {
    const r = reserveInteractive('early');
    expect(store.recordSendWait({ ...ev('e-1', r.sessionId), messageId: 'm', positionRef: 'p1', previousPositionRef: null, envelopeDigest: 'env' })).toEqual({ kind: 'send_wait' });
    store.ackMessage({ cardId: r.cardId, messageId: 'm', currentResetEpoch: 0, policyAllows: true });
    expect(store.recordAttemptStart({ ...ev('e-1', r.sessionId), messageId: 'm', positionRef: 'p1', previousPositionRef: null, envelopeDigest: 'env' })).toEqual({ kind: 'started', attemptNo: 1 });
  });

  it('final dispositions advance the contiguous cursor once; replays are re-ACK only', () => {
    const r = pendingSession('x');
    store.initCursor('scope-a', 'T-PART');
    expect(store.recordDisposition({ ...ev('e-1', null), disposition: 'unauthorized', cursor: cursor(null, 'p1') })).toEqual({ kind: 'recorded' });
    expect(store.recordDisposition({ ...ev('e-1', null), disposition: 'unauthorized', cursor: cursor('p1', 'p2') })).toEqual({ kind: 'already_final', disposition: 'unauthorized' });
    expect(store.readCursor('scope-a')?.cursor).toBe('p1');
    expect(store.recordDisposition({ ...ev('e-2', r.sessionId), disposition: 'invalid', cursor: cursor(null, 'p2') })).toEqual({ kind: 'cursor_conflict' });
    expect(store.getDisposition('e-2')).toBeNull();
    expect(store.recordDisposition({ ...ev('e-2', r.sessionId), disposition: 'invalid', cursor: cursor('p1', 'p2') })).toEqual({ kind: 'recorded' });
    // Invalid leaves the session pending (controls preserved).
    expect(store.getSession(r.sessionId)?.status).toBe('pending');
    expect(store.recordAck('scope-a', 'p1')).toBe(false);
    expect(store.recordAck('scope-a', 'p2')).toBe(true);
    expect(store.readCursor('scope-a')?.ackedThrough).toBe('p2');
    expect(() => store.recordDisposition({ ...ev('e-3', null), disposition: 'admitted' as 'invalid', cursor: cursor('p2', 'p3') })).toThrow(/invalid_input/);
  });

  it('a durable halt blocks every later commit and survives reopen', () => {
    store.initCursor('scope-a', 'T-EXCL');
    store.haltCursor('scope-a', 'non_owned_event');
    store.haltCursor('scope-a', 'second_reason');
    expect(store.recordDisposition({ ...ev('e-1', null), disposition: 'unknown', cursor: cursor(null, 'p1') })).toEqual({ kind: 'halted', reason: 'non_owned_event' });
    expect(store.getDisposition('e-1')).toBeNull();
    expect(newStore().readCursor('scope-a')?.haltedReason).toBe('non_owned_event');
    expect(store.recordDisposition({ ...ev('e-1', null), disposition: 'unknown', cursor: { scope: 'nope', expectedPrevious: null, next: 'p' } })).toEqual({ kind: 'cursor_conflict' });
    expect(store.recordDisposition({ ...ev('e-1', null), scope: 'nope', disposition: 'unknown', cursor: { scope: 'nope', expectedPrevious: null, next: 'p' } })).toEqual({ kind: 'no_cursor' });
  });

  it('definitive rejection from retry_wait restores pending', () => {
    const r = pendingSession('x');
    store.initCursor('scope-a', 'T-EXCL');
    start('e-1', r.sessionId);
    store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'membership_fetch', cursor: cursor(null, 'p1') });
    expect(store.recordDisposition({ ...ev('e-1', r.sessionId), disposition: 'rejected', reasonCode: 'rate_limited', attempts: 1, cursor: cursor(null, 'p1') })).toEqual({ kind: 'recorded' });
    expect(store.getSession(r.sessionId)?.status).toBe('pending');
  });
});

describe('T2 admission, T3 settle and T4 expiry (AC-015.1, AC-017.1)', () => {
  // T2 always commits the event's own contiguous cursor; default to the next scope-a position.
  const nextCursor = (): CursorAdvance => {
    const current = store.initCursor('scope-a', 'T-EXCL').cursor;
    return cursor(current, `p${current === null ? 1 : Number(current.slice(1)) + 1}`);
  };
  const admit = (eventId: string, sessionId: string, c: CursorAdvance = nextCursor(), epoch = 0) =>
    store.admitOnce({ ...ev(eventId, sessionId), sessionId, continuationGeneration: `cont-${eventId}`, submittedHash: 'sub', currentResetEpoch: epoch, cursor: c });

  it('admits exactly once per single-use card; later events record duplicate', () => {
    const r = pendingSession('x');
    store.initCursor('scope-a', 'T-EXCL');
    const first = admit('e-1', r.sessionId, cursor(null, 'p1'));
    expect(first.kind).toBe('admitted');
    expect(admit('e-1', r.sessionId, cursor('p1', 'p2'))).toEqual({ kind: 'duplicate', recorded: 'admitted' });
    expect(store.readCursor('scope-a')?.cursor).toBe('p1');
    expect(admit('e-2', r.sessionId, cursor('p1', 'p2'))).toEqual({ kind: 'duplicate', recorded: 'admitted' });
    expect(store.getDisposition('e-2')).toBe('duplicate');
    expect(store.readCursor('scope-a')?.cursor).toBe('p2');
    expect(count('card_admissions')).toBe(1);
    expect(store.checkInvariants()).toEqual([]);
  });

  it('never admits sending/ambiguous sends, expired, reset-fenced or unknown sessions', () => {
    const sending = reserveInteractive('s');
    expect(admit('e-s', sending.sessionId)).toEqual({ kind: 'duplicate', recorded: 'sending' });
    const fenced = pendingSession('f');
    expect(admit('e-f', fenced.sessionId, nextCursor(), 1)).toEqual({ kind: 'rejected', reason: 'reset_fenced' });
    expect(admit('e-u', 'missing')).toEqual({ kind: 'rejected', reason: 'unknown_session' });
    expect(store.getDisposition('e-u')).toBe('unknown');
    const late = pendingSession('l');
    now = T0 + DAY;
    expect(admit('e-l', late.sessionId)).toEqual({ kind: 'expired' });
    expect(count('card_admissions')).toBe(0);
  });

  it('settle is idempotent; ambiguous admissions are never rerunnable', () => {
    const r = pendingSession('x');
    const a = admit('e-1', r.sessionId);
    if (a.kind !== 'admitted') throw new Error('not admitted');
    expect(store.markAdmissionAmbiguous(a.admissionId)).toEqual({ kind: 'marked' });
    expect(store.getSession(r.sessionId)?.status).toBe('ambiguous');
    expect(admit('e-2', r.sessionId)).toEqual({ kind: 'duplicate', recorded: 'ambiguous' });
    expect(store.settleAdmission(a.admissionId, 'completed')).toEqual({ kind: 'settled', state: 'completed' });
    expect(store.settleAdmission(a.admissionId, 'failed')).toEqual({ kind: 'already', state: 'completed' });
    expect(store.getSession(r.sessionId)?.status).toBe('completed');
    expect(store.settleAdmission('nope', 'failed')).toEqual({ kind: 'not_found' });
  });

  it('expires pending/retry sessions exactly at the fixed 24 h deadline', () => {
    const r = pendingSession('x');
    now = T0 + DAY - 1;
    expect(store.expireSessions()).toEqual([]);
    now = T0 + DAY;
    expect(store.expireSessions()).toEqual([r.cardId]);
    expect(store.getSession(r.sessionId)?.status).toBe('expired');
    expect(store.getMessage(r.cardId)?.state).toBe('expired');
    expect(admit('e-1', r.sessionId)).toEqual({ kind: 'duplicate', recorded: 'expired' });
  });

  it('a reset fence terminalizes older pending sessions and keeps their evidence', () => {
    const r = pendingSession('x');
    const other = pendingSession('y');
    adapter.prepare(`UPDATE card_sessions SET reset_epoch = 5 WHERE session_id = ?`).run(other.sessionId);
    expect(store.fenceSessionKey(binding.sessionKey, 1)).toBe(1);
    expect(store.getSession(r.sessionId)?.status).toBe('failed');
    expect(store.getSession(other.sessionId)?.status).toBe('pending');
    expect(admit('e-1', r.sessionId, nextCursor(), 1)).toEqual({ kind: 'duplicate', recorded: 'failed' });
  });
});

describe('retention cleanup', () => {
  it('deletes child-first only after retention and never removes unresolved work', () => {
    store.initCursor('scope-a', 'T-EXCL');
    const done = pendingSession('done');
    const a = store.admitOnce({ ...ev('e-1', done.sessionId), sessionId: done.sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor(null, 'p1') });
    if (a.kind !== 'admitted') throw new Error('not admitted');
    store.settleAdmission(a.admissionId, 'completed');
    const amb = pendingSession('amb');
    const b = store.admitOnce({ ...ev('e-2', amb.sessionId), sessionId: amb.sessionId, continuationGeneration: 'c2', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor('p1', 'p2') });
    if (b.kind !== 'admitted') throw new Error('not admitted');
    store.markAdmissionAmbiguous(b.admissionId);

    now = T0 + DAY - 1;
    expect(store.cleanup()).toEqual({ attempts: 0, dispositions: 0, admissions: 0, requests: 0, sessions: 0, messages: 0, generations: 0 });
    now = T0 + 2 * DAY + 1;
    const report = store.cleanup();
    expect(report.admissions).toBe(1);
    expect(report.sessions).toBe(1);
    expect(store.getSession(done.sessionId)).toBeNull();
    expect(store.getSession(amb.sessionId)?.status).toBe('ambiguous');
    expect(store.getAdmissionForSession(amb.sessionId)?.state).toBe('ambiguous');
    expect(store.getDisposition('e-2')).toBe('admitted');
    expect(store.readCursor('scope-a')?.cursor).toBe('p2');
    expect(store.checkInvariants()).toEqual([]);
    // The card message is not terminal yet (lifecycle closure is a later
    // package), so it is retained even though its session is gone.
    store.cleanup();
    expect(store.getMessage(done.cardId)?.state).toBe('active');
    expect(store.getMessage(amb.cardId)).not.toBeNull();
    // A definitively failed send is removed only after its own retention.
    const failed = reserveInteractive('failed');
    store.markSendFailed(failed.cardId);
    now += DAY;
    store.cleanup();
    expect(store.getMessage(failed.cardId)).not.toBeNull();
    now += 1;
    store.cleanup();
    expect(store.getSession(failed.sessionId)).toBeNull();
    expect(store.getMessage(failed.cardId)).toBeNull();
    expect(store.checkInvariants()).toEqual([]);
  });
});

// ─── explicit-invocation ledger ─────────────────────────────────────────────

function handler(generation: string, incarnation = 'inc-1') {
  return {
    generation,
    installationRef: 'install-a',
    sessionKey: binding.sessionKey,
    runtimeIncarnation: incarnation,
    resetEpoch: 0,
    expiresAt: T0 + DAY,
    contextDigest: 'ctx',
    policyIdentity: 'policy-1',
  };
}

function fence(generation: string, incarnation = 'inc-1') {
  return { generation, runtimeIncarnation: incarnation, resetEpoch: 0 };
}

const displayCard = { opcode: 'display' as const, binding, bodyDigest: 'body' };
const interactiveCard = { opcode: 'interactive' as const, binding, bodyDigest: 'body', contract };

describe('explicit-invocation ledger (§4.1a, 32/10)', () => {
  beforeEach(() => {
    expect(store.registerHandler(handler('gen-1'))).toEqual({ kind: 'registered' });
  });

  it('a generation is minted once and never re-minted after close', () => {
    expect(store.registerHandler(handler('gen-1'))).toEqual({ kind: 'generation_exists' });
    expect(store.closeHandler('gen-1')).toBe(true);
    expect(store.closeHandler('gen-1')).toBe(false);
    expect(store.registerHandler(handler('gen-1'))).toEqual({ kind: 'generation_exists' });
  });

  it('charges at most 32 invocations; identical replay joins; changed-body reuse never mutates', () => {
    for (let i = 1; i <= MAX_EXPLICIT_INVOCATIONS; i++) {
      expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: `r${i}`, bodyDigest: `b${i}`, opcode: 'display' })).toEqual({ kind: 'charged', invocationCount: i });
    }
    expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r33', bodyDigest: 'b', opcode: 'display' })).toEqual({ kind: 'exhausted' });
    const joined = store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    expect(joined.kind).toBe('joined');
    expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'changed', opcode: 'display' })).toEqual({ kind: 'body_mismatch' });
    expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'interactive' })).toEqual({ kind: 'body_mismatch' });
    expect(store.getHandler('gen-1')?.invocationCount).toBe(32);
    expect(count('card_explicit_requests')).toBe(32);
  });

  it('closed, expired, wrong-incarnation and reset-fenced authority rejects before lookup with zero mutation', () => {
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    const before = readProtectedGraph(adapter);
    expect(store.chargeExplicitRequest({ ...fence('gen-x'), requestId: 'r', bodyDigest: 'b', opcode: 'display' })).toEqual({ kind: 'rejected', reason: 'unknown_generation' });
    expect(store.chargeExplicitRequest({ ...fence('gen-1', 'inc-2'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' })).toEqual({ kind: 'rejected', reason: 'incarnation_mismatch' });
    expect(store.chargeExplicitRequest({ generation: 'gen-1', runtimeIncarnation: 'inc-1', resetEpoch: 1, requestId: 'r2', bodyDigest: 'b', opcode: 'display' })).toEqual({ kind: 'rejected', reason: 'reset_fenced' });
    now = T0 + DAY;
    expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b', opcode: 'display' })).toEqual({ kind: 'rejected', reason: 'expired' });
    expect(readProtectedGraph(adapter)).toEqual(before);
    now = T0;
    store.closeHandler('gen-1');
    const closed = readProtectedGraph(adapter);
    // Closed replay rejects before the cache lookup, even for a known id.
    expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' })).toEqual({ kind: 'rejected', reason: 'closed' });
    expect(store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard })).toEqual({ kind: 'rejected', reason: 'closed' });
    expect(readProtectedGraph(adapter)).toEqual(closed);
  });

  it('reserves at most ten logical sends; failures and ambiguity keep their slot; no refund', () => {
    for (let i = 1; i <= 12; i++) store.chargeExplicitRequest({ ...fence('gen-1'), requestId: `r${i}`, bodyDigest: `b${i}`, opcode: 'display' });
    const slots: string[] = [];
    for (let i = 1; i <= MAX_EXPLICIT_SENDS; i++) {
      const r = store.reserveExplicitSend({ ...fence('gen-1'), requestId: `r${i}`, card: displayCard });
      expect(r).toMatchObject({ kind: 'reserved', slot: i, sessionId: null });
      if (r.kind === 'reserved') slots.push(r.cardId);
    }
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{"status":"error"}', message: { kind: 'failed' } }).kind).toBe('finished');
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r2', outcome: 'ambiguous', safeResultJson: '{"status":"error","error":{"code":"send_unconfirmed"}}', message: { kind: 'ambiguous' } }).kind).toBe('finished');
    expect(store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r11', card: displayCard })).toEqual({ kind: 'exhausted' });
    const r11 = store.getExplicitRequest('gen-1', 'r11');
    expect(r11?.state).toBe('failed');
    expect(JSON.parse(r11?.safeResultJson ?? '')).toEqual(EXPLICIT_BUDGET_EXHAUSTED);
    expect(store.getHandler('gen-1')).toMatchObject({ invocationCount: 12, logicalSendCount: 10 });
    expect(store.getExplicitRequest('gen-1', 'r1')).toMatchObject({ state: 'failed', sendSlot: 1 });
    expect(store.getExplicitRequest('gen-1', 'r2')).toMatchObject({ state: 'ambiguous', sendSlot: 2 });
    expect(store.getMessage(slots[1])?.state).toBe('ambiguous');
    // Rejected after exhaustion: still effect-free.
    expect(store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r11', card: displayCard })).toEqual({ kind: 'not_chargeable', state: 'failed' });
    expect(count('card_messages')).toBe(10);
    expect(store.checkInvariants()).toEqual([]);
  });

  it('identical reserve replay returns the same slot and client identity', () => {
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    const first = store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    const again = store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    expect(first.kind).toBe('reserved');
    expect(again.kind).toBe('already_reserved');
    if (first.kind === 'reserved' && again.kind === 'already_reserved') {
      expect(again.request).toMatchObject({ sendSlot: first.slot, clientMsgNo: first.clientMsgNo, cardId: first.cardId });
    }
    expect(store.getHandler('gen-1')?.logicalSendCount).toBe(1);
  });

  it('interactive reservation performs T-reserve atomically; capacity_full keeps the charge but no slot', () => {
    store = newStore({ sessionCapacity: 1 });
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'interactive' });
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b2', opcode: 'interactive' });
    const r1 = store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: interactiveCard });
    expect(r1.kind).toBe('reserved');
    if (r1.kind !== 'reserved') return;
    expect(store.getSession(r1.sessionId ?? '')?.status).toBe('sending');
    expect(store.getMessage(r1.cardId)?.clientMsgNo).toBe(r1.clientMsgNo);
    expect(store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r2', card: interactiveCard })).toEqual({ kind: 'capacity_full' });
    expect(store.getExplicitRequest('gen-1', 'r2')).toMatchObject({ state: 'failed', sendSlot: null });
    expect(store.getHandler('gen-1')).toMatchObject({ invocationCount: 2, logicalSendCount: 1 });
    // Acknowledgement binds the card and records the bounded result together.
    const fin = store.finishExplicitRequest({
      generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: '{"status":"sent","message_id":"m1"}',
      message: { kind: 'ack', messageId: 'm1', currentResetEpoch: 0, policyAllows: true },
    });
    expect(fin).toEqual({ kind: 'finished', ack: { kind: 'bound', admittable: true } });
    expect(store.findSessionByMessageId('m1')?.status).toBe('pending');
  });

  it('a failed card transition rolls back the ledger outcome too', () => {
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b2', opcode: 'display' });
    store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r2', card: displayCard });
    store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: '{"s":1}', message: { kind: 'ack', messageId: 'dup', currentResetEpoch: 0, policyAllows: true } });
    const res = store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r2', outcome: 'acked', safeResultJson: '{"s":1}', message: { kind: 'ack', messageId: 'dup', currentResetEpoch: 0, policyAllows: true } });
    expect(res).toEqual({ kind: 'card_transition_failed', detail: { kind: 'identity_conflict' } });
    expect(store.getExplicitRequest('gen-1', 'r2')).toMatchObject({ state: 'reserved', safeResultJson: null });
  });

  it('enforces legal outcome transitions and bounded safe results', () => {
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: '{}' })).toEqual({ kind: 'invalid_transition', from: 'charged' });
    expect(() => store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: 'not json' })).toThrow(/invalid_input/);
    expect(() => store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: `{"x":"${'a'.repeat(5000)}"}` })).toThrow(/invalid_input/);
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{"status":"error"}' })).toEqual({ kind: 'finished' });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{"status":"error"}' })).toEqual({ kind: 'already', state: 'failed' });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'cancelled', safeResultJson: '{}' })).toEqual({ kind: 'invalid_transition', from: 'failed' });
    // An unsent reserved operation cancelled at closure retains its slot.
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b2', opcode: 'display' });
    const r2 = store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r2', card: displayCard });
    if (r2.kind !== 'reserved') throw new Error('not reserved');
    store.closeHandler('gen-1');
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r2', outcome: 'cancelled', safeResultJson: '{}' })).toEqual({ kind: 'invalid_transition', from: 'reserved' });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r2', outcome: 'cancelled', safeResultJson: '{"status":"error"}', message: { kind: 'abandoned' } })).toEqual({ kind: 'finished' });
    expect(store.getMessage(r2.cardId)?.state).toBe('abandoned');
    expect(store.getHandler('gen-1')?.logicalSendCount).toBe(1);
  });

  it('startup recovery closes earlier incarnations and preserves unresolved outcomes', () => {
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b2', opcode: 'display' });
    store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r2', card: displayCard });
    store.registerHandler(handler('gen-2', 'inc-2'));
    const rec = store.recoverExplicitLedger('inc-2');
    expect(rec.closedGenerations).toBe(1);
    expect(rec.unresolved).toEqual([
      { generation: 'gen-1', requestId: 'r1', state: 'charged' },
      { generation: 'gen-1', requestId: 'r2', state: 'reserved' },
    ]);
    expect(rec.violations).toEqual([]);
    expect(store.getHandler('gen-1')?.state).toBe('closed');
    expect(store.getHandler('gen-2')?.state).toBe('live');
    expect(store.getHandler('gen-1')).toMatchObject({ invocationCount: 2, logicalSendCount: 1 });
    expect(store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r3', bodyDigest: 'b', opcode: 'display' })).toEqual({ kind: 'rejected', reason: 'closed' });
  });

  it('detects restored counters below committed request evidence', () => {
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    adapter.exec('DROP TRIGGER trg_card_handler_generations_fence');
    adapter.prepare(`UPDATE card_handler_generations SET invocation_count = 0, logical_send_count = 0`).run();
    expect(store.recoverExplicitLedger('inc-1').violations).toEqual(expect.arrayContaining(['handler_invocation_count', 'handler_send_count', 'send_slot_range']));
  });
});

describe('protected graph backup and restore comparison (AC-017.2, AC-022.1, AC-025.1)', () => {
  it('online backup of the whole graph reopens with an identical manifest under the same lineage', async () => {
    const marker = join(root, 'recovery', 'marker.json');
    provisionFirstInstallMarker(marker, 'install-a', T0);
    // Use a fresh DB so provenance is positive.
    const dbPath = join(root, 'live.db');
    const live = createAdapter(dbPath);
    new SessionStore(live).init();
    const init = await initializeCardStore({ adapter: live, marker: new FileActivationMarker(marker), installationRef: 'install-a', backupDir: join(root, 'backups'), clock, newLineageId: () => 'lineage-live' });
    if (init.state !== 'ready') throw new Error(init.reason);
    const s = init.store;
    s.initCursor('scope-a', 'T-EXCL');
    const res = s.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'c1', contract });
    if (res.kind !== 'reserved') throw new Error('reserve');
    s.ackMessage({ cardId: res.cardId, messageId: 'm1', currentResetEpoch: 0, policyAllows: true });
    s.registerHandler(handler('gen-1'));
    s.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b', opcode: 'display' });
    const snapshot = join(root, 'protected.db');
    await live.backup(snapshot);
    const liveManifest = manifestProtectedGraph(readProtectedGraph(live));

    const restored = createAdapter(snapshot);
    try {
      const reopened = await initializeCardStore({ adapter: restored, marker: new FileActivationMarker(marker), installationRef: 'install-a', backupDir: join(root, 'backups'), clock });
      expect(reopened.state).toBe('ready');
      expect(manifestProtectedGraph(readProtectedGraph(restored))).toEqual(liveManifest);
      expect(compareProtectedGraph(readProtectedGraph(restored), readProtectedGraph(live))).toEqual([]);
      expect(liveManifest.tables.card_sessions.rows).toBe(1);
      expect(liveManifest.lineageId).toBe('lineage-live');
    } finally {
      restored.close();
      live.close();
    }
  });

  it('an old backup behind a newer protected tail is quarantined, never last-write-wins', async () => {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('x');
    store.registerHandler(handler('gen-1'));
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    const oldPath = join(root, 'old.db');
    await adapter.backup(oldPath);

    // Protected tail advances after the backup.
    const a = store.admitOnce({ ...ev('e-1', r.sessionId), sessionId: r.sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor(null, 'p1') });
    if (a.kind !== 'admitted') throw new Error('admit');
    store.settleAdmission(a.admissionId, 'completed');
    store.reserveSequence(r.cardId);
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b2', opcode: 'display' });
    store.closeHandler('gen-1');
    store.haltCursor('scope-a', 'non_owned_event');

    copyFileSync(oldPath, join(root, 'old-copy.db'));
    const old = createAdapter(join(root, 'old-copy.db'));
    try {
      const conflicts = compareProtectedGraph(readProtectedGraph(old), readProtectedGraph(adapter));
      const codes = new Set(conflicts.map((c) => c.code));
      expect(codes).toEqual(new Set(['missing_fact', 'sequence_regression', 'counter_regression', 'revived_work', 'halt_lost', 'cursor_regression']));
      expect(conflicts).toEqual(expect.arrayContaining([
        { table: 'card_admissions', key: a.admissionId, code: 'missing_fact' },
        { table: 'card_event_dispositions', key: 'e-1', code: 'missing_fact' },
        { table: 'card_sessions', key: r.sessionId, code: 'revived_work' },
        { table: 'card_messages', key: r.cardId, code: 'sequence_regression' },
        { table: 'card_handler_generations', key: 'gen-1', code: 'counter_regression' },
        { table: 'card_event_cursor', key: 'scope-a', code: 'halt_lost' },
      ]));
    } finally {
      old.close();
    }
  });

  it('a foreign lineage or contradictory contract is a conflict', () => {
    pendingSession('x');
    const tail = readProtectedGraph(adapter);
    const forged = {
      ...tail,
      card_meta: tail.card_meta.map((r) => (r.k === 'lineage_id' ? { ...r, v: 'other' } : r)),
      card_sessions: tail.card_sessions.map((r) => ({ ...r, authored_contract_json: '{"buttons":[]}' })),
    };
    const codes = compareProtectedGraph(forged, tail).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['lineage_mismatch', 'conflicting_fact']));
  });
});

describe('B1: T1/T2 never commit across a halted, missing or foreign cursor boundary', () => {
  interface Snapshot {
    admissions: number;
    dispositions: number;
    sessionStatus: string | undefined;
    cursors: unknown[];
  }

  function snapshot(sessionId: string): Snapshot {
    return {
      admissions: count('card_admissions'),
      dispositions: count('card_event_dispositions'),
      sessionStatus: store.getSession(sessionId)?.status,
      cursors: adapter.prepare('SELECT * FROM card_event_cursor ORDER BY consumer_scope').all(),
    };
  }

  function admitIn(eventScope: string, sessionId: string, c: CursorAdvance | null) {
    return store.admitOnce({
      eventId: 'e-b1', scope: eventScope, eventClass: 'card_action', sessionId,
      continuationGeneration: 'cont-b1', submittedHash: 'sub', currentResetEpoch: 0,
      cursor: c as CursorAdvance,
    });
  }

  function dispose(eventScope: string, sessionId: string, c: CursorAdvance) {
    return store.recordDisposition({
      eventId: 'e-b1', scope: eventScope, eventClass: 'card_action', sessionId,
      disposition: 'invalid', cursor: c,
    });
  }

  function expectUnchanged(before: Snapshot, sessionId: string): void {
    expect(snapshot(sessionId)).toEqual(before);
    expect(before.admissions).toBe(0);
    expect(before.dispositions).toBe(0);
    expect(store.getDisposition('e-b1')).toBeNull();
    expect(store.getAdmissionForSession(sessionId)).toBeNull();
    expect(before.sessionStatus).toBe('pending');
  }

  it('admitOnce with a null cursor on a halted event scope is rejected with no mutation', () => {
    const r = pendingSession('b1');
    store.initCursor('scope-a', 'T-EXCL');
    store.haltCursor('scope-a', 'non_owned_event');
    const before = snapshot(r.sessionId);
    let result: unknown;
    try {
      result = admitIn('scope-a', r.sessionId, null);
    } catch (err) {
      result = err;
    }
    expect(result).not.toEqual(expect.objectContaining({ kind: 'admitted' }));
    expectUnchanged(before, r.sessionId);
  });

  it('admitOnce whose cursor names a different, unhalted scope is a cursor_conflict', () => {
    const r = pendingSession('b1');
    store.initCursor('scope-a', 'T-EXCL');
    store.initCursor('scope-b', 'T-EXCL');
    store.haltCursor('scope-a', 'non_owned_event');
    const before = snapshot(r.sessionId);
    expect(admitIn('scope-a', r.sessionId, { scope: 'scope-b', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'cursor_conflict' });
    expectUnchanged(before, r.sessionId);
  });

  it('admitOnce for an event scope without a cursor row never admits', () => {
    const r = pendingSession('b1');
    store.initCursor('scope-b', 'T-EXCL');
    const before = snapshot(r.sessionId);
    let nullResult: unknown;
    try {
      nullResult = admitIn('scope-missing', r.sessionId, null);
    } catch (err) {
      nullResult = err;
    }
    expect(nullResult).not.toEqual(expect.objectContaining({ kind: 'admitted' }));
    expectUnchanged(before, r.sessionId);
    expect(admitIn('scope-missing', r.sessionId, { scope: 'scope-b', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'cursor_conflict' });
    expectUnchanged(before, r.sessionId);
    expect(admitIn('scope-missing', r.sessionId, { scope: 'scope-missing', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'no_cursor' });
    expectUnchanged(before, r.sessionId);
  });

  it('admitOnce on a halted scope with its own cursor reports halted', () => {
    const r = pendingSession('b1');
    store.initCursor('scope-a', 'T-EXCL');
    store.haltCursor('scope-a', 'non_owned_event');
    const before = snapshot(r.sessionId);
    expect(admitIn('scope-a', r.sessionId, { scope: 'scope-a', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'halted', reason: 'non_owned_event' });
    expectUnchanged(before, r.sessionId);
  });

  it('recordDisposition whose cursor names a different scope is a cursor_conflict', () => {
    const r = pendingSession('b1');
    store.initCursor('scope-a', 'T-EXCL');
    store.initCursor('scope-b', 'T-EXCL');
    store.haltCursor('scope-a', 'non_owned_event');
    const before = snapshot(r.sessionId);
    expect(dispose('scope-a', r.sessionId, { scope: 'scope-b', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'cursor_conflict' });
    expectUnchanged(before, r.sessionId);
    expect(dispose('scope-missing', r.sessionId, { scope: 'scope-b', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'cursor_conflict' });
    expectUnchanged(before, r.sessionId);
    expect(dispose('scope-a', r.sessionId, { scope: 'scope-a', expectedPrevious: null, next: 'p1' })).toEqual({ kind: 'halted', reason: 'non_owned_event' });
    expectUnchanged(before, r.sessionId);
  });
});

describe('P1-1: routine retention never trips startup invariants', () => {
  it('P1-1A: pruning a settled request beside an unresolved charge keeps handler_send_count valid', () => {
    store.registerHandler(handler('gen-1'));
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r2', bodyDigest: 'b2', opcode: 'display' });
    const r1 = store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    expect(r1.kind).toBe('reserved');
    // r1 fails definitively (prunable); r2 stays charged with no result (unresolved).
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{"status":"error"}', message: { kind: 'failed' } }).kind).toBe('finished');
    store.closeHandler('gen-1');
    expect(store.checkInvariants()).toEqual([]);

    now = T0 + DAY + 1;
    const report = store.cleanup();
    expect(report.requests).toBe(1);
    expect(store.getExplicitRequest('gen-1', 'r1')).toBeNull();
    expect(store.getExplicitRequest('gen-1', 'r2')?.state).toBe('charged');
    // The trigger-protected high-water mark stays; it never refunds.
    expect(store.getHandler('gen-1')).toMatchObject({ invocationCount: 2, logicalSendCount: 1 });
    expect(store.checkInvariants()).toEqual([]);
    expect(store.recoverExplicitLedger('inc-2').violations).toEqual([]);
  });

  it('P1-1A: counters restored below retained request evidence are still detected', () => {
    store.registerHandler(handler('gen-1'));
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    adapter.exec('DROP TRIGGER trg_card_handler_generations_fence');
    adapter.prepare('UPDATE card_handler_generations SET logical_send_count = 0').run();
    expect(store.checkInvariants()).toEqual(expect.arrayContaining(['handler_send_count']));
  });

  it('P1-1B: a later duplicate event never strands a session without its admission', () => {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('multi');
    const a = store.admitOnce({ ...ev('e-1', r.sessionId), sessionId: r.sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor(null, 'p1') });
    if (a.kind !== 'admitted') throw new Error('not admitted');
    store.settleAdmission(a.admissionId, 'completed');
    // A later click on the same single-use card records a duplicate with its own, later retention.
    now = T0 + 12 * 60 * 60 * 1000;
    expect(store.admitOnce({ ...ev('e-2', r.sessionId), sessionId: r.sessionId, continuationGeneration: 'c2', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor('p1', 'p2') }))
      .toEqual({ kind: 'duplicate', recorded: 'completed' });

    // Past the admission/session retention, but before the duplicate's.
    now = T0 + DAY + 1;
    store.cleanup();
    expect(store.checkInvariants()).toEqual([]);
    expect(store.getSession(r.sessionId)?.status).toBe('completed');
    expect(store.getAdmissionForSession(r.sessionId)?.state).toBe('completed');
    expect(store.getDisposition('e-1')).toBe('admitted');

    // Once every related record is past retention, the whole set leaves together.
    now = T0 + 12 * 60 * 60 * 1000 + DAY + 1;
    store.cleanup();
    store.cleanup();
    expect(store.checkInvariants()).toEqual([]);
    expect(store.getSession(r.sessionId)).toBeNull();
    expect(store.getAdmissionForSession(r.sessionId)).toBeNull();
    expect(store.getDisposition('e-1')).toBeNull();
    expect(store.getDisposition('e-2')).toBeNull();
  });
});

describe('restore comparator: contradictory absorbing terminal outcomes quarantine', () => {
  interface Image {
    adapter: DbAdapter;
    store: CardStore;
  }
  const images: DbAdapter[] = [];

  afterEach(() => {
    while (images.length) images.pop()?.close();
  });

  /** Branch two independent images of the current live store via online backup. */
  async function branch(): Promise<[Image, Image]> {
    const out: Image[] = [];
    for (const name of ['candidate', 'tail']) {
      const path = join(root, `${name}-${seq}-${images.length}.db`);
      await adapter.backup(path);
      const a = createAdapter(path);
      images.push(a);
      let n = 0;
      out.push({ adapter: a, store: new CardStore(a, { clock, newId: () => `${name}-${++n}` }) });
    }
    return out as [Image, Image];
  }

  /** Both images must be independently valid, same-lineage stores before they are compared. */
  function compare(candidate: Image, tail: Image) {
    expect(candidate.store.checkInvariants()).toEqual([]);
    expect(tail.store.checkInvariants()).toEqual([]);
    const c = readProtectedGraph(candidate.adapter);
    const t = readProtectedGraph(tail.adapter);
    expect(manifestProtectedGraph(c).lineageId).toBe('lineage-1');
    expect(manifestProtectedGraph(t).lineageId).toBe('lineage-1');
    return compareProtectedGraph(c, t);
  }

  async function admittedImages(): Promise<{ images: [Image, Image]; sessionId: string; admissionId: string; cardId: string }> {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('restore');
    const a = store.admitOnce({ ...ev('e-1', r.sessionId), sessionId: r.sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor(null, 'p1') });
    if (a.kind !== 'admitted') throw new Error('not admitted');
    return { images: await branch(), sessionId: r.sessionId, admissionId: a.admissionId, cardId: r.cardId };
  }

  it('the same admitted receipt settled completed vs failed conflicts in both directions', async () => {
    const { images: [a, b], sessionId, admissionId } = await admittedImages();
    a.store.settleAdmission(admissionId, 'completed');
    b.store.settleAdmission(admissionId, 'failed');
    for (const [cand, tail] of [[a, b], [b, a]] as const) {
      expect(compare(cand, tail)).toEqual(expect.arrayContaining([
        { table: 'card_admissions', key: admissionId, code: 'conflicting_fact' },
        { table: 'card_sessions', key: sessionId, code: 'conflicting_fact' },
      ]));
    }
  });

  it('identical terminal admission outcomes pass', async () => {
    const { images: [a, b], admissionId } = await admittedImages();
    a.store.settleAdmission(admissionId, 'completed');
    b.store.settleAdmission(admissionId, 'completed');
    expect(compare(a, b)).toEqual([]);
  });

  it('progress from an unresolved tail to a terminal candidate passes', async () => {
    const { images: [a, b], admissionId } = await admittedImages();
    // Tail still admitted; candidate settled.
    a.store.settleAdmission(admissionId, 'failed');
    expect(compare(a, b)).toEqual([]);
    // Tail ambiguous; candidate ambiguous then settled in the same process.
    b.store.markAdmissionAmbiguous(admissionId);
    expect(compare(a, b)).toEqual([]);
  });

  it('a settled tail admission is never reopened as ambiguous by the candidate', async () => {
    const { images: [a, b], admissionId } = await admittedImages();
    a.store.markAdmissionAmbiguous(admissionId);
    b.store.settleAdmission(admissionId, 'completed');
    expect(compare(a, b)).toEqual(expect.arrayContaining([
      { table: 'card_admissions', key: admissionId, code: 'revived_work' },
    ]));
  });

  it('a pending session expired in one image and dead-lettered in the other conflicts', async () => {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('term');
    const [a, b] = await branch();
    now = T0 + DAY;
    expect(a.store.expireSessions()).toEqual([r.cardId]);
    now = T0;
    const start = (s: CardStore) => s.recordAttemptStart({ ...ev('e-1', r.sessionId), messageId: 'msg-term', positionRef: 'p1', previousPositionRef: null, envelopeDigest: 'env' });
    for (const at of [T0, T0 + 1000, T0 + 5000]) {
      now = at;
      expect(start(b.store).kind).toBe('started');
      b.store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'membership_fetch', cursor: cursor(null, 'p1') });
    }
    now = T0;
    expect(b.store.getSession(r.sessionId)?.status).toBe('dead_letter');
    for (const [cand, tail] of [[a, b], [b, a]] as const) {
      expect(compare(cand, tail)).toEqual(expect.arrayContaining([
        { table: 'card_sessions', key: r.sessionId, code: 'conflicting_fact' },
      ]));
    }
  });

  it('a card terminal outcome failed vs abandoned conflicts; identical terminal and forward progress pass', async () => {
    const res = store.reserveMessage({ kind: 'display', binding, bodyDigest: 'd', clientMsgNo: 'cmn-term' });
    if (res.kind !== 'reserved') throw new Error('reserve');
    let [a, b] = await branch();
    a.store.markSendFailed(res.cardId);
    b.store.abandonUnsent(res.cardId);
    for (const [cand, tail] of [[a, b], [b, a]] as const) {
      expect(compare(cand, tail)).toEqual(expect.arrayContaining([
        { table: 'card_messages', key: res.cardId, code: 'conflicting_fact' },
      ]));
    }
    [a, b] = await branch();
    a.store.markSendFailed(res.cardId);
    b.store.markSendFailed(res.cardId);
    expect(compare(a, b)).toEqual([]);
    [a, b] = await branch();
    // Tail ambiguous; candidate definitively failed after reconciliation.
    a.store.markSendAmbiguous(res.cardId);
    a.store.markSendFailed(res.cardId);
    b.store.markSendAmbiguous(res.cardId);
    expect(compare(a, b)).toEqual([]);
  });

  async function reservedRequestImages() {
    store.registerHandler(handler('gen-1'));
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    const r = store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard });
    if (r.kind !== 'reserved') throw new Error('reserve');
    return { images: await branch(), cardId: r.cardId };
  }

  const ack = (s: CardStore, result = '{"status":"sent","message_id":"m1"}') =>
    s.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: result, message: { kind: 'ack', messageId: 'm1', currentResetEpoch: 0, policyAllows: true } });
  const fail = (s: CardStore) =>
    s.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{"status":"error"}', message: { kind: 'failed' } });

  it('an explicit request acked vs failed conflicts in both directions', async () => {
    const { images: [a, b] } = await reservedRequestImages();
    expect(ack(a.store).kind).toBe('finished');
    expect(fail(b.store).kind).toBe('finished');
    for (const [cand, tail] of [[a, b], [b, a]] as const) {
      expect(compare(cand, tail)).toEqual(expect.arrayContaining([
        { table: 'card_explicit_requests', key: 'gen-1/r1', code: 'conflicting_fact' },
      ]));
    }
  });

  it('an absorbing request with a different recorded result conflicts', async () => {
    const { images: [a, b] } = await reservedRequestImages();
    ack(a.store, '{"status":"sent","message_id":"m1"}');
    ack(b.store, '{"status":"sent","message_id":"m1","session_id":"other"}');
    expect(compare(a, b)).toEqual(expect.arrayContaining([
      { table: 'card_explicit_requests', key: 'gen-1/r1', code: 'conflicting_fact' },
    ]));
  });

  it('identical absorbing requests pass; reserved or ambiguous tails progress to a terminal candidate', async () => {
    let { images: [a, b] } = await reservedRequestImages();
    ack(a.store);
    ack(b.store);
    expect(compare(a, b)).toEqual([]);
    [a, b] = await branch();
    // Tail still reserved; candidate acked.
    expect(compare(a, b)).toEqual([]);
    ack(a.store);
    expect(compare(a, b)).toEqual([]);
  });

  it('an ambiguous tail request progresses to failed but an absorbing tail is never reopened', async () => {
    const { images: [a, b] } = await reservedRequestImages();
    for (const s of [a.store, b.store]) {
      s.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'ambiguous', safeResultJson: '{"status":"error","error":{"code":"send_unconfirmed"}}', message: { kind: 'ambiguous' } });
    }
    fail(a.store);
    expect(compare(a, b)).toEqual([]);
    expect(compare(b, a)).toEqual(expect.arrayContaining([
      { table: 'card_explicit_requests', key: 'gen-1/r1', code: 'revived_work' },
    ]));
  });
});

describe('restore comparator: forward request progress', () => {
  it('a charged tail request progressing to reserved in the candidate passes', async () => {
    store.registerHandler(handler('gen-1'));
    store.chargeExplicitRequest({ ...fence('gen-1'), requestId: 'r1', bodyDigest: 'b1', opcode: 'display' });
    const tailPath = join(root, 'charged-tail.db');
    await adapter.backup(tailPath);
    const tail = createAdapter(tailPath);
    try {
      expect(store.reserveExplicitSend({ ...fence('gen-1'), requestId: 'r1', card: displayCard }).kind).toBe('reserved');
      expect(store.checkInvariants()).toEqual([]);
      expect(checkCardInvariants(tail)).toEqual([]);
      expect(compareProtectedGraph(readProtectedGraph(adapter), readProtectedGraph(tail))).toEqual([]);
      // The reverse direction loses the reservation and is quarantined.
      expect(compareProtectedGraph(readProtectedGraph(tail), readProtectedGraph(adapter))).toEqual(expect.arrayContaining([
        { table: 'card_explicit_requests', key: 'gen-1/r1', code: 'revived_work' },
      ]));
    } finally {
      tail.close();
    }
  });
});

describe('R1: restore comparator ranks admission and session progress', () => {
  interface Image {
    adapter: DbAdapter;
    store: CardStore;
  }
  const opened: DbAdapter[] = [];

  afterEach(() => {
    while (opened.length) opened.pop()?.close();
  });

  /** Two independent images of the current live store, branched by online backup. */
  async function images(): Promise<[Image, Image]> {
    const out: Image[] = [];
    for (const name of ['candidate', 'tail']) {
      const path = join(root, `r1-${name}-${opened.length}.db`);
      await adapter.backup(path);
      const a = createAdapter(path);
      opened.push(a);
      let n = 0;
      out.push({ adapter: a, store: new CardStore(a, { clock, newId: () => `${name}-${++n}` }) });
    }
    return out as [Image, Image];
  }

  /** Each image must be a valid same-lineage store on its own before it is compared. */
  function compareValid(candidate: Image, tail: Image) {
    expect(checkCardInvariants(candidate.adapter)).toEqual([]);
    expect(checkCardInvariants(tail.adapter)).toEqual([]);
    const c = readProtectedGraph(candidate.adapter);
    const t = readProtectedGraph(tail.adapter);
    expect(manifestProtectedGraph(c).lineageId).toBe('lineage-1');
    expect(manifestProtectedGraph(t).lineageId).toBe('lineage-1');
    return compareProtectedGraph(c, t);
  }

  const admit = (s: CardStore, sessionId: string) =>
    s.admitOnce({ ...ev('e-1', sessionId), sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor(null, 'p1') });

  async function ambiguousAdmissionTail() {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('r1');
    const a = admit(store, r.sessionId);
    if (a.kind !== 'admitted') throw new Error('not admitted');
    const [cand, tail] = await images();
    expect(tail.store.markAdmissionAmbiguous(a.admissionId)).toEqual({ kind: 'marked' });
    return { cand, tail, sessionId: r.sessionId, admissionId: a.admissionId };
  }

  it('[regression] tail ambiguous admission, candidate still admitted: revived_work on admission and session', async () => {
    const { cand, tail, sessionId, admissionId } = await ambiguousAdmissionTail();
    expect(cand.store.getAdmissionForSession(sessionId)?.state).toBe('admitted');
    expect(compareValid(cand, tail)).toEqual(expect.arrayContaining([
      { table: 'card_admissions', key: admissionId, code: 'revived_work' },
      { table: 'card_sessions', key: sessionId, code: 'revived_work' },
    ]));
  });

  for (const outcome of ['completed', 'failed'] as const) {
    it(`[control] tail ambiguous admission, candidate ${outcome}: passes`, async () => {
      const { cand, tail, admissionId } = await ambiguousAdmissionTail();
      expect(cand.store.settleAdmission(admissionId, outcome).kind).toBe('settled');
      expect(compareValid(cand, tail)).toEqual([]);
    });
  }

  it('[control] tail ambiguous admission, candidate ambiguous: passes', async () => {
    const { cand, tail, admissionId } = await ambiguousAdmissionTail();
    cand.store.markAdmissionAmbiguous(admissionId);
    expect(compareValid(cand, tail)).toEqual([]);
  });

  it('[regression] tail ambiguous admission, candidate session pending / retry_wait / sending: session revived_work', async () => {
    store.initCursor('scope-a', 'T-EXCL');
    const sending = reserveInteractive('r1-sending');
    const [sendingImage] = await images();
    store.ackMessage({ cardId: sending.cardId, messageId: 'm-r1-sending', currentResetEpoch: 0, policyAllows: true });
    const [pendingImage] = await images();
    const [retryImage] = await images();
    expect(retryImage.store.recordAttemptStart({ ...ev('e-1', sending.sessionId), messageId: 'm-r1-sending', positionRef: 'p1', previousPositionRef: null, envelopeDigest: 'env' }).kind).toBe('started');
    expect(retryImage.store.recordAttemptFailure({ eventId: 'e-1', reasonCode: 'membership_fetch', cursor: cursor(null, 'p1') }).kind).toBe('retry_wait');
    const a = admit(store, sending.sessionId);
    if (a.kind !== 'admitted') throw new Error('not admitted');
    store.markAdmissionAmbiguous(a.admissionId);
    const [, tail] = await images();
    for (const [cand, status] of [[sendingImage, 'sending'], [pendingImage, 'pending'], [retryImage, 'retry_wait']] as const) {
      expect(cand.store.getSession(sending.sessionId)?.status).toBe(status);
      expect(compareValid(cand, tail)).toEqual(expect.arrayContaining([
        { table: 'card_sessions', key: sending.sessionId, code: 'revived_work' },
      ]));
    }
  });

  it('[control] tail ambiguous send (no admission), candidate reconciled to pending: passes', async () => {
    const r = reserveInteractive('r1-send');
    store.markSendAmbiguous(r.cardId);
    const [cand, tail] = await images();
    expect(tail.store.getSession(r.sessionId)?.status).toBe('ambiguous');
    expect(cand.store.ackMessage({ cardId: r.cardId, messageId: 'm-r1-send', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'bound', admittable: true });
    expect(compareValid(cand, tail)).toEqual([]);
  });

  it('[regression] tail ambiguous send (no admission), candidate still sending: session revived_work', async () => {
    const r = reserveInteractive('r1-send');
    const [cand] = await images();
    store.markSendAmbiguous(r.cardId);
    const [, tail] = await images();
    expect(compareValid(cand, tail)).toEqual(expect.arrayContaining([
      { table: 'card_sessions', key: r.sessionId, code: 'revived_work' },
    ]));
  });

  it('[regression] tail admitted, candidate session rewound to pending: session revived_work', async () => {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('r1-adm');
    const [cand] = await images();
    expect(admit(store, r.sessionId).kind).toBe('admitted');
    const [, tail] = await images();
    expect(compareValid(cand, tail)).toEqual(expect.arrayContaining([
      { table: 'card_sessions', key: r.sessionId, code: 'revived_work' },
    ]));
  });

  it('[control] forward session progress pending -> admitted -> ambiguous passes', async () => {
    store.initCursor('scope-a', 'T-EXCL');
    const r = pendingSession('r1-fwd');
    const [, pendingTail] = await images();
    const a = admit(store, r.sessionId);
    if (a.kind !== 'admitted') throw new Error('not admitted');
    const [admittedCand, admittedTail] = await images();
    // The admission legitimately advances the opaque cursor, which the unchanged
    // cursor rule reports because opaque positions cannot be ordered; no session
    // or admission conflict may appear.
    expect(compareValid(admittedCand, pendingTail)).toEqual([
      { table: 'card_event_cursor', key: 'scope-a', code: 'cursor_regression' },
    ]);
    store.markAdmissionAmbiguous(a.admissionId);
    const [ambiguousCand] = await images();
    expect(compareValid(ambiguousCand, admittedTail)).toEqual([]);
  });
});

describe('stranded sending sessions: fixed-deadline expiry releases capacity', () => {
  function fillWithSending(capacity: number): Array<{ cardId: string; sessionId: string }> {
    store = newStore({ sessionCapacity: capacity });
    const out = [];
    for (let i = 0; i < capacity; i++) out.push(reserveInteractive(`stranded-${i}`));
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'stranded-x', contract })).toEqual({ kind: 'capacity_full' });
    return out;
  }

  it('[regression] before, exactly at and after the fixed deadline', () => {
    const rows = fillWithSending(3);
    // One millisecond before expires_at: nothing is reclaimed and capacity stays full.
    now = T0 + DAY - 1;
    expect(store.expireSessions()).toEqual([]);
    for (const r of rows) expect(store.getSession(r.sessionId)?.status).toBe('sending');
    expect(store.activeSessions()).toBe(3);
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'stranded-x', contract })).toEqual({ kind: 'capacity_full' });
    // Exactly at expires_at the stranded rows terminalize; they never had an identity, so no closure edit is owed.
    now = T0 + DAY;
    expect(store.expireSessions()).toEqual([]);
    for (const r of rows) {
      expect(store.getSession(r.sessionId)).toMatchObject({ status: 'expired', terminalAt: now, retainUntil: now + DAY });
      expect(store.getMessage(r.cardId)).toMatchObject({ state: 'expired', terminalReason: 'expired', messageId: null, terminalAt: now, retainUntil: now + DAY });
    }
    expect(store.activeSessions()).toBe(0);
    expect(store.checkInvariants()).toEqual([]);
    // After the deadline new work fits again.
    now = T0 + DAY + 1;
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'stranded-x', contract }).kind).toBe('reserved');
  });

  it('[regression] well after the deadline a full stranded capacity is released in one pass', () => {
    const rows = fillWithSending(2);
    now = T0 + 3 * DAY;
    store.expireSessions();
    expect(store.activeSessions()).toBe(0);
    for (const r of rows) expect(store.getSession(r.sessionId)?.status).toBe('expired');
    expect(store.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'stranded-x', contract }).kind).toBe('reserved');
  });

  it('[control] expiry is idempotent: a repeated pass changes nothing', () => {
    fillWithSending(2);
    now = T0 + DAY;
    store.expireSessions();
    const once = readProtectedGraph(adapter);
    now = T0 + DAY + 5;
    expect(store.expireSessions()).toEqual([]);
    expect(readProtectedGraph(adapter)).toEqual(once);
  });

  it('[regression] a late acknowledgement of an expired stranded send is rejected as terminal', () => {
    const [r] = fillWithSending(1);
    now = T0 + DAY;
    store.expireSessions();
    expect(store.ackMessage({ cardId: r.cardId, messageId: 'm-late', currentResetEpoch: 0, policyAllows: true })).toEqual({ kind: 'invalid_state', state: 'expired' });
    expect(store.getSession(r.sessionId)?.status).toBe('expired');
  });

  it('[control] ambiguous work is never reclaimed by expiry, before or after the deadline', async () => {
    store = newStore({ sessionCapacity: 3 });
    store.initCursor('scope-a', 'T-EXCL');
    const send = reserveInteractive('amb-send');
    store.markSendAmbiguous(send.cardId);
    const adm = pendingSession('amb-adm');
    const a = store.admitOnce({ ...ev('e-1', adm.sessionId), sessionId: adm.sessionId, continuationGeneration: 'c', submittedHash: 'h', currentResetEpoch: 0, cursor: cursor(null, 'p1') });
    if (a.kind !== 'admitted') throw new Error('not admitted');
    store.markAdmissionAmbiguous(a.admissionId);
    for (const at of [T0 + DAY - 1, T0 + DAY, T0 + 10 * DAY]) {
      now = at;
      store.expireSessions();
      store.cleanup();
      expect(store.getSession(send.sessionId)?.status).toBe('ambiguous');
      expect(store.getMessage(send.cardId)?.state).toBe('ambiguous');
      expect(store.getSession(adm.sessionId)?.status).toBe('ambiguous');
      expect(store.activeSessions()).toBe(2);
    }
    expect(store.checkInvariants()).toEqual([]);
  });

  it('[regression] crash-shaped: stranded rows survive a restart, then expire, stay ready and clean up', async () => {
    const marker = join(root, 'recovery', 'stranded-marker.json');
    provisionFirstInstallMarker(marker, 'install-a', T0);
    const dbPath = join(root, 'stranded.db');
    const open = async (): Promise<{ a: DbAdapter; s: CardStore }> => {
      const a = createAdapter(dbPath);
      new SessionStore(a).init();
      const r = await initializeCardStore({ adapter: a, marker: new FileActivationMarker(marker), installationRef: 'install-a', backupDir: join(root, 'stranded-backups'), clock, newLineageId: () => 'lineage-stranded', sessionCapacity: 2, newId: () => `id-${++seq}` });
      if (r.state !== 'ready') throw new Error(r.reason);
      return { a, s: r.store };
    };
    // Process 1 reserves two interactive sends and crashes before any transport.
    let { a, s } = await open();
    const stranded = [1, 2].map((i) => {
      const r = s.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: `crash-${i}`, contract });
      if (r.kind !== 'reserved') throw new Error('reserve');
      return r;
    });
    a.close();
    // Process 2 restarts before the deadline: the rows are still counted.
    now = T0 + DAY - 1;
    ({ a, s } = await open());
    s.expireSessions();
    expect(s.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'crash-3', contract })).toEqual({ kind: 'capacity_full' });
    a.close();
    // Process 3 restarts after the deadline: the store-owned expiry releases capacity.
    now = T0 + DAY + 1;
    ({ a, s } = await open());
    s.expireSessions();
    s.expireSessions();
    for (const r of stranded) expect(s.getSession(r.sessionId)?.status).toBe('expired');
    expect(s.activeSessions()).toBe(0);
    expect(s.checkInvariants()).toEqual([]);
    expect(s.reserveSession({ binding, bodyDigest: 'd', clientMsgNo: 'crash-3', contract }).kind).toBe('reserved');
    a.close();
    // Process 4: restart stays ready; retention cleanup converges on the expired rows.
    now = T0 + 2 * DAY + 2;
    ({ a, s } = await open());
    s.cleanup();
    s.cleanup();
    for (const r of stranded) {
      expect(s.getSession(r.sessionId)).toBeNull();
      expect(s.getMessage(r.cardId)).toBeNull();
    }
    expect(s.checkInvariants()).toEqual([]);
    expect(s.activeSessions()).toBe(1);
    a.close();
    ({ a, s } = await open());
    expect(s.checkInvariants()).toEqual([]);
    a.close();
  });
});
