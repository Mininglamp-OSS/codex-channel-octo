/** Real SQLite connections and a shared OS-thread barrier; no fake store CAS. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { migrateCardSchema } from '../cards/migrations.js';
import { CardStore } from '../cards/store.js';
import { createActionAdmission } from '../cards/action-admission.js';
import { createFakeEventConsumer, type FakeEvent } from '../cards/event-consumer.js';
import { canonicalEnvelope, eventKey, validateTopology } from '../cards/topology.js';
import { canonicalJson } from '../cards/protocol.js';
import { createHash } from 'node:crypto';
import type { AdmissionReservation, JsonValue } from '../cards/contracts.js';

const require = createRequire(import.meta.url);
let root: string, db: DbAdapter, store: CardStore, sessionId: string, workers: Worker[];
const binding = { environment: 'fixture', tenant: 'fixture', bot: 'fixture', stream: 'fixture' };
const proof = { ...binding, topology: 'T-PART', expiresAt: 1e12, nonDestructiveRead: true,
  orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };
const scope = validateTopology(binding, proof, () => true, 100)!.scope;
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden HTTP'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wp12-barrier-'))); workers = [];
  expect(root.startsWith('/Users/mlamp/')).toBe(false); expect(root.includes('/.codex/')).toBe(false);
  db = createAdapter(join(root, 'owned.db')); migrateCardSchema(db, { installationRef: 'fixture', lineageId: 'fixture', nowMs: 0 });
  store = new CardStore(db, { clock: { nowUtcMs: () => 100 } });
  const buttons = [{ id: 'ok', label: 'Confirm', data: { operation: 'stored' } }];
  const r = store.reserveSession({ binding: { sessionKey: 'route', channelId: 'route', channelType: 2,
    topicScope: null, generation: 'original', resetEpoch: 0 }, bodyDigest: 'digest', clientMsgNo: 'client',
    contract: { requesterUid: 'requester', contractVersion: 1,
      authoredContractJson: canonicalJson({ inputs: [], buttons } as unknown as JsonValue),
      authoredDataHash: createHash('sha256').update(canonicalJson(buttons.map(b => ({ id: b.id, data: b.data })))).digest('hex') } });
  if (r.kind !== 'reserved') throw new Error('fixture'); sessionId = r.sessionId;
  store.ackMessage({ cardId: r.cardId, messageId: 'message', policyAllows: true, currentResetEpoch: 0 });
});
afterEach(async () => {
  await Promise.all(workers.map(w => w.terminate())); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
});
function event(): FakeEvent { return { binding, wireId: 'event', position: 'position', previous: null, eventClass: 'card_action',
  payload: { sessionId, messageId: 'message', channelId: 'route', channelType: 2, topicScope: null, requesterUid: 'requester', actionId: 'ok', data: { operation: 'stored' }, inputs: {} } }; }
async function workerBundle() {
  // The worker imports the real store and adapter. Only the synthetic entry is bundled.
  symlinkSync(dirname(dirname(require.resolve('vitest/package.json'))), join(root, 'node_modules'), 'dir');
  const storeFile = fileURLToPath(new URL('../cards/store.ts', import.meta.url));
  const adapterFile = fileURLToPath(new URL('../db-adapter.ts', import.meta.url));
  const outfile = join(root, 'worker.mjs');
  await build({ stdin: { contents: `
    import {parentPort, workerData} from 'node:worker_threads';
    import {CardStore} from ${JSON.stringify(storeFile)};
    import {createAdapter} from ${JSON.stringify(adapterFile)};
    const db=createAdapter(workerData.path);
    const store=new CardStore(db,{clock:{nowUtcMs:()=>100}});
    parentPort.postMessage('ready');
    const gate=new Int32Array(workerData.barrier);
    Atomics.wait(gate,0,0);
    try {parentPort.postMessage(store.admitOnce(workerData.input));}
    catch(e){parentPort.postMessage({kind:'error',code:e.code});}
    db.close();
    `, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  return outfile;
}
describe('WP12 durable admission barriers (AC-015.1)', () => {
  it('admits one logical continuation for five replays and five distinct events across ten connections', async () => {
    store.initCursor('barrier', 'T-PART');
    const path = await workerBundle(), barrier = new SharedArrayBuffer(4);
    const completions: Promise<{ kind: string }>[] = [];
    const ready = Array.from({ length: 10 }, (_, i) => new Promise<void>((resolve, reject) => {
      const worker = new Worker(path, { workerData: { path: join(root, 'owned.db'), barrier,
        input: { eventId: i < 5 ? 'same-event' : `distinct-${i}`, scope: 'barrier', eventClass: 'card_action', sessionId,
          continuationGeneration: `generation-${i}`, submittedHash: 'hash', currentResetEpoch: 0,
          cursor: { scope: 'barrier', expectedPrevious: null, next: 'position' } } } }); workers.push(worker);
      completions.push(new Promise((done, fail) => { worker.once('error', fail); worker.on('message', m => { if (m !== 'ready') done(m); }); }));
      worker.once('error', reject); worker.once('message', m => m === 'ready' ? resolve() : reject(new Error('worker readiness')));
    }));
    await Promise.all(ready); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    const results = await Promise.all(completions);
    expect(results.filter(r => r.kind === 'admitted')).toHaveLength(1);
    expect(results.every(r => ['admitted', 'duplicate', 'cursor_conflict'].includes(r.kind))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM card_admissions').get()).toEqual({ n: 1 });
    expect(store.getSession(sessionId)?.status).toBe('admitted');
  });
  it('retains the claim after a commit-to-dispatch crash and never reruns it after reopening', async () => {
    store.initCursor(scope, 'T-PART');
    const e = event();
    store.recordAttemptStart({ eventId: eventKey(scope, 'event'), scope, eventClass: 'card_action', sessionId,
      messageId: canonicalEnvelope('message'), positionRef: 'position', previousPositionRef: null,
      envelopeDigest: createHash('sha256').update(canonicalEnvelope({ event: e, actorUid: 'requester' })).digest('hex') });
    const admission = store.admitOnce({ eventId: eventKey(scope, 'event'), scope, eventClass: 'card_action', sessionId,
      continuationGeneration: 'lost-generation', submittedHash: 'hash', currentResetEpoch: 0,
      cursor: { scope, expectedPrevious: null, next: 'position' } });
    expect(admission.kind).toBe('admitted');
    // Simulate loss after commit and before dispatch: close every old connection.
    db.close(); db = createAdapter(join(root, 'owned.db')); store = new CardStore(db, { clock: { nowUtcMs: () => 100 } });
    const dispatch = vi.fn(async () => {}), ack = vi.fn(async () => {});
    const h = createActionAdmission({ store, binding, scope: () => scope, now: () => 100, authenticate: () => ({ owned: true, actorUid: 'requester' }),
      authority: () => true, context: () => ({ sessionKey: 'route', channelId: 'route', channelType: 2, topicScope: null, requesterUid: 'requester', resetEpoch: 0, obo: false, docTask: false }),
      freshMember: async () => 'member', policy: async () => 'allowed', currentPolicy: () => true,
      withSession: async (_turn, fn) => fn({ preflightContinuation: () => ({ accepted: true, reservation: {} as AdmissionReservation }), dispatchContinuation: dispatch }) });
    // The retained T0 identity allows re-ACK; it never supplies execution authority.
    const consumer = createFakeEventConsumer({ store, binding, proof: () => proof, verifyProof: () => true, now: () => 100,
      source: { kind: 'fake', read: async () => [e], ack, verifyOwned: () => ({ owned: true, actorUid: 'requester' }) }, handler: () => h,
      invalidate: () => {}, fence: () => {}, freshMember: async () => 'member', checkPolicy: async () => 'allowed' });
    expect(await consumer.pump()).toEqual({ kind: 'processed', count: 1 });
    await h(e, new AbortController().signal);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled(); expect(store.getAdmissionForSession(sessionId)?.continuationGeneration).toBe('lost-generation');
    expect(db.prepare('SELECT COUNT(*) AS n FROM card_admissions').get()).toEqual({ n: 1 });
    consumer.close({ reason: 'shutdown', deadlineMono: 0, signal: AbortSignal.abort() });
    await consumer.drain({ reason: 'shutdown', deadlineMono: 0, signal: AbortSignal.abort() });
  });
  it('has a positive control: an unclaimed authorized event dispatches once through the real consumer', async () => {
    const dispatch = vi.fn(async () => {}), ack = vi.fn(async () => {});
    const h = createActionAdmission({ store, binding, scope: () => scope, now: () => 100, authenticate: () => ({ owned: true, actorUid: 'requester' }),
      authority: () => true, context: () => ({ sessionKey: 'route', channelId: 'route', channelType: 2, topicScope: null, requesterUid: 'requester', resetEpoch: 0, obo: false, docTask: false }),
      freshMember: async () => 'member', policy: async () => 'allowed', currentPolicy: () => true,
      withSession: async (_turn, fn) => fn({ preflightContinuation: () => ({ accepted: true, reservation: {} as AdmissionReservation }), dispatchContinuation: dispatch }) });
    const consumer = createFakeEventConsumer({ store, binding, proof: () => proof, verifyProof: () => true, now: () => 100,
      source: { kind: 'fake', read: async () => [event()], ack, verifyOwned: () => ({ owned: true, actorUid: 'requester' }) }, handler: () => h,
      invalidate: () => {}, fence: () => {}, freshMember: async () => 'member', checkPolicy: async () => 'allowed' });
    expect(await consumer.pump()).toEqual({ kind: 'processed', count: 1 });
    expect(await consumer.pump()).toEqual({ kind: 'processed', count: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(ack).toHaveBeenCalledTimes(1);
    consumer.close({ reason: 'shutdown', deadlineMono: 0, signal: AbortSignal.abort() });
    await consumer.drain({ reason: 'shutdown', deadlineMono: 0, signal: AbortSignal.abort() });
  });
});
