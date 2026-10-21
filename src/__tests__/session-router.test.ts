import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Octo API before importing SessionRouter
vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getMentionPreference: vi.fn().mockResolvedValue(false),
}));

import { SessionRouter } from '../session-router.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { Config } from '../config.js';
import { sendMessage } from '../octo/api.js';
import { buildSenderContext } from '../sender-context.js';
import { createHash } from 'node:crypto';

const ROBOT_ID = 'bot-001';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: {},
    baseDir: '/tmp', maxResponseChars: 524288, dispatchTimeoutMs: 300000,
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    botBlocklist: ['blocked-bot-1'],
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<BotMessage>): BotMessage {
  return {
    message_id: '1',
    message_seq: 1,
    from_uid: 'user-1',
    channel_id: 'group-1',
    channel_type: ChannelType.Group,
    timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'hello' },
    ...overrides,
  };
}

describe('SessionRouter', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  // --- Session key ---

  it('DM session key = from_uid', () => {
    const msg = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u1' });
    expect(router.sessionKey(msg)).toBe('u1');
  });

  it('Group session key = channel_id (shared per-channel, members share one session)', () => {
    const a = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g1', from_uid: 'u1' });
    const b = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g1', from_uid: 'u2' });
    // Both members of g1 map to the same key — the group is a shared workspace.
    expect(router.sessionKey(a)).toBe('g1');
    expect(router.sessionKey(b)).toBe('g1');
    // Different channels stay distinct.
    const c = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g2', from_uid: 'u1' });
    expect(router.sessionKey(c)).toBe('g2');
  });

  it('throws on a group message with no channel_id (never collapses to one shared key)', () => {
    // A channel-less group message is unroutable — falling back to '' would
    // merge unrelated channels into ONE shared session (history/memory leak).
    const m = makeMsg({ channel_type: ChannelType.Group, channel_id: undefined, from_uid: 'u1' });
    expect(() => router.sessionKey(m)).toThrow(/no channel_id/);
  });

  it('DM stays per-user even with the same/other channel', () => {
    const u1 = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u1' });
    const u2 = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u2' });
    expect(router.sessionKey(u1)).not.toBe(router.sessionKey(u2));
  });

  // --- Self-skip ---

  it('skips messages from self', async () => {
    const msg = makeMsg({ from_uid: ROBOT_ID, channel_type: ChannelType.DM });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- Blocklist ---

  it('skips DM from blocklisted bot', async () => {
    const msg = makeMsg({
      from_uid: 'blocked-bot-1',
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  it('skips group message from blocklisted bot', async () => {
    const msg = makeMsg({
      from_uid: 'blocked-bot-1',
      channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text,
        content: 'hi',
        mention: { uids: [ROBOT_ID] },
      },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- Mention gate ---

  it('admits a producer-shaped routing mention without stripping a teammate span', async () => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@Alice @bot-001 please look',
      mention: { uids: ['alice', ROBOT_ID], entities: [{ uid: 'alice', offset: 0, length: 6 }] } } });
    expect(await router.route(msg)).toMatchObject({ shouldProcess: true, cleanContent: msg.payload.content });
    expect(JSON.parse(buildSenderContext(msg, 'owner', ROBOT_ID).split('\n')[1]))
      .toMatchObject({ mentioned_uids: ['alice', ROBOT_ID], mention_source: 'entities', is_explicitly_mentioned: true });
  });

  it.each([
    { entities: null, uids: [ROBOT_ID] },
    { entities: [{ uid: ROBOT_ID }], uids: Array(129).fill('other') },
    { uids: 'malformed', ais: true },
    { entities: Array(129), ais: 1 },
  ])('keeps valid independent admission facts and logs bounded correlation: %j', async mention => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const msg = makeMsg({ channel_id: 'SYNTHETIC_CHANNEL', message_id: 'SYNTHETIC_MESSAGE',
        payload: { type: MessageType.Text, content: 'SYNTHETIC_BODY', mention: mention as unknown as BotMessage['payload']['mention'] } });
      expect((await router.route(msg))?.shouldProcess).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toBe('[codex-channel-octo] invalid mention metadata');
      expect(JSON.parse(warn.mock.calls[0][1] as string)).toEqual({
        mention_source: 'invalid', channelHash: createHash('sha256').update(msg.channel_id!).digest('hex'),
        messageHash: createHash('sha256').update(msg.message_id).digest('hex'),
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SYNTHETIC_');
    } finally { warn.mockRestore(); }
  });

  it.each([
    { uids: [...Array(128).fill('other'), ROBOT_ID] },
    { uids: ROBOT_ID },
  ])('admits exact legacy routing targets while keeping invalid metadata strict: %j', async mention => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: 'request',
      mention: mention as unknown as BotMessage['payload']['mention'] } });
    expect((await router.route(msg))?.shouldProcess).toBe(true);
    expect(JSON.parse(buildSenderContext(msg, 'owner', ROBOT_ID).split('\n')[1]))
      .toMatchObject({ mention_source: 'invalid', is_explicitly_mentioned: false, mentioned_uids: [] });
  });

  it.each(['prefix-bot-001-suffix', 'BOT-001', 'bot-001 ', ['other']])(
    'does not treat invalid routing payloads as substring matches: %j', async uids => {
      const msg = makeMsg({ payload: { type: MessageType.Text, content: 'request',
        mention: { uids } as unknown as BotMessage['payload']['mention'] } });
      expect(await router.route(msg)).toBeNull();
    });

  it('strips a bot prefix when only a later teammate has a rendered entity', async () => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@bot-001 @Alice look',
      mention: { uids: [ROBOT_ID, 'alice'], entities: [{ uid: 'alice', offset: 9, length: 6 }] } } });
    expect((await router.route(msg))?.cleanContent).toBe('@Alice look');
  });

  it('rejects an unusable mention with a fixed warning, without trusting humans/all as AI', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const msg = makeMsg({ channel_id: 'group-1', message_id: 'x'.repeat(513),
        payload: { type: MessageType.Text, content: 'private', mention: { uids: 'invalid', humans: 1, all: 1 } as unknown as BotMessage['payload']['mention'] } });
      expect(await router.route(msg)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0][1] as string).messageHash).toBeNull();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    } finally { warn.mockRestore(); }
  });

  it.each(['entities', 'uids'])('strips a valid fullwidth leading mention using %s', async source => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '＠bot-001 hi',
      mention: source === 'entities' ? { entities: [{ uid: ROBOT_ID, offset: 0, length: 8 }] } : { uids: [ROBOT_ID] } } });
    expect((await router.route(msg))?.cleanContent).toBe('hi');
  });

  it.each([
    [{ entities: [{ uid: ROBOT_ID, offset: 0, length: 8 }] }, true, true],
    [{ entities: [{ uid: 'other', offset: 0, length: 8 }], uids: [ROBOT_ID] }, true, true],
    [{ entities: [null], uids: [ROBOT_ID] }, true, true],
    [{ ais: true }, true, false],
    [{ all: 1, humans: 1 }, false, false],
    [{ ais: 'false' }, false, false],
    [{ uids: ROBOT_ID, ais: true }, true, false],
  ])('uses the same structured mention facts for routing and attribution: %j', async (mention, passes, explicit) => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@bot-001 hi',
      mention: mention as unknown as NonNullable<BotMessage['payload']['mention']> } });
    expect((await router.route(msg))?.shouldProcess ?? false).toBe(passes);
    expect(JSON.parse(buildSenderContext(msg, 'owner', ROBOT_ID).split('\n')[1]).is_explicitly_mentioned).toBe(explicit);
  });

  it.each([-1, 0, 999, Infinity, NaN, 1.5, '8'])('never slices text using an invalid entity length %j', async (length) => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@bot-001 hi',
      mention: { entities: [{ uid: ROBOT_ID, offset: 0, length: length as number }] } } });
    expect((await router.route(msg))?.cleanContent).toBe('@bot-001 hi');
  });

  it('retains text addressed to someone else on broad AI admission', async () => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@other hi', mention: { ais: 1 } } });
    expect((await router.route(msg))?.cleanContent).toBe('@other hi');
  });

  it.each([
    ['ordinary request', 0, 4],
    ['@other @bot-001 hi', 7, 8],
    ['@bot-001 hi', -1, 8],
    ['@bot-001 hi', 0.5, 8],
    ['@bot-001 hi', '0', 8],
    ['@🤖 hi', 0, 2],
  ])('preserves text when entity coordinates cannot safely identify a leading mention: %s/%s/%s', async (content, offset, length) => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content,
      mention: { entities: [{ uid: ROBOT_ID, offset: offset as number, length }] } } });
    expect((await router.route(msg))?.cleanContent).toBe(content);
  });

  it('removes a valid leading mention with a complete surrogate pair', async () => {
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@🤖 hi',
      mention: { entities: [{ uid: ROBOT_ID, offset: 0, length: 3 }] } } });
    expect((await router.route(msg))?.cleanContent).toBe('hi');
  });

  it('does not manufacture explicit membership when mention-free routing admits a message', async () => {
    const freeRouter = new SessionRouter(makeConfig({ mentionFreeGroups: ['group-1'] }), ROBOT_ID);
    const msg = makeMsg({ payload: { type: MessageType.Text, content: '@bot-001 hi' } });
    expect((await freeRouter.route(msg))?.shouldProcess).toBe(true);
    expect(JSON.parse(buildSenderContext(msg, 'owner', ROBOT_ID).split('\n')[1]).is_explicitly_mentioned).toBe(false);
  });

  it('passes DM without mention gate', async () => {
    const msg = makeMsg({ channel_type: ChannelType.DM });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('passes group message when mention.uids includes robotId', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { uids: [ROBOT_ID] } },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('passes group message when mention.ais is 1', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { ais: 1 } },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('REJECTS group message when only mention.all is set (humans-only)', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { all: 1 } },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  it('rejects group message with no mention at all', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- System events ---

  it('silently skips system events (payload.event)', async () => {
    const msg = makeMsg({
      channel_type: ChannelType.DM,
      payload: {
        type: MessageType.Text,
        content: '',
        event: { type: 'group_md_updated' },
      },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // --- Non-text message ---

  it('now passes non-text messages through (G1: handled by inbound.resolveContent)', async () => {
    const msg = makeMsg({
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Image, url: 'file/abc.jpg' },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    // G1: image messages are no longer rejected — they flow through to the
    // pipeline where resolveContent renders them as "[图片] <url>".
    expect(result!.shouldProcess).toBe(true);
    // No “不支持” auto-reply.
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: '暂不支持此类消息，请发送文字' }),
    );
  });

  // --- Rate limiting ---

  it('passes first N requests within limit', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 3 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    for (let i = 0; i < 3; i++) {
      const msg = makeMsg({ message_id: String(i), channel_type: ChannelType.DM });
      const result = await router.route(msg);
      expect(result!.shouldProcess).toBe(true);
    }
  });

  it('rejects requests exceeding rate limit', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 2 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume tokens
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));
    await router.route(makeMsg({ message_id: '2', channel_type: ChannelType.DM }));

    // Should be rate limited — first rejection sends notification
    const result = await router.route(makeMsg({ message_id: '3', channel_type: ChannelType.DM }));
    expect(result!.shouldProcess).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '请稍后再试' }),
    );
  });

  it('rate limit debounce: only notifies once per window', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 1 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume the single token
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));
    vi.mocked(sendMessage).mockClear();

    // First rejection — notified
    await router.route(makeMsg({ message_id: '2', channel_type: ChannelType.DM }));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Subsequent rejections — debounced, no additional notification
    await router.route(makeMsg({ message_id: '3', channel_type: ChannelType.DM }));
    await router.route(makeMsg({ message_id: '4', channel_type: ChannelType.DM }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rate limit applies to non-text messages too', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 1 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume the single token with a text message
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));

    // Non-text message should be rate limited, not replied with "暂不支持"
    vi.mocked(sendMessage).mockClear();
    const result = await router.route(makeMsg({
      message_id: '2',
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Image },
    }));
    expect(result!.shouldProcess).toBe(false);
    // Should get rate limit notification, not the non-text notice
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '请稍后再试' }),
    );
  });

  // --- Serial queue ---

  it('group rate limit is per-member, not one shared bucket for the whole channel', async () => {
    // Regression: with the per-channel sessionKey, keying the session bucket by
    // sessionKey alone collapsed the whole room into one quota. Each member must
    // get their own maxPerMinute in the same channel.
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 2 } });
    router = new SessionRouter(cfg, ROBOT_ID);
    const CH = 'group-shared';
    const mentioned = { type: MessageType.Text, content: 'hi', mention: { uids: [ROBOT_ID] } };

    // Alice uses her full quota (2).
    const a1 = await router.route(makeMsg({ message_id: 'a1', channel_id: CH, from_uid: 'alice', channel_type: ChannelType.Group, payload: mentioned }));
    const a2 = await router.route(makeMsg({ message_id: 'a2', channel_id: CH, from_uid: 'alice', channel_type: ChannelType.Group, payload: mentioned }));
    expect(a1!.shouldProcess).toBe(true);
    expect(a2!.shouldProcess).toBe(true);

    // Bob in the SAME channel still has his own quota — not blocked by Alice.
    const b1 = await router.route(makeMsg({ message_id: 'b1', channel_id: CH, from_uid: 'bob', channel_type: ChannelType.Group, payload: mentioned }));
    const b2 = await router.route(makeMsg({ message_id: 'b2', channel_id: CH, from_uid: 'bob', channel_type: ChannelType.Group, payload: mentioned }));
    expect(b1!.shouldProcess).toBe(true);
    expect(b2!.shouldProcess).toBe(true);

    // Alice's 3rd IS blocked (her own quota exhausted).
    const a3 = await router.route(makeMsg({ message_id: 'a3', channel_id: CH, from_uid: 'alice', channel_type: ChannelType.Group, payload: mentioned }));
    expect(a3!.shouldProcess).toBe(false);
  });

  it('sessionKey throws on a DM with empty from_uid (no shared-session collapse)', () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 5 } });
    router = new SessionRouter(cfg, ROBOT_ID);
    const msg = makeMsg({ channel_type: ChannelType.DM, from_uid: '', channel_id: 'dm-ch' });
    expect(() => router.sessionKey(msg)).toThrow(/no from_uid/);
  });

  // --- Serial queue (continued) ---

  it('processes same session key sequentially', async () => {
    const order: number[] = [];
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 100 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(
        router.route(makeMsg({ message_id: String(idx), channel_type: ChannelType.DM })).then(() => {
          order.push(idx);
        }),
      );
    }
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

// ─── routeAndHandle: Concurrency + Lock Integration ─────────────────────────

describe('routeAndHandle concurrency', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig({ rateLimit: { maxPerMinute: 100 } }), ROBOT_ID);
  });

  it('same session key: route + handler execute serially (FIFO)', async () => {
    const order: number[] = [];

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(idx),
            channel_type: ChannelType.DM,
            from_uid: 'same-user',
          }),
          async () => {
            // Simulate async work to expose ordering bugs
            await new Promise((r) => setTimeout(r, 1));
            order.push(idx);
          },
        ),
      );
    }
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('different session keys run in parallel', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(i),
            channel_type: ChannelType.DM,
            from_uid: `user-${i}`, // different session keys
          }),
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise((r) => setTimeout(r, 10));
            current--;
          },
        ),
      );
    }
    await Promise.all(promises);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('handler runs inside the lock (max 1 concurrent per session)', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(i),
            channel_type: ChannelType.DM,
            from_uid: 'same-user',
          }),
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise((r) => setTimeout(r, 5));
            current--;
          },
        ),
      );
    }
    await Promise.all(promises);
    expect(maxConcurrent).toBe(1);
  });

  it('routeAndHandle does not call handler for non-processable messages', async () => {
    const handlerCalls: string[] = [];

    // Group message without mention — should not be processed
    await router.routeAndHandle(
      makeMsg({
        channel_type: ChannelType.Group,
        payload: { type: MessageType.Text, content: 'no mention' },
      }),
      async (result) => {
        handlerCalls.push(result.sessionKey);
      },
    );

    expect(handlerCalls).toHaveLength(0);
  });

  it('routeAndHandle calls handler for processable messages', async () => {
    const handlerCalls: string[] = [];

    // DM text message — should be processed
    await router.routeAndHandle(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'user-1',
        payload: { type: MessageType.Text, content: 'hello' },
      }),
      async (result) => {
        handlerCalls.push(result.sessionKey);
      },
    );

    expect(handlerCalls).toEqual(['user-1']);
  });

  it('burst of same-session messages: FIFO order + max-1 concurrent', async () => {
    const order: number[] = [];
    let maxConcurrent = 0;
    let current = 0;

    const burst = 10;
    const promises = [];
    for (let i = 0; i < burst; i++) {
      const idx = i;
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(idx),
            channel_type: ChannelType.DM,
            from_uid: 'burst-user',
          }),
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise((r) => setTimeout(r, 1));
            order.push(idx);
            current--;
          },
        ),
      );
    }
    await Promise.all(promises);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ─── #141: Dispatch timeout ────────────────────────────────────────────────

