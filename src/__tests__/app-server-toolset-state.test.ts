/** T0 thread toolset persistence (session store) and the T5/R1 availability line. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { cardAvailability, legacyToolsetNotice, LEGACY_TOOLSET_NOTICE } from '../agent-bridge.js';
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

describe('D3 legacy-thread turn notice', () => {
  const current = appServerToolset().digest;
  it('is set exactly on the R1 branch: cards offered on a resumed thread without the current toolset', () => {
    expect(legacyToolsetNotice(true, true, null)).toBe(LEGACY_TOOLSET_NOTICE);
    expect(legacyToolsetNotice(true, true, 'v0:old')).toBe(LEGACY_TOOLSET_NOTICE);
  });

  it('is absent for new threads, current threads and card-off, unprovisioned or policy-denied turns', () => {
    for (const [offered, resumed, stored] of [
      [true, false, null], [true, true, current], [false, false, null],
      [false, true, null], [false, true, 'v0:old'], [false, true, current],
    ] as const) expect(legacyToolsetNotice(offered, resumed, stored)).toBeUndefined();
  });

  it('leaves the R1 developerInstructions line unchanged and does not log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    legacyToolsetNotice(true, true, null);
    expect(warn).not.toHaveBeenCalled();
    expect(cardAvailability(true, true, null)).toBe('Explicit card tools are not available in this conversation because it was started before the current card toolset. Reply in plain text.');
  });

  it('is the agreed text: anchored, no secrets, paths or addresses, no reset instruction', () => {
    expect(LEGACY_TOOLSET_NOTICE).toBe('[Card tools notice — gateway, not user text]\n'
      + 'This resumed conversation does not have the current explicit card tools, so none are available in it. '
      + 'Reply through ordinary messages. A new or reset conversation may offer card tools if the current Bot policy permits.');
    expect(LEGACY_TOOLSET_NOTICE).not.toMatch(/https?:|\/|token|credential|account|progress card/i);
  });

  it('is truthful for both R1 origins: it states the current state, not how the thread began', () => {
    // NULL: started while cards were off or unprovisioned, when the tools already existed.
    // 'v0:old': started with an earlier toolset, i.e. with card tools.
    for (const stored of [null, 'v0:old']) {
      const notice = legacyToolsetNotice(true, true, stored);
      expect(notice).toBe(LEGACY_TOOLSET_NOTICE);
      expect(notice).toContain('does not have the current explicit card tools');
      expect(notice).not.toMatch(/started|before|predates|were available|never had|older|earlier/i);
    }
  });
});
