/**
 * SC-1 (XIN-2384 rev2 §6.4 + addendum A3): app-server settlement marker and
 * late-outcome audit on the explicit ledger, schema version 3.
 *
 * ST-1 A-settled ambiguous rows reject late acked/failed and record late_*.
 * ST-2 exec-path ambiguous rows still accept acked/failed.
 * ST-3 request state, safe result and budgets are byte-identical after a late write.
 * ST-4 recovery and retention are unchanged; ambiguous rows are never swept.
 * ST-5 R-4 outcomes in store terms, including the unrefunded abandoned slot.
 * ST-6 a late ack binds the card only under the reset/policy/expiry guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import {
  CARD_SCHEMA_VERSION, FileActivationMarker, inspectCardSchema, migrateCardSchema, provisionFirstInstallMarker,
  referenceSchema, upgradeCardSchemaV2toV3,
} from '../cards/migrations.js';
import { CardStore, initializeCardStore, type CardBinding, type SessionContract } from '../cards/store.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 24, 8, 0, 0);
let root: string;
let adapter: DbAdapter;
let store: CardStore;
let now: number;
let seq: number;
const clock = { nowUtcMs: () => now };

const binding: CardBinding = { sessionKey: 'group:g1', channelId: 'g1', channelType: 2, topicScope: null, generation: 'gen-1', resetEpoch: 0 };
const contract: SessionContract = { requesterUid: 'u1', contractVersion: 1, authoredContractJson: '{"buttons":[{"id":"ok"}]}', authoredDataHash: 'h' };
const fence = { generation: 'gen-1', runtimeIncarnation: 'inc-1', resetEpoch: 0 };
const displayCard = { opcode: 'display' as const, binding, bodyDigest: 'body' };
const interactiveCard = { opcode: 'interactive' as const, binding, bodyDigest: 'body', contract };
const UNSENT = '{"status":"error","error":{"code":"send_unconfirmed"}}';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cards-sc1-'));
  adapter = createAdapter(join(root, 'cc-octo.db'));
  new SessionStore(adapter).init();
  migrateCardSchema(adapter, { installationRef: 'install-a', lineageId: 'lineage-1', nowMs: T0 });
  now = T0;
  seq = 0;
  store = new CardStore(adapter, { clock, newId: () => `id-${++seq}` });
  expect(store.registerHandler({
    generation: 'gen-1', installationRef: 'install-a', sessionKey: binding.sessionKey, runtimeIncarnation: 'inc-1',
    resetEpoch: 0, expiresAt: T0 + DAY, contextDigest: 'ctx', policyIdentity: 'policy-1',
  })).toEqual({ kind: 'registered' });
});
afterEach(() => { try { adapter.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); });

function reserved(requestId: string, opcode: 'display' | 'interactive' = 'display') {
  expect(store.chargeExplicitRequest({ ...fence, requestId, bodyDigest: `b-${requestId}`, opcode }).kind).toBe('charged');
  const r = store.reserveExplicitSend({ ...fence, requestId, card: opcode === 'display' ? displayCard : interactiveCard });
  if (r.kind !== 'reserved') throw new Error(`not reserved: ${r.kind}`);
  return r;
}

/** An A-path R-4 settlement: reserved, send possibly called → ambiguous, marked app_server. */
function aSettledAmbiguous(requestId: string, opcode: 'display' | 'interactive' = 'display') {
  const r = reserved(requestId, opcode);
  expect(store.finishExplicitRequest({ generation: 'gen-1', requestId, outcome: 'ambiguous', safeResultJson: UNSENT, message: { kind: 'ambiguous' }, settledBy: 'app_server' }))
    .toEqual({ kind: 'finished' });
  return r;
}

const row = (requestId: string) => adapter.prepare('SELECT * FROM card_explicit_requests WHERE generation = ? AND request_id = ?').get('gen-1', requestId);
const counters = () => adapter.prepare('SELECT invocation_count, logical_send_count FROM card_handler_generations WHERE generation = ?').get('gen-1');