describe('dispatch timeout (#141)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a hung handler quarantines its session without starting the next message', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 50 }),
      ROBOT_ID,
    );
    const completed: number[] = [];

    // Message 1: handler never resolves (simulates a hung agent turn).
    const p1 = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      (_result, turn) => { turn.executionRisk = 'unknown'; return new Promise<void>(() => { /* never resolves */ }); },
    );

    // Message 2: a normal fast handler on the SAME session. Without the
    // timeout it would be blocked forever behind message 1's session lock.
    const p2 = router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      async () => { completed.push(2); },
    );

    await Promise.all([p1, p2]);

    // Message 2 remains blocked because the started execution is uncertain.
    expect(completed).toEqual([]);
  });

  it('sends a single bounded apology on timeout', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 30 }),
      ROBOT_ID,
    );

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      () => new Promise<void>(() => { /* never resolves */ }),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0][0]).toMatchObject({
      content: expect.stringContaining('任务超时'),
    });
  });

  it('does not fire for a normal fast handler', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 1000 }),
      ROBOT_ID,
    );
    let ran = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async () => { ran = true; },
    );

    expect(ran).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('disabled (0) runs the handler unguarded', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 0 }),
      ROBOT_ID,
    );
    let ran = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async () => { ran = true; },
    );

    expect(ran).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a rejecting handler does not wedge the session (next message still runs)', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 1000 }),
      ROBOT_ID,
    );
    const completed: number[] = [];

    // Message 1: handler rejects fast (a real handler error, not a timeout).
    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      async () => { throw new Error('boom'); },
    );
    // Message 2: same session — must still run (lock released, no timeout apology).
    await router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      async () => { completed.push(2); },
    );

    expect(completed).toEqual([2]);
    // A non-timeout error must NOT trigger the timeout apology.
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Q10: Message length limit ─────────────────────────────────────────────

