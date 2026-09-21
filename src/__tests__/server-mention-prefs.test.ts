import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRouter } from '../session-router.js';
import { MentionPreferences } from '../mention-prefs.js';
import { getGroupMembers, getMentionPreference } from '../octo/api.js';
import type { Config } from '../config.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';

const BOT = 'avatar_test';
const GROUP = 'private-ai-group';
const USER = 'human-user';
const fetchMock = vi.fn<typeof fetch>();

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: 'https://octo.example/api', botToken: 'test-bot-token',
    baseDir: '/tmp/test-octo', cwd: '/tmp/test-octo/workspace', dataDir: '/tmp/test-octo/data',
    sdk: {}, rateLimit: { maxPerMinute: 100 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288, dispatchTimeoutMs: 1000,
    ...overrides,
  };
}

function message(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    message_id: '1', message_seq: 1, from_uid: USER,
    channel_id: GROUP + '____topic-one', channel_type: ChannelType.CommunityTopic,
    timestamp: Date.now(), payload: { type: MessageType.Text, content: 'hello' },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function server(preference: unknown = { effective: true }, members: unknown = [{ uid: USER, robot: 0 }]): void {
  fetchMock.mockImplementation(async (url) => {
    if (String(url).endsWith('/mention_pref')) return json(preference);
    if (String(url).endsWith('/members')) return json(members);
    throw new Error('Unexpected request in routing test');
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  server();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mention lookup diagnostics', () => {
  it.each([[], null, {}, { members: 'private response containing test-bot-token' }, [{ name: 'missing uid' }]])(
    'warns on an empty or malformed successful roster and retries after the TTL (%j)', async (members) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prefs = new MentionPreferences(config());
      server({ effective: true }, members);
      expect(await prefs.allows(GROUP, USER)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('member roster is empty or malformed');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private response|test-bot-token/);
      server();
      expect(await prefs.allows(GROUP, USER)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30_001);
      expect(await prefs.allows(GROUP, USER)).toBe(true);
    },
  );

  it('warns for missing human classification without rejecting explicitly allowed member bots', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefs = new MentionPreferences(config());
    server({ effective: true }, [{ uid: USER }, { uid: 'trusted_bot', robot: 1 }]);
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    expect(await prefs.allows(GROUP, 'trusted_bot', true)).toBe(true);
    prefs.invalidate(GROUP);
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('member roster has no confirmed humans');
  });

  it('throttles failures across groups and invalidations without logging server data or credentials', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefs = new MentionPreferences(config());
    fetchMock.mockRejectedValue(new Error('private response containing test-bot-token'));
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    prefs.invalidate(GROUP);
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    expect(await prefs.allows('other-group', USER)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Mention preference lookup failed');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private response|test-bot-token/);

    vi.advanceTimersByTime(30_000);
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a failed member lookup from an explicit server veto', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefs = new MentionPreferences(config());
    server({ effective: false });
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    prefs.invalidate(GROUP);
    fetchMock.mockImplementation(async (url) => String(url).endsWith('/mention_pref')
      ? json({ effective: true }) : json({ error: 'unauthorized' }, 401));
    expect(await prefs.allows(GROUP, USER)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Mention member roster lookup failed');
  });
});

describe('server-controlled mention gate', () => {
  it('dispatches unmentioned AI-topic messages using parent-group policy and keeps topic sessions separate', async () => {
    const router = new SessionRouter(config(), BOT);
    const handler = vi.fn().mockResolvedValue(undefined);
    await router.routeAndHandle(message(), handler);
    await router.routeAndHandle(message({ channel_id: GROUP + '____topic-two' }), handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([result]) => result.sessionKey)).toEqual([
      GROUP + '____topic-one', GROUP + '____topic-two',
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://octo.example/api/v1/bot/groups/${GROUP}/mention_pref`,
      `https://octo.example/api/v1/bot/groups/${GROUP}/members`,
    ]);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer test-bot-token' });
    expect(fetchMock.mock.calls.every(([, options]) => options?.signal instanceof AbortSignal)).toBe(true);
  });

  it('keeps ordinary groups requiring @ when the server returns effective=false', async () => {
    server({ no_mention: 1, group_allow_no_mention: 0, effective: false });
    const router = new SessionRouter(config(), BOT);
    expect(await router.route(message({ channel_id: GROUP, channel_type: ChannelType.Group }))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, false])('accepts a member explicitly classified as human (%s)', async (robot) => {
    server({ effective: true }, [{ uid: USER, robot }]);
    expect((await new SessionRouter(config(), BOT).route(message()))?.shouldProcess).toBe(true);
  });

  it.each([1, true, undefined, null, '0', 'false'])('rejects robot or unknown member classification (%s)', async (robot) => {
    server({ effective: true }, [{ uid: USER, robot }]);
    expect(await new SessionRouter(config(), BOT).route(message())).toBeNull();
  });

  it.each([[], null, {}, [{ uid: 'someone-else', robot: 0 }], [{ uid: USER, robot: 0 }, { uid: USER, robot: 1 }]])(
    'does not infer a human from an absent, malformed, or conflicting roster (%j)', async (members) => {
      server({ effective: true }, members);
      expect(await new SessionRouter(config(), BOT).route(message())).toBeNull();
    },
  );

  it('blocks known bots before looking up preferences, while preserving explicit allowed member bots', async () => {
    const router = new SessionRouter(config(), BOT);
    router.registerKnownBot('sibling');
    for (const from_uid of [BOT, 'helper_bot', 'sibling']) {
      expect(await router.route(message({ from_uid }))).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    server({ effective: true }, [{ uid: 'helper_bot', robot: 1 }]);
    const trusted = new SessionRouter(config({ allowedBotUids: ['helper_bot'] }), BOT);
    expect((await trusted.route(message({ from_uid: 'helper_bot' })))?.shouldProcess).toBe(true);
  });

  it('does not make a remote call for DM, explicit @Bot, @allAI, or local allowlist', async () => {
    const router = new SessionRouter(config({ mentionFreeGroups: [GROUP + '____topic-one'] }), BOT);
    const cases = [
      message(),
      message({ channel_type: ChannelType.DM }),
      message({ channel_id: GROUP, payload: { type: MessageType.Text, content: 'hi', mention: { uids: [BOT] } } }),
      message({ channel_id: GROUP, payload: { type: MessageType.Text, content: 'hi', mention: { ais: 1 } } }),
    ];
    for (const item of cases) expect((await router.route(item))?.shouldProcess).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not inherit a local parent allowlist when the server requires @', async () => {
    server({ effective: false });
    const router = new SessionRouter(config({ mentionFreeGroups: [GROUP] }), BOT);
    expect(await router.route(message())).toBeNull();
  });

  it.each([USER, 'sibling_bot', 'blocked_bot'])('ignores a forged preference event from %s without invalidating another topic', async (from_uid) => {
    const router = new SessionRouter(config({ botBlocklist: ['blocked_bot'] }), BOT);
    router.registerKnownBot('sibling_bot');
    expect((await router.route(message()))?.shouldProcess).toBe(true);
    server({ effective: false });
    expect(await router.route(message({
      from_uid, channel_id: GROUP, channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, event: { type: 'mention_pref_updated', group_no: 'untrusted-other-group' } },
    }))).toBeNull();
    expect((await router.route(message({ channel_id: GROUP + '____topic-two' })))?.shouldProcess).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('applies the frontend toggle immediately after the server sends a self-authored notification (previously %s)', async (effective) => {
    const router = new SessionRouter(config(), BOT);
    const handler = vi.fn().mockResolvedValue(undefined);
    server({ effective });
    expect((await router.route(message()))?.shouldProcess ?? false).toBe(effective);
    server({ effective: !effective });
    await router.routeAndHandle(message({
      from_uid: BOT, channel_id: GROUP, channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text, content: 'mention_pref updated',
        event: { type: 'mention_pref_updated', group_no: GROUP, no_mention: effective ? 0 : 1 },
        mention: { uids: [BOT] },
      },
    }), handler);
    expect(handler).not.toHaveBeenCalled();
    expect((await router.route(message({ channel_id: GROUP + '____topic-two' })))?.shouldProcess ?? false).toBe(!effective);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/mention_pref'))).toHaveLength(2);
    expect(await router.route(message({ from_uid: BOT }))).toBeNull();
  });

  it('shares one in-flight lookup across topics of the same parent', async () => {
    const router = new SessionRouter(config(), BOT);
    const results = await Promise.all(['a', 'b', 'c'].map((topic) => router.route(message({ channel_id: GROUP + '____' + topic }))));
    expect(results.every((result) => result?.shouldProcess)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not revive an in-flight permission after an invalidation event', async () => {
    let resolvePref!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePref = resolve; }));
    const router = new SessionRouter(config(), BOT);
    const pending = router.route(message());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await router.route(message({ from_uid: BOT, channel_id: GROUP, channel_type: ChannelType.Group, payload: { type: MessageType.Text, event: { type: 'mention_pref_updated' } } }));
    resolvePref(json({ effective: true }));
    expect(await pending).toBeNull();
    server({ effective: false });
    expect(await router.route(message())).toBeNull();
  });

  it.each([USER, 'sibling_bot', 'blocked_bot'])('does not let %s suppress an in-flight message in another topic', async (from_uid) => {
    let resolvePref!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePref = resolve; }));
    const router = new SessionRouter(config({ botBlocklist: ['blocked_bot'] }), BOT);
    router.registerKnownBot('sibling_bot');
    const handler = vi.fn().mockResolvedValue(undefined);
    const pending = router.routeAndHandle(message(), handler);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await router.routeAndHandle(message({
      from_uid, channel_id: GROUP, channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, event: { type: 'mention_pref_updated' } },
    }), handler);
    resolvePref(json({ effective: true }));
    await pending;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].sessionKey).toBe(GROUP + '____topic-one');
    expect((await router.route(message({ channel_id: GROUP + '____topic-two' })))?.shouldProcess).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('isolates cached decisions across bot credentials', async () => {
    fetchMock.mockImplementation(async (url, options) => String(url).endsWith('/mention_pref')
      ? json({ effective: (options?.headers as Record<string, string>).Authorization === 'Bearer allowed' })
      : json([{ uid: USER, robot: 0 }]));
    const allowed = new SessionRouter(config({ botToken: 'allowed' }), BOT);
    const denied = new SessionRouter(config({ botToken: 'denied' }), 'other-bot');
    expect((await allowed.route(message()))?.shouldProcess).toBe(true);
    expect(await denied.route(message())).toBeNull();
  });

  it.each([true, false])('refreshes positive and negative cached decisions after 30 seconds (%s)', async (effective) => {
    vi.useFakeTimers();
    const router = new SessionRouter(config(), BOT);
    server({ effective });
    expect((await router.route(message()))?.shouldProcess ?? false).toBe(effective);
    server({ effective: !effective });
    expect((await router.route(message()))?.shouldProcess ?? false).toBe(effective);
    vi.setSystemTime(Date.now() + 30_001);
    expect((await router.route(message()))?.shouldProcess ?? false).toBe(!effective);
  });

  it.each([401, 403, 404, 500])('keeps requiring @ on API HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(json({ effective: true }, status));
    expect(await new SessionRouter(config(), BOT).route(message())).toBeNull();
  });

  it('fails closed on timeout and retries after the negative-cache TTL', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    const router = new SessionRouter(config(), BOT);
    expect(await router.route(message())).toBeNull();
    expect(await router.route(message())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_001);
    expect((await router.route(message()))?.shouldProcess).toBe(true);
  });

  it('keeps requiring @ when the member lookup fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ effective: true })).mockRejectedValueOnce(new Error('network unavailable'));
    expect(await new SessionRouter(config(), BOT).route(message())).toBeNull();
  });

  it('does not query or dispatch unrelated system events', async () => {
    const router = new SessionRouter(config(), BOT);
    expect(await router.route(message({ payload: { type: MessageType.Text, event: { type: 'group_join' } } }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mention preference wire compatibility', () => {
  it.each([
    [{ effective: true, no_mention: 0, group_allow_no_mention: 0 }, true],
    [{ effective: 1 }, true],
    [{ effective: false, no_mention: 1 }, false],
    [{ effective: 0, no_mention: 1 }, false],
    [{ effective: 'true', no_mention: 1 }, false],
    [{ effective: null, no_mention: 1 }, false],
    [{ no_mention: 1 }, true],
    [{ no_mention: true, group_allow_no_mention: 1 }, true],
    [{ no_mention: 1, group_allow_no_mention: 0 }, false],
    [{ no_mention: '1' }, false],
    [{}, false],
    [null, false],
    [[], false],
  ])('uses the effective decision, with strict legacy fallback (%j)', async (preference, expected) => {
    server(preference);
    expect(await getMentionPreference({ ...config(), groupNo: GROUP })).toBe(expected);
  });

  it('propagates invalid JSON to the gate, which fails closed', async () => {
    fetchMock.mockResolvedValue(new Response('not JSON'));
    expect(await new SessionRouter(config(), BOT).route(message())).toBeNull();
  });

  it('encodes the caller-resolved group ID without silently changing its scope', async () => {
    server();
    await getGroupMembers({ ...config(), groupNo: 'group/with space____topic' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://octo.example/api/v1/bot/groups/group%2Fwith%20space____topic/members');
  });
});
