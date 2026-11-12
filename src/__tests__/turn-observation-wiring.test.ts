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
import { AgentFailure, TurnFailure } from '../agent-failure.js';
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
      expect(receipt.route).toBe('dm');
      expect(receipt.delivery).toEqual({ attempted: 1, acked: 1, failed: 0, outcome: 'acked', errorReply: 'unattempted' });
      expect(receipt.settlementMs).toEqual(expect.any(Number));
      expect(JSON.stringify(receipt)).not.toContain('CANARY');
      expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toBe('FINAL_CANARY');
      expect(store.buildHistoryPrefix('SESSION_CANARY', 40)).toContain('FINAL_CANARY');
      expect(log.mock.calls.filter(args => args[0] === '[codex-channel-octo] turn boundary')).toHaveLength(1);
      expect(coordinator.settle).toHaveBeenCalledTimes(available ? 1 : 0);
    } finally { store.close(); }
  });

  it('settles cardTurn immediately on error, then drains cardTurn and awaits error sendMessage before emitting turn boundary receipt', async () => {
    vi.mocked(sendTyping).mockResolvedValue(undefined);
    vi.mocked(sendReadReceipt).mockResolvedValue(undefined);
    vi.mocked(getChannelMessages).mockResolvedValue([]);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>(resolve => { releaseDrain = resolve; });
    const events: string[] = [];
    vi.mocked(sendMessage).mockImplementation(async () => {
      events.push('error_reply_send_start');
      await sendGate;
      events.push('error_reply_send_done');
      return { message_id: '123', message_seq: 1, client_msg_no: 'safe' };
    });
    const config = { botToken: 'CREDENTIAL_CANARY', apiUrl: 'https://example.test', baseDir: tmpdir(), cwd: tmpdir(),
      dataDir: tmpdir(), sdk: { toolProgress: true },
      cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 524_288, dispatchTimeoutMs: 300_000, botBlocklist: [] } as Config;
    const adapter = createAdapter(':memory:');
    const store = new SessionStore(adapter); store.init();
    const router = new SessionRouter(config, 'bot');
    const group = new GroupContext(adapter, 6000);
    const receipts: TurnBoundaryReceipt[] = [];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[codex-channel-octo] turn boundary') {
        events.push('turn_boundary');
        receipts.push(JSON.parse(String(args[1])) as TurnBoundaryReceipt);
      }
    });
    let settledAtTurnFailed = false;
    let boundaryCountAtTurnFailed = 0;
    const coordinator = {
      observe: vi.fn(),
      signal: vi.fn(),
      settle: vi.fn(() => { if (!events.includes('card_settle')) events.push('card_settle'); }),
      drain: vi.fn(async () => {
        events.push('card_drain_start');
        await drainGate;
        events.push('card_drain_done');
        return true;
      }),
      claimsNotices: () => false,
      inspect: () => ({
        mode: 'undecided',
        opened: false,
        settled: true,
        policy: 'unattempted',
        firstReservation: { state: 'unattempted', atMs: null, reason: 'no_displayable_row' },
        card: { initial: 'unattempted', terminal: 'unattempted' },
      }),
    } as unknown as AutomaticTurn;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[codex-channel-octo] turn failed') {
        events.push('turn_failed');
        settledAtTurnFailed = vi.mocked(coordinator.settle).mock.calls.length === 1;
        boundaryCountAtTurnFailed = infoSpy.mock.calls.filter(c => c[0] === '[codex-channel-octo] turn boundary').length;
      }
    });
    const runtime = { beginTurn: vi.fn(() => ({ coordinator })) } as unknown as CardRuntime;
    const snap = { stage: 'inference' as const, category: 'unknown' as const, source: 'sdk_event' as const, evidence: 'unknown' as const };
    vi.mocked(queryAgentEvents).mockImplementation(async function* () {
      yield { kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null };
      throw new TurnFailure({
        diagnosticId: '00000000-0000-4000-8000-000000000001',
        attempts: 1,
        decision: 'blocked_uncertain',
        recoveryStopReason: 'disabled',
        executionRisk: 'unknown',
        first: snap,
        final: snap,
      });
    });
    try {
      const pending = handleMessage({ message_id: 'm-err', message_seq: 1, timestamp: 1, from_uid: 'u1', channel_id: 'u1',
        channel_type: 1, payload: { type: 1, content: 'fail turn' } }, config, store, router, group,
      new StreamRelay(), 'bot', () => '', runtime);
      await vi.waitFor(() => expect(events).toContain('error_reply_send_start'));
      expect(settledAtTurnFailed).toBe(true);
      expect(boundaryCountAtTurnFailed).toBe(0);
      expect(events).toEqual(['card_settle', 'turn_failed', 'error_reply_send_start']);
      releaseSend();
      await vi.waitFor(() => expect(events).toContain('card_drain_start'));
      expect(events).not.toContain('turn_boundary');
      releaseDrain();
      await pending;
      expect(events).toEqual([
        'card_settle',
        'turn_failed',
        'error_reply_send_start',
        'error_reply_send_done',
        'card_drain_start',
        'card_drain_done',
        'turn_boundary',
      ]);
      expect(coordinator.settle).toHaveBeenCalled();
      expect(receipts).toHaveLength(1);
      expect(receipts[0].delivery).toEqual({
        attempted: 0,
        acked: 0,
        failed: 0,
        outcome: 'unattempted',
        errorReply: 'acked',
      });
    } finally {
      releaseSend();
      releaseDrain();
      store.close();
    }
  });

  it('preserves app-server toolsetDigest through sessionOpts.onSessionId and mid-stream continuation', async () => {
    vi.mocked(sendTyping).mockResolvedValue(undefined);
    vi.mocked(sendReadReceipt).mockResolvedValue(undefined);
    vi.mocked(getChannelMessages).mockResolvedValue([]);
    vi.mocked(sendMessage).mockResolvedValue({ message_id: '123', message_seq: 1, client_msg_no: 'safe' });
    const config = { botToken: 'CREDENTIAL_CANARY', apiUrl: 'https://example.test', baseDir: tmpdir(), cwd: tmpdir(),
      dataDir: tmpdir(), sdk: { runtime: 'app-server', toolProgress: true },
      cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 524_288, dispatchTimeoutMs: 300_000, botBlocklist: [] } as Config;
    const adapter = createAdapter(':memory:');
    const store = new SessionStore(adapter); store.init();
    const router = new SessionRouter(config, 'bot');
    const group = new GroupContext(adapter, 6000);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seenOpts: QueryAgentOptions[] = [];
    vi.mocked(queryAgentEvents).mockImplementation(async function* (_prompt, _config, _ctx, _legacy, opts) {
      seenOpts.push({ ...opts });
      if (seenOpts.length === 1) {
        opts?.onSessionId?.('thr-app-1', 'prompt-1', 'v1:toolset-digest');
        yield { kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null };
        throw new AgentFailure({ stage: 'inference', category: 'stream_interrupted', source: 'local', evidence: 'recognized_text' });
      }
      yield { kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null };
      yield { kind: 'message', attempt: 0, itemId: 'm2', seq: 0, text: 'RESUMED_OK', phase: 'final_answer' };
      yield { kind: 'attempt_end', attempt: 0, terminal: 'completed' };
    });
    try {
      await handleMessage({ message_id: 'm-cont', message_seq: 1, timestamp: 1, from_uid: 'u-app', channel_id: 'u-app',
        channel_type: 1, payload: { type: 1, content: 'start app-server turn' } }, config, store, router, group,
      new StreamRelay(), 'bot', () => '');
      expect(store.getSdkSessionId('u-app')).toBe('thr-app-1');
      expect(store.getThreadToolsetDigest('u-app')).toBe('v1:toolset-digest');
      expect(seenOpts).toHaveLength(2);
      expect(seenOpts[1].resume).toBe('thr-app-1');
      expect(seenOpts[1].threadToolsetDigest).toBe('v1:toolset-digest');
    } finally { store.close(); }
  });
});
