/** Real handler → relay → REST parser → SQLite; only model events/fetch are synthetic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../agent-bridge.js', async importOriginal => ({
  ...await importOriginal<typeof import('../agent-bridge.js')>(),
  queryAgentEvents: vi.fn(async function* () {
    yield { kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null };
    yield { kind: 'message', attempt: 0, itemId: 'answer', seq: 0, text: 'ACK_BOUNDARY_ANSWER', phase: 'unknown' };
    yield { kind: 'attempt_end', attempt: 0, terminal: 'completed' };
  }),
}));

import { handleMessage } from '../index.js';
import { queryAgentEvents } from '../agent-bridge.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';

describe('durable acknowledgement identity boundary', () => {
  let root: string;
  let adapter: DbAdapter;
  let store: SessionStore;
  let config: Config;
  let sent: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'ack-wiring-'));
    adapter = createAdapter(join(root, 'sessions.db'));
    store = new SessionStore(adapter);
    store.init();
    config = {
      botToken: 'FAKE_TEST_TOKEN', apiUrl: 'https://test.invalid',
      cwd: join(root, 'workspace'), dataDir: join(root, 'data'), sdk: {},
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
    } as Config;
    sent = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function run(rawId: string): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/bot/sendMessage')) {
        const request = JSON.parse(String(init?.body)) as { payload: { content: string } };
        sent.push(request.payload.content);
        // Test the original raw token, not a JSON.stringify-normalized fixture.
        return new Response(`{"message_id":${rawId},"client_msg_no":"server-key","message_seq":1}`);
      }
      return new Response('{}');
    }));
    const msg: BotMessage = {
      message_id: 'incoming-1', message_seq: 1, from_uid: 'human', from_name: 'Human',
      channel_id: 'human', channel_type: ChannelType.DM, timestamp: 0,
      payload: { type: MessageType.Text, content: 'test request' },
    };
    await handleMessage(msg, config, store, new SessionRouter(config, 'bot', 'owner', store),
      new GroupContext(adapter, 6000), new StreamRelay(), 'bot');
    expect(queryAgentEvents).toHaveBeenCalledTimes(1);
    expect(sent.filter(text => text === 'ACK_BOUNDARY_ANSWER')).toHaveLength(1);
  }

  it.each(['0000000000000001', '01234567890123456789'])(
    'never commits a malformed raw numeric ID %s', async rawId => {
      expect(() => JSON.parse(`{"message_id":${rawId}}`)).toThrow();
      await run(rawId);
      expect(adapter.prepare('SELECT state, message_id FROM delivery_parts').all())
        .toEqual([{ state: 'unknown', message_id: null }]);
      expect(adapter.prepare('SELECT state FROM turn_outputs').get()).toEqual({ state: 'generated' });
      expect(store.buildHistoryPrefix('human', 10)).not.toContain('ACK_BOUNDARY_ANSWER');
      const output = adapter.prepare('SELECT turn_id FROM turn_outputs').get() as { turn_id: string };
      expect(() => store.commitTurnOutput(output.turn_id)).toThrow('Delivery not confirmed');
      expect(store.getLastBotReplySeq('human')).toBeUndefined();
    },
  );

  it.each(['0', '"01"', '"0000000000000001"', '9223372036854775808', JSON.stringify('1\n'), JSON.stringify('1\r'), JSON.stringify('+1'), JSON.stringify(' 1'), JSON.stringify('1e0'), '"1'.padEnd(100, '0') + '"'])(
    'keeps noncanonical or out-of-range IDs unknown: %s', async rawId => {
      await run(rawId);
      expect(adapter.prepare('SELECT state FROM delivery_parts').get()).toEqual({ state: 'unknown' });
      expect(adapter.prepare('SELECT state FROM turn_outputs').get()).toEqual({ state: 'generated' });
      expect(store.buildHistoryPrefix('human', 10)).not.toContain('ACK_BOUNDARY_ANSWER');
      const output = adapter.prepare('SELECT turn_id FROM turn_outputs').get() as { turn_id: string };
      expect(() => store.commitTurnOutput(output.turn_id)).toThrow('Delivery not confirmed');
    },
  );

  it.each(['1', '9007199254740991', '9007199254740992', '9223372036854775807', '"9223372036854775807"'])(
    'confirms canonical IDs losslessly at numeric boundaries: %s', async rawId => {
      await run(rawId);
      expect(adapter.prepare('SELECT state, message_id FROM delivery_parts').get())
        .toEqual({ state: 'confirmed', message_id: rawId.replaceAll('"', '') });
      expect(adapter.prepare('SELECT state FROM turn_outputs').get()).toEqual({ state: 'committed' });
      expect(store.buildHistoryPrefix('human', 10).match(/ACK_BOUNDARY_ANSWER/g)).toHaveLength(1);
      expect(store.getLastBotReplySeq('human')).toBe(1);
      expect(sent).toEqual(['ACK_BOUNDARY_ANSWER']);
    },
  );
});
