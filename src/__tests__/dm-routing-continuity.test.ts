import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRouter } from '../session-router.js';
import { SessionStore } from '../session-store.js';
import { createAdapter } from '../db-adapter.js';
import { resolveSessionCwd, resolveMemoryDir } from '../cwd-resolver.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';
describe('existing DM persistence and workspace continuity', () => {
  it.each([
    ['sA_owner____id', 'A_owner___:sA_owner____id'],
    ['sA_owner________id', 'A_owner_______:sA_owner________id'],
    ['sA_owner____id____tail', 'A_owner____id___:sA_owner____id____tail'],
    ['s1_alice@s1_bot', '1_alice@s1:s1_alice@s1_bot'],
  ])('reopens SQLite thread, history, cwd and memory for %s', (uid, legacyKey) => {
    const root = mkdtempSync(join(tmpdir(), 'sender-routing-'));
    const config = { apiUrl: 'https://example.com', botToken: 'synthetic', sdk: {},
      rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 } } as Config;
    const database = join(root, 'sessions.sqlite');
    let store = new SessionStore(createAdapter(database)); store.init();
    try {
      store.getOrCreate(legacyKey, uid, ChannelType.DM);
      store.setSdkSessionId(legacyKey, 'legacy-thread');
      store.appendUser(legacyKey, 'existing conversation', 1, uid);
      const oldCtx = { kind: 'dm' as const, sessionKey: legacyKey };
      const cwd = resolveSessionCwd(join(root, 'workspace'), oldCtx);
      const memory = resolveMemoryDir(join(root, 'memory'), oldCtx);
      writeFileSync(join(cwd, 'kept.txt'), 'existing workspace');
      mkdirSync(memory, { recursive: true });
      writeFileSync(join(memory, 'MEMORY.md'), 'synthetic persistent memory');
      store.close(); store = new SessionStore(createAdapter(database)); store.init();
      const msg = { from_uid: uid, channel_id: uid+'@sA_bot', channel_type: ChannelType.DM,
        payload: { type: MessageType.Text, content: 'continue' } } as BotMessage;
      const key = new SessionRouter(config, 'bot').sessionKey(msg);
      expect(key).toBe(legacyKey);
      expect(store.getSdkSessionId(key)).toBe('legacy-thread');
      expect(store.buildHistoryPrefix(key, 40)).toContain('existing conversation');
      const ctx = { kind: 'dm' as const, sessionKey: key };
      expect(resolveSessionCwd(join(root, 'workspace'), ctx)).toBe(cwd);
      expect(resolveMemoryDir(join(root, 'memory'), ctx)).toBe(memory);
      expect(readFileSync(join(cwd, 'kept.txt'), 'utf8')).toBe('existing workspace');
      expect(readFileSync(join(resolveMemoryDir(join(root, 'memory'), ctx), 'MEMORY.md'), 'utf8')).toBe('synthetic persistent memory');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
