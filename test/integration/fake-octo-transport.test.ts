/**
 * Fake-server integration (R8 §10.1 layer 2): the production OctoGateway,
 * WKSocket and REST helpers run unmodified against the scripted fake Octo WS +
 * REST servers over loopback. Nothing in src is mocked here.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { OctoGateway } from '../../src/gateway.js';
import {
  sendMessage,
  sendTyping,
  sendHeartbeat,
  sendReadReceipt,
  fetchUserInfo,
  getGroupMembers,
  getMentionPreference,
  getGroupMd,
  getThreadMd,
  getChannelMessages,
  getUploadCredentials,
} from '../../src/octo/api.js';
import type { BotMessage } from '../../src/octo/types.js';
import type { Config } from '../../src/config.js';
import { FakeOctoWsServer } from '../harness/fake-octo/ws-server.js';
import { FakeOctoRest } from '../harness/fake-octo/rest-server.js';
import { ScriptedFaultPlan } from '../harness/scripted-fault-plan.js';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

let ws: FakeOctoWsServer | undefined;
let rest: FakeOctoRest | undefined;
let gateway: OctoGateway | undefined;
let dataDir = '';

function gatewayConfig(apiUrl: string): Config {
  return { apiUrl, botToken: 'bf_test_token_dev01', dataDir } as unknown as Config;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dev01-fake-octo-'));
});

afterEach(async () => {
  await gateway?.stop().catch(() => undefined);
  gateway = undefined;
  await ws?.close();
  await rest?.close();
  ws = undefined;
  rest = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function startStack(opts: { faults?: ScriptedFaultPlan; salt?: string } = {}) {
  ws = await FakeOctoWsServer.start({ faults: opts.faults, salt: opts.salt });
  rest = await FakeOctoRest.start({
    faults: opts.faults,
    register: { robot_id: 'u_bot_dev01', im_token: 'im_token_dev01', ws_url: ws.url, owner_uid: 'u_owner', owner_channel_id: 'u_owner' },
  });
  const received: BotMessage[] = [];
  gateway = new OctoGateway(gatewayConfig(rest.url), { handleSignals: false });
  gateway.setMessageHandler((m) => received.push(m));
  await gateway.register();
  gateway.connect();
  return { received };
}

describe('fake Octo WS: production WKSocket handshake and delivery', () => {
  it('FO-01: register + CONNECT carry the pinned protocol fields and the bot identity', async () => {
    await startStack();
    const connect = await ws!.waitFor((e) => e.dir === 'in' && e.type === 'CONNECT');
    const reg = rest!.requests.find((r) => r.path === '/v1/bot/register');
    expect(reg?.method).toBe('POST');
    expect(reg?.authorization).toBe('Bearer bf_test_token_dev01');
    expect(reg?.body).toEqual({ agent_platform: 'codex-channel-octo', agent_version: pkg.version });
    expect(connect.parsed).toMatchObject({ version: 4, deviceFlag: 0, uid: 'u_bot_dev01', token: 'im_token_dev01' });
    const parsed = connect.parsed as { deviceID: string; clientKey: string };
    expect(parsed.deviceID).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}W$/);
    expect(Buffer.from(parsed.clientKey, 'base64')).toHaveLength(32);
    await ws!.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
  });

  it('FO-02: RECV is decrypted, delivered with full int64 precision, and ACKed only after a successful parse', async () => {
    const { received } = await startStack();
    await ws!.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    const sent = await ws!.sendRecv({
      messageId: '9007199254740993123',
      messageSeq: 42,
      fromUid: 'u_alice',
      channelId: 'u_alice',
      channelType: 1,
      payload: { type: 1, content: '你好 😀 dev01' },
    });
    const ack = await ws!.waitFor((e) => e.dir === 'in' && e.type === 'RECVACK');
    expect(ack.parsed).toEqual({ messageId: '9007199254740993123', messageSeq: 42 });
    expect(ack.seq).toBeGreaterThan(sent.eventSeq);
    await waitUntil(() => received.length === 1);
    expect(received[0]).toMatchObject({
      message_id: '9007199254740993123',
      message_seq: 42,
      from_uid: 'u_alice',
      channel_id: 'u_alice',
      channel_type: 1,
      payload: { type: 1, content: '你好 😀 dev01' },
    });
  });

  it('FO-03: a poison payload is not ACKed until the third delivery and never reaches the handler', async () => {
    const { received } = await startStack();
    await ws!.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ws!.sendRecv({
        messageId: '777', messageSeq: 7, fromUid: 'u_alice', channelId: 'u_alice', channelType: 1,
        rawCiphertext: Buffer.from('not-base64-ciphertext!!', 'latin1'),
      });
      await sleep(80);
      const acks = ws!.events.filter((e) => e.dir === 'in' && e.type === 'RECVACK');
      expect(acks).toHaveLength(attempt === 3 ? 1 : 0);
    }
    expect(received).toHaveLength(0);
  });

  it('FO-04: a CONNACK salt shorter than 16 bytes fails the handshake (client closes, nothing delivered)', async () => {
    const { received } = await startStack({ salt: 'short-salt' });
    await ws!.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    await ws!.waitFor((e) => e.type === 'CLOSE');
    expect(received).toHaveLength(0);
  });

  it('FO-05: DISCONNECT triggers the existing kick → force_refresh re-register → reconnect path', async () => {
    await startStack();
    await ws!.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    ws!.sendDisconnect(1, 'kicked by test');
    await waitUntil(() => rest!.requests.some((r) => r.path === '/v1/bot/register' && r.query === 'force_refresh=true'), 5_000);
    await ws!.waitFor((e) => e.dir === 'in' && e.type === 'CONNECT' && e.connection === 2, 5_000);
  });

  it('FO-06: transport.dropConnack leaves the client unconnected and is recorded as a consumed fault', async () => {
    const faults = new ScriptedFaultPlan().arm({ name: 'transport.dropConnack' }, { kind: 'drop' });
    const { received } = await startStack({ faults });
    await ws!.waitFor((e) => e.dir === 'in' && e.type === 'CONNECT');
    await sleep(150);
    expect(ws!.events.some((e) => e.type === 'CONNACK')).toBe(false);
    expect(faults.hits.map((h) => h.key)).toContain('transport.dropConnack');
    expect(received).toHaveLength(0);
  });

  it('FO-07: api.forceStatus(register,503) fails register() and releases the per-bot lock', async () => {
    const faults = new ScriptedFaultPlan().forceStatus('register', 503, 1);
    ws = await FakeOctoWsServer.start({});
    rest = await FakeOctoRest.start({ faults, register: { robot_id: 'u_bot', im_token: 't', ws_url: ws.url, owner_uid: '', owner_channel_id: '' } });
    gateway = new OctoGateway(gatewayConfig(rest.url), { handleSignals: false });
    await expect(gateway.register()).rejects.toThrow(/\(503\)/);
    expect(existsSync(join(dataDir, 'gateway.lock'))).toBe(false);
    // the fault is single-shot: the next register succeeds and takes the lock
    await gateway.register();
    expect(existsSync(join(dataDir, 'gateway.lock'))).toBe(true);
  });
});

describe('fake Octo REST: endpoint wire inventory for existing A endpoints', () => {
  const T = 'bf_wire_token';
  beforeEach(async () => {
    rest = await FakeOctoRest.start({});
  });

  it('EP-03.send: sendMessage posts type-1 payload, mention block and a fresh client_msg_no', async () => {
    await sendMessage({ apiUrl: rest!.url, botToken: T, channelId: 'g1', channelType: 2, content: 'hi @Ada', mentionUids: ['u_ada'], mentionEntities: [{ uid: 'u_ada', offset: 3, length: 4 }], mentionAll: true, replyMsgId: '9007199254740993' });
    await sendMessage({ apiUrl: rest!.url, botToken: T, channelId: 'g1', channelType: 2, content: 'again' });
    const [a, b] = rest!.requests.filter((r) => r.path === '/v1/bot/sendMessage');
    expect(a.method).toBe('POST');
    expect(a.authorization).toBe(`Bearer ${T}`);
    expect(a.body).toMatchObject({
      channel_id: 'g1', channel_type: 2,
      payload: { type: 1, content: 'hi @Ada', mention: { uids: ['u_ada'], entities: [{ uid: 'u_ada', offset: 3, length: 4 }], all: 1 }, reply: { message_id: '9007199254740993' } },
    });
    expect((a.body as { client_msg_no: string }).client_msg_no).toMatch(/^[0-9a-f-]{36}$/);
    expect((a.body as { client_msg_no: string }).client_msg_no).not.toBe((b.body as { client_msg_no: string }).client_msg_no);
  });

  it('EP-02/EP-09/EP-10: heartbeat, typing and read receipt wire shapes', async () => {
    await sendHeartbeat({ apiUrl: rest!.url, botToken: T });
    await sendTyping({ apiUrl: rest!.url, botToken: T, channelId: 'u_a', channelType: 1 });
    await sendReadReceipt({ apiUrl: rest!.url, botToken: T, channelId: 'u_a', channelType: 1, messageIds: ['5', ' '] });
    expect(rest!.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/v1/bot/heartbeat', {}],
      ['POST', '/v1/bot/typing', { channel_id: 'u_a', channel_type: 1 }],
      ['POST', '/v1/bot/readReceipt', { channel_id: 'u_a', channel_type: 1, message_ids: ['5'] }],
    ]);
  });

  it('EP-19.get: user/info encodes the uid, maps 200 and returns null on 404', async () => {
    rest!.setRoute('GET', '/v1/bot/user/info', (req) =>
      req.query === 'uid=u%2Fslash%20x' ? { status: 200, body: { uid: 'u/slash x', name: 'Slash' } } : { status: 404, body: {} });
    await expect(fetchUserInfo({ apiUrl: rest!.url, botToken: T, uid: 'u/slash x' })).resolves.toEqual({ uid: 'u/slash x', name: 'Slash', avatar: undefined });
    await expect(fetchUserInfo({ apiUrl: rest!.url, botToken: T, uid: 'missing' })).resolves.toBeNull();
    expect(rest!.requests.map((r) => `${r.method} ${r.path}?${r.query}`)).toEqual([
      'GET /v1/bot/user/info?uid=u%2Fslash%20x',
      'GET /v1/bot/user/info?uid=missing',
    ]);
  });

  it('EP-13.get / EP-14.get / EP-15.get / EP-16.get: group reads encode path segments', async () => {
    rest!.setRoute('GET', '/v1/bot/groups/g%2F1____t%201/members', () => ({ status: 200, body: { members: [{ uid: 'u1', name: 'One', role: 1, robot: 0 }] } }));
    rest!.setRoute('GET', '/v1/bot/groups/g%2F1/mention_pref', () => ({ status: 200, body: { effective: 1 } }));
    rest!.setRoute('GET', '/v1/bot/groups/g%2F1/md', () => ({ status: 200, body: { content: '# G', version: 3 } }));
    rest!.setRoute('GET', '/v1/bot/groups/g%2F1/threads/s%2F2/md', () => ({ status: 200, body: { content: '# T', version: 0 } }));
    await expect(getGroupMembers({ apiUrl: rest!.url, botToken: T, groupNo: 'g/1____t 1' })).resolves.toEqual([{ uid: 'u1', name: 'One', role: 1, robot: 0 }]);
    await expect(getMentionPreference({ apiUrl: rest!.url, botToken: T, groupNo: 'g/1' })).resolves.toBe(true);
    await expect(getGroupMd({ apiUrl: rest!.url, botToken: T, groupNo: 'g/1' })).resolves.toEqual({ content: '# G', version: 3 });
    await expect(getThreadMd({ apiUrl: rest!.url, botToken: T, groupNo: 'g/1', shortId: 's/2' })).resolves.toEqual({ content: '# T', version: 0 });
    expect(rest!.requests.every((r) => r.method === 'GET' && r.authorization === `Bearer ${T}`)).toBe(true);
  });

  it('EP-11.sync: messages/sync request body and base64 payload decoding', async () => {
    const payload = Buffer.from(JSON.stringify({ type: 1, content: 'from history' })).toString('base64');
    rest!.setRoute('POST', '/v1/bot/messages/sync', () => ({ status: 200, rawBody: `{"messages":[{"from_uid":"u1","message_id":12345678901234567890,"message_seq":9,"timestamp":1,"payload":"${payload}"}]}` }));
    const msgs = await getChannelMessages({ apiUrl: rest!.url, botToken: T, channelId: 'g1', channelType: 2, limit: 5 });
    expect(rest!.requests[0].body).toEqual({ channel_id: 'g1', channel_type: 2, limit: 5, start_message_seq: 0, end_message_seq: 0, pull_mode: 1 });
    expect(msgs).toEqual([expect.objectContaining({ from_uid: 'u1', message_id: '12345678901234567890', message_seq: 9, content: 'from history', type: 1 })]);
  });

  it('EP-21.get: upload/credentials encodes the filename and scrubs Bearer tokens from error text', async () => {
    rest!.setRoute('GET', '/v1/bot/upload/credentials', () => ({ status: 500, rawBody: 'echo Authorization: Bearer sekrit-token-value' }));
    const err = await getUploadCredentials({ apiUrl: rest!.url, botToken: T, filename: 'a b.png' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/\(500\).*\*\*\*/);
    expect(String(err)).not.toContain('sekrit');
    expect(rest!.requests[0].query).toBe('filename=a%20b.png');
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