describe('current schema with SC-1 columns', () => {
  it('a fresh install is version 4 with the settlement columns', () => {
    expect(CARD_SCHEMA_VERSION).toBe(4);
    expect(inspectCardSchema(adapter)).toMatchObject({ state: 'complete', meta: { schemaVersion: 4, schemaHash: referenceSchema(4).hash } });
    const cols = (adapter.prepare('PRAGMA table_info(card_explicit_requests)').all() as Array<{ name: string; notnull: number }>);
    for (const c of ['settled_by', 'late_outcome', 'late_message_id', 'late_at']) {
      expect(cols.find((x) => x.name === c)).toMatchObject({ notnull: 0 });
    }
  });

  it('the settlement trigger rejects direct state changes and rewrites of an A-settled ambiguous row', () => {
    aSettledAmbiguous('r1');
    expect(() => adapter.prepare(`UPDATE card_explicit_requests SET state = 'acked' WHERE request_id = 'r1'`).run()).toThrow(/settlement is immutable/);
    expect(() => adapter.prepare(`UPDATE card_explicit_requests SET settled_by = NULL WHERE request_id = 'r1'`).run()).toThrow(/settlement is immutable/);
    expect(() => adapter.prepare(`UPDATE card_explicit_requests SET late_outcome = 'acked' WHERE request_id = 'r1'`).run()).toThrow(/settlement is immutable/); // no late_at
    expect(() => adapter.prepare(`UPDATE card_explicit_requests SET settled_by = 'other' WHERE request_id = 'r1'`).run()).toThrow(/CHECK|immutable/);
  });

  it('late_* can only be written on an A-settled ambiguous row', () => {
    reserved('r1');
    expect(() => adapter.prepare(`UPDATE card_explicit_requests SET late_outcome = 'failed', late_at = 1 WHERE request_id = 'r1'`).run()).toThrow(/settlement is immutable/);
  });
});

describe('ST-1/ST-2 late outcomes', () => {
  it('ST-1: an A-settled ambiguous row rejects late acked and failed through finishExplicitRequest', () => {
    aSettledAmbiguous('r1');
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: '{}', message: { kind: 'ack', messageId: 'm1', currentResetEpoch: 0, policyAllows: true } }))
      .toEqual({ kind: 'invalid_transition', from: 'ambiguous' });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{}', message: { kind: 'failed' } }))
      .toEqual({ kind: 'invalid_transition', from: 'ambiguous' });
    now = T0 + 5;
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'failed' })).toEqual({ kind: 'recorded' });
    expect(store.getExplicitRequest('gen-1', 'r1')).toMatchObject({ state: 'ambiguous', settledBy: 'app_server', lateOutcome: 'failed', lateMessageId: null, lateAt: T0 + 5 });
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', ack: { messageId: 'm1', currentResetEpoch: 0, policyAllows: true } })).toEqual({ kind: 'already' });
  });

  it('ST-2: an exec-path ambiguous row still accepts acked (regression)', () => {
    reserved('r1');
    store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'ambiguous', safeResultJson: UNSENT, message: { kind: 'ambiguous' } });
    expect(store.getExplicitRequest('gen-1', 'r1')).toMatchObject({ state: 'ambiguous', settledBy: null });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: '{"status":"sent"}', message: { kind: 'ack', messageId: 'm1', currentResetEpoch: 0, policyAllows: true } }))
      .toMatchObject({ kind: 'finished' });
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'failed' })).toMatchObject({ kind: 'not_applicable', state: 'acked', settledBy: null });
  });

  it('ST-2: an exec-path ambiguous row still accepts failed (regression)', () => {
    reserved('r1');
    store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'ambiguous', safeResultJson: UNSENT, message: { kind: 'ambiguous' } });
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'failed', safeResultJson: '{}', message: { kind: 'failed' } })).toEqual({ kind: 'finished' });
  });

  it('late outcomes do not apply to unsettled or non-ambiguous rows', () => {
    reserved('r1');
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'failed' })).toEqual({ kind: 'not_applicable', state: 'reserved', settledBy: null });
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'nope', outcome: 'failed' })).toEqual({ kind: 'not_found' });
  });
});

describe('ST-3 immutability of the request row and budgets', () => {
  it('state, safe result and counters are byte-identical after a late ack that binds the card', () => {
    aSettledAmbiguous('r1', 'interactive');
    const before = { ...(row('r1') as Record<string, unknown>) };
    const budget = counters();
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', ack: { messageId: 'm1', currentResetEpoch: 0, policyAllows: true } }))
      .toEqual({ kind: 'recorded', ack: { kind: 'bound', admittable: true } });
    const after = row('r1') as Record<string, unknown>;
    for (const k of ['state', 'safe_result_json', 'send_slot', 'client_msg_no', 'card_id', 'updated_at', 'settled_by']) expect(after[k]).toBe(before[k]);
    expect(counters()).toEqual(budget);
    expect(after).toMatchObject({ late_outcome: 'acked', late_message_id: 'm1' });
  });
});

describe('ST-4 recovery and retention', () => {
  it('recoverExplicitLedger and cleanup behave the same with the new columns; ambiguous rows are kept', () => {
    aSettledAmbiguous('r1');
    store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'failed' });
    expect(store.chargeExplicitRequest({ ...fence, requestId: 'r2', bodyDigest: 'b2', opcode: 'display' }).kind).toBe('charged');
    const rec = store.recoverExplicitLedger('inc-2');
    expect(rec).toMatchObject({ closedGenerations: 1, violations: [] });
    expect(rec.unresolved).toEqual([{ generation: 'gen-1', requestId: 'r2', state: 'charged' }]);
    now = T0 + 10 * DAY;
    store.cleanup();
    expect(store.getExplicitRequest('gen-1', 'r1')).toMatchObject({ state: 'ambiguous', lateOutcome: 'failed' });
  });
});

