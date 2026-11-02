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

function action(channelType: 1 | 2 | 5 = 2, acknowledged = true): FakeEvent {
  const r = store.reserveSession({ binding: { sessionKey: 'session', channelId: 'route', channelType,
    topicScope: channelType === 5 ? 'route' : null, generation: 'gen', resetEpoch: 0 }, bodyDigest: 'authored', clientMsgNo: 'client',
    contract: { requesterUid: 'u', contractVersion: 1, authoredContractJson: '{}', authoredDataHash: 'hash' } });
  if (r.kind !== 'reserved') throw new Error('fixture reservation');
  if (acknowledged) store.ackMessage({ cardId: r.cardId, messageId: 'message', currentResetEpoch: 0, policyAllows: true });
  return { ...settings(), eventClass: 'card_action', payload: { sessionId: r.sessionId, messageId: 'message',
    channelId: 'route', channelType, topicScope: channelType === 5 ? 'route' : null, requesterUid: 'u', actionId: 'ok' } };
}

function attemptIdentity(event: FakeEvent) {
  const body = event.payload as { sessionId: string; messageId: string };
  return { eventId: eventKey(proven().scope, event.wireId), scope: proven().scope, eventClass: event.eventClass,
    sessionId: body.sessionId, messageId: canonicalEnvelope(body.messageId), positionRef: event.position,
    previousPositionRef: event.previous, envelopeDigest: createHash('sha256').update(canonicalEnvelope({ event, actorUid: 'u' })).digest('hex') };
}

