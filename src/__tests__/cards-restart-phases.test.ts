import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createAdapter } from '../db-adapter.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { cardSubsystemPaths, openCardSubsystem } from '../cards/recovery.js';
import { createActionAdmission } from '../cards/action-admission.js';
import { createFakeEventConsumer, type FakeEvent } from '../cards/event-consumer.js';
import { canonicalJson } from '../cards/protocol.js';
import { getContinuation } from '../cards/continuation.js';
import { canonicalEnvelope, eventKey, validateTopology } from '../cards/topology.js';
import type { AdmissionReservation } from '../cards/contracts.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const binding = { environment: 'fixture', tenant: 'tenant', bot: 'bot', stream: 'stream' };
const proof = { ...binding, topology: 'T-PART', expiresAt: 1e12, nonDestructiveRead: true,
  orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };
const scope = validateTopology(binding, proof, () => true, 100)!.scope;
const buttons = [{ id: 'ok', label: 'Confirm' }];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const effects = (root: string) => existsSync(join(root, 'effects')) ? readFileSync(join(root, 'effects'), 'utf8').trim().split('\n').length : 0;

// Bundled from the candidate source. Only this newly owned fixture DB can be opened.
const childSource = `
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapter } from './src/db-adapter.ts';
import { openCardSubsystem } from './src/cards/recovery.ts';
import { createFakeEventConsumer } from './src/cards/event-consumer.ts';
import { createActionAdmission } from './src/cards/action-admission.ts';
import { getContinuation } from './src/cards/continuation.ts';
import { validateTopology } from './src/cards/topology.ts';
const [root, phase, serialized] = process.argv.slice(2);
const event = JSON.parse(serialized), binding = event.binding;
const proof = { ...binding, topology: 'T-PART', expiresAt: 1e12, nonDestructiveRead: true,
 orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };
let forbidden = 0;
globalThis.fetch = async () => { forbidden++; throw new Error('forbidden fixture network'); };
const db = createAdapter(join(root, 'owned.db'));
const opened = await openCardSubsystem({ adapter: db, dataDir: root, clock: { nowUtcMs: () => 100 }, runtimeIncarnation: 'child' });
if (opened.state !== 'ready') throw new Error('fixture startup');
const store = opened.store, scope = validateTopology(binding, proof, () => true, 100).scope;
function barrier() {
 writeFileSync(join(root, 'barrier.json'), JSON.stringify({ phase, forbidden }));
}
async function hold() { const handle = setInterval(() => {}, 1000); barrier(); await new Promise(() => {}); clearInterval(handle); }
if (phase.startsWith('uncommitted_')) {
 const prepare = db.prepare.bind(db);
 db.prepare = (sql) => {
  const statement = prepare(sql);
  const matches = phase === 'uncommitted_disposition' ? sql.includes('INSERT INTO card_event_dispositions')
   : sql.includes('UPDATE card_event_cursor SET cursor');
  if (!matches) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => { const result = run(...args); barrier(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return result; };
  return statement;
 };
}
const admission = createActionAdmission({ store, binding, now: () => 100, scope: () => scope,
 authenticate: () => ({ owned: true, actorUid: 'requester' }), authority: () => true,
 context: () => ({ sessionKey: 'route', channelId: 'route', channelType: 1, topicScope: null,
  requesterUid: 'requester', resetEpoch: 0, obo: false, docTask: false }),
 freshMember: async () => 'member', policy: async () => 'allowed', currentPolicy: () => true,
 withSession: async (turn, fn) => {
  if (phase === 'before_claim') await hold();
  return fn({ preflightContinuation: () => ({ accepted: true, reservation: {} }),
   dispatchContinuation: async () => {
    if (phase === 'after_claim') await hold();
    appendFileSync(join(root, 'effects'), 'effect\\n');
    getContinuation(turn).settle('completed');
   } });
 } });
const consumer = createFakeEventConsumer({ store, binding, proof: () => proof, verifyProof: () => true, now: () => 100,
 source: { kind: 'fake', read: async () => [event], verifyOwned: () => ({ owned: true, actorUid: 'requester' }),
  ack: async () => {
   if (['after_disposition', 'after_cursor_write'].includes(phase)) await hold();
   writeFileSync(join(root, 'remote-acked'), event.position);
   if (phase === 'after_ack') await hold();
  } },
 handler: () => phase === 'after_disposition' || phase.startsWith('uncommitted_')
  ? async () => ({ kind: 'final', disposition: 'invalid' }) : admission,
 checkPolicy: async () => 'allowed', invalidate() {}, fence() {} });
await consumer.pump();
throw new Error('missing fixture barrier');
`;

