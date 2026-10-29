import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { migrateCardSchema } from '../cards/migrations.js';
import { CardStore } from '../cards/store.js';
import { createFakeEventConsumer, type FakeEvent, type FakeConsumerOptions } from '../cards/event-consumer.js';
import { eventKey, validateTopology } from '../cards/topology.js';
import { createPacer } from '../cards/pacer.js';
import { normalizeOrigin } from '../cards/origin.js';
import { OctoApiError } from '../cards/api.js';
import { createPolicy } from '../cards/policy.js';
import { profile } from './fixtures/card-profile.js';
import { canonicalEnvelope } from '../cards/topology.js';
import { createHash } from 'node:crypto';
import { createCardRuntime } from '../cards/runtime.js';
import { createWriteQueue } from '../cards/write-queue.js';
import { inspectCardSchema } from '../cards/migrations.js';

const binding = { environment: 'test', tenant: 'a', bot: 'a', stream: 'a' };
const proof = { ...binding, topology: 'T-PART', expiresAt: 1e12, nonDestructiveRead: true,
  orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };
const proven = () => validateTopology(binding, proof, () => true, 0)!;
const settings = (wireId = '11', previous: string | null = null): FakeEvent => ({
  binding, wireId, position: wireId, previous, eventClass: 'bot_setting_updated', payload: { scope: 'bot_setting', value: false },
});
let root: string, db: DbAdapter, store: CardStore, now: number;
let queue: FakeEvent[], trace: string[];
let consumers: ReturnType<typeof createFakeEventConsumer>[];
let opts: FakeConsumerOptions;
const fence = () => ({ reason: 'shutdown' as const, signal: AbortSignal.abort(), deadlineMono: 0 });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wp11-events-')));
  expect(root.startsWith('/Users/mlamp/')).toBe(false);
  expect(root.includes('/.codex/')).toBe(false);
  db = createAdapter(join(root, 'events.db'));
  migrateCardSchema(db, { installationRef: 'test', lineageId: 'test', nowMs: 0 });
  now = 100; store = new CardStore(db, { clock: { nowUtcMs: () => now } });
  queue = []; trace = []; consumers = [];
  opts = { store, binding, proof: () => proof, verifyProof: () => true, now: () => now,
    source: { kind: 'fake', read: async (after) => { trace.push(`read:${after}`); return queue; },
      ack: async (event) => { trace.push(`ack:${event.wireId}`); expect(store.getEventReplay(eventKey(proven().scope, event.wireId))).toMatchObject({ kind: 'retained', final: expect.any(Object) }); },
      verifyOwned: () => ({ owned: true, actorUid: 'u' }) },
    handler: () => async () => ({ kind: 'final', disposition: 'unsupported_control' }),
    invalidate: () => { trace.push('invalidate'); }, fence: () => { trace.push('fence'); } };
});
afterEach(async () => {
  for (const c of consumers) { c.close(fence()); await c.drain(fence()); }
  db.close(); rmSync(root, { recursive: true, force: true });
});
function consumer(overrides: Partial<FakeConsumerOptions> = {}) {
  const c = createFakeEventConsumer({ ...opts, ...overrides }); consumers.push(c); return c;
}
function replay(id = '11') { return store.getEventReplay(eventKey(proven().scope, id)); }

function action(channelType: 1 | 2 | 5 = 2): FakeEvent {
  const r = store.reserveSession({ binding: { sessionKey: 'session', channelId: 'route', channelType,
    topicScope: channelType === 5 ? 'route' : null, generation: 'gen', resetEpoch: 0 }, bodyDigest: 'authored', clientMsgNo: 'client',
    contract: { requesterUid: 'u', contractVersion: 1, authoredContractJson: '{}', authoredDataHash: 'hash' } });
  if (r.kind !== 'reserved') throw new Error('fixture reservation');
  store.ackMessage({ cardId: r.cardId, messageId: 'message', currentResetEpoch: 0, policyAllows: true });
  return { ...settings(), eventClass: 'card_action', payload: { sessionId: r.sessionId, messageId: 'message',
    channelId: 'route', channelType, topicScope: channelType === 5 ? 'route' : null, requesterUid: 'u', actionId: 'ok' } };
}

function attemptIdentity(event: FakeEvent) {
  const body = event.payload as { sessionId: string; messageId: string };
  return { eventId: eventKey(proven().scope, event.wireId), scope: proven().scope, eventClass: event.eventClass,
    sessionId: body.sessionId, messageId: canonicalEnvelope(body.messageId), positionRef: event.position,
    previousPositionRef: event.previous, envelopeDigest: createHash('sha256').update(canonicalEnvelope({ event, actorUid: 'u' })).digest('hex') };
}

