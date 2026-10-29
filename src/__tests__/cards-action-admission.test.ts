import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { migrateCardSchema } from '../cards/migrations.js';
import { CardStore } from '../cards/store.js';
import { createActionAdmission, type ActionAdmissionOptions } from '../cards/action-admission.js';
import { createFakeEventConsumer, type FakeEvent } from '../cards/event-consumer.js';
import { canonicalJson } from '../cards/protocol.js';
import { eventKey, validateTopology } from '../cards/topology.js';
import { getContinuation } from '../cards/continuation.js';
import type { AdmissionReservation, ContinuationPort, JsonValue } from '../cards/contracts.js';

const binding = { environment: 'fixture', tenant: 'tenant', bot: 'bot', stream: 'stream' };
const proof = { ...binding, topology: 'T-PART', expiresAt: 1e12, nonDestructiveRead: true,
  orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };
const scope = validateTopology(binding, proof, () => true, 100)!.scope;
const buttons = [{ id: 'ok', label: 'Confirm', data: { operation: 'stored' } }];
const inputs = [{ id: 'text', kind: 'text', label: 'Text', required: true, maxLength: 80 }];
let root: string, db: DbAdapter, store: CardStore, event: FakeEvent, opts: ActionAdmissionOptions;
let live: boolean, member: boolean, allowed: boolean;
let dispatch: ReturnType<typeof vi.fn>, edit: ReturnType<typeof vi.fn>, consumer: ReturnType<typeof createFakeEventConsumer>;
let port: ContinuationPort;
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v as JsonValue)).digest('hex');
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden network'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wp12-action-')));
  expect(root.startsWith('/Users/mlamp/')).toBe(false);
  db = createAdapter(join(root, 'owned.db')); migrateCardSchema(db, { installationRef: 'fixture', lineageId: 'fixture', nowMs: 0 });
  store = new CardStore(db, { clock: { nowUtcMs: () => 100 } });
  const reserved = store.reserveSession({ binding: { sessionKey: 'route', channelId: 'route', channelType: 2,
    topicScope: null, generation: 'original', resetEpoch: 0 }, bodyDigest: 'digest', clientMsgNo: 'client',
    contract: { requesterUid: 'requester', contractVersion: 1, authoredContractJson: canonicalJson({ inputs, buttons } as unknown as JsonValue),
      authoredDataHash: digest(buttons.map(b => ({ id: b.id, data: b.data }))) } });
  if (reserved.kind !== 'reserved') throw new Error('fixture');
  store.ackMessage({ cardId: reserved.cardId, messageId: 'message', policyAllows: true, currentResetEpoch: 0 });
  event = { binding, wireId: 'event', position: 'position', previous: null, eventClass: 'card_action',
    payload: { sessionId: reserved.sessionId, messageId: 'message', channelId: 'route', channelType: 2,
      topicScope: null, requesterUid: 'requester', actionId: 'ok', data: { operation: 'stored' }, inputs: { text: 'private-value' } } };
  live = member = allowed = true; dispatch = vi.fn(async () => {}); edit = vi.fn(async () => {});
  port = { preflightContinuation: () => ({ accepted: true, reservation: {} as AdmissionReservation }), dispatchContinuation: dispatch };
  opts = { store, binding, now: () => 100, scope: () => scope,
    authenticate: () => ({ owned: true, actorUid: 'requester' }), authority: () => live,
    context: () => ({ sessionKey: 'route', channelId: 'route', channelType: 2, topicScope: null,
      requesterUid: 'requester', resetEpoch: 0, obo: false, docTask: false }),
    freshMember: async () => member ? 'member' : 'not_member',
    policy: async () => allowed ? 'allowed' : 'denied', currentPolicy: () => allowed,
    withSession: async (_turn, fn) => fn(port), edit };
});
afterEach(async () => {
  const fence = { reason: 'shutdown' as const, signal: AbortSignal.abort(), deadlineMono: 0 };
  consumer?.close(fence); if (consumer) await consumer.drain(fence);
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
});
function handler() { return createActionAdmission(opts); }
function body() { return event.payload as Record<string, unknown>; }
function admission() { return store.getAdmissionForSession(body().sessionId as string); }
async function pump() {
  consumer = createFakeEventConsumer({ store, binding, proof: () => proof, verifyProof: () => live, now: () => 100,
    source: { kind: 'fake', read: async () => [event], ack: async () => {}, verifyOwned: opts.authenticate },
    handler: () => handler(), freshMember: opts.freshMember, checkPolicy: opts.policy, invalidate: () => {}, fence: () => {} });
  return consumer.pump();
}

