import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import {
  CARD_TABLES,
  CARD_V1_DDL,
  CARD_V3_DDL,
  FileActivationMarker,
  backupBeforeMigration,
  inspectCardSchema,
  migrateCardSchema,
  parseActivationMarker,
  provisionFirstInstallMarker,
  referenceSchema,
  upgradeCardSchemaV1toV2,
  upgradeCardSchemaV2toV3,
  upgradeCardSchemaV3toV4,
  serializeActivationMarker,
  type ActivationMarker,
  type ActivationMarkerPort,
  type MarkerRead,
} from '../cards/migrations.js';
import { CardStore, initializeCardStore, readProtectedGraph, type CardStoreInit } from '../cards/store.js';

const INSTALL = 'install-a';
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const isPosix = platform() !== 'win32';

interface Env {
  root: string;
  dbPath: string;
  backupDir: string;
  markerPath: string;
}

let env: Env;
const open: DbAdapter[] = [];

function openDb(path = env.dbPath): DbAdapter {
  const a = createAdapter(path);
  open.push(a);
  // Ordinary store initialization always precedes card initialization.
  new SessionStore(a).init();
  return a;
}

function closeAll(): void {
  while (open.length) {
    try {
      open.pop()?.close();
    } catch {
      // already closed
    }
  }
}

function clock(t = T0) {
  return { nowUtcMs: () => t };
}

async function init(adapter: DbAdapter, overrides: Partial<Parameters<typeof initializeCardStore>[0]> = {}): Promise<CardStoreInit> {
  return initializeCardStore({
    adapter,
    marker: new FileActivationMarker(env.markerPath),
    installationRef: INSTALL,
    backupDir: env.backupDir,
    clock: clock(),
    newLineageId: () => 'lineage-1',
    ...overrides,
  });
}

function cardObjects(a: DbAdapter): string[] {
  return (a.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'card%' OR name LIKE 'idx_card%' OR name LIKE 'trg_card%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cards-migrations-'));
  env = {
    root,
    dbPath: join(root, 'data', 'cc-octo.db'),
    backupDir: join(root, 'data', 'backups'),
    markerPath: join(root, 'recovery', 'card-activation.json'),
  };
});

afterEach(() => {
  closeAll();
  rmSync(env.root, { recursive: true, force: true });
});

describe('DbAdapter.backup', () => {
  it('writes a consistent online copy including uncheckpointed WAL pages', async () => {
    const a = openDb();
    a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    a.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    const dest = join(env.root, 'copy.db');
    await a.backup(dest);
    const b = createAdapter(dest);
    open.push(b);
    expect(b.prepare('SELECT v FROM t').get()).toEqual({ v: 'x' });
  });
});

describe('reference schema', () => {
  it('is stable and covers every planned card table with constraints', () => {
    const ref = referenceSchema();
    expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(referenceSchema().hash).toBe(ref.hash);
    const tables = ref.objects.filter((o) => o.type === 'table').map((o) => o.name).sort();
    expect(tables).toEqual([...CARD_TABLES].sort());
    // Version 3 (SC-1) adds one settlement trigger to the eight of versions 1 and 2.
    expect(ref.objects.filter((o) => o.type === 'trigger')).toHaveLength(14);
    expect(referenceSchema(3).objects.filter((o) => o.type === 'trigger')).toHaveLength(9);
    expect(referenceSchema(2).objects.filter((o) => o.type === 'trigger')).toHaveLength(8);
    expect(referenceSchema(1).hash).toBe(referenceSchema(2).hash);
    expect(referenceSchema(1).hash).toBe('96ceca1b7fcb7dc6b5c9a2a9ce31789fdd0c7905ddc7090c69a2e69547e3652b');
    expect(referenceSchema(3).hash).toBe('e8b1cca8e75c8f7ad38240edcf661219d3f25858d7ec491878e3877d1c779028');
    expect(referenceSchema(2).hash).not.toBe(ref.hash);
    expect(ref.objects.filter((o) => o.type === 'index' && !o.name.startsWith('sqlite_')).map((o) => o.name).sort()).toEqual([
      'idx_card_messages_open',
      'idx_card_sessions_active',
    ]);
  });
});

