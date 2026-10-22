/** Real SDK/proxy → bridge → handler/relay → SQLite, with synthetic events and IM only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

vi.mock('../jsonl-proxy-path.js', () => ({
  resolveJsonlProxyPath: () => fileURLToPath(new URL('./fixtures/notification-proxy.mjs', import.meta.url)),
}));
vi.mock('../execution-scope.js', async importOriginal => {
  const original = await importOriginal<typeof import('../execution-scope.js')>();
  return { ...original, ExecutionScope: class extends original.ExecutionScope {
    constructor() { super(fileURLToPath(new URL('./fixtures/notification-cli.mjs', import.meta.url))); }
  } };
});
vi.mock('../octo/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../octo/api.js')>(),
  sendMessage: vi.fn().mockResolvedValue({ message_id: '123', message_seq: 2 }),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
}));

import { handleMessage } from '../index.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { sendMessage } from '../octo/api.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';

let root: string;
let adapter: DbAdapter;
let store: SessionStore;
let config: Config;
let router: SessionRouter;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'notification-reconciliation-'));
  mkdirSync(join(root, 'data'));
  adapter = createAdapter(join(root, 'data', 'sessions.db'));
  store = new SessionStore(adapter); store.init();
  for (const name of ['notification-cli.mjs', 'notification-proxy.mjs']) {
    chmodSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 0o755);
  }
  config = {
    baseDir: root, cwd: join(root, 'workspace'), dataDir: join(root, 'data'),
    botToken: 'synthetic', apiUrl: 'https://test.invalid',
    cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
    sdk: { privateDiagnostics: true, sandboxMode: 'read-only',
      recovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 },
      env: { NOTIFICATION_RECORD_FILE: join(root, 'records') } },
    rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288, dispatchTimeoutMs: 10000,
  };
  router = new SessionRouter(config, 'bot', 'owner', store);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
const records = () => readFileSync(join(root, 'records'), 'utf8').trim().split('\n');
function message(seq: number): BotMessage {
  return { message_id: `incoming-${seq}`, message_seq: seq, from_uid: 'human', channel_id: 'human',
    channel_type: ChannelType.DM, timestamp: 0, payload: { type: MessageType.Text, content: `new independent request ${seq}` } };
}
async function run(seq: number): Promise<void> {
  await handleMessage(message(seq), config, store, router, new GroupContext(adapter, 6000), new StreamRelay(), 'bot');
}

describe.skipIf(process.platform === 'win32')('silent completed notifications retain reconciliation', () => {
  it.each(['silent-stream', 'silent-item', 'work-silent'])('persists %s and carries its guard into the next user turn', async mode => {
    config.sdk.env!.NOTIFICATION_FIXTURE_MODE = mode;
    await run(1);
    const interrupted = store.getInterruption('human');
    expect(interrupted).toMatchObject({ reason: 'failed', stage: 'inference',
      executionRisk: mode === 'work-silent' ? 'effects_observed' : 'unknown' });
    expect(records().filter(value => value === 'launched')).toHaveLength(1);
    expect(store.isTurnQuarantined('human')).toBe(false); // Owned process has stopped; uncertainty is retained.
    expect(store.getLastBotReplySeq('human')).toBeUndefined();
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM turn_outputs').get()).toEqual({ count: 0 });
    expect(sendMessage).toHaveBeenCalledOnce();
    const reply = vi.mocked(sendMessage).mock.calls[0][0].content;
    expect(reply).toContain('模型认证失败');
    expect(reply).toContain('任务可能已部分执行');
    expect(reply).not.toContain('rephrasing');
    const raw = readFileSync(join(root, 'data', 'diagnostics', 'agent-failures.jsonl'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ diagnosticId: interrupted!.turnId, attempts: 1, decision: 'blocked_uncertain',
      final: { category: 'auth' }, sdk: { event: mode === 'silent-item' ? 'item.error' : 'error' } });
    expect(raw).not.toMatch(/authentication failed|SYNTHETIC_PRIVATE_OUTPUT|new independent request/);

    config.sdk.env!.NOTIFICATION_FIXTURE_MODE = 'success';
    await run(2);
    expect(records()).toContain(`interruption:${interrupted!.turnId}`);
    expect(records().filter(value => value === 'launched')).toHaveLength(2);
    expect(store.getInterruption('human')).toBeUndefined();
    expect(store.getLastBotReplySeq('human')).toBe(2);
    expect(adapter.prepare('SELECT state FROM turn_outputs').all()).toEqual([{ state: 'committed' }]);
    expect(store.buildHistoryPrefix('human', 10)).toContain('completed answer');
  });
});