describe('current authority at effect boundaries', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('forbidden real HTTP'); });
    vi.spyOn(store, 'admitOnce').mockImplementation(() => { throw new Error('forbidden real admission'); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // Exercise each shortcut with no T0, and both ledgers with an unresolved ACK.
  it.each([
    ['settings', 'revoked'], ['invalid_action', 'revoked'], ['invalid_control', 'revoked'],
    ['pending_settings', 'revoked'], ['pending_action', 'revoked'],
    ['settings', 'wrong_scope'], ['invalid_action', 'wrong_scope'], ['pending_settings', 'wrong_scope'],
    ['settings', 'expired'], ['invalid_action', 'expired'], ['pending_settings', 'expired'],
    ['settings', 'absent'], ['settings', 'T-WS'],
  ] as const)('holds %s when proof becomes %s during read, then resumes only under valid authority', async (kind, change) => {
    const pendingFinal = kind.startsWith('pending_');
    const event = kind === 'pending_action' ? action() : kind === 'invalid_action' || kind === 'invalid_control'
      ? { ...settings(), eventClass: kind === 'invalid_action' ? 'card_action' : 'card_control', payload: {} } : settings();
    queue = [event];
    let currentProof: typeof proof | undefined = { ...proof }, verified = true;
    let defer = false, failAck = pendingFinal, release!: () => void;
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const read = vi.fn(async () => {
      trace.push('read');
      if (defer) { defer = false; await new Promise<void>((r) => { release = r; }); }
      return queue;
    });
    const c = consumer({ proof: () => currentProof, verifyProof: () => verified, handler: () => handler,
      freshMember: async () => 'member', checkPolicy: async () => 'allowed',
      source: { ...opts.source, read, ack: async (e) => {
        trace.push(`ack:${e.wireId}`);
        if (failAck) { failAck = false; throw new Error('fixture ACK loss'); }
      } } });
    if (pendingFinal) expect(await c.pump()).toEqual({ kind: 'held' });
    const retained = replay();
    const cursorBefore = pendingFinal ? '11' : null;
    const handlerBefore = handler.mock.calls.length;
    const mark = vi.spyOn(store, 'recordAck'), final = vi.spyOn(store, 'recordDisposition');
    const invalidation = vi.spyOn(store, 'recordEventInvalidation');
    trace = []; queue = [event, settings('12', '11')]; defer = true;
    const work = c.pump(); while (!release) await Promise.resolve();
    expect(c.pump()).toBe(work); expect(read).toHaveBeenCalledTimes(pendingFinal ? 2 : 1);
    if (change === 'revoked') verified = false;
    else if (change === 'absent') currentProof = undefined;
    else currentProof = { ...proof, ...(change === 'wrong_scope' ? { stream: 'foreign' }
      : change === 'T-WS' ? { topology: 'T-WS' } : { expiresAt: now }) };
    release(); expect(await work).toEqual({ kind: 'held' });
    expect(replay()).toEqual(retained); expect(replay('12').kind).toBe('absent');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: cursorBefore, ackedThrough: null, haltedReason: null });
    expect(trace).toEqual(['read']); expect(handler).toHaveBeenCalledTimes(handlerBefore);
    expect(mark).not.toHaveBeenCalled(); expect(final).not.toHaveBeenCalled(); expect(invalidation).not.toHaveBeenCalled();
    expect(await c.pump()).toEqual({ kind: 'off' });
    expect(read).toHaveBeenCalledTimes(pendingFinal ? 2 : 1);
    currentProof = { ...proof }; verified = true;
    expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '12', ackedThrough: '12' });
    expect(replay()).toMatchObject({ final: { outcome: kind.includes('invalid') ? 'invalid'
      : kind === 'pending_action' ? 'unsupported_control' : 'invalidated' } });
    if (pendingFinal) expect(replay()).toEqual(retained);
    expect(handler).toHaveBeenCalledTimes(handlerBefore);
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual(['ack:11', 'ack:12']);
    expect(trace.filter((s) => s === 'invalidate')).toHaveLength(pendingFinal || kind.includes('invalid') ? 1 : 2);
  });

  it.each(['settings', 'invalid_action'] as const)('revalidates %s authority after synchronous ownership verification', async (kind) => {
    queue = [kind === 'settings' ? settings() : { ...settings(), eventClass: 'card_action', payload: {} }];
    let verified = true, revoke = true;
    const c = consumer({ verifyProof: () => verified, source: { ...opts.source, verifyOwned: () => {
      if (revoke) verified = false;
      return { owned: true, actorUid: 'u' };
    } } });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(replay().kind).toBe('absent'); expect(trace).toEqual(['read:null']);
    revoke = false; verified = true;
    expect(await c.pump()).toMatchObject({ kind: 'processed' });
    expect(replay()).toMatchObject({ final: { outcome: kind === 'settings' ? 'invalidated' : 'invalid' } });
  });

  it.each(['settings', 'action'] as const)('keeps the %s final pending when authority is revoked during remote ACK', async (kind) => {
    queue = [kind === 'action' ? action() : settings(), settings('12', '11')];
    let verified = true, release!: () => void, defer = true;
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const mark = vi.spyOn(store, 'recordAck');
    const c = consumer({ verifyProof: () => verified, handler: () => handler,
      freshMember: async () => 'member', checkPolicy: async () => 'allowed',
      source: { ...opts.source, ack: async (e) => {
        trace.push(`ack:${e.wireId}`);
        if (defer) { defer = false; await new Promise<void>((r) => { release = r; }); }
      } } });
    const work = c.pump(); while (!release) await Promise.resolve();
    const retained = replay(); expect(retained).toHaveProperty('final');
    expect(c.pump()).toBe(work); verified = false; release();
    expect(await work).toEqual({ kind: 'held' });
    expect(mark).not.toHaveBeenCalled(); expect(replay()).toEqual(retained); expect(replay('12').kind).toBe('absent');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '11', ackedThrough: null });
    expect(await c.pump()).toEqual({ kind: 'off' }); verified = true;
    expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(handler).toHaveBeenCalledTimes(kind === 'action' ? 1 : 0);
    expect(replay()).toEqual(retained); expect(mark).toHaveBeenCalledTimes(2);
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual(['ack:11', 'ack:11', 'ack:12']);
  });

  it('holds ACK after authority changes during the final commit without undoing the durable final', async () => {
    queue = [settings()]; let verified = true;
    const commit = store.recordEventInvalidation.bind(store);
    const final = vi.spyOn(store, 'recordEventInvalidation').mockImplementation((input) => {
      const result = commit(input); verified = false; return result;
    });
    const c = consumer({ verifyProof: () => verified });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(trace).toEqual(['read:null', 'invalidate']);
    const retained = replay(); expect(retained).toMatchObject({ final: { outcome: 'invalidated' } });
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '11', ackedThrough: null });
    verified = true; expect(await c.pump()).toMatchObject({ kind: 'processed' });
    expect(final).toHaveBeenCalledTimes(1); expect(replay()).toEqual(retained);
    expect(trace).toEqual(['read:null', 'invalidate', 'read:null', 'ack:11']);
  });

  it('does not finalize settings when authority changes inside an already authorized invalidation', async () => {
    queue = [settings()]; let verified = true;
    const c = consumer({ verifyProof: () => verified, invalidate: () => { trace.push('invalidate'); verified = false; } });
    expect(await c.pump()).toEqual({ kind: 'held' });
    // The synchronous invalidation was authorized at entry; only the next effect is held.
    expect(trace).toEqual(['read:null', 'invalidate']); expect(replay().kind).toBe('absent');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: null, ackedThrough: null });
  });

  it.each(['hold', 'retry', 'final'] as const)('never re-enters a handler returning %s after revocation while it was pending', async (kind) => {
    queue = [action(), settings('12', '11')]; let verified = true, release!: () => void;
    const handler = vi.fn(async () => {
      await new Promise<void>((r) => { release = r; });
      return kind === 'final' ? { kind, disposition: 'unsupported_control' as const } : { kind };
    });
    const owner = vi.fn(() => 'live' as const);
    const c = consumer({ verifyProof: () => verified, handler: () => handler, startedOwner: owner,
      freshMember: async () => 'member', checkPolicy: async () => 'allowed' });
    const work = c.pump(); while (!release) await Promise.resolve();
    verified = false; release(); expect(await work).toEqual({ kind: 'held' });
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } }); expect(replay()).not.toHaveProperty('final');
    verified = true; expect(await c.pump()).toEqual({ kind: 'held' });
    expect(handler).toHaveBeenCalledTimes(1); expect(owner).toHaveBeenCalledTimes(1);
    expect(replay('12').kind).toBe('absent'); expect(trace.filter((s) => s.startsWith('ack'))).toEqual([]);
  });

  it('revalidates replay identity after renewal and physical reopen before restoring a settings barrier', async () => {
    queue = [settings()]; vi.spyOn(opts.source, 'ack').mockRejectedValueOnce(new Error('lost'));
    const first = consumer(); expect(await first.pump()).toEqual({ kind: 'held' });
    first.close(fence()); await first.drain(fence()); store.retire(); db.close();
    db = createAdapter(join(root, 'events.db')); store = new CardStore(db, { clock: { nowUtcMs: () => now } });
    opts = { ...opts, store }; let verified = true;
    const c = consumer({ verifyProof: () => verified,
      source: { ...opts.source, read: async () => { verified = false; return queue; } } });
    trace = []; expect(await c.pump()).toEqual({ kind: 'held' }); expect(trace).toEqual([]);
    const retained = replay(); expect(retained).toHaveProperty('final');
    queue = [{ ...settings(), payload: { scope: 'bot_setting', value: 'changed' } }];
    verified = true;
    const next = consumer(); expect(await next.pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(replay()).toEqual(retained); expect(trace).toEqual(['read:null', 'fence']);
    expect(store.readCursor(next.scope!)).toMatchObject({ cursor: '11', ackedThrough: null });
  });

  it('refreshes an expired real policy after a delayed read before entering the handler', async () => {
    queue = [action()];
    const origin = normalizeOrigin('https://policy.invalid'), botRef = { originKey: origin.key, credentialRef: 'a' };
    const fetchProfile = vi.fn(async () => profile());
    const policy = createPolicy({ botRef, api: { origin, getProfile: fetchProfile }, clock: { nowMono: () => now } });
    const old = await policy.snapshot(); expect(policy.authorize('interaction', { botRef }, old).allowed).toBe(true);
    fetchProfile.mockRejectedValueOnce(new OctoApiError('get_profile', 'response', 404, 'http_status'));
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const c = consumer({ handler: () => handler, freshMember: async () => 'member',
      source: { ...opts.source, read: async () => { now += 60001; return queue; } },
      checkPolicy: async () => {
        const snapshot = await policy.snapshot();
        return policy.authorize('interaction', { botRef }, snapshot).allowed ? 'allowed' : 'denied';
      } });
    expect(await c.pump()).toMatchObject({ kind: 'processed' }); expect(fetchProfile).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled(); expect(policy.authorize('interaction', { botRef }, old).allowed).toBe(false);
    expect(replay()).toMatchObject({ final: { outcome: 'unauthorized' }, attempt: { number: 1 } });
  });

  it('accepts verified same-scope renewal during read without changing the replay namespace', async () => {
    queue = [action(), settings('12', '11')]; let currentProof = { ...proof, expiresAt: now + 10 };
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const read = vi.fn(async () => {
      now += 11; currentProof = { ...proof, expiresAt: now + 10000 }; return queue;
    });
    const c = consumer({ proof: () => currentProof, source: { ...opts.source, read }, handler: () => handler,
      freshMember: async () => 'member', checkPolicy: async () => 'allowed' });
    expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(c.scope).toBe(proven().scope); expect(read).toHaveBeenCalledTimes(1); expect(handler).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ attempt: { number: 1 }, final: { outcome: 'unsupported_control' } });
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '12', ackedThrough: '12' });
  });

  it('holds a newly started attempt before membership if authority changes at the T0 write boundary', async () => {
    queue = [action(), settings('12', '11')]; let verified = true;
    const start = store.recordAttemptStart.bind(store);
    vi.spyOn(store, 'recordAttemptStart').mockImplementation((input) => {
      const result = start(input); verified = false; return result;
    });
    const member = vi.fn(async () => 'member' as const);
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const c = consumer({ verifyProof: () => verified, freshMember: member, handler: () => handler,
      checkPolicy: async () => 'allowed' });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(member).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } }); expect(replay()).not.toHaveProperty('final');
    verified = true; expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(member).toHaveBeenCalledTimes(1); expect(handler).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ attempt: { number: 1 }, final: { outcome: 'unsupported_control' } });
  });

  it('holds a structural final if authority changes after its identity is retained', async () => {
    queue = [{ ...settings(), eventClass: 'card_action', payload: {} }]; let verified = true;
    const retain = store.recordSendWait.bind(store);
    vi.spyOn(store, 'recordSendWait').mockImplementation((input) => {
      const result = retain(input); verified = false; return result;
    });
    const c = consumer({ verifyProof: () => verified });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(replay()).toMatchObject({ attempt: { phase: 'send_wait' } }); expect(replay()).not.toHaveProperty('final');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: null, ackedThrough: null });
    expect(trace).toEqual(['read:null']);
  });

  it('fails closed on a throwing current-proof provider and resumes only after recovery', async () => {
    queue = [settings()]; let unavailable = false;
    const c = consumer({ proof: () => { if (unavailable) throw new Error('proof unavailable'); return proof; },
      source: { ...opts.source, read: async () => { unavailable = true; return queue; } } });
    expect(await c.pump()).toEqual({ kind: 'held' }); expect(replay().kind).toBe('absent'); expect(trace).toEqual([]);
    expect(await c.pump()).toEqual({ kind: 'off' });
    unavailable = false;
    const next = consumer(); expect(await next.pump()).toMatchObject({ kind: 'processed' });
    expect(replay()).toMatchObject({ final: { outcome: 'invalidated' } });
  });
});

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
    queue = [settings(), settings('13', '11')];
    const mark = vi.spyOn(store, 'recordAck').mockReturnValueOnce(false);
    const first = consumer(); expect((await first.pump()).kind).toBe('held');
    expect(store.readCursor(first.scope!)).toMatchObject({ cursor: '11', ackedThrough: null });
    expect(replay('13').kind).toBe('absent');
    first.close(fence()); await first.drain(fence());
    store.retire(); db.close(); db = createAdapter(join(root, 'events.db'));
    store = new CardStore(db, { clock: { nowUtcMs: () => now } }); opts = { ...opts, store }; queue = [settings()];
    const nextMark = vi.spyOn(store, 'recordAck');
    const next = consumer(); expect((await next.pump()).kind).toBe('processed');
    expect(trace).toEqual(['read:null', 'invalidate', 'ack:11', 'read:null', 'invalidate', 'ack:11']);
    expect(mark).toHaveBeenCalledTimes(1); expect(nextMark).toHaveBeenCalledTimes(1);
  });
  it.each(['tenant', 'bot', 'environment', 'stream'])('halts a delivered wrong %s scope before any invalidation', async (key) => {
    queue = [{ ...settings(), binding: { ...binding, [key]: 'foreign' } }];
    expect(await consumer().pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(trace).toEqual(['read:null', 'fence']); expect(replay().kind).toBe('absent');
  });
  it('halts wrong settings scope even when source ownership is claimed', async () => {
    queue = [{ ...settings(), payload: { scope: 'channel_setting' } }, settings('12', '11')];
    expect(await consumer().pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(trace).toEqual(['read:null', 'fence']);
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
  it('uses the authenticated actor rather than a forged requester/operator payload', async () => {
    queue = [action()]; opts.source.verifyOwned = () => ({ owned: true, actorUid: 'v' });
    const member = vi.fn(), handler = vi.fn(); await consumer({ freshMember: member, handler: () => handler }).pump();
    expect(member).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ final: { outcome: 'unauthorized' } });
  });
  it('does not turn an unproven action into a poison disposition', async () => {
    queue = [{ ...action(), payload: {} }]; opts.source.verifyOwned = () => ({ owned: false });
    expect(await consumer().pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(replay().kind).toBe('absent'); expect(trace).toEqual(['read:null', 'fence']);
  });
  it('retains an owned malformed control identity without inventing message or session authority', async () => {
    queue = [{ ...settings(), eventClass: 'card_control', payload: {} }]; await consumer().pump();
    expect(replay()).toMatchObject({ kind: 'retained', identity: { sessionId: null, messageId: 'null' }, final: { outcome: 'invalid' } });
  });
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

describe('independent boundary regressions', () => {
  it('holds an independently owned early callback until T-bind instead of finalizing it', async () => {
    const r = store.reserveSession({ binding: { sessionKey: 'session', channelId: 'route', channelType: 2,
      topicScope: null, generation: 'gen', resetEpoch: 0 }, bodyDigest: 'authored', clientMsgNo: 'early-client',
      contract: { requesterUid: 'u', contractVersion: 1, authoredContractJson: '{}', authoredDataHash: 'hash' } });
    if (r.kind !== 'reserved') throw new Error('reservation');
    queue = [{ ...settings(), eventClass: 'card_action', payload: { sessionId: r.sessionId, messageId: 'message',
      channelId: 'route', channelType: 2, topicScope: null, requesterUid: 'u', actionId: 'ok' } }];
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const c = consumer({ freshMember: async () => 'member', checkPolicy: async () => 'allowed', handler: () => handler });
    const result = await c.pump();
    expect(result.kind).toBe('held');
    expect(replay()).toMatchObject({ kind: 'retained', attempt: { phase: 'send_wait', number: 0 } });
    expect(trace.some((s) => s.startsWith('ack:'))).toBe(false);
    store.ackMessage({ cardId: r.cardId, messageId: 'message', currentResetEpoch: 0, policyAllows: true });
    await c.pump();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('resumes a settled local attempt after a cooldown starts during fresh membership', async () => {
    queue = [action()];
    const clock = { nowMono: () => now };
    const origin = normalizeOrigin('https://fixture.invalid');
    const pacer = createPacer({ clock, timers: { setTimeout: () => 1, clearTimeout: () => undefined }, rng: () => 0 });
    let first = true;
    const member = vi.fn(async () => {
      if (first) { first = false; pacer.observe429(origin, 5000, now); }
      return 'member' as const;
    });
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const c = consumer({ freshMember: member, checkPolicy: async () => 'allowed', handler: () => handler,
      pacing: { pacer, origin, clock } });
    expect((await c.pump()).kind).toBe('held');
    now += 5000;
    expect(pacer.gate(origin).eligible).toBe(true);
    const result = await c.pump();
    pacer.close();
    expect(result.kind).toBe('processed');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('positive control: a bound valid action reaches the scripted handler', async () => {
    queue = [action()];
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const c = consumer({ freshMember: async () => 'member', checkPolicy: async () => 'allowed', handler: () => handler });
    expect((await c.pump()).kind).toBe('processed');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ final: { outcome: 'unsupported_control' } });
  });

  it('positive control: cooldown before T0 resumes once eligibility returns', async () => {
    queue = [action()];
    const clock = { nowMono: () => now };
    const origin = normalizeOrigin('https://fixture.invalid');
    const pacer = createPacer({ clock, timers: { setTimeout: () => 1, clearTimeout: () => undefined }, rng: () => 0 });
    pacer.observe429(origin, 5000, now);
    const handler = vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
    const c = consumer({ freshMember: async () => 'member', checkPolicy: async () => 'allowed', handler: () => handler,
      pacing: { pacer, origin, clock } });
    expect((await c.pump()).kind).toBe('held');
    expect(replay().kind).toBe('absent');
    now += 5000;
    expect((await c.pump()).kind).toBe('processed');
    pacer.close();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('early callback binding and local hold recovery', () => {
  const finalHandler = () => vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));
  const member = async () => 'member' as const;
  const allowed = async () => 'allowed' as const;

  it.each([1, 2, 5] as const)('retains route %i send_wait through reopen until independent T-bind', async (type) => {
    const event = action(type, false); queue = [event, settings('12', '11')];
    const body = event.payload as { sessionId: string };
    const session = store.getSession(body.sessionId)!;
    const handler = finalHandler(), membership = vi.fn(member), policy = vi.fn(allowed);
    const start = vi.spyOn(store, 'recordAttemptStart');
    const c = consumer({ handler: () => handler, freshMember: membership, checkPolicy: policy });
    expect(await c.pump()).toEqual({ kind: 'held' }); await c.pump();
    expect(replay()).toMatchObject({ attempt: { phase: 'send_wait', number: 0 } });
    const retained = replay();
    expect(replay('12').kind).toBe('absent');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: null, ackedThrough: null });
    expect(store.getMessage(session.cardId)).toMatchObject({ messageId: null, state: 'sending' });
    expect(store.getSession(session.sessionId)?.status).toBe('sending');
    expect(start).not.toHaveBeenCalled(); expect(membership).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual([]);
    c.close(fence()); await c.drain(fence()); store.retire(); db.close();
    db = createAdapter(join(root, 'events.db')); store = new CardStore(db, { clock: { nowUtcMs: () => now } });
    opts = { ...opts, store };
    const next = consumer({ handler: () => handler, freshMember: membership, checkPolicy: policy });
    expect(await next.pump()).toEqual({ kind: 'held' }); expect(replay()).toEqual(retained);
    expect(store.ackMessage({ cardId: session.cardId, messageId: 'message', currentResetEpoch: 0, policyAllows: true }))
      .toEqual({ kind: 'bound', admittable: true });
    expect(await next.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 }, final: { outcome: 'unsupported_control' } });
    expect(handler).toHaveBeenCalledTimes(1); expect(membership).toHaveBeenCalledTimes(type === 1 ? 0 : 1);
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual(['ack:11', 'ack:12']);
    queue = [event]; await next.pump(); expect(handler).toHaveBeenCalledTimes(1);
  });

  it('holds an ambiguous unbound send and never binds it from a callback', async () => {
    const event = action(2, false); queue = [event];
    const session = store.getSession((event.payload as { sessionId: string }).sessionId)!;
    store.markSendAmbiguous(session.cardId);
    const handler = finalHandler(); const c = consumer({ handler: () => handler, freshMember: member, checkPolicy: allowed });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(store.getMessage(session.cardId)).toMatchObject({ messageId: null, state: 'ambiguous' });
    expect(store.getSession(session.sessionId)?.status).toBe('ambiguous');
    expect(replay()).toMatchObject({ attempt: { phase: 'send_wait', number: 0 } });
    expect(handler).not.toHaveBeenCalled();
    store.ackMessage({ cardId: session.cardId, messageId: 'independently-proven-other', currentResetEpoch: 0, policyAllows: true });
    expect(await c.pump()).toMatchObject({ kind: 'processed' });
    expect(replay()).toMatchObject({ final: { outcome: 'invalid' } });
    expect(handler).not.toHaveBeenCalled();
    expect(store.getMessage(session.cardId)?.messageId).toBe('independently-proven-other');
  });

  it.each([
    ['sessionId', 'unknown', 'unknown'], ['channelId', 'foreign', 'unauthorized'],
    ['channelType', 1, 'unauthorized'], ['topicScope', 'foreign', 'unauthorized'],
    ['requesterUid', 'forged', 'unauthorized'],
  ])('does not grant an early wait bypass for changed %s', async (key, value, outcome) => {
    const event = action(2, false);
    queue = [{ ...event, payload: { ...event.payload as object, [key as string]: value } }];
    const handler = finalHandler(), membership = vi.fn(member);
    expect(await consumer({ handler: () => handler, freshMember: membership, checkPolicy: allowed }).pump())
      .toMatchObject({ kind: 'processed' });
    expect(replay()).toMatchObject({ final: { outcome } });
    expect(handler).not.toHaveBeenCalled(); expect(membership).not.toHaveBeenCalled();
  });

  it.each(['unproven', 'forged_actor', 'wrong_scope'])('keeps %s early ownership fail-closed', async (mode) => {
    const event = action(2, false); queue = [event];
    if (mode === 'wrong_scope') queue = [{ ...event, binding: { ...binding, bot: 'other' } }];
    else opts.source.verifyOwned = () => ({ owned: mode !== 'unproven', actorUid: 'forged' });
    const handler = finalHandler(); const result = await consumer({ handler: () => handler }).pump();
    expect(handler).not.toHaveBeenCalled();
    if (mode === 'forged_actor') expect(replay()).toMatchObject({ final: { outcome: 'unauthorized' } });
    else { expect(result.kind).toBe('halted'); expect(replay().kind).toBe('absent'); }
  });

  it('halts a changed retained early callback without finalizing or binding it', async () => {
    const event = action(2, false); queue = [event]; const c = consumer();
    await c.pump(); queue = [{ ...event, payload: { ...event.payload as object, messageId: 'changed' } }];
    expect(await c.pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(replay()).toMatchObject({ attempt: { phase: 'send_wait', number: 0 } });
    expect(replay()).not.toHaveProperty('final');
    expect(trace.some((s) => s.startsWith('ack'))).toBe(false);
  });

  it.each(['membership', 'policy'] as const)('resumes only after %s settles and real pacing eligibility returns', async (stage) => {
    queue = [action(), settings('12', '11')];
    let mono = 0, release!: () => void;
    const clock = { nowMono: () => mono }, origin = normalizeOrigin('https://local-hold.invalid');
    const timers = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
    const pacer = createPacer({ clock, timers, rng: () => 0 });
    let pending = true;
    const wait = async () => { if (pending) { pending = false; await new Promise<void>((r) => { release = r; }); } };
    const membership = vi.fn(async () => { if (stage === 'membership') await wait(); return 'member' as const; });
    const policy = vi.fn(async () => { if (stage === 'policy') await wait(); return 'allowed' as const; });
    const handler = finalHandler(); const retired = vi.fn(() => 'unknown' as const);
    const c = consumer({ freshMember: membership, checkPolicy: policy, handler: () => handler,
      startedOwner: retired, pacing: { pacer, clock, origin } });
    try {
      const first = c.pump();
      while (!release) await Promise.resolve();
      expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 } });
      expect(c.pump()).toBe(first); expect(membership).toHaveBeenCalledTimes(1);
      pacer.observe429(origin, 5000, mono); release();
      expect(await first).toEqual({ kind: 'held' });
      expect(handler).not.toHaveBeenCalled(); expect(replay('12').kind).toBe('absent');
      expect(store.readCursor(c.scope!)).toMatchObject({ cursor: null, ackedThrough: null });
      mono = 4999; expect(await c.pump()).toEqual({ kind: 'held' });
      expect(membership).toHaveBeenCalledTimes(1);
      mono = 5000; expect(pacer.gate(origin).eligible).toBe(true);
      expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
      expect(retired).not.toHaveBeenCalled(); expect(handler).toHaveBeenCalledTimes(1);
      expect(membership).toHaveBeenCalledTimes(2); expect(policy).toHaveBeenCalledTimes(stage === 'policy' ? 2 : 1);
      expect(replay()).toMatchObject({ attempt: { number: 1 }, final: { outcome: 'unsupported_control' } });
      expect(trace.filter((s) => s.startsWith('ack'))).toEqual(['ack:11', 'ack:12']);
      queue = [queue[0]]; await c.pump(); expect(handler).toHaveBeenCalledTimes(1);
    } finally { pacer.close(); }
  });

  it('keeps handler-originated holds fenced instead of assuming dispatch was harmless', async () => {
    queue = [action()]; const handler = vi.fn(async () => ({ kind: 'hold' as const }));
    const c = consumer({ handler: () => handler, freshMember: member, checkPolicy: allowed });
    expect(await c.pump()).toEqual({ kind: 'held' }); expect(await c.pump()).toEqual({ kind: 'held' });
    expect(handler).toHaveBeenCalledTimes(1); expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } });
    expect(trace.some((s) => s.startsWith('ack'))).toBe(false);
  });

  it('does not carry local settled authority into a new consumer incarnation', async () => {
    queue = [action()]; let present = true;
    const handler = finalHandler();
    const c = consumer({ handler: () => present ? handler : undefined,
      freshMember: async () => { present = false; return 'member'; }, checkPolicy: allowed });
    expect(await c.pump()).toEqual({ kind: 'held' });
    c.close(fence()); await c.drain(fence());
    const next = consumer({ handler: () => handler, freshMember: member, checkPolicy: allowed });
    expect(await next.pump()).toEqual({ kind: 'held' }); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } });
  });

  it('resumes local wiring holds without charging attempts and preserves the 1s/4s failure schedule', async () => {
    queue = [action()]; let available = true, pause = true;
    const handler = vi.fn(async () => ({ kind: 'retry' as const }));
    const membership = vi.fn(async () => { if (pause) available = false; return 'member' as const; });
    const c = consumer({ handler: () => available ? handler : undefined, freshMember: membership, checkPolicy: allowed });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } });
    available = true; expect(await c.pump()).toEqual({ kind: 'held' });
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'started' } });
    pause = false; available = true; await c.pump();
    expect(replay()).toMatchObject({ attempt: { number: 1, phase: 'failed', nextEligibleAt: now + 1000 } });
    expect(handler).toHaveBeenCalledTimes(1);
    now += 999; await c.pump(); expect(handler).toHaveBeenCalledTimes(1);
    now++; await c.pump(); expect(handler).toHaveBeenCalledTimes(2);
    expect(replay()).toMatchObject({ attempt: { number: 2, phase: 'failed', nextEligibleAt: now + 4000 } });
    now += 3999; await c.pump(); expect(handler).toHaveBeenCalledTimes(2);
    now++; await c.pump(); expect(handler).toHaveBeenCalledTimes(3);
    expect(replay()).toMatchObject({ final: { outcome: 'dead_letter' }, attempt: { number: 3 } });
    await c.pump(); expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe('settled pre-handler transition boundaries', () => {
  const finalHandler = () => vi.fn(async () => ({ kind: 'final' as const, disposition: 'unsupported_control' as const }));

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('forbidden real HTTP'); });
    vi.spyOn(store, 'admitOnce').mockImplementation(() => { throw new Error('forbidden real admission'); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // Every check settles before a local witness may permit the SAME attempt.
  // Availability faults with valid proof still use the ordinary 1s/4s retry path.
  it.each([
    ['membership', 'allowed'], ['membership', 'denied'], ['membership', 'unavailable'], ['membership', 'throws'],
    ['policy', 'allowed'], ['policy', 'denied'], ['policy', 'unavailable'], ['policy', 'throws'],
  ] as const)('renews an expired proof after settled %s/%s without losing T0', async (stage, outcome) => {
    queue = [action(), settings('12', '11')];
    let currentProof = { ...proof, expiresAt: now + 10 }, release!: () => void, pending = true;
    const wait = async () => {
      if (!pending) return false;
      pending = false;
      await new Promise<void>((r) => { release = r; });
      now = currentProof.expiresAt;
      if (outcome === 'throws') throw new Error('fixture unavailable');
      return true;
    };
    const membership = vi.fn(async () => {
      const first = stage === 'membership' && await wait();
      return first && outcome === 'denied' ? 'not_member' as const
        : first && outcome === 'unavailable' ? 'unavailable' as const : 'member' as const;
    });
    const policy = vi.fn(async () => {
      const first = stage === 'policy' && await wait();
      return first && outcome === 'denied' ? 'denied' as const
        : first && outcome === 'unavailable' ? 'unavailable' as const : 'allowed' as const;
    });
    const handler = finalHandler(), owner = vi.fn(() => 'live' as const);
    const c = consumer({ proof: () => currentProof, freshMember: membership, checkPolicy: policy,
      handler: () => handler, startedOwner: owner });
    const first = c.pump();
    while (!release) await Promise.resolve();
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 } });
    expect(c.pump()).toBe(first); expect(membership).toHaveBeenCalledTimes(1);
    release(); expect(await first).toEqual({ kind: 'held' });
    expect(handler).not.toHaveBeenCalled(); expect(replay()).not.toHaveProperty('final');
    expect(replay('12').kind).toBe('absent');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: null, ackedThrough: null });
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual([]);
    expect(await c.pump()).toEqual({ kind: 'off' });
    expect(membership).toHaveBeenCalledTimes(1);
    currentProof = { ...proof, expiresAt: now + 10000 };
    expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(owner).not.toHaveBeenCalled(); expect(handler).toHaveBeenCalledTimes(1);
    expect(membership).toHaveBeenCalledTimes(2);
    expect(policy).toHaveBeenCalledTimes(stage === 'policy' ? 2 : 1);
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 }, final: { outcome: 'unsupported_control' } });
    expect(replay('12')).toMatchObject({ final: { outcome: 'invalidated' } });
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: '12', ackedThrough: '12' });
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual(['ack:11', 'ack:12']);
    queue = [queue[0]]; await c.pump(); expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['membership', 'policy'] as const)('rechecks proof revocation after %s before dispatch', async (stage) => {
    queue = [action(), settings('12', '11')]; let verified = true, pending = true;
    const revoke = () => { if (pending) { pending = false; verified = false; } };
    const handler = finalHandler();
    const membership = vi.fn(async () => { if (stage === 'membership') revoke(); return 'member' as const; });
    const policy = vi.fn(async () => { if (stage === 'policy') revoke(); return 'allowed' as const; });
    const c = consumer({ verifyProof: () => verified, freshMember: membership, checkPolicy: policy, handler: () => handler });
    expect(await c.pump()).toEqual({ kind: 'held' }); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 } });
    expect(replay()).not.toHaveProperty('final'); expect(replay('12').kind).toBe('absent');
    expect(await c.pump()).toEqual({ kind: 'off' }); expect(membership).toHaveBeenCalledTimes(1);
    verified = true;
    expect(await c.pump()).toMatchObject({ kind: 'processed', count: 2 });
    expect(handler).toHaveBeenCalledTimes(1); expect(replay()).toMatchObject({ attempt: { number: 1 } });
  });

  it.each(['expired', 'unverified', 'absent', 'wrong_scope'] as const)('requires valid same-scope renewal after an %s replacement', async (replacement) => {
    queue = [action()]; let currentProof: typeof proof | undefined = { ...proof, expiresAt: now + 10 }, verified = true;
    let pending = true;
    const handler = finalHandler(), membership = vi.fn(async () => {
      if (pending) { pending = false; now += 11; } return 'member' as const;
    });
    const c = consumer({ proof: () => currentProof, verifyProof: () => verified,
      freshMember: membership, checkPolicy: async () => 'allowed', handler: () => handler });
    expect(await c.pump()).toEqual({ kind: 'held' });
    currentProof = replacement === 'absent' ? undefined : { ...proof, expiresAt: now + 10000,
      ...(replacement === 'wrong_scope' ? { stream: 'foreign' } : {}) };
    if (replacement === 'expired') currentProof = { ...proof, expiresAt: now };
    if (replacement === 'unverified') verified = false;
    expect(await c.pump()).toEqual({ kind: 'off' }); expect(handler).not.toHaveBeenCalled();
    expect(membership).toHaveBeenCalledTimes(1); expect(replay()).not.toHaveProperty('final');
    verified = true; currentProof = { ...proof, expiresAt: now + 10000 };
    expect(await c.pump()).toMatchObject({ kind: 'processed' });
    expect(c.scope).toBe(proven().scope); expect(handler).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ attempt: { number: 1 } });
  });

  it.each(['hold', 'retry', 'final'] as const)('never resumes %s work after the handler crossed an expired proof', async (kind) => {
    queue = [action()]; let currentProof = { ...proof, expiresAt: now + 10 };
    const handler = vi.fn(async () => { now += 11; return kind === 'final'
      ? { kind, disposition: 'unsupported_control' as const } : { kind }; });
    const owner = vi.fn(() => 'live' as const);
    const c = consumer({ proof: () => currentProof, freshMember: async () => 'member',
      checkPolicy: async () => 'allowed', handler: () => handler, startedOwner: owner });
    expect(await c.pump()).toEqual({ kind: 'held' });
    currentProof = { ...proof, expiresAt: now + 10000 };
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(handler).toHaveBeenCalledTimes(1); expect(owner).toHaveBeenCalledTimes(1);
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 } });
    expect(replay()).not.toHaveProperty('final');
    expect(store.readCursor(c.scope!)).toMatchObject({ cursor: null, ackedThrough: null });
  });

  it.each(['membership', 'policy'] as const)('keeps shutdown during %s closed without reviving the old attempt', async (stage) => {
    queue = [action()]; let release!: () => void;
    const wait = () => new Promise<void>((r) => { release = r; });
    const handler = finalHandler();
    const c = consumer({ handler: () => handler,
      freshMember: async () => { if (stage === 'membership') await wait(); return 'member'; },
      checkPolicy: async () => { if (stage === 'policy') await wait(); return 'allowed'; } });
    const first = c.pump(); while (!release) await Promise.resolve();
    c.close(fence()); release(); expect(await first).toEqual({ kind: 'closed' });
    expect(await c.drain(fence())).toMatchObject({ unresolved: 0 });
    expect(await c.pump()).toEqual({ kind: 'closed' });
    const next = consumer({ handler: () => handler, freshMember: async () => 'member', checkPolicy: async () => 'allowed' });
    expect(await next.pump()).toEqual({ kind: 'held' }); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 } });
    expect(replay()).not.toHaveProperty('final');
  });

  it.each(['membership', 'policy'] as const)('charges %s unavailability once when proof stays valid', async (stage) => {
    queue = [action()];
    const handler = finalHandler(), membership = vi.fn(async () => stage === 'membership' ? 'unavailable' as const : 'member' as const);
    const policy = vi.fn(async () => 'unavailable' as const);
    const c = consumer({ handler: () => handler, freshMember: membership, checkPolicy: policy });
    expect(await c.pump()).toEqual({ kind: 'held' });
    expect(replay()).toMatchObject({ attempt: { phase: 'failed', number: 1, nextEligibleAt: now + 1000 } });
    now += 999; await c.pump(); expect(membership).toHaveBeenCalledTimes(1);
    now++; await c.pump();
    expect(replay()).toMatchObject({ attempt: { phase: 'failed', number: 2, nextEligibleAt: now + 4000 } });
    now += 3999; await c.pump(); expect(membership).toHaveBeenCalledTimes(2);
    now++; expect(await c.pump()).toMatchObject({ kind: 'processed' });
    expect(replay()).toMatchObject({ attempt: { number: 3 }, final: { outcome: 'dead_letter' } });
    await c.pump(); expect(membership).toHaveBeenCalledTimes(3); expect(handler).not.toHaveBeenCalled();
  });

  it('does not restore a local proof-expiry witness after physical reopen', async () => {
    queue = [action()]; let currentProof = { ...proof, expiresAt: now + 10 };
    const handler = finalHandler();
    const c = consumer({ proof: () => currentProof, freshMember: async () => { now += 11; return 'member'; },
      checkPolicy: async () => 'allowed', handler: () => handler });
    expect(await c.pump()).toEqual({ kind: 'held' });
    c.close(fence()); await c.drain(fence()); store.retire(); db.close();
    db = createAdapter(join(root, 'events.db')); store = new CardStore(db, { clock: { nowUtcMs: () => now } });
    opts = { ...opts, store }; currentProof = { ...proof, expiresAt: now + 10000 };
    const next = consumer({ proof: () => currentProof, freshMember: async () => 'member',
      checkPolicy: async () => 'allowed', handler: () => handler });
    expect(await next.pump()).toEqual({ kind: 'held' }); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { phase: 'started', number: 1 } });
  });

  it('compares replay identity before using a locally settled proof-expiry witness', async () => {
    queue = [action()]; let currentProof = { ...proof, expiresAt: now + 10 };
    const handler = finalHandler();
    const c = consumer({ proof: () => currentProof, freshMember: async () => { now += 11; return 'member'; },
      checkPolicy: async () => 'allowed', handler: () => handler });
    expect(await c.pump()).toEqual({ kind: 'held' }); currentProof = { ...proof, expiresAt: now + 10000 };
    queue = [{ ...queue[0], payload: { ...queue[0].payload as object, actionId: 'changed' } }];
    expect(await c.pump()).toMatchObject({ kind: 'halted', persisted: true });
    expect(handler).not.toHaveBeenCalled(); expect(replay()).not.toHaveProperty('final');
    expect(trace.filter((s) => s.startsWith('ack'))).toEqual([]);
  });

  it('rechecks policy after renewal instead of retaining an earlier permission', async () => {
    queue = [action()]; let currentProof = { ...proof, expiresAt: now + 10 };
    const handler = finalHandler(), policy = vi.fn(async () => {
      if (policy.mock.calls.length === 1) { now += 11; return 'allowed' as const; }
      return 'denied' as const;
    });
    const c = consumer({ proof: () => currentProof, freshMember: async () => 'member', checkPolicy: policy, handler: () => handler });
    expect(await c.pump()).toEqual({ kind: 'held' }); currentProof = { ...proof, expiresAt: now + 10000 };
    expect(await c.pump()).toMatchObject({ kind: 'processed' }); expect(handler).not.toHaveBeenCalled();
    expect(policy).toHaveBeenCalledTimes(2);
    expect(replay()).toMatchObject({ attempt: { number: 1 }, final: { outcome: 'unauthorized' } });
  });

  it('finalizes session expiry during policy checking without dispatch or retry', async () => {
    queue = [action()]; const body = queue[0].payload as { sessionId: string };
    const handler = finalHandler();
    const c = consumer({ freshMember: async () => 'member', handler: () => handler,
      checkPolicy: async () => { now = store.getSession(body.sessionId)!.expiresAt; return 'allowed'; } });
    expect(await c.pump()).toMatchObject({ kind: 'processed' }); expect(handler).not.toHaveBeenCalled();
    expect(replay()).toMatchObject({ attempt: { number: 1 }, final: { outcome: 'expired' } });
  });
});
