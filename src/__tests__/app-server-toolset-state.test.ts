/** T0 thread toolset persistence (session store) and the T5/R1 availability line. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { cardAvailability } from '../agent-bridge.js';
import { appServerToolset } from '../cards/tool-host.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

function store(path?: string): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'cco-t0-'));
  dirs.push(dir);
  const s = new SessionStore(createAdapter(path ?? join(dir, 'db.sqlite')));
  s.init();
  return s;
}

describe('T0: thread toolset digest next to the stored thread id', () => {
  it('exec-era and unknown threads have none', () => {
    const s = store();
    expect(s.getThreadToolsetDigest('k')).toBeNull();
    s.setSdkSessionId('k', 'thr-1');
    expect(s.getThreadToolsetDigest('k')).toBeNull();
  });

  it('records the digest of a new thread, keeps it for the same thread and resets it on a new thread', () => {
    const s = store();
    s.setSdkSessionId('k', 'thr-1', 'v1:abc');
    expect(s.getThreadToolsetDigest('k')).toBe('v1:abc');
    s.setSdkSessionId('k', 'thr-1');
    expect(s.getThreadToolsetDigest('k')).toBe('v1:abc');
    s.setSdkSessionId('k', 'thr-2');
    expect(s.getThreadToolsetDigest('k')).toBeNull();
    s.setSdkSessionId('k', 'thr-3', 'v1:def');
    s.clearSdkSessionId('k');
    expect(s.getThreadToolsetDigest('k')).toBeNull();
  });

  it('adds the nullable column to an existing database without touching its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cco-t0-old-'));
    dirs.push(dir);
    const path = join(dir, 'db.sqlite');
    const old = new Database(path);
    old.exec('CREATE TABLE sdk_sessions (session_id TEXT PRIMARY KEY, sdk_session_id TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    old.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?)').run('k', 'thr-old', 1);
    old.close();
    const s = store(path);
    expect(s.getSdkSessionId('k')).toBe('thr-old');
    expect(s.getThreadToolsetDigest('k')).toBeNull();
  });
});

describe('R1 availability line', () => {
  const current = appServerToolset().digest;
  it('card-off conversations get no extra instructions', () => {
    expect(cardAvailability(false, false, null)).toBeUndefined();
    expect(cardAvailability(false, true, null)).toBeUndefined();
  });

  it('new and current threads with cards offered say they are available', () => {
    expect(cardAvailability(true, false, null)).toMatch(/are available/);
    expect(cardAvailability(true, true, current)).toMatch(/are available/);
  });

  it('a thread that predates the toolset is declared unavailable and logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(cardAvailability(true, true, null)).toMatch(/not available/);
    expect(cardAvailability(true, true, 'v0:old')).toMatch(/not available/);
    expect(warn).toHaveBeenCalledWith('[codex-channel-octo] explicit cards unavailable: thread predates toolset v1');
  });

  it('a thread with tools while cards are disabled for the bot says so (T3)', () => {
    expect(cardAvailability(false, true, current)).toMatch(/disabled for this bot/);
  });
});