describe('ST-5 R-4 outcomes', () => {
  it('a timer or abort on a charged row gives cancelled (1 invocation, 0 sends)', () => {
    expect(store.chargeExplicitRequest({ ...fence, requestId: 'r1', bodyDigest: 'b1', opcode: 'display' }).kind).toBe('charged');
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'cancelled', safeResultJson: '{}', settledBy: 'app_server' })).toEqual({ kind: 'finished' });
    expect(counters()).toEqual({ invocation_count: 1, logical_send_count: 0 });
    expect(store.getExplicitRequest('gen-1', 'r1')).toMatchObject({ state: 'cancelled', settledBy: 'app_server' });
  });

  it('a reserved row whose send was never called gives cancelled + abandoned; the slot stays consumed', () => {
    const r = reserved('r1');
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'cancelled', safeResultJson: '{}', message: { kind: 'abandoned' }, settledBy: 'app_server' })).toEqual({ kind: 'finished' });
    expect(store.getMessage(r.cardId)?.state).toBe('abandoned');
    expect(counters()).toEqual({ invocation_count: 1, logical_send_count: 1 });
  });

  it('a reserved row whose send was (possibly) called gives ambiguous; no resend is possible', () => {
    aSettledAmbiguous('r1');
    expect(counters()).toEqual({ invocation_count: 1, logical_send_count: 1 });
    expect(store.reserveExplicitSend({ ...fence, requestId: 'r1', card: displayCard })).toMatchObject({ kind: 'already_reserved' });
  });
});

describe('ST-6 late-ack card binding under the reset/policy/expiry guards', () => {
  const late = (requestId: string, over: Partial<{ currentResetEpoch: number; policyAllows: boolean }> = {}) =>
    store.recordLateExplicitOutcome({ generation: 'gen-1', requestId, outcome: 'acked', ack: { messageId: `m-${requestId}`, currentResetEpoch: 0, policyAllows: true, ...over } });

  it('1: matching guards bind an interactive card; it becomes routable through the normal ingress', () => {
    const r = aSettledAmbiguous('r1', 'interactive');
    const before = { req: { ...(row('r1') as Record<string, unknown>) }, budget: counters() };
    expect(late('r1')).toEqual({ kind: 'recorded', ack: { kind: 'bound', admittable: true } });
    expect(store.getMessage(r.cardId)).toMatchObject({ state: 'active', messageId: 'm-r1' });
    expect(store.findSessionByMessageId('m-r1')?.status).toBe('pending');
    const after = row('r1') as Record<string, unknown>;
    expect([after.state, after.safe_result_json]).toEqual([before.req.state, before.req.safe_result_json]);
    expect(counters()).toEqual(before.budget);
  });

  it('2: after a reset epoch change the identity binds but the card is reset_fenced and terminal', () => {
    const r = aSettledAmbiguous('r1', 'interactive');
    expect(late('r1', { currentResetEpoch: 1 })).toEqual({ kind: 'recorded', ack: { kind: 'bound', admittable: false, reason: 'reset_fenced' } });
    expect(store.getMessage(r.cardId)).toMatchObject({ state: 'error', messageId: 'm-r1' });
  });

  it('3: after a policy revocation it is policy_revoked', () => {
    aSettledAmbiguous('r1', 'interactive');
    expect(late('r1', { policyAllows: false })).toEqual({ kind: 'recorded', ack: { kind: 'bound', admittable: false, reason: 'policy_revoked' } });
  });

  it('4: after session expiry it is expired', () => {
    const r = aSettledAmbiguous('r1', 'interactive');
    now = T0 + 2 * DAY;
    expect(late('r1')).toEqual({ kind: 'recorded', ack: { kind: 'bound', admittable: false, reason: 'expired' } });
    expect(store.getMessage(r.cardId)?.state).toBe('expired');
  });

  it('5: in every fenced case the request row and budgets are unchanged', () => {
    aSettledAmbiguous('r1', 'interactive');
    const before = { state: (row('r1') as { state: string }).state, safe: (row('r1') as { safe_result_json: string }).safe_result_json, budget: counters() };
    late('r1', { currentResetEpoch: 7 });
    expect((row('r1') as { state: string }).state).toBe(before.state);
    expect((row('r1') as { safe_result_json: string }).safe_result_json).toBe(before.safe);
    expect(counters()).toEqual(before.budget);
  });

  it('6: a late failed changes only late_*', () => {
    const r = aSettledAmbiguous('r1', 'interactive');
    const card = store.getMessage(r.cardId);
    expect(store.recordLateExplicitOutcome({ generation: 'gen-1', requestId: 'r1', outcome: 'failed' })).toEqual({ kind: 'recorded' });
    expect(store.getMessage(r.cardId)).toEqual(card);
    expect(store.getExplicitRequest('gen-1', 'r1')).toMatchObject({ state: 'ambiguous', lateOutcome: 'failed', lateMessageId: null });
  });
});