describe('Message length limit (Q10)', () => {
  it('rejects messages exceeding 32KB', async () => {
    const config = makeConfig();
    const router = new SessionRouter(config, ROBOT_ID);
    const longContent = 'A'.repeat(33_000); // > 32KB

    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'long-msg-user',
        payload: { type: MessageType.Text, content: longContent },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '消息过长，请缩短后重试' }),
    );
  });

  it('accepts messages at exactly 32KB', async () => {
    const config = makeConfig();
    const router = new SessionRouter(config, ROBOT_ID);
    const exactContent = 'A'.repeat(32_768); // exactly 32KB ASCII

    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'exact-limit-user',
        payload: { type: MessageType.Text, content: exactContent },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('measures length in bytes not chars (CJK)', async () => {
    const config = makeConfig();
    const router = new SessionRouter(config, ROBOT_ID);
    // 11000 CJK chars × 3 bytes = 33000 bytes > 32KB
    const cjkContent = '中'.repeat(11_000);

    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'cjk-user',
        payload: { type: MessageType.Text, content: cjkContent },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(false);
  });
});

// ─── G14: bot-to-bot DM loop prevention ────────────────────────────────────────────

describe('G14: bot-to-bot DM loop prevention', () => {
  it('drops DM from a uid ending in _bot', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'random_bot',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
  });

  it('drops DM from the bot itself (knownBotUids includes self)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: ROBOT_ID,
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
  });

  it('drops DM from a registered known bot uid', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.registerKnownBot('peer-bot-uid');
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'peer-bot-uid',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
  });

  it('allows DM from a bot in allowedBotUids whitelist', async () => {
    const router = new SessionRouter(
      makeConfig({ allowedBotUids: ['trusted_bot'] }),
      ROBOT_ID,
    );
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'trusted_bot',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('allows DM from a regular human user (no _bot suffix)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'alice123',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('does NOT drop group messages from _bot uid (mention gate handles those)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    // Without @mention, group msg from bot would be dropped by mention gate, not G14.
    // With @mention, it should pass.
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.Group,
        from_uid: 'someone_bot',
        payload: {
          type: MessageType.Text,
          content: 'hi',
          mention: { uids: [ROBOT_ID] },
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });
});