describe('WP12 requester admission (AC-013/014/015)', () => {
  it.each(['membership', 'policy', 'handler'])(
    'observes durable %s failures before ACK, retaining the 1s/4s retry boundary', async boundary => {
      let now = 100;
      // Both connections use the fixture clock; no real sleep or transport.
      store = new CardStore(db, { clock: { nowUtcMs: () => now } });
      const ack = vi.fn(async () => {});
      const statusObserver = vi.fn(async (_event, status, signal, current) => {
        expect(signal.aborted).toBe(false); expect(current()).toBe(true);
        expect(store.getSession(body().sessionId as string)?.status).toBe(status === 'Retrying' ? 'retry_wait' : 'dead_letter');
        expect(store.readCursor(scope)?.cursor).toBe(status === 'Retrying' ? null : 'position');
        expect(ack).not.toHaveBeenCalled();
      });
      consumer = createFakeEventConsumer({ store, binding, proof: () => proof, verifyProof: () => live, now: () => now,
        source: { kind: 'fake', read: async () => [event], ack, verifyOwned: opts.authenticate },
        handler: () => async () => ({ kind: 'retry' }),
        freshMember: async () => boundary === 'membership' ? 'unavailable' : 'member',
        checkPolicy: async () => boundary === 'policy' ? 'unavailable' : 'allowed',
        invalidate: () => {}, fence: () => {}, ...{ statusObserver } });
      expect(await consumer.pump()).toEqual({ kind: 'held' });
      expect(await consumer.pump()).toEqual({ kind: 'held' });
      expect(statusObserver.mock.calls.map(c => c[1])).toEqual(['Retrying']);
      now += 1000; expect(await consumer.pump()).toEqual({ kind: 'held' });
      now += 3999; expect(await consumer.pump()).toEqual({ kind: 'held' });
      now++; expect(await consumer.pump()).toEqual({ kind: 'processed', count: 1 });
      expect(statusObserver.mock.calls.map(c => c[1])).toEqual(['Retrying', 'Retrying', 'Failed']);
      expect(ack).toHaveBeenCalledTimes(1);
      await consumer.pump(); expect(statusObserver).toHaveBeenCalledTimes(3);
    });
  it('rechecks proof after an awaited failure status edit before ACK', async () => {
    let now = 100;
    store = new CardStore(db, { clock: { nowUtcMs: () => now } });
    const ack = vi.fn(async () => {});
    const statusObserver = vi.fn(async (_event, status) => { if (status === 'Failed') live = false; });
    consumer = createFakeEventConsumer({ store, binding, proof: () => proof, verifyProof: () => live, now: () => now,
      source: { kind: 'fake', read: async () => [event], ack, verifyOwned: opts.authenticate },
      handler: () => async () => ({ kind: 'retry' }), freshMember: async () => 'member', checkPolicy: async () => 'allowed',
      invalidate: () => {}, fence: () => {}, ...{ statusObserver } });
    await consumer.pump(); now += 1000; await consumer.pump(); now += 4000;
    expect(await consumer.pump()).toEqual({ kind: 'held' });
    expect(store.getDisposition(eventKey(scope, event.wireId))).toBe('dead_letter');
    expect(ack).not.toHaveBeenCalled(); live = true;
    expect(await consumer.pump()).toEqual({ kind: 'processed', count: 1 }); expect(ack).toHaveBeenCalledTimes(1);
  });
  it('finalizes unsupported controls without membership checks or changing the session', async () => {
    event = { ...event, eventClass: 'card_control' };
    opts = { ...opts, freshMember: vi.fn(async () => 'unavailable' as const) };
    expect(await pump()).toEqual({ kind: 'processed', count: 1 });
    expect(store.getDisposition(eventKey(scope, event.wireId))).toBe('unsupported_control');
    expect(store.getSession(body().sessionId as string)?.status).toBe('pending');
    expect(opts.freshMember).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });
  it('commits T2 before dispatch, uses stored data and never completes from router return', async () => {
    dispatch.mockImplementation(async turn => {
      expect(admission()).toMatchObject({ state: 'admitted', continuationGeneration: getContinuation(turn)!.generation });
      expect(store.getDisposition(eventKey(scope, 'event'))).toBe('admitted');
      expect(store.readCursor(scope)?.cursor).toBe('position');
      expect(getContinuation(turn)!.prompt).toContain('"operation":"stored"');
      expect(getContinuation(turn)!.prompt).toContain('untrusted user-submitted data');
    });
    expect(await pump()).toEqual({ kind: 'processed', count: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(admission()?.state).toBe('ambiguous');
    expect(await consumer.pump()).toEqual({ kind: 'processed', count: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(edit.mock.calls)).not.toContain('private-value');
  });
  it.each(['actor', 'bot', 'tenant', 'environment', 'stream', 'channel', 'type', 'topic', 'session', 'message', 'context'])(
    'rejects %s mismatches with no claim or shared mutation', async change => {
      if (change === 'actor') opts = { ...opts, authenticate: () => ({ owned: true, actorUid: 'other' }) };
      else if (['bot', 'tenant', 'environment', 'stream'].includes(change)) event = { ...event, binding: { ...binding, [change]: 'foreign' } };
      else if (change === 'context') opts = { ...opts, context: () => undefined };
      else body()[{ channel: 'channelId', type: 'channelType', topic: 'topicScope', session: 'sessionId', message: 'messageId' }[change]!] = 'foreign';
      await handler()(event, new AbortController().signal);
      expect(dispatch).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
      expect(store.findSessionByMessageId('message')).toMatchObject({ status: 'pending' });
      expect(store.getMessage(store.findSessionByMessageId('message')!.cardId)?.seqReserved).toBe(0);
    });
  it.each(['unknown', 'required', 'type', 'sensitive', 'overflow', 'tampered', 'extra', 'null_inputs', 'null_data'])(
    'rejects %s callback inputs without exposing values', async change => {
      if (change === 'tampered') body().data = { operation: 'replacement' };
      else if (change === 'extra') body().prompt = 'replacement';
      else if (change === 'null_inputs') body().inputs = null;
      else if (change === 'null_data') body().data = null;
      else body().inputs = { unknown: { other: 'private-value' }, required: {}, type: { text: 5 },
        sensitive: { text: 'token=sk-proj-123456789012345678901234567890' }, overflow: { text: 'x'.repeat(100) } }[change];
      const result = await handler()(event, new AbortController().signal);
      expect(result).toEqual({ kind: 'final', disposition: 'invalid' });
      expect(dispatch).not.toHaveBeenCalled(); expect(admission()).toBeNull();
      expect(JSON.stringify(edit.mock.calls)).not.toContain('private-value');
    });
  it('uses no payload self-attestation for authenticity', async () => {
    body().authenticated = true; opts = { ...opts, authenticate: () => ({ owned: false }) };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'hold' });
    expect(dispatch).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });
  it('returns unsupported_control without mutation', async () => {
    event = { ...event, eventClass: 'card_control' };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'final', disposition: 'unsupported_control' });
    expect(dispatch).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });
  it('treats membership failure as retryable and nonmembership as unauthorized', async () => {
    opts = { ...opts, freshMember: async () => 'unavailable' };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'retry' });
    member = false; opts = { ...opts, freshMember: async () => 'not_member' };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'final', disposition: 'unauthorized' });
    expect(dispatch).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });
  it.each(['obo', 'docTask', 'unknown'])( 'refuses %s route facts without manufacturing eligibility', async kind => {
    const original = opts.context;
    opts = { ...opts, context: session => ({ ...original(session)!, ...(kind === 'unknown' ? { obo: undefined } : { [kind]: true }) }) as never };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'final', disposition: 'unauthorized' });
    expect(dispatch).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });
  it('shows fixed invalid and processing statuses with the prescribed controls and no input echo', async () => {
    body().inputs = {};
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'final', disposition: 'invalid' });
    expect(edit.mock.calls[0][0]).toMatchObject({ status: 'Please check your response.', controls: true });
    body().inputs = { text: 'private-value' }; await pump();
    expect(edit.mock.calls.slice(1).map(c => [c[0].status, c[0].controls])).toEqual([['Processing', false], ['Interrupted; outcome needs review', false]]);
    expect(JSON.stringify(edit.mock.calls)).not.toContain('private-value');
    const rows = db.prepare('SELECT submitted_hash FROM card_admissions').all();
    expect(JSON.stringify(rows)).not.toContain('private-value');
  });
  it('rejects a reset between preflight and claim without dispatch', async () => {
    let epoch = 0;
    const context = opts.context;
    opts = { ...opts, context: s => ({ ...context(s)!, resetEpoch: epoch }) };
    port.preflightContinuation = () => { epoch = 1; return { accepted: true, reservation: {} as AdmissionReservation }; };
    await pump(); expect(admission()).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects expired sessions without dispatch or status mutation', async () => {
    opts = { ...opts, now: () => store.getSession(body().sessionId as string)!.expiresAt };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'final', disposition: 'expired' });
    expect(admission()).toBeNull(); expect(dispatch).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });
  it('restores authored controls after a definitive router rejection, without a claim', async () => {
    port.preflightContinuation = () => ({ accepted: false, reason: 'rate_limited' });
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'final', disposition: 'rejected' });
    expect(admission()).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
    expect(edit.mock.calls[0][0]).toMatchObject({ status: 'Unable to start. Please try again.', controls: true });
    expect(JSON.stringify(edit.mock.calls)).not.toContain('private-value');
  });
  it('keeps a fresh membership failure at the locked preflight boundary retryable', async () => {
    let checks = 0;
    opts = { ...opts, freshMember: async () => ++checks === 1 ? 'member' : 'unavailable' };
    expect(await handler()(event, new AbortController().signal)).toEqual({ kind: 'retry' });
    expect(admission()).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
  });
  it('never dispatches after permission is revoked during the Processing edit', async () => {
    edit.mockImplementation(async frame => {
      expect(frame.current()).toBe(true); allowed = false; expect(frame.current()).toBe(false);
    });
    await pump();
    expect(edit).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
    expect(admission()?.state).toBe('ambiguous');
  });
  it('renders durable retry status only while identity, context, membership and policy still permit it', async () => {
    store.initCursor(scope, 'T-PART');
    const id = eventKey(scope, event.wireId);
    store.recordAttemptStart({ eventId: id, scope, eventClass: 'card_action', sessionId: body().sessionId as string,
      messageId: 'message', positionRef: 'position', previousPositionRef: null, envelopeDigest: 'digest' });
    store.recordAttemptFailure({ eventId: id, reasonCode: 'pre_admission', cursor: { scope, expectedPrevious: null, next: 'position' } });
    const h = handler(); let proofCurrent = true;
    await h.statusObserver(event, 'Retrying', new AbortController().signal, () => proofCurrent);
    expect(edit.mock.calls.map(c => [c[0].status, c[0].controls])).toEqual([['Retrying', false]]);
    expect(JSON.stringify(edit.mock.calls)).not.toContain('private-value');
    proofCurrent = false; await h.statusObserver(event, 'Retrying', new AbortController().signal, () => proofCurrent);
    proofCurrent = true; member = false; await h.statusObserver(event, 'Retrying', new AbortController().signal, () => proofCurrent);
    member = true; allowed = false; await h.statusObserver(event, 'Retrying', new AbortController().signal, () => proofCurrent);
    expect(edit).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not restore invalid controls when another callback claims during authorization', async () => {
    store.initCursor(scope, 'T-PART');
    body().inputs = {};
    let checks = 0;
    opts = { ...opts, policy: async () => {
      if (++checks === 2) store.admitOnce({ eventId: 'other-event', scope, eventClass: 'card_action',
        sessionId: body().sessionId as string, continuationGeneration: 'other-generation', submittedHash: 'digest',
        currentResetEpoch: 0, cursor: { scope, expectedPrevious: null, next: 'other-position' } });
      return 'allowed';
    } };
    await handler()(event, new AbortController().signal);
    expect(admission()?.state).toBe('admitted');
    expect(edit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(['preflight', 'claim', 'dispatch', 'proof'])(
    'rechecks revocation at the %s boundary', async boundary => {
      if (boundary === 'preflight') port.preflightContinuation = () => { allowed = false; return { accepted: true, reservation: {} as AdmissionReservation }; };
      if (boundary === 'claim' || boundary === 'dispatch') {
        const original = store.admitOnce.bind(store);
        vi.spyOn(store, 'admitOnce').mockImplementation(input => { const result = original(input); if (boundary === 'claim') member = false; else allowed = false; return result; });
      }
      if (boundary === 'proof') opts = { ...opts, freshMember: async () => { live = false; return 'member'; } };
      await pump(); expect(dispatch).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      if (boundary === 'claim' || boundary === 'dispatch') expect(admission()?.state).toBe('ambiguous');
      else expect(admission()).toBeNull();
    });
});
