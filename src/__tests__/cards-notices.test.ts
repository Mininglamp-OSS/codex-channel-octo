/**
 * End-to-end smoke tests — simulate the complete message pipeline
 * without real WS connections or Claude API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (hoisted before imports) ---

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getGroupMembers: vi.fn().mockResolvedValue([]),
  getMentionPreference: vi.fn().mockResolvedValue(false),
  // G4 backfill path in the real handleMessage — default to no history.
  getChannelMessages: vi.fn().mockResolvedValue([]),
  getUploadCredentials: vi.fn().mockResolvedValue({
    bucket: 'b', region: 'r', key: 'k',
    credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
    startTime: 1, expiredTime: 2,
  }),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  registerBot: vi.fn().mockResolvedValue({
    robot_id: 'bot-001',
    im_token: 'token',
    ws_url: 'ws://localhost',
    api_url: 'https://test.example.com',
    owner_uid: 'owner',
    owner_channel_id: 'ch-owner',
  }),
  generateClientMsgNo: vi.fn().mockReturnValue('client-msg-001'),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('../agent-bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent-bridge.js')>();
  const queryAgent = vi.fn();
  // index.ts consumes typed events; replay each string the queryAgent mock
  // yields as one unclassified message of a single completed attempt. A plain
  // function (not vi.fn) so clearAllMocks never drops the pass-through.
  async function* queryAgentEvents(...args: Parameters<typeof original.queryAgentEvents>) {
    yield { kind: 'attempt_start' as const, attempt: 0, reason: 'initial' as const, continues: null };
    let seq = 0;
    for await (const text of (queryAgent as (...a: unknown[]) => AsyncIterable<string>)(...args)) {
      yield { kind: 'message' as const, attempt: 0, itemId: `item_${seq}`, seq, text, phase: 'unknown' as const };
      seq++;
    }
    yield { kind: 'attempt_end' as const, attempt: 0, terminal: 'completed' as const };
  }
  return {
    ...original,
    buildSystemPrompt: original.buildSystemPrompt,
    sanitizeForSystemPrompt: original.sanitizeForSystemPrompt,
    queryAgent,
    queryAgentEvents,
  };
});

// Mock the inbound-image downloader so the suite never does a real network
// fetch (the #86 download path). Without this, G1 (a non-text DM with an image
// URL) intermittently fails as `downloadInboundImage` tries a live HTTP request
// and times out / errors. Preserve the real constants (e.g.
// MAX_IMAGES_PER_MESSAGE, used by index.ts) via importOriginal; stub only the
// network call to a deterministic error so the caller falls back to the URL
// marker (`[图片] <url>`) — exactly the behavior G1 asserts.
vi.mock('../media-inbound.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../media-inbound.js')>();
  return {
    ...original,
    downloadInboundImage: vi.fn().mockResolvedValue({ error: 'mocked: no network in tests' }),
  };
});

// --- Imports (after mocks) ---

import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { createAdapter } from '../db-adapter.js';
import { queryAgent } from '../agent-bridge.js';
import { handleMessage } from '../index.js';
import {
  sendMessage,
  getMentionPreference,
  getGroupMembers,
} from '../octo/api.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';

// --- Constants ---

const BOT_ID = 'bot-001';
const USER_UID = 'user-001';
const GROUP_CHANNEL = 'group-ch-001';

// --- Helpers ---

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    baseDir: '/tmp/test-project',
    cwd: '/tmp/test-project',
    dataDir: '/tmp/data',
    sdk: {
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      modelReasoningEffort: 'medium',
    },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524_288,
    dispatchTimeoutMs: 300_000,
    botBlocklist: [],
    ...overrides,
  } as Config;
}

function makeDmMsg(content: string, overrides?: Partial<BotMessage>): BotMessage {
  return {
    message_id: `msg-${Date.now()}`,
    message_seq: 1,
    from_uid: USER_UID,
    from_name: 'TestUser',
    channel_id: USER_UID,
    channel_type: ChannelType.DM,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content },
    ...overrides,
  };
}

function makeGroupMsg(
  content: string,
  mentionBot = false,
  overrides?: Partial<BotMessage>,
): BotMessage {
  return {
    message_id: `msg-${Date.now()}`,
    message_seq: 1,
    from_uid: USER_UID,
    from_name: 'TestUser',
    channel_id: GROUP_CHANNEL,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content,
      mention: mentionBot ? { uids: [BOT_ID] } : undefined,
    },
    ...overrides,
  };
}

function mockQueryYield(...texts: string[]): void {
  // Mirror the real SDK: report a session id (so cc stores it and resumes on the
  // next turn) before yielding text. A stable id per mock install is fine for
  // these single-session tests.
  (queryAgent as ReturnType<typeof vi.fn>).mockImplementation(
    async function* (
      _u: string, _cfg: unknown, _ctx: unknown, _t: unknown,
      opts?: { onSessionId?: (id: string) => void },
    ) {
      opts?.onSessionId?.('sdk-session-mock');
      for (const t of texts) {
        yield t;
      }
    },
  );
}

/**
 * Drive the REAL pipeline. Previously this test reimplemented handleMessage as
 * a hand-copied replica, which drifted from index.ts (e.g. it never threaded the
 * PR#51 per-session cwd `sessionCtx` into queryAgent). We now import the real
 * exported handleMessage so the e2e tests fail if the production pipeline
 * changes. The wrapper only fills in the fixed BOT_ID so the 25 call sites stay
 * unchanged.
 */
