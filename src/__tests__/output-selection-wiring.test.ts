/**
 * Output-selection wiring through the real handleMessage + StreamRelay:
 * delivery/history parity, cap behavior at the relay, mention offsets, error
 * and empty paths, and the small-limit startup warning. Only the network and
 * the agent bridge are mocked; the bridge is scripted with typed events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({message_id:'123',message_seq:1}),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getGroupMembers: vi.fn().mockResolvedValue([]),
  getMentionPreference: vi.fn().mockResolvedValue(false),
  getChannelMessages: vi.fn().mockResolvedValue([]),
  getUploadCredentials: vi.fn(),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  registerBot: vi.fn().mockResolvedValue({
    robot_id: 'bot-001', im_token: 'token', ws_url: 'ws://localhost',
    api_url: 'https://test.example.com', owner_uid: 'owner', owner_channel_id: 'ch-owner',
  }),
  generateClientMsgNo: vi.fn().mockReturnValue('client-msg-001'),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('../octo/socket.js', () => ({
  WKSocket: vi.fn().mockImplementation(() => ({
    connect: vi.fn(), disconnectAndWait: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../media-inbound.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../media-inbound.js')>();
  return { ...original, downloadInboundImage: vi.fn().mockResolvedValue({ error: 'no network' }) };
});

vi.mock('../agent-bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent-bridge.js')>();
  return { ...original, queryAgent: vi.fn(), queryAgentEvents: vi.fn() };
});

vi.mock('../mention-utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../mention-utils.js')>();
  return { ...original, resolveMentions: vi.fn(original.resolveMentions) };
});

import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { queryAgentEvents, type AgentOutputEvent } from '../agent-bridge.js';
import { resolveMentions } from '../mention-utils.js';
import { handleMessage, startBot } from '../index.js';
import { sendMessage, getGroupMembers } from '../octo/api.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';
import { TRUNCATION_SUFFIX } from '../output-selection.js';

const BOT_ID = 'bot-001';
const USER_UID = 'user-001';
const GROUP = 'group-ch-001';

function makeConfig(overrides: Partial<Config> = {}, sdk: Partial<Config['sdk']> = {}): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp/test-project',
    dataDir: '/tmp/data',
    sdk: { sandboxMode: 'read-only', approvalPolicy: 'never', ...sdk },
    rateLimit: { maxPerMinute: 100 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524_288,
    dispatchTimeoutMs: 300_000,
    botBlocklist: [],
    ...overrides,
  } as Config;
}

let msgSeq = 1;
function dm(content = 'question'): BotMessage {
  const seq = msgSeq++;
  return {
    message_id: `m-${seq}`, message_seq: seq, from_uid: USER_UID, from_name: 'U',
    channel_id: USER_UID, channel_type: ChannelType.DM,
    timestamp: Math.floor(Date.now() / 1000), payload: { type: MessageType.Text, content },
  };
}
function groupMsg(content = 'question'): BotMessage {
  const seq = msgSeq++;
  return {
    message_id: `g-${seq}`, message_seq: seq, from_uid: USER_UID, from_name: 'U',
    channel_id: GROUP, channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content: `@bot ${content}`, mention: { uids: [BOT_ID] } },
  };
}

// Event script helpers.
type Step = AgentOutputEvent | Error;
function script(steps: Step[]): void {
  vi.mocked(queryAgentEvents).mockImplementation(async function* () {
    for (const s of steps) {
      if (s instanceof Error) throw s;
      yield s;
    }
  });
}
const start = (attempt = 0): AgentOutputEvent => ({ kind: 'attempt_start', attempt, reason: 'initial', continues: null });
const end = (attempt = 0): AgentOutputEvent => ({ kind: 'attempt_end', attempt, terminal: 'completed' });
const m = (itemId: string, seq: number, text: string, attempt = 0): AgentOutputEvent => ({
  kind: 'message', attempt, itemId, seq, text, phase: 'unknown',
});
const w = (itemId: string, seq: number, attempt = 0): AgentOutputEvent => ({
  kind: 'work', attempt, itemId, seq, itemType: 'command_execution',
});

describe('output selection wiring', () => {
  let adapter: DbAdapter;
  let store: SessionStore;
  let router: SessionRouter;
  let groupContext: GroupContext;
  let relay: StreamRelay;
  let appendSpy: ReturnType<typeof vi.spyOn>;

  function setup(config: Config) {
    store = new SessionStore(adapter);
    store.init();
    groupContext = new GroupContext(adapter, config.context.maxContextChars);
    relay = new StreamRelay();
    router = new SessionRouter(config, BOT_ID);
    appendSpy = vi.spyOn(store, 'appendAssistant');
  }

  async function run(config: Config, msg: BotMessage = dm()): Promise<void> {
    await handleMessage(msg, config, store, router, groupContext, relay, BOT_ID);
  }

  const relayInputs = (): string[] => vi.mocked(resolveMentions).mock.calls.map((c) => c[0]);
  const historyInputs = (): string[] => appendSpy.mock.calls.map((c) => c[1] as string);
  const sentContents = (): string[] => vi.mocked(sendMessage).mock.calls.map((c) => c[0].content);

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createAdapter(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('T13: delivery and history receive the same selected text in every mode', async () => {
    const expected = {
      final: 'The answer is 42.',
      phase: 'Let me check.\n\nThe answer is 42.',
      heuristic: 'The answer is 42.',
      legacy: 'Let me check.The answer is 42.',
    } as const;
    for (const mode of ['final', 'phase', 'heuristic', 'legacy'] as const) {
      vi.clearAllMocks();
      const config = makeConfig({}, { outputSelection: mode });
      setup(config);
      script([start(), m('item_0', 0, 'Let me check.'), w('item_1', 1), m('item_2', 2, 'The answer is 42.'), end()]);
      await run(config);
      expect(relayInputs()).toEqual([expected[mode]]);
      expect(historyInputs()).toEqual([expected[mode]]);
      expect(sentContents()).toEqual([expected[mode]]);
      store.close();
      adapter = createAdapter(':memory:');
    }
  });

  it('default mode final filters unlabeled narration without a tool boundary', async () => {
    const config = makeConfig();
    setup(config);
    script([start(), m('a', 0, 'one'), m('b', 1, 'two'), end()]);
    await run(config);
    expect(historyInputs()).toEqual(['two']);
    expect(sentContents()).toEqual(['two']);
    expect(relayInputs()).toEqual(['two']);
  });

  it('publishes and stores only the short tail after long unlabeled output', async () => {
    const config = makeConfig();
    setup(config);
    const answer = 'answer '.repeat(200);
    script([start(), m('a', 0, answer), w('tool', 1), m('b', 2, 'Done.'), end()]);
    await run(config);
    const expected = 'Done.';
    expect(relayInputs()).toEqual([expected]);
    expect(historyInputs()).toEqual([expected]);
    expect(sentContents().join('')).toBe(expected);
  });

  it('returns the no-response notice without publishing or storing labeled commentary beside blank output', async () => {
    const config = makeConfig();
    setup(config);
    script([start(), m('blank', 0, ' \n'), { ...m('c', 1, 'INTERNAL progress'), phase: 'commentary' }, end()]);
    await run(config);
    expect(historyInputs()).toEqual([]);
    expect(sentContents()).toEqual(['[No response generated. Please try rephrasing your question.]']);
    expect(sentContents().join('')).not.toContain('INTERNAL');
  });

  it('T6: a throw after partial output → error notice, nothing delivered, nothing stored', async () => {
    const config = makeConfig();
    setup(config);
    script([start(), m('a', 0, 'partial commentary'), new Error('boom')]);
    await run(config);
    expect(relayInputs()).toEqual([]);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(sentContents()).toEqual([expect.stringContaining('模型处理未完成')]);
  });

  it('empty selection → existing "No response generated" notice, nothing stored', async () => {
    const config = makeConfig();
    setup(config);
    script([start(), w('x', 0), end()]);
    await run(config);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(sentContents()).toEqual(['[No response generated. Please try rephrasing your question.]']);
  });

  it('B5/T11: over-limit multi-segment reply — relay sends the capped text verbatim and history matches', async () => {
    const max = 8000;
    const config = makeConfig({ maxResponseChars: max });
    setup(config);
    const warn = vi.spyOn(console, 'warn');
    const para = 'word '.repeat(700).trim(); // ~3.5k chars per paragraph
    script([start(), m('a', 0, 'discarded narration'), m('b', 1, `${para}\n\n${para}\n\n${para}`), end()]);
    await run(config);
    const [input] = relayInputs();
    expect(input.length).toBeLessThanOrEqual(max);
    expect(input.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(historyInputs()).toEqual([input]);
    const sent = sentContents();
    expect(sent.length).toBeGreaterThan(1);
    // splitMessage only drops the separator whitespace it splits on.
    expect(sent.join('').replace(/\s/g, '')).toBe(input.replace(/\s/g, ''));
    // The relay's own cap never fired on a selected payload.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[stream-relay] Response truncated'))).toBe(false);
    warn.mockRestore();
  });

  it('B4 (wiring): high surrogate at max−1 — no stray newline after the relay', async () => {
    const max = 1024;
    const config = makeConfig({ maxResponseChars: max });
    setup(config);
    script([start(), m('a', 0, 'a'.repeat(max - 1) + '😀' + 'tail'), end()]);
    await run(config);
    expect(sentContents()).toEqual(['a'.repeat(max - 22) + TRUNCATION_SUFFIX]);
    expect(historyInputs()).toEqual(['a'.repeat(max - 22) + TRUNCATION_SUFFIX]);
  });

  it('B7b (delivery): maxResponseChars 10 delivers exactly 10 chars with no suffix', async () => {
    const config = makeConfig({ maxResponseChars: 10 });
    setup(config);
    script([start(), m('a', 0, 'z'.repeat(100)), end()]);
    await run(config);
    expect(sentContents()).toEqual(['z'.repeat(10)]);
    expect(historyInputs()).toEqual(['z'.repeat(10)]);
  });

  it('B6: parity property — history === relay input and length ≤ max', async () => {
    let seed = 11;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ['a', ' ', '\n', '😀', '中'];
    for (let i = 0; i < 50; i++) {
      vi.clearAllMocks();
      const max = 1 + Math.floor(rnd() * 200);
      const config = makeConfig({ maxResponseChars: max });
      setup(config);
      const parts: string[] = [];
      for (let p = 0; p < 1 + Math.floor(rnd() * 3); p++) {
        let str = '';
        const len = 1 + Math.floor(rnd() * 150);
        for (let j = 0; j < len; j++) str += alphabet[Math.floor(rnd() * alphabet.length)];
        parts.push(str);
      }
      script([start(), ...parts.map((t, k) => m(`i${k}`, k, t)), end()]);
      await run(config);
      const inputs = relayInputs();
      expect(historyInputs()).toEqual(inputs);
      for (const t of inputs) expect(t.length).toBeLessThanOrEqual(max);
      store.close();
      adapter = createAdapter(':memory:');
    }
  });

  it.each(['final', 'heuristic'] as const)('T10: mention entities use selected text (%s)', async mode => {
    vi.mocked(getGroupMembers).mockResolvedValue([{ uid: 'uid-alice', name: 'Alice', role: 0, robot: 0 }]);
    const config = makeConfig({}, { outputSelection: mode });
    setup(config);
    groupContext.learnMember(GROUP, 'uid-alice', 'Alice');
    script([
      start(),
      m('a', 0, 'Checking with @[uid-alice:Alice] first.'),
      w('x', 1),
      m('b', 2, 'Done, @[uid-alice:Alice] please review.'),
      end(),
    ]);
    await run(config, groupMsg());
    expect(relayInputs()).toEqual(['Done, @[uid-alice:Alice] please review.']);
    expect(historyInputs()).toEqual(['Done, @[uid-alice:Alice] please review.']);
    const call = vi.mocked(sendMessage).mock.calls.find((c) => c[0].content.startsWith('Done'));
    expect(call?.[0].content).toBe('Done, @Alice please review.');
    expect(call?.[0].mentionEntities).toEqual([{ uid: 'uid-alice', offset: 6, length: 6 }]);
    expect(call?.[0].mentionUids).toEqual(['uid-alice']);
  });
});

describe('B7b: small maxResponseChars warns once at bot start', () => {
  it.each([10, 44])('maxResponseChars=%i', async (max) => {
    const root = mkdtempSync(join(tmpdir(), 'octo-small-limit-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stack = await startBot({
        botId: 'small', apiUrl: 'https://octo.example', botToken: 'test-token',
        cwd: join(root, 'workspace'), dataDir: join(root, 'data'), sdk: {},
        rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
        maxResponseChars: max, dispatchTimeoutMs: 300_000,
      } as Config, true);
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('too small for the truncation notice'));
      expect(hits).toHaveLength(1);
      expect(String(hits[0][0])).toContain(`maxResponseChars=${max}`);
      await stack.shutdown();
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no warning at 45 and above', async () => {
    const root = mkdtempSync(join(tmpdir(), 'octo-small-limit-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stack = await startBot({
        botId: 'ok', apiUrl: 'https://octo.example', botToken: 'test-token',
        cwd: join(root, 'workspace'), dataDir: join(root, 'data'), sdk: {},
        rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
        maxResponseChars: 45, dispatchTimeoutMs: 300_000,
      } as Config, true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('too small'))).toBe(false);
      await stack.shutdown();
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
