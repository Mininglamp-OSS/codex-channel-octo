/**
 * WP-05′ re-integration regressions on the latest-main integration parent:
 * - the safe-notice callback keeps main's interrupted-turn fence as its first
 *   statement, so a fenced turn performs no reduction, dedup or send;
 * - the safe-item gate reuses the single-read `eventType`, so an SDK accessor
 *   is never read twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: '123', message_seq: 1 }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getGroupMembers: vi.fn().mockResolvedValue([]),
  getMentionPreference: vi.fn().mockResolvedValue(false),
  getChannelMessages: vi.fn().mockResolvedValue([]),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  generateClientMsgNo: vi.fn().mockReturnValue('client-msg-001'),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
}));

let runs: unknown[][] = [];
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  startThread() { return { async runStreamed() { const events = runs.shift() ?? []; return { events: (async function* () { yield* events; })() }; } }; }
  resumeThread() { return this.startThread(); }
} }));

type EventsImpl = (...args: unknown[]) => AsyncIterable<unknown>;
let handlerEvents: EventsImpl | undefined;
vi.mock('../agent-bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent-bridge.js')>();
  // Handler tests script the callback directly; bridge tests use the real
  // event loop over the mocked SDK.
  function queryAgentEvents(...args: Parameters<typeof original.queryAgentEvents>) {
    return handlerEvents ? handlerEvents(...args) : original.queryAgentEvents(...args);
  }
  return { ...original, queryAgentEvents };
});

vi.mock('../cards/redact.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../cards/redact.js')>();
  return { ...original, safeNotice: vi.fn(original.safeNotice) };
});

import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { createAdapter } from '../db-adapter.js';
import { queryAgentEvents, type AgentOutputEvent } from '../agent-bridge.js';
import { handleMessage } from '../index.js';
import { sendMessage } from '../octo/api.js';
import { safeNotice, type ReducedItemFacts } from '../cards/redact.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';

const BOT_ID = 'bot-001';
const USER_UID = 'user-001';
const COMMAND: ReducedItemFacts = { category: 'command' };
const FILES: ReducedItemFacts = { category: 'file_change', fileCount: 1 };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wp05-fence-')); runs = []; handlerEvents = undefined; vi.clearAllMocks(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: 'synthetic', apiUrl: 'https://example.com', baseDir: dir, cwd: dir, cwdBase: dir, dataDir: dir,
    sdk: { toolProgress: true }, rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524_288, dispatchTimeoutMs: 300_000, botBlocklist: [], ...overrides,
  };
}

function makeDmMsg(content: string): BotMessage {
  return {
    message_id: `msg-${Date.now()}`, message_seq: 1, from_uid: USER_UID, from_name: 'TestUser',
    channel_id: USER_UID, channel_type: ChannelType.DM, timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content },
  };
}

describe('safe notice after the turn is interrupted', () => {
  let store: SessionStore, group: GroupContext;
  beforeEach(() => {
    const adapter = createAdapter(':memory:');
    store = new SessionStore(adapter); store.init(); group = new GroupContext(adapter, 6000);
  });
  afterEach(() => { store.close(); });

  const notices = () => vi.mocked(sendMessage).mock.calls.map(c => c[0].content as string).filter(s => s.startsWith('🔧 '));

  async function drive(config: Config, interrupt: (router: SessionRouter) => Promise<void> | void) {
    const router = new SessionRouter(config, BOT_ID);
    const thrown: unknown[] = [];
    let reducedBeforeFence = 0;
    handlerEvents = async function* (...args: unknown[]) {
      const onSafeItem = args[5] as ((facts: ReducedItemFacts) => void) | undefined;
      yield { kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null };
      onSafeItem?.(COMMAND);
      reducedBeforeFence = vi.mocked(safeNotice).mock.calls.length;
      await interrupt(router);
      // Same shape as the bridge: a callback throw is contained, never rethrown.
      try { onSafeItem?.(FILES); } catch (err) { thrown.push(err); }
      yield { kind: 'message', attempt: 0, itemId: 'm', seq: 0, text: 'late answer', phase: 'unknown' };
      yield { kind: 'attempt_end', attempt: 0, terminal: 'completed' };
    };
    await handleMessage(makeDmMsg('work'), config, store, router, group, new StreamRelay(), BOT_ID);
    return { thrown, reducedBeforeFence };
  }

  it('a cancelled turn rejects the notice before reduction, dedup or send', async () => {
    const { thrown, reducedBeforeFence } = await drive(makeConfig(), router => { void router.stopTurns(10); });
    expect(reducedBeforeFence).toBe(1);
    expect(thrown).toHaveLength(1);
    expect((thrown[0] as DOMException).name).toBe('AbortError');
    // The fence is the first statement: the fenced call never reaches safeNotice.
    expect(vi.mocked(safeNotice)).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual(['🔧 Running command…']);
    expect(vi.mocked(sendMessage).mock.calls.some(c => String(c[0].content).includes('late answer'))).toBe(false);
    expect(store.buildHistoryPrefix(USER_UID, 40)).not.toContain('late answer');
    expect(store.buildHistoryPrefix(USER_UID, 40)).not.toContain('🔧 ');
  });

  it('a turn past its deadline rejects the notice before reduction, dedup or send', async () => {
    const { thrown } = await drive(makeConfig({ dispatchTimeoutMs: 40 }), () => new Promise(resolve => setTimeout(resolve, 80)));
    expect(thrown).toHaveLength(1);
    expect((thrown[0] as DOMException).name).toBe('AbortError');
    expect(vi.mocked(safeNotice)).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual(['🔧 Running command…']);
  });

  it('a publishable turn still sends the notice and the final answer', async () => {
    const { thrown } = await drive(makeConfig(), () => {});
    expect(thrown).toEqual([]);
    expect(notices()).toEqual(['🔧 Running command…', '🔧 Editing files…']);
    expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toBe('late answer');
    expect(store.buildHistoryPrefix(USER_UID, 40)).toContain('late answer');
    expect(store.buildHistoryPrefix(USER_UID, 40)).not.toContain('🔧 ');
  });
});

describe('safe-item gate reads the SDK event type once', () => {
  const bridgeConfig = (): Config => ({ ...makeConfig(), sdk: {} });

  it.each(['item.started', 'item.completed'])('a %s accessor read twice would throw; the notice is still reduced', async type => {
    let typeReads = 0;
    const event = {
      get type() { if (++typeReads > 1) throw Error('PRIVATE_SECOND_TYPE_READ'); return type; },
      item: { id: 'a', type: 'command_execution', command: 'git PRIVATE_ARG', status: 'completed' },
    };
    runs = [[event, { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'final exact text' } }, { type: 'turn.completed', usage: {} }]];
    const facts: ReducedItemFacts[] = [];
    const out: AgentOutputEvent[] = [];
    for await (const ev of queryAgentEvents('synthetic request', bridgeConfig(), undefined, undefined, undefined, f => facts.push(f))) out.push(ev);
    expect(typeReads).toBe(1);
    expect(facts.map(f => safeNotice(f))).toEqual(['🔧 Running command…']);
    expect(JSON.stringify(facts)).not.toContain('PRIVATE');
    expect(out.some(e => e.kind === 'message' && e.text === 'final exact text')).toBe(true);
  });

  it('a proxy-shaped event reports one notice per single-read event type', async () => {
    let typeReads = 0;
    const started = new Proxy({ type: 'item.started', item: { id: 'a', type: 'web_search', query: 'PRIVATE_QUERY' } }, {
      get(target, key) { if (key === 'type' && ++typeReads > 1) throw Error('PRIVATE_SECOND_TYPE_READ'); return Reflect.get(target, key); },
    });
    runs = [[started, { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'final exact text' } }, { type: 'turn.completed', usage: {} }]];
    const safe = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for await (const ev of queryAgentEvents('synthetic request', bridgeConfig(), undefined, undefined, undefined, safe)) void ev;
    expect(typeReads).toBe(1);
    expect(safe.mock.calls.map(c => safeNotice(c[0]))).toEqual(['🔧 Searching…']);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
    log.mockRestore();
  });
});