describe('WP11 historical migration chains and faults', () => {
  function historical(a: DbAdapter, version: 1 | 2 | 3) {
    for (const ddl of [...CARD_V1_DDL, ...(version === 3 ? CARD_V3_DDL : [])]) a.exec(ddl);
    const values = { schema_family: 'card_v1', schema_version: String(version), explicit_ledger_version: '1',
      schema_hash: referenceSchema(version).hash, lineage_id: 'lineage-1', installation_ref: INSTALL,
      created_by: 'codex-channel-octo', created_at: String(T0), ...(version >= 2 ? { intent_legacy: '{"format":1,"cards":[]}' } : {}) };
    const insert = a.prepare('INSERT INTO card_meta(k,v) VALUES (?,?)');
    for (const [k, v] of Object.entries(values)) insert.run(k, v);
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const marker = new FileActivationMarker(env.markerPath); const m = marker.read();
    if (m.state !== 'present') throw new Error('fixture marker');
    marker.write({ ...m.marker, everActivated: true, schemaFamily: 'card_v1', lineageId: 'lineage-1' });
    return marker;
  }
  function proxy(a: DbAdapter, fault: (sql: string, operation: 'exec' | 'prepare') => void): DbAdapter {
    return new Proxy(a, { get(target, prop) {
      if (prop === 'exec') return (sql: string) => { fault(sql, 'exec'); return target.exec(sql); };
      if (prop === 'prepare') return (sql: string) => { fault(sql, 'prepare'); return target.prepare(sql); };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...p: unknown[]) => unknown).bind(target) : value;
    } });
  }
  it.each([1, 2, 3] as const)('backs up once and upgrades exact historical version %i through v4', async (version) => {
    const a = openDb(); historical(a, version);
    const old = new CardStore(a, { clock: clock() });
    old.registerHandler({ generation: 'g', installationRef: INSTALL, sessionKey: 's', runtimeIncarnation: 'r', resetEpoch: 0,
      expiresAt: T0 + 86400000, contextDigest: 'd', policyIdentity: 'p' });
    const before = readProtectedGraph(a); const result = await init(a);
    expect(result).toMatchObject({ state: 'ready', meta: { schemaVersion: 4 } });
    const after = readProtectedGraph(a);
    for (const table of CARD_TABLES.filter((t) => t !== 'card_meta')) expect(after[table]).toEqual(before[table]);
    expect(readdirSync(env.backupDir)).toHaveLength(1);
    expect(result.state === 'ready' && result.backup?.fileName).toContain(`pre-card_v1-s${version + 1}`);
    expect(await init(a)).toMatchObject({ state: 'ready', meta: { schemaVersion: 4 } });
    expect(readdirSync(env.backupDir)).toHaveLength(1);
  });
  it('preserves literal historical direct targets and hashes before the additive v4 step', () => {
    const a = openDb(); historical(a, 1);
    expect(upgradeCardSchemaV1toV2(a, 'lineage-1').schemaVersion).toBe(2);
    expect(inspectCardSchema(a)).toMatchObject({ meta: { schemaHash: referenceSchema(1).hash } });
    expect(upgradeCardSchemaV2toV3(a, 'lineage-1').schemaVersion).toBe(3);
    expect(inspectCardSchema(a)).toMatchObject({ meta: { schemaHash: referenceSchema(3).hash } });
    expect(upgradeCardSchemaV3toV4(a, 'lineage-1').schemaVersion).toBe(4);
  });
  it.each(['CREATE TABLE card_event_invalidations', 'CREATE TRIGGER trg_card_event_invalidations_final',
    'CREATE TRIGGER trg_card_event_attempts_identity', 'UPDATE card_meta SET v = ? WHERE k = ? AND v = ?',
    'PRAGMA integrity_check', 'PRAGMA foreign_key_check(card_event_invalidations)',
    'SELECT 1 FROM card_event_invalidations'])('rolls v4 back on %s failure', (fragment) => {
    const a = openDb(); historical(a, 3); const before = readProtectedGraph(a);
    const failing = proxy(a, (sql) => { if (sql.includes(fragment)) throw new Error('injected'); });
    expect(() => upgradeCardSchemaV3toV4(failing, 'lineage-1')).toThrow('injected');
    expect(a.inTransaction).toBe(false); expect(inspectCardSchema(a)).toMatchObject({ state: 'complete', meta: { schemaVersion: 3 } });
    expect(readProtectedGraph(a)).toEqual(before);
  });
  it.each(['schema_version', 'lineage_id', 'installation_ref', 'schema_hash'])('detects %s drift during backup before mutation', async (key) => {
    const a = openDb(); historical(a, 3);
    const wrapped = new Proxy(a, { get(target, prop) {
      if (prop === 'backup') return async (path: string) => { await target.backup(path); target.prepare('UPDATE card_meta SET v = ? WHERE k = ?').run('changed', key); };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...p: unknown[]) => unknown).bind(target) : value;
    } });
    expect(await init(wrapped)).toEqual({ state: 'disabled', reason: 'provenance_conflict' });
    expect(cardObjects(a)).not.toContain('card_event_invalidations');
    expect(a.prepare('SELECT v FROM card_meta WHERE k = ?').get(key)).toEqual({ v: 'changed' });
  });
  it('keeps the last committed historical version after a later step fails, then re-upgrades', async () => {
    const a = openDb(); historical(a, 1);
    const failing = proxy(a, (sql) => { if (sql.startsWith('ALTER TABLE card_explicit_requests ADD COLUMN')) throw new Error('injected'); });
    expect(await init(failing)).toEqual({ state: 'disabled', reason: 'migration_failed' });
    expect(inspectCardSchema(a)).toMatchObject({ state: 'complete', meta: { schemaVersion: 2 } });
    const result = await init(a);
    expect(result).toMatchObject({ state: 'ready', meta: { schemaVersion: 4 } });
    expect(result.state === 'ready' && result.backup?.fileName).toContain('pre-card_v1-s3');
  });
  it('keeps v3 untouched on backup failure and keeps committed v4 disabled on marker failure', async () => {
    const a = openDb(); const marker = historical(a, 3);
    const backupFails = new Proxy(a, { get(target, prop) {
      if (prop === 'backup') return async () => { throw new Error('backup'); };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...p: unknown[]) => unknown).bind(target) : value;
    } });
    expect(await init(backupFails)).toMatchObject({ state: 'disabled' });
    expect(inspectCardSchema(a)).toMatchObject({ meta: { schemaVersion: 3 } });
    const result = await init(a, { marker: { read: () => marker.read(), write: () => { throw new Error('marker'); } } });
    expect(result).toEqual({ state: 'disabled', reason: 'marker_write_failed' });
    expect(inspectCardSchema(a)).toMatchObject({ state: 'complete', meta: { schemaVersion: 4 } });
  });
});

