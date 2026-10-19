import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { ConversationMarkdown } from '../conversation-md.js';
import { privateMemorySessionKey } from '../private-memory.js';
import { ChannelType } from '../octo/types.js';
import { getGroupMd } from '../octo/api.js';

vi.mock('../octo/api.js', () => ({ getGroupMd: vi.fn(), getThreadMd: vi.fn() }));

const config = { apiUrl: 'https://octo.example', botToken: 'synthetic-token' };
let root: string;
let store: SessionStore;
function open() { const value = new SessionStore(createAdapter(join(root, 'state.sqlite'))); value.init(); return value; }

beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), 'document-state-'));
  store = open();
  vi.mocked(getGroupMd).mockResolvedValue({ content: 'synthetic rules', version: 1 });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

describe('durable server-document lifecycle', () => {
  it('deduplicates and withdraws documents using the namespaced SDK storage key across restart', async () => {
    const session = privateMemorySessionKey('group', false);
    store.setSdkSessionId(session, 'thread-scoped');
    const first = new ConversationMarkdown(config, store);
    const initial = await first.prepareTurn('group', ChannelType.Group, undefined, session);
    expect(initial.context).toContain('synthetic rules');
    initial.commit('thread-scoped');
    expect((await first.prepareTurn('group', ChannelType.Group, 'thread-scoped', session)).context).toBe('');
    expect(store.getSdkSessionId('group')).toBeUndefined();

    store.close();
    store = open();
    vi.mocked(getGroupMd).mockResolvedValue({ content: '', version: 0 });
    const restarted = new ConversationMarkdown(config, store);
    const withdrawn = await restarted.prepareTurn('group', ChannelType.Group, 'thread-scoped', session);
    expect(withdrawn.context).toContain('Document is absent');
    withdrawn.commit('thread-scoped');
    expect((await restarted.prepareTurn('group', ChannelType.Group, 'thread-scoped', session)).context).toBe('');
  });
  it('withdraws after SQLite close/reopen and a fresh cache, then persists withdrawal deduplication', async () => {
    store.setSdkSessionId('group', 'thread-1');
    const first = new ConversationMarkdown(config, store);
    (await first.prepareTurn('group', ChannelType.Group)).commit('thread-1');
    store.close();
    store = open();
    vi.mocked(getGroupMd).mockResolvedValue({ content: '', version: 0 });
    const restarted = new ConversationMarkdown(config, store);
    const absent = await restarted.prepareTurn('group', ChannelType.Group, store.getSdkSessionId('group'));
    expect(absent.context).toContain('Document is absent');
    expect(absent.retryContext).toBe('');
    absent.commit('thread-1');
    store.close();
    store = open();
    expect((await new ConversationMarkdown(config, store).prepareTurn('group', ChannelType.Group, 'thread-1')).context).toBe('');
  });
  it('retains injection evidence after more than 512 other conversations', async () => {
    const cache = new ConversationMarkdown(config, store);
    store.setSdkSessionId('group', 'thread-1');
    (await cache.prepareTurn('group', ChannelType.Group)).commit('thread-1');
    for (let index = 0; index < 513; index++) {
      const channel = `other-${index}`;
      const thread = `thread-${index + 2}`;
      store.setSdkSessionId(channel, thread);
      (await cache.prepareTurn(channel, ChannelType.Group)).commit(thread);
    }
    vi.mocked(getGroupMd).mockResolvedValue({ content: '', version: 0 });
    expect((await cache.prepareTurn('group', ChannelType.Group, 'thread-1')).context).toContain('Document is absent');
  });
  it('keeps known never-injected sessions silent and clears evidence with mapping replacement/reset', async () => {
    store.setSdkSessionId('group', 'thread-1');
    expect(store.getConversationDocumentSignature('group', 'thread-1')).toBeNull();
    vi.mocked(getGroupMd).mockResolvedValue({ content: '', version: 0 });
    expect((await new ConversationMarkdown(config, store).prepareTurn('group', ChannelType.Group, 'thread-1')).context).toBe('');
    store.setConversationDocumentSignature('group', 'thread-1', 'version-hash');
    store.setSdkSessionId('group', 'thread-1');
    expect(store.getConversationDocumentSignature('group', 'thread-1')).toBe('version-hash');
    store.setSdkSessionId('group', 'thread-2');
    expect(store.getConversationDocumentSignature('group', 'thread-2')).toBeNull();
    store.setConversationDocumentSignature('group', 'thread-1', 'late-old-commit');
    expect(store.getConversationDocumentSignature('group', 'thread-2')).toBeNull();
    store.setConversationDocumentSignature('group', 'thread-2', 'new-hash');
    store.clearSdkSessionId('group');
    store.setSdkSessionId('group', 'thread-3');
    expect(store.getConversationDocumentSignature('group', 'thread-3')).toBeNull();
  });
  it('conservatively withdraws for pre-migration mappings with unknown injection history', async () => {
    const legacy = createAdapter(join(root, 'legacy.sqlite'));
    legacy.exec('CREATE TABLE sdk_sessions (session_id TEXT PRIMARY KEY, sdk_session_id TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO sdk_sessions VALUES (\'group\', \'legacy-thread\', 1)');
    const migrated = new SessionStore(legacy);
    migrated.init();
    try {
      expect(migrated.getConversationDocumentSignature('group', 'legacy-thread')).toBeUndefined();
      vi.mocked(getGroupMd).mockResolvedValue({ content: '', version: 0 });
      const absent = await new ConversationMarkdown(config, migrated).prepareTurn('group', ChannelType.Group, 'legacy-thread');
      expect(absent.context).toContain('Document is absent');
      expect((await new ConversationMarkdown(config, migrated).prepareTurn('group', ChannelType.Group)).context).toBe('');
      absent.commit('legacy-thread');
      expect(migrated.getConversationDocumentSignature('group', 'legacy-thread')).toBeTypeOf('string');
    } finally { migrated.close(); }
  });
});