describe('serial fake event intake', () => {
  it('preserves source order across legal numeric gaps and opaque positions', async () => {
    queue = [settings('11'), settings('99', '11'), settings('opaque-a', '99'), settings('opaque-Z', 'opaque-a')];
    const c = consumer(); await c.pump();
    expect(trace.filter((x) => x.startsWith('ack'))).toEqual(['ack:11', 'ack:99', 'ack:opaque-a', 'ack:opaque-Z']);
    expect(store.readCursor(c.scope!)?.ackedThrough).toBe('opaque-Z');
  });
  it('enforces the T-EXCL document boundary and preserves its halt across reopen', async () => {
    queue = [settings(), { ...settings('12', '11'), eventClass: 'document_task' }, settings('13', '12')];
    const exclusive = { ...proof, topology: 'T-EXCL', exclusiveAcrossHosts: true, excludesNonOwnedClasses: true };
    const c = consumer({ proof: () => exclusive });
    // This ACK oracle uses this topology's separate stable scope.
    opts.source.ack = async (event) => { trace.push(`ack:${event.wireId}`); };
    expect(await c.pump()).toMatchObject({ kind: 'halted', persisted: true });
    c.close(fence()); await c.drain(fence()); store.retire(); db.close();
    db = createAdapter(join(root, 'events.db')); store = new CardStore(db, { clock: { nowUtcMs: () => now } }); opts = { ...opts, store };
    expect(await consumer({ proof: () => exclusive }).pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(trace.filter((x) => x.startsWith('ack'))).toEqual(['ack:11']);
  });
  it('halts an unresolved predecessor before finalization', async () => {
    queue = [settings('99', 'missing')]; const c = consumer();
    expect((await c.pump()).kind).toBe('halted'); expect(store.readCursor(c.scope!)?.cursor).toBeNull();
    expect(trace).toEqual(['read:null', 'fence']);
  });
  it('commits settings before ACK, marks confirmation and preserves unrelated queues', async () => {
    const otherQueue = [{ wireId: '10', eventClass: 'document_task' }];
    queue = [settings()]; const c = consumer();
    expect((await c.pump()).kind).toBe('processed');
    expect(trace).toEqual(['read:null', 'invalidate', 'ack:11']);
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '11', ackedThrough: '11' });
    expect(replay()).toMatchObject({ final: { outcome: 'invalidated' } });
    await c.pump();
    expect(trace.filter((x) => x === 'invalidate')).toHaveLength(1);
    expect(trace.filter((x) => x === 'ack:11')).toHaveLength(1);
    expect(otherQueue).toEqual([{ wireId: '10', eventClass: 'document_task' }]);
  });
  it.each(['document_task', 'bot_task', 'unknown'])('fences %s before later events and persists halt', async (eventClass) => {
    queue = [settings(), { ...settings('12', '11'), eventClass }, settings('13', '12')];
    const c = consumer(); expect((await c.pump()).kind).toBe('halted');
    expect(trace).toEqual(['read:null', 'invalidate', 'ack:11', 'fence']);
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '11', ackedThrough: '11', haltedReason: expect.any(String) });
    expect(replay('12').kind).toBe('absent');
    const next = consumer(); await next.pump(); expect(trace.filter((x) => x.startsWith('read'))).toHaveLength(1);
  });
  it('does not claim a durable halt when the halt write fails', async () => {
    queue = [{ ...settings(), eventClass: 'unknown' }];
    vi.spyOn(store, 'haltCursor').mockImplementation(() => { throw new Error('disk'); });
    const c = consumer(); expect(await c.pump()).toMatchObject({ kind: 'halted', persisted: false });
    await c.pump(); expect(trace).toEqual(['read:null', 'fence']);
  });
  it('replays from confirmed ACK after remote success/local mark loss without redispatch', async () => {
    queue = [settings()];
    const mark = vi.spyOn(store, 'recordAck').mockReturnValueOnce(false);
    const first = consumer(); expect((await first.pump()).kind).toBe('held');
    expect(store.readCursor(first.scope!)).toMatchObject({ cursor: '11', ackedThrough: null });
    first.close(fence()); await first.drain(fence());
    const next = consumer(); expect((await next.pump()).kind).toBe('processed');
    expect(trace).toEqual(['read:null', 'invalidate', 'ack:11', 'read:null', 'invalidate', 'ack:11']);
    expect(mark).toHaveBeenCalledTimes(2);
  });
  it('ACK failure holds every later event and replays only the final', async () => {
    queue = [settings(), settings('13', '11')];
    const ack = vi.spyOn(opts.source, 'ack').mockRejectedValueOnce(new Error('lost'));
    const c = consumer(); expect((await c.pump()).kind).toBe('held');
    expect(replay('13').kind).toBe('absent');
    expect((await c.pump()).kind).toBe('processed');
    expect(ack).toHaveBeenCalledTimes(3);
    expect(trace.filter((x) => x === 'invalidate')).toHaveLength(2);
  });
  it.each(['binding', 'payload', 'eventClass', 'position', 'previous'])('compares %s before replay effects or ACK', async (field) => {
    queue = [settings()]; const c = consumer(); await c.pump();
    const old = queue[0]; queue = [{ ...old, [field]: field === 'binding' ? { ...binding, tenant: 'b' }
      : field === 'payload' ? { scope: 'bot_setting', value: true } : 'changed' }];
    expect((await c.pump()).kind).toBe('halted');
    expect(trace.filter((x) => x === 'invalidate')).toHaveLength(1);
    expect(trace.filter((x) => x === 'ack:11')).toHaveLength(1);
  });
  it('requires missing-handler and proof gates before reading even settings', async () => {
    queue = [settings()];
    await consumer({ handler: () => undefined }).pump();
    await consumer({ verifyProof: () => false }).pump();
    expect(trace).toEqual([]); expect(replay().kind).toBe('absent');
  });
  it('requires reconciliation before changing the trusted stream on restart', async () => {
    queue = [settings()]; const first = consumer(); await first.pump(); first.close(fence()); await first.drain(fence());
    const nextBinding = { ...binding, stream: 'renewed-attestation-must-not-rename-stream' };
    const nextProof = { ...proof, ...nextBinding };
    const reads = vi.spyOn(opts.source, 'read'); const before = reads.mock.calls.length;
    const next = consumer({ binding: nextBinding, proof: () => nextProof });
    expect(await next.pump()).toMatchObject({ kind: 'halted', persisted: false });
    expect(reads).toHaveBeenCalledTimes(before);
    expect(store.readCursor(first.scope!)?.ackedThrough).toBe('11');
    expect(store.readCursor(validateTopology(nextBinding, nextProof, () => true, now)!.scope)).toBeNull();
  });
  it('holds an action whose handler disappears before T0 and later settings', async () => {
    let available = true;
    opts.source.read = async () => { available = false; return [{ ...settings(), eventClass: 'card_action', payload: {} }, settings('12', '11')]; };
    const c = consumer({ handler: () => available ? async () => ({ kind: 'final', disposition: 'invalid' }) : undefined });
    expect((await c.pump()).kind).toBe('held');
    expect(replay().kind).toBe('absent'); expect(replay('12').kind).toBe('absent');
  });
  it('serializes concurrent pumps and fences an outstanding read on close', async () => {
    let resolve!: (events: FakeEvent[]) => void;
    opts.source.read = () => new Promise((r) => { resolve = r; });
    const c = consumer(); const a = c.pump(); const b = c.pump();
    expect(a).toBe(b); c.close(fence()); resolve([settings()]);
    await a; expect(replay().kind).toBe('absent'); expect(trace).toEqual([]);
    expect(await c.drain(fence())).toMatchObject({ unresolved: 0 });
  });
});