describe('activation marker', () => {
  const base: ActivationMarker = {
    installationRef: INSTALL,
    everActivated: true,
    schemaFamily: 'card_v1',
    lineageId: 'lineage-1',
    backupRef: null,
    recoveryClearanceRef: null,
    updatedAt: T0,
  };

  it('round-trips and rejects unknown keys, wrong types and contradictory activation facts', () => {
    expect(parseActivationMarker(serializeActivationMarker(base))).toEqual(base);
    const obj = JSON.parse(serializeActivationMarker(base));
    expect(parseActivationMarker(JSON.stringify({ ...obj, extra: 1 }))).toBeNull();
    expect(parseActivationMarker(JSON.stringify({ ...obj, everActivated: 'yes' }))).toBeNull();
    expect(parseActivationMarker(JSON.stringify({ ...obj, lineageId: null }))).toBeNull();
    expect(parseActivationMarker(JSON.stringify({ ...obj, everActivated: false }))).toBeNull();
    expect(parseActivationMarker(JSON.stringify({ ...obj, version: 2 }))).toBeNull();
    expect(parseActivationMarker(JSON.stringify({ ...obj, installationRef: '../x' }))).toBeNull();
    expect(parseActivationMarker('{')).toBeNull();
    expect(parseActivationMarker('[]')).toBeNull();
  });

  it('provisioning never overwrites an existing marker', () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    new FileActivationMarker(env.markerPath).write(base);
    expect(() => provisionFirstInstallMarker(env.markerPath, INSTALL, T0)).toThrow();
    const read = new FileActivationMarker(env.markerPath).read();
    expect(read.state === 'present' && read.marker.everActivated).toBe(true);
  });

  it.runIf(isPosix)('is written owner-only inside an owner-only directory', () => {
    new FileActivationMarker(env.markerPath).write(base);
    expect(statSync(env.markerPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(env.root, 'recovery')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(env.root, 'recovery'))).toEqual(['card-activation.json']);
  });
});

