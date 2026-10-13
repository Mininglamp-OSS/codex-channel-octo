/**
 * Downgrade-open harness (R8 §8.4, §10.2 `downgrade-open`). The dd12980 build is
 * compiled from the pinned git object, a DB is populated through that build's
 * own production store APIs, the head's migrations are applied, and the
 * dd12980 build must reopen the DB and run its core paths with the original
 * tables semantically conserved. DEV-01 adds no production migration, so the
 * actual migration list is empty; the additive and destructive migrations below
 * are harness fixtures, not product schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBaseline } from '../../scripts/downgrade/build-baseline.mjs';
import { seedPopulatedDb, applyMigrations, openWithBaseline, semanticInventory, ORIGINAL_TABLES } from '../../scripts/downgrade/harness.mjs';
import { pins } from '../harness/pins.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let baseline: { dir: string; commit: string; distDir: string };
let work = '';

beforeAll(() => {
  baseline = buildBaseline({ root: ROOT, commit: pins.A });
  work = mkdtempSync(join(tmpdir(), 'dev01-downgrade-'));
}, 180_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const freshDb = async (name: string) => {
  const p = join(work, `${name}.db`);
  await seedPopulatedDb(p, baseline.distDir);
  return p;
};

describe('downgrade-open harness', () => {
  it('DG-01: the baseline build is compiled from the pinned A commit object, not the working tree', () => {
    expect(baseline.commit).toBe(pins.A);
    const pinned = execFileSync('git', ['-C', ROOT, 'show', `${pins.A}:src/session-store.ts`], { encoding: 'utf8' });
    expect(readFileSync(join(baseline.dir, 'src', 'session-store.ts'), 'utf8')).toBe(pinned);
  });

  it('DG-02: the seeded DB populates every original table with two distinguishable conversations via baseline store APIs', async () => {
    const db = await freshDb('seed');
    const inv = semanticInventory(db);
    expect(Object.keys(inv.tables).sort()).toEqual([...ORIGINAL_TABLES].sort());
    for (const t of ORIGINAL_TABLES) expect(inv.tables[t].rows, t).toBeGreaterThan(0);
    expect(inv.tables.sdk_sessions.keys.sort()).toEqual(['g_fixture', 'u_alice']);
  });

  it('DG-03: with the head\'s actual migration list (empty at DEV-01) the dd12980 build reopens the DB and runs its core paths', async () => {
    const migrations = JSON.parse(readFileSync(new URL('./migrations.json', import.meta.url), 'utf8')) as { head: string[] };
    expect(migrations.head).toEqual([]);
    const db = await freshDb('actual');
    const before = semanticInventory(db);
    applyMigrations(db, migrations.head);
    const r = await openWithBaseline(db, baseline.distDir);
    expect(r.errors).toEqual([]);
    expect(r.corePaths).toEqual(['history', 'append', 'sdk-mapping', 'reset', 'document-state', 'group-context', 'cleanExpired']);
    expect(r.inventoryBefore).toEqual(before);
  });

  it('DG-04: an additive fixture migration (new table + nullable column) keeps the dd12980 core paths and original-table semantics', async () => {
    const db = await freshDb('additive');
    const before = semanticInventory(db);
    applyMigrations(db, [
      'CREATE TABLE IF NOT EXISTS dev01_fixture_additions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
      "INSERT INTO dev01_fixture_additions VALUES ('x', 1)",
      'ALTER TABLE messages ADD COLUMN dev01_fixture_note TEXT',
    ]);
    const r = await openWithBaseline(db, baseline.distDir, { ignoreColumns: { messages: ['dev01_fixture_note'] } });
    expect(r.errors).toEqual([]);
    expect(r.inventoryBefore).toEqual(before);
  });

  it.each([
    ['drop-table', ['DROP TABLE sdk_sessions']],
    ['not-null-without-default', [
      'CREATE TABLE messages_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL, message_seq INTEGER, from_name TEXT, must_have TEXT NOT NULL)',
      "INSERT INTO messages_v2 SELECT id, session_id, role, content, timestamp, message_seq, from_name, 'x' FROM messages",
      'DROP TABLE messages', 'ALTER TABLE messages_v2 RENAME TO messages']],
    ['rename-column', ['ALTER TABLE reset_barriers RENAME COLUMN reset_seq TO barrier_seq']],
  ])('DG-05 negative control (%s): a destructive migration is detected by the dd12980 core paths', async (name, sql) => {
    const db = await freshDb(`neg-${name}`);
    applyMigrations(db, sql as string[]);
    const r = await openWithBaseline(db, baseline.distDir);
    expect(r.errors.length, name).toBeGreaterThan(0);
  });
});