describe('version 2 → 3 upgrade', () => {
  function downgradeToV2(a: DbAdapter): void {
    for (const trigger of ['trg_card_event_invalidations_final', 'trg_card_event_invalidations_exclusive',
      'trg_card_event_dispositions_exclusive', 'trg_card_event_attempts_exclusive', 'trg_card_event_attempts_identity']) a.exec(`DROP TRIGGER ${trigger}`);
    a.exec('DROP TABLE card_event_invalidations');
    a.exec('DROP TRIGGER trg_card_explicit_requests_settled');
    for (const c of ['late_at', 'late_message_id', 'late_outcome', 'settled_by']) a.exec(`ALTER TABLE card_explicit_requests DROP COLUMN ${c}`);
    a.prepare(`UPDATE card_meta SET v = '2' WHERE k = 'schema_version'`).run();
    a.prepare(`UPDATE card_meta SET v = ? WHERE k = 'schema_hash'`).run(referenceSchema(2).hash);
  }

  it('a version 2 store with explicit rows upgrades in place and keeps every value', () => {
    reserved('r1');
    store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'ambiguous', safeResultJson: UNSENT, message: { kind: 'ambiguous' } });
    downgradeToV2(adapter);
    expect(inspectCardSchema(adapter)).toMatchObject({ state: 'complete', meta: { schemaVersion: 2 } });
    const before = row('r1');
    const meta = upgradeCardSchemaV2toV3(adapter, 'lineage-1');
    expect(meta.schemaVersion).toBe(3);
    expect(row('r1')).toEqual({ ...(before as object), settled_by: null, late_outcome: null, late_message_id: null, late_at: null });
    // Pre-upgrade ambiguous rows are exec-path rows: they still accept acked.
    expect(store.finishExplicitRequest({ generation: 'gen-1', requestId: 'r1', outcome: 'acked', safeResultJson: '{"status":"sent"}', message: { kind: 'ack', messageId: 'm1', currentResetEpoch: 0, policyAllows: true } }).kind).toBe('finished');
  });

  it('initializeCardStore backs up before the upgrade and reopens version 4', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cards-sc1-init-'));
    try {
      const a = createAdapter(join(dir, 'cc-octo.db'));
      new SessionStore(a).init();
      const markerPath = join(dir, 'recovery', 'card-activation.json');
      provisionFirstInstallMarker(markerPath, 'install-a', T0);
      const opts = { adapter: a, marker: new FileActivationMarker(markerPath), installationRef: 'install-a', backupDir: join(dir, 'backups'),
        clock: { nowUtcMs: () => T0 }, newLineageId: () => 'lineage-1', newId: () => `card-${randomUUID()}` };
      expect(await initializeCardStore(opts)).toMatchObject({ state: 'ready', meta: { schemaVersion: 4 } });
      downgradeToV2(a);
      const upgraded = await initializeCardStore({ ...opts, clock: { nowUtcMs: () => T0 + 1000 } });
      expect(upgraded).toMatchObject({ state: 'ready', provenance: 'reopened', meta: { schemaVersion: 4 } });
      expect(upgraded.state === 'ready' && upgraded.backup?.fileName).toMatch(/^cc-octo\.pre-card_v1-s3\./);
      expect(readdirSync(join(dir, 'backups')).some((f) => f.includes('pre-card_v1-s3'))).toBe(true);
      a.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a failure inside the upgrade rolls back to version 2', () => {
    downgradeToV2(adapter);
    // The metadata bump fails after the columns were added inside the same transaction.
    const failing = new Proxy(adapter, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => { if (sql.startsWith('UPDATE card_meta SET v = ? WHERE k = ? AND v = ?')) throw new Error('blocked'); return target.prepare(sql); };
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
    expect(() => upgradeCardSchemaV2toV3(failing, 'lineage-1')).toThrow(/blocked/);
    expect(adapter.inTransaction).toBe(false);
    expect(inspectCardSchema(adapter)).toMatchObject({ state: 'complete', meta: { schemaVersion: 2 } });
    const cols = (adapter.prepare('PRAGMA table_info(card_explicit_requests)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('settled_by');
  });
});