// ─── #157: unregisterKnownBot (hot-reload sibling removal) ───────────────────

describe('#157: unregisterKnownBot', () => {
  it('drops a registered sibling, then processes it again after unregister', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.registerKnownBot('peer-bot-uid');
    const dm = () =>
      router.route(
        makeMsg({
          channel_type: ChannelType.DM,
          from_uid: 'peer-bot-uid',
          payload: { type: MessageType.Text, content: 'hi' },
        }),
      );
    // While registered: dropped as a known bot.
    expect(await dm()).toBeNull();
    // After unregister: no longer a known bot → treated as a normal DM peer.
    router.unregisterKnownBot('peer-bot-uid');
    const after = await dm();
    expect(after).not.toBeNull();
    expect(after!.shouldProcess).toBe(true);
  });

  it('refuses to unregister the router its own robotId (self is always a bot)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.unregisterKnownBot(ROBOT_ID);
    // Self must still be treated as a bot — its own echoes stay dropped.
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: ROBOT_ID,
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
    expect(router.knownBotUidsSnapshot().has(ROBOT_ID)).toBe(true);
  });

  it('is idempotent and safe for unknown / empty uids', () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    expect(() => router.unregisterKnownBot('never-registered')).not.toThrow();
    expect(() => router.unregisterKnownBot('')).not.toThrow();
    router.registerKnownBot('peer');
    router.unregisterKnownBot('peer');
    router.unregisterKnownBot('peer'); // second time is a no-op
    expect(router.knownBotUidsSnapshot().has('peer')).toBe(false);
  });

  it('snapshot reflects register/unregister and is a copy (not live)', () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.registerKnownBot('peer');
    const snap = router.knownBotUidsSnapshot();
    expect(snap.has('peer')).toBe(true);
    expect(snap.has(ROBOT_ID)).toBe(true);
    // Mutating after snapshot must not change the already-returned set.
    router.unregisterKnownBot('peer');
    expect(snap.has('peer')).toBe(true); // snapshot is a copy
    expect(router.knownBotUidsSnapshot().has('peer')).toBe(false);
  });
});