describe('attempt ownership and trust order', () => {
  it('persists T0 before asynchronous checks and dead-letters only the third eligible failure', async () => {
    queue = [action(), settings('12', '11')];
    const member = vi.fn(async () => { expect(replay()).toMatchObject({ attempt: { phase: 'started' } }); return 'member' as const; });
    const handler = vi.fn(async () => ({ kind: 'retry' as const }));
    const c = consumer({ freshMember: member, checkPolicy: async () => 'allowed', handler: () => handler });
    await c.pump(); await c.pump();
    expect(member).toHaveBeenCalledTimes(1); expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'failed' } });
    expect(trace.some((s) => s.startsWith('ack'))).toBe(false);
    now += 1000; await c.pump(); now += 3999; await c.pump();
    expect(member).toHaveBeenCalledTimes(2);
    now++; await c.pump();
    expect(member).toHaveBeenCalledTimes(3); expect(handler).toHaveBeenCalledTimes(3);
    expect(replay()).toMatchObject({ final: { outcome: 'dead_letter' }, attempt: { number: 3 } });
    await c.pump(); expect(handler).toHaveBeenCalledTimes(3);
  });
  it.each(['live', 'unknown'] as const)('never recovers an unfinished %s owner', async (owner) => {
    const event = action(); queue = [event];
    store.initCursor(proven().scope, 'T-PART'); store.recordAttemptStart(attemptIdentity(event));
    const handler = vi.fn(); const c = consumer({ startedOwner: () => owner, handler: () => handler });
    await c.pump(); await c.pump(); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } });
  });
  it.each([1, 2, 3])('counts a retired attempt %i once through a real database reopen', async (attemptNo) => {
    const event = action(); const identity = attemptIdentity(event); queue = [event];
    store.initCursor(proven().scope, 'T-PART');
    for (let n = 1; n <= attemptNo; n++) {
      store.recordAttemptStart(identity);
      if (n < attemptNo) { store.recordAttemptFailure({ eventId: identity.eventId, reasonCode: 'fault', cursor: { scope: identity.scope, expectedPrevious: null, next: '11' } }); now += 5000; }
    }
    store.retire(); db.close(); db = createAdapter(join(root, 'events.db'));
    store = new CardStore(db, { clock: { nowUtcMs: () => now } }); opts = { ...opts, store };
    const handler = vi.fn(); const c = consumer({ startedOwner: () => 'retired', handler: () => handler });
    await c.pump(); const first = replay(); await c.pump();
    expect(replay()).toEqual(first); expect(handler).not.toHaveBeenCalled();
    expect(first).toMatchObject(attemptNo === 3 ? { final: { outcome: 'dead_letter' } } : { attempt: { phase: 'failed', number: attemptNo } });
  });
  it.each([
    ['messageId', 'foreign', 'invalid'], ['sessionId', 'unknown', 'unknown'], ['channelId', 'foreign', 'unauthorized'],
    ['channelType', 1, 'unauthorized'], ['topicScope', 'foreign', 'unauthorized'], ['requesterUid', 'other', 'unauthorized'],
  ])('rejects changed %s before membership or handler calls', async (key, value, outcome) => {
    const valid = action(); queue = [{ ...valid, payload: { ...valid.payload as object, [key as string]: value } }];
    const member = vi.fn(), handler = vi.fn();
    await consumer({ freshMember: member, handler: () => handler }).pump();
    expect(member).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ final: { outcome } });
  });
  it.each([1, 2, 5] as const)('valid route %i uses fresh trust checks before the scripted final', async (type) => {
    queue = [action(type)]; const member = vi.fn(async () => 'member' as const);
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    await consumer({ freshMember: member, checkPolicy: async () => 'allowed', handler: () => handler }).pump();
    expect(member).toHaveBeenCalledTimes(type === 1 ? 0 : 1); expect(handler).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ final: { outcome: 'unsupported_control' } });
  });
  it.each(['not_member', 'unavailable'] as const)('membership %s cannot reach the handler', async (member) => {
    queue = [action()]; const handler = vi.fn(); const policy = vi.fn();
    await consumer({ freshMember: async () => member, checkPolicy: policy, handler: () => handler }).pump();
    expect(handler).not.toHaveBeenCalled(); expect(policy).not.toHaveBeenCalled();
    expect(replay()).toMatchObject(member === 'not_member' ? { final: { outcome: 'unauthorized' } } : { attempt: { phase: 'failed', number: 1 } });
  });
  it('does not dispatch an already admitted or ambiguous action', async () => {
    const event = action(); queue = [event]; const body = event.payload as { sessionId: string };
    const identity = attemptIdentity(event); store.initCursor(identity.scope, 'T-PART'); store.recordAttemptStart(identity);
    const admitted = store.admitOnce({ ...identity, sessionId: body.sessionId, continuationGeneration: 'next', submittedHash: 'submitted',
      currentResetEpoch: 0, cursor: { scope: identity.scope, expectedPrevious: null, next: '11' } });
    if (admitted.kind !== 'admitted') throw new Error('fixture admission');
    store.markAdmissionAmbiguous(admitted.admissionId);
    const handler = vi.fn(); await consumer({ handler: () => handler, startedOwner: () => 'retired' }).pump();
    expect(handler).not.toHaveBeenCalled(); expect(replay()).toMatchObject({ final: { outcome: 'admitted' } });
  });
});

