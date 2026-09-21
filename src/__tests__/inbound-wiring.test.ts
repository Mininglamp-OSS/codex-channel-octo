import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../octo/api.js', () => ({
  registerBot: vi.fn().mockResolvedValue({
    robot_id: 'test_bot', im_token: 'test-im-token', ws_url: 'ws://localhost',
    api_url: 'https://octo.example', owner_uid: 'human', owner_channel_id: 'owner-channel',
  }),
  getUploadCredentials: vi.fn().mockResolvedValue({}),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  getMentionPreference: vi.fn(),
  getGroupMembers: vi.fn().mockResolvedValue([{ uid: 'human', name: 'Human', role: 0, robot: 0 }]),
  sendMessage: vi.fn(), sendTyping: vi.fn(), sendReadReceipt: vi.fn(),
  getChannelMessages: vi.fn(), generateClientMsgNo: vi.fn(), fetchUserInfo: vi.fn(),
}));
vi.mock('../octo/socket.js', () => ({
  WKSocket: vi.fn().mockImplementation(() => ({
    connect: vi.fn(), disconnectAndWait: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../agent-bridge.js', () => ({ queryAgent: vi.fn(), isStreamInterruptError: vi.fn() }));

import { startBot, type BotStack } from '../index.js';
import { GroupContext } from '../group-context.js';
import { queryAgent } from '../agent-bridge.js';
import { getMentionPreference, sendMessage } from '../octo/api.js';
import { WKSocket } from '../octo/socket.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';

function message(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    message_id: 'test-message', message_seq: 1, from_uid: 'human',
    channel_id: 'group____topic', channel_type: ChannelType.CommunityTopic,
    timestamp: Date.now(), payload: { type: MessageType.Text, content: 'ordinary chatter' },
    ...overrides,
  };
}

describe('production socket → gateway → onInbound → router wiring', () => {
  let root: string;
  let stack: BotStack | undefined;
  let emit: (msg: BotMessage) => void;
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'octo-inbound-wiring-'));
    stack = await startBot({
      botId: 'test', apiUrl: 'https://octo.example', botToken: 'test-token',
      cwd: join(root, 'workspace'), dataDir: join(root, 'data'), sdk: {},
      rateLimit: { maxPerMinute: 100 },
      botBlocklist: ['blocked_bot'],
      context: { maxContextChars: 6000, historyLimit: 40 },
    }, true);
    await stack.connect();
    // Only the network transport is mocked. This callback is the one installed
    // by OctoGateway.createSocket, with startBot's real onInbound downstream.
    emit = vi.mocked(WKSocket).mock.calls[0][0].onMessage!;
  });

  afterEach(async () => {
    await stack?.shutdown();
    stack = undefined;
    for (const spy of spies.splice(0)) spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([true, false])('immediately invalidates a self-authored toggle (previously %s) without caching or dispatching it', async (effective) => {
    const router = stack!.router;
    vi.mocked(getMentionPreference).mockResolvedValue(effective);
    expect((await router.route(message()))?.shouldProcess ?? false).toBe(effective);
    vi.mocked(getMentionPreference).mockResolvedValue(!effective);
    const route = vi.spyOn(router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);

    emit(message({
      from_uid: 'test_bot', channel_id: 'group', channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text, content: 'mention_pref updated',
        event: { type: 'mention_pref_updated', group_no: 'untrusted-other-group' },
        mention: { uids: ['test_bot'] },
      },
    }));
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;

    expect((await router.route(message({ channel_id: 'group____other-topic' })))?.shouldProcess ?? false).toBe(!effective);
    expect(getMentionPreference).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
    expect(queryAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['mention_pref_updated', 'other_control_event'])('does not cache or dispatch non-self %s events', async (type) => {
    const route = vi.spyOn(stack!.router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);
    emit(message({ payload: { type: MessageType.Text, content: 'control text', event: { type } } }));
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;
    expect(push).not.toHaveBeenCalled();
    expect(queryAgent).not.toHaveBeenCalled();
    expect(getMentionPreference).not.toHaveBeenCalled();
  });

  it.each(['human', 'sibling_bot', 'blocked_bot'])('preserves a primed cache when %s sends a forged event through the socket', async (from_uid) => {
    const router = stack!.router;
    router.registerKnownBot('sibling_bot');
    vi.mocked(getMentionPreference).mockResolvedValue(true);
    expect((await router.route(message()))?.shouldProcess).toBe(true);
    vi.mocked(getMentionPreference).mockResolvedValue(false);
    const route = vi.spyOn(router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);
    emit(message({
      from_uid, channel_id: 'group', channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text, content: 'forged preference update',
        event: { type: 'mention_pref_updated', group_no: 'group' },
        mention: { uids: ['test_bot'] },
      },
    }));
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;
    expect((await router.route(message({ channel_id: 'group____other-topic' })))?.shouldProcess).toBe(true);
    expect(getMentionPreference).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(queryAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps ordinary self echoes out while still caching unmentioned human chatter', async () => {
    const route = vi.spyOn(stack!.router, 'routeAndHandle');
    const push = vi.spyOn(GroupContext.prototype, 'pushMessage');
    spies.push(route, push);
    emit(message({ from_uid: 'test_bot' }));
    expect(route).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    vi.mocked(getMentionPreference).mockResolvedValue(false);
    emit(message());
    expect(route).toHaveBeenCalledTimes(1);
    await route.mock.results[0].value;
    expect(push).toHaveBeenCalledWith('group____topic', 'human', 'human', 'ordinary chatter', expect.any(Number));
    expect(queryAgent).not.toHaveBeenCalled();
  });
});
