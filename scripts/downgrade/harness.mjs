/**
 * Downgrade-open harness (R8 §8.4 "Package downgrade", §10.2 downgrade-open).
 * Seeds a DB through the baseline build's own production store APIs, applies
 * the head's migrations, then reopens it with the baseline build and runs its
 * core paths, asserting outcomes (not just absence of exceptions) and original
 * table semantic conservation.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ORIGINAL_TABLES = ['sessions', 'messages', 'group_members', 'reset_barriers', 'sdk_sessions', 'conversation_document_state', 'group_messages', 'group_context_cursors'];
/** Wall-clock columns the baseline writes with Date.now(); excluded from semantic hashes by declaration. */
const VOLATILE = new Set(['created_at', 'updated_at', 'timestamp']);

const load = (distDir, mod) => import(pathToFileURL(join(distDir, mod)).href);

export async function seedPopulatedDb(dbPath, distDir) {
  const { createAdapter } = await load(distDir, 'db-adapter.js');
  const { SessionStore } = await load(distDir, 'session-store.js');
  const { GroupContext } = await load(distDir, 'group-context.js');
  const adapter = createAdapter(dbPath);
  const store = new SessionStore(adapter);
  store.init();
  const gc = new GroupContext(adapter, 4_000);
  // conversation A: DM with an old reset barrier and a live mapping
  store.getOrCreate('u_alice', 'u_alice', 1);
  store.appendUser('u_alice', 'alpha question', 4, 'Alice');
  store.appendAssistant('u_alice', 'alpha answer', 4, 'u_bot');
  store.setResetBarrier('u_alice', 3);
  store.setSdkSessionId('u_alice', 'thread-a');
  // conversation B: group with document state, group context and cursor
  store.getOrCreate('g_fixture', 'g_fixture', 2);
  store.appendUser('g_fixture', 'bravo question', 10, 'Bob');
  store.appendAssistant('g_fixture', 'bravo answer', 10, 'u_bot');
  store.setResetBarrier('g_fixture', 2);
  store.setSdkSessionId('g_fixture', 'thread-b');
  store.setConversationDocumentSignature('g_fixture', 'thread-b', '3:fixture-signature');
  gc.pushMessage('g_fixture', 'u_bob', 'Bob', 'group chatter one', 1);
  gc.pushMessage('g_fixture', 'u_carol', 'Carol', 'group chatter two', 2);
  gc.setContextCursor('g_fixture', gc.getMaxMessageId('g_fixture'));
  store.close();
}

export function applyMigrations(dbPath, statements) {
  const db = new Database(dbPath);
  try { db.transaction(() => { for (const s of statements) db.exec(s); })(); } finally { db.close(); }
}

/**
 * @param {string} dbPath
 * @param {{ tables?: string[], ignoreColumns?: Record<string, string[]> }} [opts]
 * @returns {{ tables: Record<string, { rows: number, keys: string[], hash: string }> }}
 */
export function semanticInventory(dbPath, opts = {}) {
  const tables = opts.tables ?? ORIGINAL_TABLES;
  const ignore = opts.ignoreColumns ?? {};
  const db = new Database(dbPath, { readonly: true });
  try {
    const out = {};
    for (const t of tables) {
      if (!ORIGINAL_TABLES.includes(t) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error("invalid inventory table");
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!exists) { out[t] = { rows: 0, keys: [], hash: 'missing' }; continue; }
      const info = db.prepare(`PRAGMA table_info(${t})`).all();
      if (info.some(c => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name))) throw new Error("invalid inventory column");
      const cols = info.map((c) => c.name).filter((c) => !VOLATILE.has(c) && !(ignore[t] ?? []).includes(c));
      const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${t}`).all();
      const canon = rows.map((r) => JSON.stringify(cols.map((c) => r[c]))).sort();
      const keyCols = pk.length ? pk : cols;
      const keys = db.prepare(`SELECT ${keyCols.join(', ')} FROM ${t}`).all().map((r) => keyCols.map((c) => String(r[c])).join('|'));
      out[t] = { rows: rows.length, keys: keys.sort(), hash: createHash('sha256').update(canon.join('\n')).digest('hex') };
    }
    return { tables: out };
  } finally {
    db.close();
  }
}

/** Reopen with the baseline build and run its core paths; every path asserts its outcome. */
export async function openWithBaseline(dbPath, distDir, opts = {}) {
  const inventoryBefore = semanticInventory(dbPath, opts);
  const errors = [];
  const corePaths = [];
  const { createAdapter } = await load(distDir, 'db-adapter.js');
  const { SessionStore } = await load(distDir, 'session-store.js');
  const { GroupContext } = await load(distDir, 'group-context.js');
  const { handleCommand } = await load(distDir, 'commands.js');
  let adapter;
  let store;
  const path = (name, fn) => {
    try { fn(); corePaths.push(name); } catch (e) { errors.push({ path: name, error: String(e instanceof Error ? e.message : e) }); }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  const quiet = console.error;
  console.error = () => undefined; // the baseline logs and swallows some SQL errors; outcomes are asserted instead
  try {
    path('history', () => {
      adapter = createAdapter(dbPath);
      store = new SessionStore(adapter);
      store.init();
      expect(store.buildHistoryPrefix('u_alice', 10).includes('alpha question'), 'DM history lost');
      expect(store.buildSegmentedHistoryPrefix('g_fixture', 10).includes('bravo answer'), 'group history lost');
    });
    if (!store) return { errors, corePaths, inventoryBefore };
    path('append', () => {
      store.appendUser('u_alice', 'after downgrade', 20, 'Alice');
      expect(store.buildHistoryPrefix('u_alice', 10).endsWith('[user Alice]: after downgrade'), 'append not readable');
    });
    path('sdk-mapping', () => {
      expect(store.getSdkSessionId('g_fixture') === 'thread-b', 'group thread mapping lost');
      store.setSdkSessionId('u_alice', 'thread-a2');
      expect(store.getSdkSessionId('u_alice') === 'thread-a2', 'mapping write failed');
    });
    path('reset', () => {
      const r = handleCommand('/reset', 'g_fixture', store, {}, 100);
      expect(r.handled, 'reset not handled');
      expect(store.getResetBarrier('g_fixture') === 100, 'barrier not raised');
      expect(store.getSdkSessionId('g_fixture') === undefined, 'mapping not cleared');
      expect(store.buildHistoryPrefix('g_fixture', 10) === '', 'history not cleared');
    });
    path('document-state', () => {
      store.setConversationDocumentSignature('u_alice', 'thread-a2', '7:after');
      expect(store.getConversationDocumentSignature('u_alice', 'thread-a2') === '7:after', 'document state not persisted');
    });
    path('group-context', () => {
      const gc = new GroupContext(adapter, 4_000);
      gc.loadAllFromDb();
      const delta = gc.buildContextSince('g_fixture', 0);
      expect(delta.text.includes('group chatter two'), 'group context lost');
      expect(gc.getContextCursor('g_fixture') >= 2, 'context cursor lost');
      gc.pushMessage('g_fixture', 'u_dave', 'Dave', 'after downgrade', 3);
      expect(gc.getMaxMessageId('g_fixture') >= 3, 'group context write failed');
    });
    path('cleanExpired', () => {
      expect(Number.isInteger(store.cleanExpired()), 'cleanExpired failed');
    });
  } finally {
    console.error = quiet;
    try { store?.close(); } catch { /* already closed */ }
  }
  return { errors, corePaths, inventoryBefore };
}