describe('faults, pacing and policy barriers', () => {
  it('rolls settings final and cursor back together on a real SQLite write fault', async () => {
    db.exec("CREATE TRIGGER inject_final_failure BEFORE INSERT ON card_event_invalidations BEGIN SELECT RAISE(ABORT, 'fault'); END");
    queue = [settings()]; const c = consumer(); expect((await c.pump()).kind).toBe('halted');
    expect(replay().kind).toBe('absent'); expect(store.readCursor(c.scope!)?.cursor).toBeNull();
    expect(trace).toEqual(['read:null', 'invalidate', 'fence']);
  });
  it('halts a pending ACK whose retained event is missing from strict-after replay', async () => {
    queue = [settings()]; vi.spyOn(opts.source, 'ack').mockRejectedValueOnce(new Error('lost'));
    const c = consumer(); await c.pump(); queue = [];
    expect((await c.pump()).kind).toBe('halted'); expect(store.readCursor(c.scope!)?.ackedThrough).toBeNull();
  });
  it('preserves final replay identity after retention, cleanup and physical reopen', async () => {
    queue = [settings()]; vi.spyOn(opts.source, 'ack').mockRejectedValueOnce(new Error('lost'));
    const c = consumer(); await c.pump(); c.close(fence()); await c.drain(fence());
    now += 3 * 86400000; store.cleanup(); store.retire(); db.close();
    db = createAdapter(join(root, 'events.db')); store = new CardStore(db, { clock: { nowUtcMs: () => now } });
    opts = { ...opts, store }; await consumer().pump();
    expect(replay()).toMatchObject({ final: { outcome: 'invalidated' } });
    expect(store.readCursor(proven().scope)?.ackedThrough).toBe('11');
  });
  it('keeps an inconsistent old scoped final through cleanup and halts without reconstructing identity', async () => {
    const event = action(); queue = [event]; const id = attemptIdentity(event);
    store.initCursor(id.scope, 'T-PART');
    store.recordDisposition({ ...id, disposition: 'invalid', cursor: { scope: id.scope, expectedPrevious: null, next: '11' } });
    now += 3 * 86400000; store.cleanup();
    expect(store.getEventReplay(id.eventId)).toEqual({ kind: 'inconsistent', code: 'missing_identity' });
    expect((await consumer().pump()).kind).toBe('halted');
    expect(trace.some((s) => s.startsWith('ack'))).toBe(false);
  });
  it('shares same-origin 429 pacing without touching another origin or implicitly ACKing', async () => {
    let mono = 0; const clock = { nowMono: () => mono };
    const timers = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
    const pacer = createPacer({ clock, timers, rng: () => 0 });
    const origin = normalizeOrigin('https://one.invalid'); const other = normalizeOrigin('https://two.invalid');
    const read = vi.spyOn(opts.source, 'read').mockRejectedValueOnce(new OctoApiError('poll_owned', 'response', 429, 'http_status', 5000));
    const c = consumer({ pacing: { pacer, clock, origin } });
    await c.pump(); mono = 4999; await c.pump(); expect(read).toHaveBeenCalledTimes(1);
    expect(pacer.gate(normalizeOrigin('https://one.invalid:443')).eligible).toBe(false); expect(pacer.gate(other).eligible).toBe(true);
    mono = 5000; await c.pump(); expect(read).toHaveBeenCalledTimes(2); expect(replay().kind).toBe('absent');
    pacer.close();
  });
  it('revokes real Bot A policy, rejects its old flight/grant and leaves Bot B unchanged', async () => {
    const origin = normalizeOrigin('https://policy.invalid');
    const aRef = { originKey: origin.key, credentialRef: 'a' }, bRef = { originKey: origin.key, credentialRef: 'b' };
    let release!: (p: ReturnType<typeof profile>) => void;
    const fetchA = vi.fn(async () => profile()); const fetchB = vi.fn(async () => profile());
    const a = createPolicy({ botRef: aRef, api: { origin, getProfile: fetchA }, clock: { nowMono: () => now } });
    const b = createPolicy({ botRef: bRef, api: { origin, getProfile: fetchB }, clock: { nowMono: () => now } });
    const old = await a.snapshot(); now += 60001; const bSnapshot = await b.snapshot();
    fetchA.mockImplementationOnce(() => new Promise((r) => { release = r; })); const oldFlight = a.snapshot();
    queue = [settings()]; await consumer({ invalidate: () => { trace.push('invalidate'); a.invalidate('bot_setting'); } }).pump();
    release(profile()); const late = await oldFlight;
    expect(a.authorize('interaction', { botRef: aRef }, old).allowed).toBe(false);
    await a.snapshot(); expect(a.authorize('interaction', { botRef: aRef }, old).allowed).toBe(false);
    expect(a.authorize('interaction', { botRef: aRef }, late).allowed).toBe(false);
    expect(await b.snapshot()).toBe(bSnapshot); expect(bSnapshot.generation).toBe(0); expect(fetchB).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ final: { outcome: 'invalidated' } });
  });
  it('reports an unresolved ACK on the aggregate fence then collects it without touching a retired store', async () => {
    queue = [settings()]; let release!: () => void;
    opts.source.ack = () => new Promise((r) => { release = r; });
    const c = consumer(); const work = c.pump();
    while (!release) await Promise.resolve();
    c.close(fence()); expect(await c.drain(fence())).toMatchObject({ unresolved: 1 });
    store.retire(); const mark = vi.spyOn(store, 'recordAck'); release(); await work;
    expect(mark).not.toHaveBeenCalled(); expect(await c.drain(fence())).toMatchObject({ unresolved: 0 });
  });
});