// ─── G18: owner_uid storage ────────────────────────────────────────────────────────────

describe('G18: owner_uid storage', () => {
  it('reads the latest owner after registration refresh instead of a stale snapshot', () => {
    let owner = 'first-owner';
    const router = new SessionRouter(makeConfig(), ROBOT_ID, () => owner);
    expect(router.getOwnerUid()).toBe(owner);
    owner = 'next-owner';
    expect(router.getOwnerUid()).toBe(owner);
  });
  it('SessionRouter accepts and stores ownerUid (default empty)', () => {
    const r1 = new SessionRouter(makeConfig(), ROBOT_ID);
    expect(r1).toBeDefined(); // construct without ownerUid arg
    const r2 = new SessionRouter(makeConfig(), ROBOT_ID, 'owner-uid-xyz');
    expect(r2).toBeDefined(); // construct with ownerUid arg
  });
});

// ─── G20: per-user cross-channel rate limit + debounce correctness ────────────────

describe('G20: per-user cross-channel rate limit', () => {
  it('per-user limit blocks across different groups', async () => {
    // 5 req/min limit. Send 5 messages from same user across different groups
    // — 6th should be rate-limited even though each group has its own session.
    const router = new SessionRouter(makeConfig({ rateLimit: { maxPerMinute: 5 } }), ROBOT_ID);
    const uid = 'spammer-1';
    let blocked = 0;
    for (let i = 0; i < 7; i++) {
      const result = await router.route(
        makeMsg({
          channel_id: `group-${i}`, // different group each time
          channel_type: ChannelType.Group,
          from_uid: uid,
          payload: {
            type: MessageType.Text,
            content: 'msg',
            mention: { uids: [ROBOT_ID] },
          },
        }),
      );
      if (result && !result.shouldProcess) blocked++;
    }
    expect(blocked).toBeGreaterThanOrEqual(2); // at least 2 of the 7 should be blocked
  });

  it('debounce: blocked user receives at most one notice per refill window', async () => {
    const router = new SessionRouter(makeConfig({ rateLimit: { maxPerMinute: 2 } }), ROBOT_ID);
    const uid = 'user-debounce';
    vi.clearAllMocks();
    // Burn through quota across multiple groups
    for (let i = 0; i < 10; i++) {
      await router.route(
        makeMsg({
          channel_id: `g-${i}`,
          channel_type: ChannelType.Group,
          from_uid: uid,
          payload: {
            type: MessageType.Text,
            content: 'x',
            mention: { uids: [ROBOT_ID] },
          },
        }),
      );
    }
    // The reply for '请稍后再试' should be sent at most a few times —
    // crucially NOT once per blocked message. Without the fix, every blocked
    // message would trigger another reply (DoS reflection).
    const replyCalls = (sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { content?: string }).content === '请稍后再试',
    );
    expect(replyCalls.length).toBeLessThanOrEqual(2);
  });
});

