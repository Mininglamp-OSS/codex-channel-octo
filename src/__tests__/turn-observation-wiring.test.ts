/** Real handler, in-memory synthetic store, mocked model/execution/transport ports. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: '123', message_seq: 1, client_msg_no: 'safe' }),
  sendTyping: vi.fn().mockResolvedValue(undefined), sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getChannelMessages: vi.fn().mockResolvedValue([]), generateClientMsgNo: () => 'safe',
}));
vi.mock('../agent-bridge.js', async original => ({
  ...await original<typeof import('../agent-bridge.js')>(), queryAgentEvents: vi.fn(),
}));
vi.mock('../octo/socket.js', () => ({ WKSocket: vi.fn() }));

import { handleMessage } from '../index.js';
import { queryAgentEvents, type QueryAgentOptions, type TurnBoundaryReceipt } from '../agent-bridge.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { sendMessage, sendTyping, sendReadReceipt, getChannelMessages } from '../octo/api.js';
import type { Config } from '../config.js';
import type { CardRuntime } from '../cards/runtime.js';
import type { AutomaticTurn } from '../cards/lifecycle.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('handler boundary receipt wiring', () => {
  it.each(['available', 'refused', 'runtime_absent', 'disabled', 'sink_failure'] as const)('%s keeps admission factual and final separate', async condition => {
    vi.mocked(sendTyping).mockResolvedValue(undefined);
    vi.mocked(sendReadReceipt).mockResolvedValue(undefined);
    vi.mocked(getChannelMessages).mockResolvedValue([]);
    vi.mocked(sendMessage).mockResolvedValue({ message_id: '123', message_seq: 1, client_msg_no: 'safe' });
    const available = condition === 'available' || condition === 'sink_failure';
    const config = { botToken: 'CREDENTIAL_CANARY', apiUrl: 'https://example.test', baseDir: tmpdir(), cwd: tmpdir(),
      dataDir: tmpdir(), sdk: { toolProgress: condition !== 'disabled' },
      cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 524_288, dispatchTimeoutMs: 300_000, botBlocklist: [] } as Config;
    const adapter = createAdapter(':memory:');
    const store = new SessionStore(adapter); store.init();
    const router = new SessionRouter(config, 'bot');
    const group = new GroupContext(adapter, 6000);
    const log = vi.spyOn(console, 'info').mockImplementation(() => { if (condition === 'sink_failure') throw Error('SINK_CANARY'); });
    const coordinator = { observe: vi.fn(), signal: vi.fn(), settle: vi.fn(), claimsNotices: () => false,
      inspect: () => ({ mode: 'card', opened: true, settled: true }) } as unknown as AutomaticTurn;
    const runtime = { beginTurn: vi.fn(() => condition === 'refused' ? undefined : { coordinator }) } as unknown as CardRuntime;
    let seenOpts: QueryAgentOptions | undefined;
    vi.mocked(queryAgentEvents).mockImplementation(async function* (_prompt, _config, _ctx, _legacy, opts) {
      seenOpts = opts;
      opts?.onNativeCommand?.('sdk', 'completed');
      yield { kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null };
      yield { kind: 'message', attempt: 0, itemId: 'ID_CANARY', seq: 0, text: 'FINAL_CANARY', phase: 'final_answer' };
      yield { kind: 'attempt_end', attempt: 0, terminal: 'completed' };
    });
    try {
      await handleMessage({ message_id: 'm', message_seq: 1, timestamp: 1, from_uid: 'SESSION_CANARY', channel_id: 'SESSION_CANARY',
        channel_type: 1, payload: { type: 1, content: 'PROMPT_CANARY' } }, config, store, router, group,
      new StreamRelay(), 'bot', () => '', condition === 'runtime_absent' ? undefined : runtime);
      const call = log.mock.calls.find(args => args[0] === '[codex-channel-octo] turn boundary');
      expect(call).toBeDefined();
      const receipt = JSON.parse(String(call![1])) as TurnBoundaryReceipt;
      expect(seenOpts).toBeDefined();
      expect(seenOpts?.itemStates === true).toBe(available);
      expect(receipt.command.sdk.completed).toBe(1);
      expect(receipt.admission).toBe({ available: 'coordinator_available', refused: 'coordinator_unavailable',
        runtime_absent: 'runtime_unavailable', disabled: 'progress_disabled', sink_failure: 'coordinator_available' }[condition]);
      expect(receipt.itemStates).toBe(available);
      expect(receipt.firstReservation.state).toBe('unknown');
      expect(receipt.policy).toBe('unknown');
      expect(receipt.settlementMs).toEqual(expect.any(Number));
      expect(JSON.stringify(receipt)).not.toContain('CANARY');
      expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toBe('FINAL_CANARY');
      expect(store.buildHistoryPrefix('SESSION_CANARY', 40)).toContain('FINAL_CANARY');
      expect(log.mock.calls.filter(args => args[0] === '[codex-channel-octo] turn boundary')).toHaveLength(1);
      expect(coordinator.settle).toHaveBeenCalledTimes(available ? 1 : 0);
    } finally { store.close(); }
  });
});