async function fixture() {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden fixture network'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wp13b-kill-')));
  expect(root.startsWith('/Users/')).toBe(false);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = cardSubsystemPaths(root);
  mkdirSync(paths.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.installationRefPath, 'fixture-installation\n', { mode: 0o600, flag: 'wx' });
  provisionFirstInstallMarker(paths.markerPath, 'fixture-installation', 100);
  let now = 100, db = createAdapter(join(root, 'owned.db')), dbOpen = true;
  const open = async () => {
    const opened = await openCardSubsystem({ adapter: db, dataDir: root, clock: { nowUtcMs: () => now }, runtimeIncarnation: 'parent' });
    if (opened.state !== 'ready') throw new Error('fixture startup: ' + opened.reason);
    return opened.store;
  };
  let store = await open();
  cleanups.push(() => { store.retire(); if (dbOpen) db.close(); });
  const r = store.reserveSession({ binding: { sessionKey: 'route', channelId: 'route', channelType: 1,
    topicScope: null, generation: 'original', resetEpoch: 0 }, bodyDigest: 'fixture', clientMsgNo: 'client',
    contract: { requesterUid: 'requester', contractVersion: 1, authoredContractJson: canonicalJson({ inputs: [], buttons }),
      authoredDataHash: createHash('sha256').update(canonicalJson(buttons.map(b => ({ id: b.id, data: {} })))).digest('hex') } });
  if (r.kind !== 'reserved') throw new Error('fixture reserve');
  store.ackMessage({ cardId: r.cardId, messageId: 'message', policyAllows: true, currentResetEpoch: 0 });
  const event: FakeEvent = { binding, wireId: 'event', position: 'opaque-z', previous: null, eventClass: 'card_action',
    payload: { sessionId: r.sessionId, messageId: 'message', channelId: 'route', channelType: 1, topicScope: null,
      requesterUid: 'requester', actionId: 'ok', data: {}, inputs: {} } };
  const outfile = join(root, 'child.mjs');
  await build({ stdin: { contents: childSource, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
    packages: 'external', outfile, logLevel: 'silent' });
  symlinkSync(resolve(dirname(require.resolve('better-sqlite3/package.json')), '..'), join(root, 'node_modules'), 'dir');
  return { root, event, r, get store() { return store; }, get db() { return db; }, now: () => now,
    setNow(v: number) { now = v; }, close() { store.retire(); db.close(); dbOpen = false; },
    async reopen() { db = createAdapter(join(root, 'owned.db')); dbOpen = true; store = await open(); } };
}

async function killAt(f: Awaited<ReturnType<typeof fixture>>, phase: string) {
  f.close();
  const child: ChildProcess = spawn(process.execPath, [join(f.root, 'child.mjs'), f.root, phase, canonicalEnvelope(f.event)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '';
  child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
  const exit = new Promise<{ code: number | null; signal: string | null }>((res, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => res({ code, signal }));
  });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const start = Date.now();
  while (!existsSync(join(f.root, 'barrier.json'))) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() - start > 10_000) throw new Error('fixture barrier: ' + phase + '\n' + output);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(JSON.parse(readFileSync(join(f.root, 'barrier.json'), 'utf8'))).toEqual({ phase, forbidden: 0 });
  expect(child.kill('SIGKILL')).toBe(true);
  expect(await exit).toEqual({ code: null, signal: 'SIGKILL' });
  await f.reopen();
}