describe('runtime fake seam and default regression', () => {
  function runtime(seam?: Parameters<typeof createCardRuntime>[1]['fakeEventsForTest']) {
    const inspected = inspectCardSchema(db);
    if (inspected.state !== 'complete') throw new Error('fixture schema');
    const calls = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) !== 'https://runtime.invalid/v1/bot/card/profile' || init?.method !== 'GET') throw new Error('forbidden operation');
      return new Response(JSON.stringify(profile()), { status: 200 });
    });
    const sink = { emit: vi.fn() };
    const r = createCardRuntime({ state: 'ready', store, meta: inspected.meta, provenance: 'reopened',
      ledger: store.recoverExplicitLedger('fixture'), queueFactory: (o) => createWriteQueue({ ...o, store }) },
    { apiUrl: 'https://runtime.invalid', botToken: 'synthetic-token', fetchImpl: calls, clock: { nowMono: () => now },
      telemetry: { sink, botRef: 'bot-test', originRef: 'origin-test' }, explicitTransportForTest: null,
      ...(seam ? { fakeEventsForTest: seam } : {}) });
    if (!r) throw new Error('fixture runtime');
    return { r, calls, sink };
  }
  it.each(['absent', 'unproven', 'missing_handler'])('keeps %s source inert while accounting for ordinary policy warm-up', async (mode) => {
    queue = [settings()]; const read = vi.spyOn(opts.source, 'read');
    const seam = mode === 'absent' ? undefined : { ...opts,
      verifyProof: () => mode !== 'unproven', handler: () => mode === 'missing_handler' ? undefined : opts.handler() };
    const { r, calls } = runtime(seam); await r.idle();
    await r.eventsForTest?.pump();
    expect(calls).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(replay().kind).toBe('absent');
    const closed = r.close(); expect(r.close()).toBe(closed); await closed;
    expect(store.retired).toBe(true);
  });
  it('invalidates the real runtime policy and emits the existing metric before the next action gate', async () => {
    const e = action(); queue = [settings(), { ...e, wireId: '12', position: '12', previous: '11' }];
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const { r, calls, sink } = runtime({ ...opts, freshMember: async () => 'member', handler: () => handler });
    await r.idle(); expect(calls).toHaveBeenCalledTimes(1);
    await r.eventsForTest!.pump();
    expect(calls).toHaveBeenCalledTimes(2); expect(handler).toHaveBeenCalledTimes(1);
    expect(sink.emit).toHaveBeenCalledWith('policy_invalidation_total', { bot_ref: 'bot-test', code: 'bot_setting_updated' }, 1);
    expect(await r.close()).toMatchObject({ outcome: 'drained', owners: 3, unresolved: 0 });
    expect((await r.eventsForTest!.pump()).kind).toBe('closed');
  });
  it('uses the existing aggregate 3s fence and collects a source that ignores abort', async () => {
    vi.useFakeTimers();
    let release!: (events: FakeEvent[]) => void;
    try {
      opts.source.read = () => new Promise((resolve) => { release = resolve; });
      const { r } = runtime(opts); await r.idle();
      const work = r.eventsForTest!.pump(); const close = r.close();
      let settled = false; void close.then(() => { settled = true; });
      now += 2999; await vi.advanceTimersByTimeAsync(2999); expect(settled).toBe(false);
      now++; await vi.advanceTimersByTimeAsync(1);
      expect(await close).toMatchObject({ outcome: 'ambiguous', unresolved: 1 });
      expect(store.retired).toBe(true); release([settings()]); await work;
      expect(trace).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