// ─── v0.3 multi-bot: mention-free group bot-loop guard ─────────────────

describe('multi-bot loop guard in mention-free groups', () => {
  const GROUP = 'mf-group';

  function mfConfig(): Config {
    return makeConfig({ mentionFreeGroups: [GROUP] });
  }
  function mfMsg(fromUid: string): BotMessage {
    return makeMsg({
      from_uid: fromUid,
      channel_id: GROUP,
      channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, content: 'auto reply' },
    });
  }

  it('processes a human message in a mention-free group (baseline)', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    const result = await r.route(mfMsg('human-1'));
    expect(result?.shouldProcess).toBe(true);
  });

  it('drops a _bot-suffixed sender in a mention-free group (no mention)', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    const result = await r.route(mfMsg('helper_bot'));
    expect(result).toBeNull();
  });

  it('drops a registered sibling bot in a mention-free group', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    r.registerKnownBot('bot-002'); // sibling bot id (no _bot suffix)
    const result = await r.route(mfMsg('bot-002'));
    expect(result).toBeNull();
  });

  it('still answers a sibling bot that explicitly @-mentions us', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    r.registerKnownBot('bot-002');
    const msg = mfMsg('bot-002');
    msg.payload.mention = { uids: [ROBOT_ID] };
    const result = await r.route(msg);
    expect(result?.shouldProcess).toBe(true);
  });

  it('honors allowedBotUids whitelist in mention-free groups', async () => {
    const r = new SessionRouter(
      makeConfig({ mentionFreeGroups: [GROUP], allowedBotUids: ['trusted_bot'] }),
      ROBOT_ID,
    );
    const result = await r.route(mfMsg('trusted_bot'));
    expect(result?.shouldProcess).toBe(true);
  });
});

// ─── #68: unsupported/system channel types are dropped ──────────────────

describe('unsupported channel types (system messages)', () => {
  let router: SessionRouter;
  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  it('drops a system channel_type (8 "systemcmdonline") with no reply', async () => {
    // Reproduces the live-deployment bug: a system message on channel_type 8
    // must not be processed as a conversation.
    const msg = makeMsg({
      channel_id: 'systemcmdonline',
      channel_type: 8 as unknown as ChannelType,
      from_uid: 'system',
      payload: { type: MessageType.Text, content: '' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drops an unknown channel_type (e.g. 99)', async () => {
    const msg = makeMsg({ channel_type: 99 as unknown as ChannelType });
    expect(await router.route(msg)).toBeNull();
  });

  it('still processes a normal DM', async () => {
    const msg = makeMsg({
      channel_id: 'dm-1', channel_type: ChannelType.DM, from_uid: 'human',
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result?.shouldProcess).toBe(true);
  });
});
