/**
 * Ten-way barrier races against one real SQLite file. Each worker thread owns
 * its own connection, so the only serialization point is SQLite's write lock.
 * The store sources are transpiled once into a private temporary directory so
 * workers execute exactly the module under test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { migrateCardSchema } from '../cards/migrations.js';
import { CardStore } from '../cards/store.js';

const WORKERS = 10;
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..');

let root: string;
let storeUrl: string;

function transpile(rel: string, outRoot: string, sqliteUrl: string): void {
  const source = readFileSync(join(srcDir, rel), 'utf8');
  let out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  out = out.replace(/from 'better-sqlite3'/g, `from '${sqliteUrl}'`);
  const dest = join(outRoot, rel.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
}

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
(async () => {
  const { storeUrl, adapterUrl, dbPath, barrier, task } = workerData;
  const { CardStore } = await import(storeUrl);
  const { createAdapter } = await import(adapterUrl);
  const adapter = createAdapter(dbPath);
  let n = 0;
  const store = new CardStore(adapter, {
    clock: { nowUtcMs: () => task.now },
    newId: () => task.worker + '-' + (++n),
    sessionCapacity: task.capacity,
  });
  const flag = new Int32Array(barrier);
  Atomics.add(flag, 0, 1);
  while (Atomics.load(flag, 0) < task.workers) Atomics.wait(flag, 0, Atomics.load(flag, 0), 50);
  const out = [];
  try {
    for (const op of task.ops) {
      if (op.k === 'admit') out.push(store.admitOnce(op.input));
      else if (op.k === 'reserveSession') out.push(store.reserveSession(op.input));
      else if (op.k === 'charge') out.push(store.chargeExplicitRequest(op.input));
      else if (op.k === 'reserveExplicit') out.push(store.reserveExplicitSend(op.input));
      else if (op.k === 'chargeAndReserve') {
        const c = store.chargeExplicitRequest(op.charge);
        const r = c.kind === 'charged' || c.kind === 'joined' ? store.reserveExplicitSend(op.reserve) : null;
        out.push({ charge: c, reserve: r });
      }
    }
    parentPort.postMessage({ ok: true, out });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.code || err) });
  } finally {
    adapter.close();
  }
})();
`;

type Op = Record<string, unknown>;

async function race(dbPath: string, tasks: Array<{ ops: Op[]; capacity?: number }>): Promise<unknown[][]> {
  const barrier = new SharedArrayBuffer(4);
  const adapterUrl = pathToFileURL(join(root, 'out', 'db-adapter.js')).href;
  const results = await Promise.all(
    tasks.map(
      (t, i) =>
        new Promise<unknown[]>((resolvePromise, reject) => {
          const w = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: {
              storeUrl,
              adapterUrl,
              dbPath,
              barrier,
              task: { worker: `w${i}`, workers: tasks.length, now: T0, capacity: t.capacity, ops: t.ops },
            },
          });
          w.once('message', (m: { ok: boolean; out?: unknown[]; error?: string }) =>
            m.ok ? resolvePromise(m.out ?? []) : reject(new Error(m.error)),
          );
          w.once('error', reject);
        }),
    ),
  );
  return results;
}

const binding = { sessionKey: 'group:g1', channelId: 'g1', channelType: 2, topicScope: null, generation: 'turn-1', resetEpoch: 0 };
const contract = { requesterUid: 'u1', contractVersion: 1, authoredContractJson: '{}', authoredDataHash: 'h' };

function freshDb(name: string): { dbPath: string; store: CardStore; close: () => void } {
  const dbPath = join(root, `${name}.db`);
  const a = createAdapter(dbPath);
  new SessionStore(a).init();
  migrateCardSchema(a, { installationRef: 'install-a', lineageId: 'lineage-1', nowMs: T0 });
  let n = 0;
  const store = new CardStore(a, { clock: { nowUtcMs: () => T0 }, newId: () => `main-${++n}` });
  return { dbPath, store, close: () => a.close() };
}

function count(dbPath: string, sql: string): number {
  const a = createAdapter(dbPath);
  try {
    return (a.prepare(sql).get() as { c: number }).c;
  } finally {
    a.close();
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cards-race-'));
  const req = createRequire(import.meta.url);
  const sqliteUrl = pathToFileURL(req.resolve('better-sqlite3')).href;
  const outRoot = join(root, 'out');
  for (const rel of ['db-adapter.ts', 'cards/migrations.ts', 'cards/safe-file.ts', 'cards/store.ts', 'cards/contracts.ts']) transpile(rel, outRoot, sqliteUrl);
  storeUrl = pathToFileURL(join(outRoot, 'cards', 'store.js')).href;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ten-way barrier races on separate SQLite connections', () => {
  it('ten distinct submissions for one single-use card yield exactly one admission (AC-015.1)', async () => {
    const db = freshDb('admit');
    const r = db.store.reserveSession({ binding: binding as never, bodyDigest: 'd', clientMsgNo: 'c1', contract });
    if (r.kind !== 'reserved') throw new Error('reserve');
    db.store.ackMessage({ cardId: r.cardId, messageId: 'm1', currentResetEpoch: 0, policyAllows: true });
    for (let i = 0; i < WORKERS; i++) db.store.initCursor(`scope-${i}`, 'T-PART');
    db.close();
    const results = (await race(
      db.dbPath,
      Array.from({ length: WORKERS }, (_, i) => ({
        ops: [{
          k: 'admit',
          input: {
            eventId: `e-${i}`, scope: `scope-${i}`, eventClass: 'card_action', sessionId: r.sessionId,
            continuationGeneration: `cont-${i}`, submittedHash: 'sub', currentResetEpoch: 0,
            cursor: { scope: `scope-${i}`, expectedPrevious: null, next: `p-${i}` },
          },
        }],
      })),
    )).flat() as Array<{ kind: string }>;
    expect(results.filter((x) => x.kind === 'admitted')).toHaveLength(1);
    expect(results.filter((x) => x.kind === 'duplicate')).toHaveLength(WORKERS - 1);
    expect(count(db.dbPath, 'SELECT count(*) AS c FROM card_admissions')).toBe(1);
    expect(count(db.dbPath, 'SELECT count(*) AS c FROM card_event_dispositions')).toBe(WORKERS);
    expect(count(db.dbPath, `SELECT count(*) AS c FROM card_event_dispositions WHERE disposition = 'admitted'`)).toBe(1);
  });

  it('ten replays of the same event commit one final disposition and advance the cursor once', async () => {
    const db = freshDb('same-event');
    const r = db.store.reserveSession({ binding: binding as never, bodyDigest: 'd', clientMsgNo: 'c1', contract });
    if (r.kind !== 'reserved') throw new Error('reserve');
    db.store.ackMessage({ cardId: r.cardId, messageId: 'm1', currentResetEpoch: 0, policyAllows: true });
    db.store.initCursor('scope-a', 'T-EXCL');
    db.close();
    const input = {
      eventId: 'e-1', scope: 'scope-a', eventClass: 'card_action', sessionId: r.sessionId,
      continuationGeneration: 'cont', submittedHash: 'sub', currentResetEpoch: 0,
      cursor: { scope: 'scope-a', expectedPrevious: null, next: 'p1' },
    };
    const results = (await race(db.dbPath, Array.from({ length: WORKERS }, () => ({ ops: [{ k: 'admit', input }] })))).flat() as Array<{ kind: string; recorded?: string }>;
    expect(results.filter((x) => x.kind === 'admitted')).toHaveLength(1);
    expect(results.filter((x) => x.kind === 'duplicate' && x.recorded === 'admitted')).toHaveLength(WORKERS - 1);
    expect(count(db.dbPath, 'SELECT count(*) AS c FROM card_event_dispositions')).toBe(1);
    expect(count(db.dbPath, `SELECT count(*) AS c FROM card_event_cursor WHERE cursor = 'p1'`)).toBe(1);
  });

  it('concurrent T-reserve never exceeds capacity (count and insert are one transaction)', async () => {
    const db = freshDb('capacity');
    db.close();
    const results = (await race(
      db.dbPath,
      Array.from({ length: WORKERS }, (_, i) => ({
        capacity: 4,
        ops: Array.from({ length: 3 }, (_, j) => ({
          k: 'reserveSession',
          input: { binding, bodyDigest: 'd', clientMsgNo: `c-${i}-${j}`, contract },
        })),
      })),
    )).flat() as Array<{ kind: string }>;
    expect(results.filter((x) => x.kind === 'reserved')).toHaveLength(4);
    expect(results.filter((x) => x.kind === 'capacity_full')).toHaveLength(WORKERS * 3 - 4);
    expect(count(db.dbPath, 'SELECT count(*) AS c FROM card_sessions')).toBe(4);
  });

  it('identical concurrent request ids charge once and reserve at most one logical send (AC-011.8)', async () => {
    const db = freshDb('same-request');
    db.store.registerHandler({
      generation: 'gen-1', installationRef: 'install-a', sessionKey: 'group:g1', runtimeIncarnation: 'inc-1',
      resetEpoch: 0, expiresAt: T0 + 60_000, contextDigest: 'ctx', policyIdentity: 'p',
    });
    db.close();
    const f = { generation: 'gen-1', runtimeIncarnation: 'inc-1', resetEpoch: 0 };
    const results = (await race(
      db.dbPath,
      Array.from({ length: WORKERS }, () => ({
        ops: [{
          k: 'chargeAndReserve',
          charge: { ...f, requestId: 'r1', bodyDigest: 'b1', opcode: 'display' },
          reserve: { ...f, requestId: 'r1', card: { opcode: 'display', binding, bodyDigest: 'b1' } },
        }],
      })),
    )).flat() as Array<{ charge: { kind: string }; reserve: { kind: string } | null }>;
    expect(results.filter((x) => x.charge.kind === 'charged')).toHaveLength(1);
    expect(results.filter((x) => x.charge.kind === 'joined')).toHaveLength(WORKERS - 1);
    expect(results.filter((x) => x.reserve?.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((x) => x.reserve?.kind === 'already_reserved')).toHaveLength(WORKERS - 1);
    expect(count(db.dbPath, 'SELECT invocation_count AS c FROM card_handler_generations')).toBe(1);
    expect(count(db.dbPath, 'SELECT logical_send_count AS c FROM card_handler_generations')).toBe(1);
    expect(count(db.dbPath, 'SELECT count(*) AS c FROM card_messages')).toBe(1);
  });

  it('≥128 concurrent mixed calls stay within 32 invocations and 10 logical sends (AC-011.9)', async () => {
    const db = freshDb('mixed');
    db.store.registerHandler({
      generation: 'gen-1', installationRef: 'install-a', sessionKey: 'group:g1', runtimeIncarnation: 'inc-1',
      resetEpoch: 0, expiresAt: T0 + 60_000, contextDigest: 'ctx', policyIdentity: 'p',
    });
    db.close();
    const f = { generation: 'gen-1', runtimeIncarnation: 'inc-1', resetEpoch: 0 };
    const results = (await race(
      db.dbPath,
      Array.from({ length: WORKERS }, (_, i) => ({
        capacity: 3,
        ops: Array.from({ length: 13 }, (_, j) => {
          const opcode = (i + j) % 2 === 0 ? 'display' : 'interactive';
          const card = opcode === 'display'
            ? { opcode, binding, bodyDigest: `b-${i}-${j}` }
            : { opcode, binding, bodyDigest: `b-${i}-${j}`, contract };
          return {
            k: 'chargeAndReserve',
            charge: { ...f, requestId: `r-${i}-${j}`, bodyDigest: `b-${i}-${j}`, opcode },
            reserve: { ...f, requestId: `r-${i}-${j}`, card },
          };
        }),
      })),
    )).flat() as Array<{ charge: { kind: string }; reserve: { kind: string } | null }>;
    expect(results).toHaveLength(130);
    expect(results.filter((x) => x.charge.kind === 'charged')).toHaveLength(32);
    expect(results.filter((x) => x.charge.kind === 'exhausted')).toHaveLength(98);
    expect(results.filter((x) => x.reserve?.kind === 'reserved').length).toBeLessThanOrEqual(10);
    expect(count(db.dbPath, 'SELECT invocation_count AS c FROM card_handler_generations')).toBe(32);
    expect(count(db.dbPath, 'SELECT count(*) AS c FROM card_explicit_requests')).toBe(32);
    expect(count(db.dbPath, 'SELECT logical_send_count AS c FROM card_handler_generations')).toBe(
      results.filter((x) => x.reserve?.kind === 'reserved').length,
    );
    expect(count(db.dbPath, `SELECT count(*) AS c FROM card_sessions`)).toBeLessThanOrEqual(3);
    // Interactive capacity rejections are charged, bounded outcomes; nothing exceeds ten sends.
    const reserved = results.filter((x) => x.reserve?.kind === 'reserved').length;
    const capacityFull = results.filter((x) => x.reserve?.kind === 'capacity_full').length;
    const exhausted = results.filter((x) => x.reserve?.kind === 'exhausted').length;
    expect(reserved + capacityFull + exhausted).toBe(32);
  });
});