describe('startup provenance matrix (§4.3)', () => {
  it('pristine first install: backup, one-transaction migration, then marker activation', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb();
    a.prepare('INSERT INTO sessions (id, channel_id, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s1', 'c1', 1, 1, 1);
    const r = await init(a);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    expect(r.provenance).toBe('first_install');
    expect(r.meta.lineageId).toBe('lineage-1');
    expect(r.backup?.fileName).toBe('cc-octo.pre-card_v1.20261014T080000000Z.db');
    // The backup predates the migration: legacy rows, no card objects.
    const b = createAdapter(r.backup!.path);
    open.push(b);
    expect(cardObjects(b)).toEqual([]);
    expect(b.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's1' }]);
    if (isPosix) {
      expect(statSync(r.backup!.path).mode & 0o777).toBe(0o600);
      expect(statSync(env.backupDir).mode & 0o777).toBe(0o700);
    }
    const marker = new FileActivationMarker(env.markerPath).read();
    expect(marker).toEqual({
      state: 'present',
      marker: {
        installationRef: INSTALL,
        everActivated: true,
        schemaFamily: 'card_v1',
        lineageId: 'lineage-1',
        backupRef: r.backup!.fileName,
        recoveryClearanceRef: null,
        updatedAt: T0,
      },
    });
    expect(inspectCardSchema(a).state).toBe('complete');
    expect(a.prepare('SELECT count(*) AS c FROM sessions').get()).toEqual({ c: 1 });
  });

  it('idempotent reopen keeps lineage, data and schema; no second backup', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const r1 = await init(openDb());
    expect(r1.state).toBe('ready');
    if (r1.state !== 'ready') return;
    r1.store.initCursor('scope-a', 'T-EXCL');
    closeAll();
    const r2 = await init(openDb(), { newLineageId: () => 'lineage-other' });
    expect(r2.state).toBe('ready');
    if (r2.state !== 'ready') return;
    expect(r2.provenance).toBe('reopened');
    expect(r2.meta.lineageId).toBe('lineage-1');
    expect(r2.store.readCursor('scope-a')?.topology).toBe('T-EXCL');
    expect(readdirSync(env.backupDir)).toHaveLength(1);
    // Rerunning the migration on a complete schema is a no-op.
    const a = open[open.length - 1];
    const before = readProtectedGraph(a);
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-1', nowMs: T0 + 5 });
    expect(readProtectedGraph(a)).toEqual(before);
  });

  it('missing marker with no DB is unknown, not fresh', async () => {
    const a = openDb();
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'provenance_missing' });
    expect(cardObjects(a)).toEqual([]);
    expect(existsSync(env.backupDir)).toBe(false);
  });

  it('missing marker with an existing card DB stays disabled', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    expect((await init(openDb())).state).toBe('ready');
    closeAll();
    rmSync(env.markerPath);
    expect(await init(openDb())).toEqual({ state: 'disabled', reason: 'provenance_missing' });
  });

  it('prior-active marker with a missing/replaced DB never initializes over lost ownership', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    expect((await init(openDb())).state).toBe('ready');
    closeAll();
    rmSync(join(env.root, 'data'), { recursive: true, force: true });
    const a = openDb();
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'prior_active_store_missing' });
    expect(cardObjects(a)).toEqual([]);
  });

  it('DB-only crash (schema committed, marker not activated) reconciles only an empty graph', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-crash', nowMs: T0 });
    const r = await init(a);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    expect(r.provenance).toBe('activation_reconciled');
    const m = new FileActivationMarker(env.markerPath).read();
    expect(m.state === 'present' && m.marker.lineageId).toBe('lineage-crash');
  });

  it('DB-only state with protected rows but never-activated marker is a provenance conflict', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-x', nowMs: T0 });
    a.prepare(`INSERT INTO card_event_cursor (consumer_scope, topology, updated_at) VALUES ('s', 'T-EXCL', 1)`).run();
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'provenance_conflict' });
    const m = new FileActivationMarker(env.markerPath).read();
    expect(m.state === 'present' && m.marker.everActivated).toBe(false);
  });

  it('marker-only state (activated marker, no card schema) is treated as lost ownership', async () => {
    new FileActivationMarker(env.markerPath).write({
      installationRef: INSTALL, everActivated: true, schemaFamily: 'card_v1', lineageId: 'lineage-1',
      backupRef: null, recoveryClearanceRef: null, updatedAt: T0,
    });
    expect(await init(openDb())).toEqual({ state: 'disabled', reason: 'prior_active_store_missing' });
  });

  it('marker write failure after migration leaves cards disabled and is reconciled on restart', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const file = new FileActivationMarker(env.markerPath);
    const failing: ActivationMarkerPort = { read: (): MarkerRead => file.read(), write: () => { throw new Error('EIO'); } };
    const a = openDb();
    expect(await init(a, { marker: failing })).toEqual({ state: 'disabled', reason: 'marker_write_failed' });
    expect(inspectCardSchema(a).state).toBe('complete');
    const r = await init(a);
    expect(r.state === 'ready' && r.provenance).toBe('activation_reconciled');
  });

  it('old backup restored under a newer activation lineage is rejected', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    expect((await init(openDb())).state).toBe('ready');
    closeAll();
    // A different lineage (e.g. a rebuilt or foreign store) behind the same marker.
    rmSync(join(env.root, 'data'), { recursive: true, force: true });
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-old', nowMs: T0 - 1000 });
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'lineage_mismatch' });
  });

  it('installation mismatch between marker, caller and DB is rejected', async () => {
    provisionFirstInstallMarker(env.markerPath, 'install-b', T0);
    expect(await init(openDb())).toEqual({ state: 'disabled', reason: 'installation_mismatch' });
    rmSync(env.markerPath);
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb(join(env.root, 'data', 'other.db'));
    migrateCardSchema(a, { installationRef: 'install-b', lineageId: 'lineage-1', nowMs: T0 });
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'installation_mismatch' });
  });

  it('corrupt or unreadable marker is invalid provenance', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    writeFileSync(env.markerPath, '{"format":"cc-octo-card-activation"');
    expect(await init(openDb())).toEqual({ state: 'disabled', reason: 'provenance_invalid' });
    const throwing: ActivationMarkerPort = { read: () => { throw new Error('EACCES'); }, write: () => undefined };
    expect(await init(openDb(), { marker: throwing })).toEqual({ state: 'disabled', reason: 'provenance_invalid' });
  });

  it('marker written by a newer schema family is rejected', async () => {
    new FileActivationMarker(env.markerPath).write({
      installationRef: INSTALL, everActivated: true, schemaFamily: 'card_v2', lineageId: 'lineage-1',
      backupRef: null, recoveryClearanceRef: null, updatedAt: T0,
    });
    expect(await init(openDb())).toEqual({ state: 'disabled', reason: 'newer_schema' });
  });
});

