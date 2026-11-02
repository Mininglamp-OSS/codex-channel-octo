import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { CardStore, readProtectedGraph, manifestProtectedGraph, type RetirementWitness } from '../cards/store.js';
import { provisionFirstInstallMarker, RETENTION_MS } from '../cards/migrations.js';
import { cardSubsystemPaths, openCardSubsystem, runInteractionRecovery } from '../cards/recovery.js';
import { createFakeEventConsumer } from '../cards/event-consumer.js';
import { createResourceRegistry } from '../cards/resource-registry.js';
import { eventKey, validateTopology, canonicalEnvelope } from '../cards/topology.js';

const binding = { environment: 'fixture', tenant: 'tenant', bot: 'bot', stream: 'stream' };
const proof = { ...binding, topology: 'T-PART', expiresAt: 1e12, nonDestructiveRead: true,
  orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };
const scope = validateTopology(binding, proof, () => true, 100)!.scope;
const owned: Array<() => void> = [];
afterEach(() => { owned.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden fixture network'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wp13b-interaction-')));
  expect(root.startsWith('/Users/')).toBe(false);
  let now = 100, db: DbAdapter, store: CardStore;
  const paths = cardSubsystemPaths(root);
  mkdirSync(paths.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.installationRefPath, 'fixture-installation\n', { mode: 0o600, flag: 'wx' });
  provisionFirstInstallMarker(paths.markerPath, 'fixture-installation', now);
  async function open() {
    db = createAdapter(join(root, 'owned.db'));
    const opened = await openCardSubsystem({ adapter: db, dataDir: root, clock: { nowUtcMs: () => now }, runtimeIncarnation: 'new' });
    if (opened.state !== 'ready') throw new Error('fixture startup: ' + opened.reason);
    store = opened.store;
  }
  await open();
  owned.push(() => { store.retire(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, get store() { return store; }, root,
    now: () => now, setNow: (value: number) => { now = value; },
    async reopen() { store.retire(); db.close(); await open(); } };
}
function reserve(store: CardStore, bound = true) {
  const r = store.reserveSession({ binding: { sessionKey: 'route', channelId: 'route', channelType: 1,
    topicScope: null, generation: 'original', resetEpoch: 0 }, bodyDigest: 'fixture-digest', clientMsgNo: 'fixture-client',
    contract: { requesterUid: 'requester', contractVersion: 1,
      authoredContractJson: '{"inputs":[],"buttons":[{"id":"ok","label":"Confirm"}]}', authoredDataHash: 'fixture-hash' } });
  if (r.kind !== 'reserved') throw new Error('fixture reservation');
  if (bound) expect(store.ackMessage({ cardId: r.cardId, messageId: 'message', policyAllows: true, currentResetEpoch: 0 }).kind).toBe('bound');
  return r;
}
function identity(sessionId: string) {
  return { eventId: eventKey(scope, 'event'), scope, eventClass: 'card_action', sessionId,
    messageId: canonicalEnvelope('message'), positionRef: 'opaque-z', previousPositionRef: null,
    envelopeDigest: 'fixture-envelope-digest' };
}
function claim(store: CardStore, sessionId: string) {
  const event = identity(sessionId);
  store.initCursor(scope, 'T-PART');
  expect(store.recordAttemptStart(event).kind).toBe('started');
  const a = store.admitOnce({ ...event, continuationGeneration: 'lost-generation', submittedHash: 'fixture-hash',
    currentResetEpoch: 0, cursor: { scope, expectedPrevious: null, next: event.positionRef } });
  if (a.kind !== 'admitted') throw new Error('fixture admission');
  return { event, admissionId: a.admissionId };
}

describe('WP13B interaction restart (AC-016.2/017.1/018.1/025.1 fixture layer)', () => {
  it.each(['sending', 'ambiguous'] as const)('keeps unresolved %s N2 suspension at and beyond 24h', async state => {
    const f = await fixture(), r = reserve(f.store, false);
    if (state === 'ambiguous') f.store.markSendAmbiguous(r.cardId);
    await f.reopen();
    for (const now of [r.expiresAt - 1, r.expiresAt, r.expiresAt + RETENTION_MS]) {
      f.setNow(now); expect(f.store.expireSessions()).toEqual([]); f.store.cleanup();
      expect(f.store.getMessage(r.cardId)?.state).toBe(state);
      expect(f.store.unresolvedSendKinds()).toEqual(['interactive']);
      expect(f.store.getSession(r.sessionId)?.expiresAt).toBe(r.expiresAt);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('expires a bound pending session at the original deadline without renewal on reopen', async () => {
    const f = await fixture(), r = reserve(f.store);
    f.setNow(r.expiresAt - 1); await f.reopen();
    expect(f.store.getSession(r.sessionId)?.status).toBe('pending');
    f.setNow(r.expiresAt); await f.reopen();
    expect(f.store.getSession(r.sessionId)).toMatchObject({ status: 'expired', expiresAt: r.expiresAt,
      terminalAt: r.expiresAt, retainUntil: r.expiresAt + RETENTION_MS });
    expect(f.store.expireSessions()).toEqual([]);
    expect(f.store.getMessage(r.cardId)?.state).toBe('expired');
  });
  it.each(['admitted', 'ambiguous', 'completed', 'failed'] as const)('reconciles %s without minting or replaying a continuation', async state => {
    const f = await fixture(), r = reserve(f.store), a = claim(f.store, r.sessionId);
    if (state === 'ambiguous') f.store.markAdmissionAmbiguous(a.admissionId);
    if (state === 'completed' || state === 'failed') f.store.settleAdmission(a.admissionId, state);
    await f.reopen();
    expect(f.store.getAdmissionForSession(r.sessionId)).toMatchObject({ admissionId: a.admissionId,
      continuationGeneration: 'lost-generation', state: state === 'admitted' ? 'ambiguous' : state });
    expect(f.store.readCursor(scope)).toMatchObject({ cursor: a.event.positionRef, ackedThrough: null });
    const snapshot = readProtectedGraph(f.db);
    await f.reopen(); expect(readProtectedGraph(f.db)).toEqual(snapshot);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

function witness(f: Awaited<ReturnType<typeof fixture>>, event: ReturnType<typeof identity>): RetirementWitness {
  const graph = readProtectedGraph(f.db), manifest = manifestProtectedGraph(graph);
  const replay = f.store.getEventReplay(event.eventId);
  if (replay.kind !== 'retained' || !replay.final) throw new Error('fixture final');
  return { installationRef: 'fixture-installation', lineageId: manifest.lineageId!, protectedGraphSha256: manifest.sha256,
    identity: event, ...replay.final, outcome: replay.final.outcome, topology: 'T-PART', confirmedPosition: event.positionRef,
    issuedAt: f.now(), expiresAt: f.now() + 1000, sourceFence: 'fixture-source-retirement', restoreFence: 'fixture-restore-fence',
    ownerFence: 'fixture-retired-owner', replayExcluded: true, restoreExcluded: true, activeOwnersExcluded: true };
}
async function terminalFixture(settled = true) {
  const f = await fixture(), r = reserve(f.store), a = claim(f.store, r.sessionId);
  if (settled) f.store.settleAdmission(a.admissionId, 'completed');
  else f.store.markAdmissionAmbiguous(a.admissionId);
  f.store.recordAck(scope, a.event.positionRef);
  f.setNow(100 + RETENTION_MS);
  return { f, r, a };
}
function independentFixtureVerifier(f: Awaited<ReturnType<typeof fixture>>, evidence: RetirementWitness | undefined) {
  // Synthetic fixture authority: proof references cannot supply their own verifier or claims.
  const authenticated = new Map([['authenticated-reference', evidence]]);
  const verify = vi.fn((reference: string) => authenticated.get(reference));
  const store = new CardStore(f.db, { clock: { nowUtcMs: f.now }, retirementVerifier: { verify } });
  return { store, verify };
}

describe('independently verified retirement (synthetic fixtures, no live certification)', () => {
  it('retires the FK graph at 24h only with exact current source/restore/owner evidence', async () => {
    const { f, r, a } = await terminalFixture();
    const { store, verify } = independentFixtureVerifier(f, witness(f, a.event));
    expect(store.cleanup()).toMatchObject({ attempts: 0, admissions: 0, sessions: 0 });
    const result = store.cleanup(['authenticated-reference']);
    expect(result).toMatchObject({ attempts: 1, dispositions: 1, admissions: 1, sessions: 1, messages: 1 });
    expect(verify).toHaveBeenCalledTimes(3);
    expect(store.getEventReplay(a.event.eventId).kind).toBe('absent');
    expect(store.getSession(r.sessionId)).toBeNull();
    expect(store.readCursor(scope)).toMatchObject({ cursor: 'opaque-z', ackedThrough: 'opaque-z' });
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    await f.reopen(); expect(f.store.getEventReplay(a.event.eventId).kind).toBe('absent');
    expect(f.store.cleanup(['authenticated-reference'])).toMatchObject({ attempts: 0, admissions: 0, sessions: 0 });
  });
  it.each(['missing', 'unverified', 'expired', 'future', 'installation', 'lineage', 'graph', 'scope', 'event',
    'digest', 'position', 'predecessor', 'outcome', 'retention', 'cursor', 'topology', 'replay', 'restore', 'owner', 'empty_fence'])(
    'retains the whole graph for %s proof', async mode => {
      const { f, a } = await terminalFixture();
      const w = witness(f, a.event);
      let evidence: RetirementWitness | undefined = w;
      if (mode === 'missing') evidence = undefined;
      const field = { expired: 'expiresAt', future: 'issuedAt', installation: 'installationRef', lineage: 'lineageId',
        graph: 'protectedGraphSha256', outcome: 'outcome', retention: 'retainUntil', cursor: 'confirmedPosition',
        topology: 'topology', replay: 'replayExcluded', restore: 'restoreExcluded', owner: 'activeOwnersExcluded', empty_fence: 'ownerFence' }[mode];
      if (field) evidence = { ...w, [field]: mode === 'expired' ? f.now() : mode === 'future' ? f.now() + 1
        : mode === 'retention' ? f.now() + 1000 : ['replay', 'restore', 'owner'].includes(mode) ? false : mode === 'empty_fence' ? '' : 'foreign' } as RetirementWitness;
      const key = { scope: 'scope', event: 'eventId', digest: 'envelopeDigest', position: 'positionRef', predecessor: 'previousPositionRef' }[mode];
      if (key) evidence = { ...w, identity: { ...w.identity, [key]: 'foreign' } };
      const { store } = independentFixtureVerifier(f, evidence);
      const before = readProtectedGraph(f.db);
      expect(store.cleanup([mode === 'unverified' ? 'self-asserted-reference' : 'authenticated-reference'])).toMatchObject({ attempts: 0, admissions: 0, sessions: 0 });
      expect(readProtectedGraph(f.db)).toEqual(before);
      await f.reopen(); expect(readProtectedGraph(f.db)).toEqual(before);
    });
  it.each(['retention_minus_one', 'pending_ack', 'live_admission', 'unacked_edit', 'live_generation', 'halt'])(
    'retains %s even with an authenticated witness', async mode => {
      const { f, r, a } = await terminalFixture(mode !== 'live_admission');
      if (mode === 'retention_minus_one') f.setNow(f.now() - 1);
      if (mode === 'pending_ack') f.db.prepare('UPDATE card_event_cursor SET acked_through = NULL').run();
      if (mode === 'unacked_edit') f.store.reserveSequence(r.cardId);
      if (mode === 'live_generation') f.store.registerHandler({ generation: 'original', installationRef: 'fixture-installation',
        sessionKey: 'route', runtimeIncarnation: 'new', resetEpoch: 0, expiresAt: f.now() + 1000, contextDigest: 'fixture', policyIdentity: 'fixture' });
      if (mode === 'halt') f.store.haltCursor(scope, 'fixture_halt');
      const { store } = independentFixtureVerifier(f, witness(f, a.event));
      const before = readProtectedGraph(f.db);
      store.cleanup(['authenticated-reference']); expect(readProtectedGraph(f.db)).toEqual(before);
    });
  it.each([2, 3])('retains atomically when verifier authority is lost on check %s', async lostAt => {
    const { f, a } = await terminalFixture();
    const w = witness(f, a.event), { store, verify } = independentFixtureVerifier(f, w);
    let checks = 0; verify.mockImplementation(() => ++checks < lostAt ? w : undefined);
    const before = readProtectedGraph(f.db);
    expect(store.cleanup(['authenticated-reference'])).toMatchObject({ attempts: 0, sessions: 0 });
    expect(readProtectedGraph(f.db)).toEqual(before);
    await f.reopen(); expect(readProtectedGraph(f.db)).toEqual(before);
  });
  it('rolls back child deletions on a storage fault and succeeds after reopen with fresh proof', async () => {
    const { f, a } = await terminalFixture();
    const { store } = independentFixtureVerifier(f, witness(f, a.event));
    const before = readProtectedGraph(f.db), prepare = f.db.prepare.bind(f.db);
    const fault = vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (sql === 'DELETE FROM card_sessions WHERE session_id = ?') throw new Error('fixture disk fault');
      return prepare(sql);
    });
    expect(() => store.cleanup(['authenticated-reference'])).toThrow('storage_failure');
    fault.mockRestore(); expect(readProtectedGraph(f.db)).toEqual(before);
    await f.reopen(); expect(readProtectedGraph(f.db)).toEqual(before);
    const next = independentFixtureVerifier(f, witness(f, a.event));
    expect(next.store.cleanup(['authenticated-reference']).sessions).toBe(1);
  });
});

describe('owned recovery maintenance', () => {
  it('honors 60s expiry, hourly conservative cleanup and cancellation before lease retirement', async () => {
    const f = await fixture(), r = reserve(f.store);
    vi.useFakeTimers();
    const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
    const registry = createResourceRegistry({ clock: { nowMono: () => 0 }, timers });
    registry.register(runInteractionRecovery(f.store, timers));
    f.setNow(r.expiresAt); await vi.advanceTimersByTimeAsync(59_999);
    expect(f.store.getSession(r.sessionId)?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1); expect(f.store.getSession(r.sessionId)?.status).toBe('expired');
    expect(await registry.closeAll('shutdown')).toMatchObject({ outcome: 'drained', unresolved: 0, owners: 1 });
    expect(vi.getTimerCount()).toBe(0);
    f.store.retire(); await vi.advanceTimersByTimeAsync(3_600_000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shares the 3s deadline with unresolved work and leaves no maintenance handles', async () => {
    const f = await fixture(); vi.useFakeTimers();
    const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
    const registry = createResourceRegistry({ clock: { nowMono: () => 0 }, timers });
    registry.register(runInteractionRecovery(f.store, timers));
    registry.register({ kind: 'event_consumer', close() {}, drain: () => new Promise(() => {}) });
    const closing = registry.closeAll('shutdown');
    await vi.advanceTimersByTimeAsync(3001);
    expect(await closing).toMatchObject({ outcome: 'ambiguous', unresolved: 1, overdue: 1 });
    expect(vi.getTimerCount()).toBe(0); f.store.retire();
  });
  it('resumes persisted failures after reopen at 1s/4s and never starts attempt four', async () => {
    const f = await fixture(), r = reserve(f.store);
    const event = { binding, wireId: 'event', position: 'opaque-z', previous: null, eventClass: 'card_action',
      payload: { sessionId: r.sessionId, messageId: 'message', channelId: 'route', channelType: 1, topicScope: null, requesterUid: 'requester' } };
    const handler = vi.fn(async () => ({ kind: 'retry' as const })), ack = vi.fn(async () => {});
    const make = () => createFakeEventConsumer({ store: f.store, binding, proof: () => proof, verifyProof: () => true,
      now: f.now, source: { kind: 'fake', read: async () => [event], ack, verifyOwned: () => ({ owned: true, actorUid: 'requester' }) },
      handler: () => handler, checkPolicy: async () => 'allowed', invalidate() {}, fence() {} });
    const fence = { reason: 'shutdown' as const, signal: AbortSignal.abort(), deadlineMono: 0 };
    let c = make();
    for (const [attempt, delay] of [[1, 1000], [2, 4000]] as const) {
      expect(await c.pump()).toEqual({ kind: 'held' });
      expect(f.store.getEventReplay(eventKey(scope, 'event'))).toMatchObject({ attempt: { number: attempt, phase: 'failed', nextEligibleAt: f.now() + delay } });
      c.close(fence); await c.drain(fence); await f.reopen(); c = make();
      f.setNow(f.now() + delay - 1); expect(await c.pump()).toEqual({ kind: 'held' });
      expect(handler).toHaveBeenCalledTimes(attempt); expect(ack).not.toHaveBeenCalled();
      f.setNow(f.now() + 1);
    }
    expect(await c.pump()).toEqual({ kind: 'processed', count: 1 });
    expect(handler).toHaveBeenCalledTimes(3); expect(ack).toHaveBeenCalledTimes(1);
    c.close(fence); await c.drain(fence); await f.reopen(); c = make(); await c.pump();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(f.store.getSession(r.sessionId)).toMatchObject({ status: 'dead_letter', attempts: 3, expiresAt: r.expiresAt });
    c.close(fence); await c.drain(fence);
  });
});