describe('owned child-process restart barriers', () => {
  // T1 disposition and cursor are one commit. The two durable observations
  // below share that commit; the uncommitted controls prove its atomicity.
  it.each(['before_claim', 'after_claim', 'after_disposition', 'after_cursor_write', 'after_ack',
    'uncommitted_disposition', 'uncommitted_cursor'])(
    'recovers %s without duplicate business work or an invented ACK', async phase => {
      const f = await fixture(); await killAt(f, phase);
      const id = eventKey(scope, 'event'), replay = f.store.getEventReplay(id);
      const unclaimed = phase === 'before_claim' || phase.startsWith('uncommitted_');
      const rejected = phase === 'after_disposition';
      const initialEffects = phase === 'after_cursor_write' || phase === 'after_ack' ? 1 : 0;
      expect(effects(f.root)).toBe(initialEffects);
      expect(f.store.readCursor(scope)).toMatchObject({ cursor: unclaimed ? null : 'opaque-z', ackedThrough: null });
      if (unclaimed) {
        expect(replay).toMatchObject({ attempt: { number: 1, phase: 'started' } }); expect(replay).not.toHaveProperty('final');
        expect(f.store.getAdmissionForSession(f.r.sessionId)).toBeNull();
      } else if (rejected) expect(replay).toMatchObject({ final: { outcome: 'invalid' } });
      else expect(f.store.getAdmissionForSession(f.r.sessionId)?.state).toBe(phase === 'after_claim' ? 'ambiguous' : 'completed');
      expect(existsSync(join(f.root, 'remote-acked'))).toBe(phase === 'after_ack');
      let owner: 'unknown' | 'retired' = 'unknown', valid = true;
      const dispatch = vi.fn(async turn => { appendFileSync(join(f.root, 'effects'), 'effect\n'); getContinuation(turn)!.settle('completed'); });
      const admission = createActionAdmission({ store: f.store, binding, now: f.now, scope: () => scope,
        authenticate: () => ({ owned: true, actorUid: 'requester' }), authority: () => valid,
        context: () => ({ sessionKey: 'route', channelId: 'route', channelType: 1, topicScope: null,
          requesterUid: 'requester', resetEpoch: 0, obo: false, docTask: false }),
        freshMember: async () => 'member', policy: async () => 'allowed', currentPolicy: () => true,
        withSession: async (_turn, fn) => fn({ preflightContinuation: () => ({ accepted: true, reservation: {} as AdmissionReservation }), dispatchContinuation: dispatch }) });
      const ack = vi.fn(async () => { writeFileSync(join(f.root, 'remote-acked'), f.event.position); });
      const c = createFakeEventConsumer({ store: f.store, binding, proof: () => proof, verifyProof: () => valid, now: f.now,
        source: { kind: 'fake', read: async () => [f.event], ack, verifyOwned: () => ({ owned: true, actorUid: 'requester' }) },
        handler: () => admission, startedOwner: () => owner, checkPolicy: async () => 'allowed', invalidate() {}, fence() {} });
      const fence = { reason: 'shutdown' as const, signal: AbortSignal.abort(), deadlineMono: 0 };
      cleanups.push(async () => { c.close(fence); await c.drain(fence); });
      valid = false; expect(await c.pump()).toEqual({ kind: 'off' }); expect(ack).not.toHaveBeenCalled();
      valid = true;
      if (unclaimed) {
        expect(await c.pump()).toEqual({ kind: 'held' }); expect(dispatch).not.toHaveBeenCalled();
        owner = 'retired'; expect(await c.pump()).toEqual({ kind: 'held' });
        expect(f.store.getEventReplay(id)).toMatchObject({ attempt: { number: 1, phase: 'failed', nextEligibleAt: 1100 } });
        f.setNow(1099); await c.pump(); expect(dispatch).not.toHaveBeenCalled();
        f.setNow(1100);
      }
      expect(await c.pump()).toEqual({ kind: 'processed', count: 1 });
      expect(dispatch).toHaveBeenCalledTimes(unclaimed ? 1 : 0);
      expect(effects(f.root)).toBe(initialEffects + (unclaimed ? 1 : 0));
      expect(f.store.readCursor(scope)).toMatchObject({ cursor: 'opaque-z', ackedThrough: 'opaque-z' });
      await c.pump(); expect(ack).toHaveBeenCalledTimes(1);
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }, 20_000);
});