async function simulateMessage(
  msg: BotMessage,
  config: Config,
  store: SessionStore,
  router: SessionRouter,
  groupContext: GroupContext,
  streamRelay: StreamRelay,
): Promise<void> {
  await handleMessage(msg, config, store, router, groupContext, streamRelay, BOT_ID);
}

import { reduceItem } from '../cards/redact.js';
import corpus from '../cards/__fixtures__/privacy-corpus.v1.json' with { type: 'json' };

describe('WP-05 / PN-01–09 notice sink', () => {
  let store: SessionStore, router: SessionRouter, group: GroupContext, relay: StreamRelay, config: Config;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendMessage).mockResolvedValue({ message_id: '123', client_msg_no: 'client-msg-001', message_seq: 1 });
    config=makeConfig({sdk:{toolProgress:true}});
    const adapter=createAdapter(':memory:');
    store=new SessionStore(adapter); store.init();
    router=new SessionRouter(config,BOT_ID); group=new GroupContext(adapter,6000); relay=new StreamRelay();
    mockQueryYield('final exact text');
  });
  afterEach(() => {store.close();});
  function drive(items: unknown[]) {
    vi.mocked(queryAgent).mockImplementation(async function* (_u,_cfg,_ctx,_legacy,_opts,onSafeItem) {
      expect(_legacy).toBeUndefined();
      for (const item of items) onSafeItem?.(reduceItem(item));
      yield 'final exact text';
    });
  }
  async function run(msg=makeDmMsg('work')) {
    await simulateMessage(msg,config,store,router,group,relay);
    const all=vi.mocked(sendMessage).mock.calls.map(c=>c[0]);
    return {all,notices:all.filter(c=>c.content.startsWith('🔧 ')).map(c=>c.content)};
  }
  it('A1 exact six labels, A2 consecutive collapse and preserved final/history',async () => {
    drive([{type:'command_execution',command:'git private'}, {type:'command_execution',command:'node other'},
      {type:'file_change',changes:[{path:'/synthetic/private'}]}, {type:'mcp_tool_call',server:'private',tool:'private'},
      {type:'web_search',query:'private'}, {type:'reasoning',text:'private'}, {type:'todo_list',items:[]}]);
    const {notices,all}=await run();
    expect(notices).toEqual(['🔧 Running command…','🔧 Editing files…','🔧 Tool…','🔧 Searching…','🔧 Thinking…','🔧 Planning…']);
    expect(all.at(-1)?.content).toBe('final exact text');
    expect(store.buildHistoryPrefix(USER_UID,40)).toContain('final exact text');
    expect(store.buildHistoryPrefix(USER_UID,40)).not.toContain('🔧 ');
  });
  it('PN-08 A,A,B,A is A,B,A and no global dedup',async () => {
    const a={type:'command_execution',command:'git'};drive([a,a,{type:'file_change',changes:[]},a]);
    expect((await run()).notices).toEqual(['🔧 Running command…','🔧 Editing files…','🔧 Running command…']);
  });
  it('PN-08 ten attempts across a continuous run; failed sends consume count and contain no raw error',async () => {
    const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error(corpus.canary));
    drive(Array.from({length:14},(_,i)=>({type:i%2?'web_search':'command_execution',command:'git',query:corpus.canary})));
    const {notices,all}=await run();
    expect(notices).toHaveLength(10); expect(all.at(-1)?.content).toBe('final exact text');
    expect(JSON.stringify(error.mock.calls).includes(corpus.canary)).toBe(false);
    expect(error).toHaveBeenCalledWith('[codex-channel-octo] tool-progress send failed');
    error.mockRestore();
  });
  it('PN-09 off leaves safe sink absent and emits zero automatic notices',async () => {
    config=makeConfig();
    vi.mocked(queryAgent).mockImplementation(async function* (_u,_cfg,_ctx,_legacy,_opts,onSafeItem) {
      expect(onSafeItem).toBeUndefined(); yield 'final exact text';
    });
    expect((await run()).notices).toEqual([]);
  });
  for (const route of ['dm','group','topic'] as const) it('corpus zero canaries at notice sink, exact '+route+' route',async () => {
    drive(corpus.cases.map(c=>c.item));
    let msg=makeDmMsg('work');
    if(route!=='dm') {
      vi.mocked(getGroupMembers).mockResolvedValueOnce([{uid:USER_UID,name:'TestUser',role:0,robot:0}]);
      vi.mocked(getMentionPreference).mockResolvedValueOnce(false);
      msg=makeGroupMsg('work',true,route==='topic'?{channel_id:GROUP_CHANNEL+'____topic',channel_type:ChannelType.CommunityTopic}:{});
    }
    const {all,notices}=await run(msg);expect(notices.length).toBeGreaterThan(0);
    for(const call of all){
      expect(call.channelId).toBe(msg.channel_id);expect(call.channelType).toBe(msg.channel_type);
      for(const c of corpus.cases)for(const marker of c.forbidden) expect(call.content.includes(marker)).toBe(false);
    }
    expect(all.at(-1)?.content).toBe('final exact text');
  });
});