describe('schema rejection', () => {
  beforeEach(() => provisionFirstInstallMarker(env.markerPath, INSTALL, T0));

  it('partial schema (a planned table missing) is rejected without repair', async () => {
    const a = openDb();
    for (const stmt of CARD_V1_DDL.slice(0, 4)) a.exec(stmt);
    const before = cardObjects(a);
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'partial_schema' });
    expect(cardObjects(a)).toEqual(before);
    expect(existsSync(env.backupDir)).toBe(false);
  });

  it('complete tables with missing metadata rows are rejected', async () => {
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-1', nowMs: T0 });
    a.prepare(`DELETE FROM card_meta WHERE k = 'schema_hash'`).run();
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'unknown_schema' });
  });

  it('unknown extra card object is rejected', async () => {
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-1', nowMs: T0 });
    a.exec('CREATE TABLE card_experimental (x TEXT)');
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'unknown_schema' });
  });

  it('rewritten card object (dropped constraint) is rejected', async () => {
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-1', nowMs: T0 });
    a.exec('DROP TRIGGER trg_card_event_dispositions_final');
    a.exec(`CREATE TRIGGER trg_card_event_dispositions_final BEFORE UPDATE ON card_event_dispositions BEGIN SELECT 1; END`);
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'unknown_schema' });
  });

  it('newer schema version is rejected and left untouched', async () => {
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-1', nowMs: T0 });
    a.prepare(`UPDATE card_meta SET v = '5' WHERE k = 'schema_version'`).run();
    a.exec('CREATE TABLE card_v2_extra (x TEXT)');
    expect(inspectCardSchema(a)).toEqual({ state: 'newer', schemaVersion: 5 });
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'newer_schema' });
    expect(cardObjects(a)).toContain('card_v2_extra');
  });

  it('corrupt card metadata value types are rejected', async () => {
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-1', nowMs: T0 });
    a.prepare(`UPDATE card_meta SET v = 'not-a-number' WHERE k = 'created_at'`).run();
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'unknown_schema' });
  });

  it('FK-broken protected graph fails invariants on open', async () => {
    const a = openDb();
    expect((await init(a)).state).toBe('ready');
    a.exec('PRAGMA foreign_keys = OFF');
    a.prepare(
      `INSERT INTO card_admissions (admission_id, session_id, event_id, continuation_generation, submitted_hash, state, admitted_at)
       VALUES ('adm', 'missing-session', 'ev', 'g', 'h', 'admitted', 1)`,
    ).run();
    a.exec('PRAGMA foreign_keys = ON');
    const r = await init(a);
    expect(r.state).toBe('disabled');
    if (r.state === 'disabled') {
      expect(r.reason).toBe('invariant_failed');
      expect(r.violations).toContain('foreign_key');
    }
  });

  it('a corrupt card page is an integrity failure, never a fresh install', async () => {
    const a = openDb();
    expect((await init(a)).state).toBe('ready');
    const { rootpage } = a.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'card_messages'`).get() as { rootpage: number };
    const { page_size: pageSize } = a.prepare('PRAGMA page_size').get() as { page_size: number };
    closeAll();
    const bytes = readFileSync(env.dbPath);
    expect(rootpage).toBeGreaterThan(1);
    bytes.fill(0xa5, (rootpage - 1) * pageSize, rootpage * pageSize);
    writeFileSync(env.dbPath, bytes);
    const r = await init(openDb());
    expect(r).toMatchObject({ state: 'disabled', reason: 'integrity_failed' });
  });
});

describe('backup before mutation', () => {
  beforeEach(() => provisionFirstInstallMarker(env.markerPath, INSTALL, T0));

  it('backup failure leaves the database untouched and cards disabled', async () => {
    const a = openDb();
    // A regular file where the backup directory must be.
    writeFileSync(join(env.root, 'data', 'backups'), 'not a directory');
    expect(await init(a)).toEqual({ state: 'disabled', reason: 'backup_failed' });
    expect(cardObjects(a)).toEqual([]);
    const m = new FileActivationMarker(env.markerPath).read();
    expect(m.state === 'present' && m.marker.everActivated).toBe(false);
  });

  it('a rejected adapter backup removes the partial file and runs no migration', async () => {
    const a = openDb();
    const failing: DbAdapter = {
      exec: (s) => a.exec(s),
      prepare: (s) => a.prepare(s),
      close: () => a.close(),
      get inTransaction() { return a.inTransaction; },
      transaction: (fn) => a.transaction(fn),
      backup: async () => { throw new Error('SQLITE_FULL'); },
    };
    expect(await init(failing)).toEqual({ state: 'disabled', reason: 'backup_failed' });
    expect(cardObjects(a)).toEqual([]);
    expect(readdirSync(env.backupDir)).toEqual([]);
  });

  it('an existing backup with the same stamp is never overwritten', async () => {
    const a = openDb();
    const first = await backupBeforeMigration(a, env.backupDir, T0);
    await expect(backupBeforeMigration(a, env.backupDir, T0)).rejects.toThrow();
    expect(readdirSync(env.backupDir)).toEqual([first.fileName]);
  });

  it('migration failure rolls back every card object', async () => {
    const a = openDb();
    const broken: DbAdapter = {
      exec: (s) => {
        if (s.includes('CREATE TABLE IF NOT EXISTS card_explicit_requests')) throw new Error('disk I/O error');
        a.exec(s);
      },
      prepare: (s) => a.prepare(s),
      close: () => a.close(),
      get inTransaction() { return a.inTransaction; },
      transaction: (fn) => a.transaction(fn),
      backup: (p) => a.backup(p),
    };
    expect(await init(broken)).toEqual({ state: 'disabled', reason: 'migration_failed' });
    expect(cardObjects(a)).toEqual([]);
    const m = new FileActivationMarker(env.markerPath).read();
    expect(m.state === 'present' && m.marker.everActivated).toBe(false);
  });
});

describe('downgrade and re-upgrade (AC-025.1)', () => {
  it('the baseline store ignores card tables and leaves protected records intact', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb();
    const r = await init(a);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    r.store.initCursor('scope-a', 'T-PART');
    r.store.haltCursor('scope-a', 'non_owned_event');
    const before = readProtectedGraph(a);
    closeAll();

    // Baseline binary: ordinary init only, ordinary traffic and expiry sweeps.
    const baseline = createAdapter(env.dbPath);
    open.push(baseline);
    const store = new SessionStore(baseline);
    store.init();
    store.getOrCreate('dm:u1', 'u1', 1);
    store.cleanExpired();
    expect(readProtectedGraph(baseline)).toEqual(before);
    closeAll();

    const again = await init(openDb());
    expect(again.state).toBe('ready');
    if (again.state !== 'ready') return;
    expect(again.provenance).toBe('reopened');
    expect(again.store.readCursor('scope-a')?.haltedReason).toBe('non_owned_event');
  });

  it('restoring the pre-migration backup behind an activated marker stays disabled', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const r = await init(openDb());
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    closeAll();
    copyFileSync(r.backup!.path, env.dbPath);
    rmSync(`${env.dbPath}-wal`, { force: true });
    rmSync(`${env.dbPath}-shm`, { force: true });
    expect(await init(openDb())).toEqual({ state: 'disabled', reason: 'prior_active_store_missing' });
  });
});

describe('P1-2: invalid startup options resolve disabled with no mutation', () => {
  function markerBytes(): string | null {
    return existsSync(env.markerPath) ? readFileSync(env.markerPath, 'utf8') : null;
  }

  const invalid: Array<[string, Partial<Parameters<typeof initializeCardStore>[0]>]> = [
    ['capacity 0', { sessionCapacity: 0 }],
    ['capacity -1', { sessionCapacity: -1 }],
    ['capacity 1.5', { sessionCapacity: 1.5 }],
    ['capacity NaN', { sessionCapacity: Number.NaN }],
    ['capacity string', { sessionCapacity: '5' as unknown as number }],
    ['clock NaN', { clock: { nowUtcMs: () => Number.NaN } }],
    ['clock negative', { clock: { nowUtcMs: () => -1 } }],
    ['clock fractional', { clock: { nowUtcMs: () => T0 + 0.5 } }],
    ['clock Infinity', { clock: { nowUtcMs: () => Number.POSITIVE_INFINITY } }],
    ['clock string', { clock: { nowUtcMs: () => String(T0) as unknown as number } }],
    ['clock throws', { clock: { nowUtcMs: () => { throw new Error('clock'); } } }],
    ['clock missing', { clock: {} as unknown as { nowUtcMs: () => number } }],
    ['lineage invalid', { newLineageId: () => '../escape' }],
    ['lineage throws', { newLineageId: () => { throw new Error('rng'); } }],
  ];

  for (const [name, overrides] of invalid) {
    it(`first install with ${name} resolves disabled and leaves DB, marker and backups untouched`, async () => {
      provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
      const a = openDb();
      const marker = markerBytes();
      const pending = init(a, overrides);
      await expect(pending).resolves.toEqual({ state: 'disabled', reason: 'invalid_options' });
      expect(cardObjects(a)).toEqual([]);
      expect(markerBytes()).toBe(marker);
      expect(existsSync(env.backupDir)).toBe(false);
    });
  }

  it('DB-only reconciliation with a NaN clock never writes an unparseable marker', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb();
    migrateCardSchema(a, { installationRef: INSTALL, lineageId: 'lineage-crash', nowMs: T0 });
    const before = readProtectedGraph(a);
    const marker = markerBytes();
    await expect(init(a, { clock: { nowUtcMs: () => Number.NaN } })).resolves.toEqual({ state: 'disabled', reason: 'invalid_options' });
    expect(markerBytes()).toBe(marker);
    expect(readProtectedGraph(a)).toEqual(before);
    // A valid restart still reconciles normally.
    const r = await init(a);
    expect(r.state === 'ready' && r.provenance).toBe('activation_reconciled');
  });

  it('reopening an activated store with an invalid capacity resolves disabled without touching it', async () => {
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const a = openDb();
    expect((await init(a)).state).toBe('ready');
    const before = readProtectedGraph(a);
    const marker = markerBytes();
    await expect(init(a, { sessionCapacity: 0 })).resolves.toEqual({ state: 'disabled', reason: 'invalid_options' });
    expect(markerBytes()).toBe(marker);
    expect(readProtectedGraph(a)).toEqual(before);
    expect(readdirSync(env.backupDir)).toHaveLength(1);
  });
});
