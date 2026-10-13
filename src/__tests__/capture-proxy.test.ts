import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
// Test-only capture code is deliberately outside the release source tree.
// @ts-expect-error JavaScript helper has runtime-checked interfaces.
import { startCapture, sanitize } from '../../scripts/capture_proxy.mjs';
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });
async function fixture() {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    if (req.url === '/v1/bot/sendMessage') {
      const mode = req.headers['x-fixture'];
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      res.writeHead(mode === 'failed' ? 403 : 200);
      res.end(mode === 'failed' ? 'Bearer fixture-secret' : '{"message_id":9000000000000001}');
    } else { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('captures every attempt before forwarding and records failed/unknown outcomes independently', async () => {
  const records: Record<string, unknown>[] = [];
  const upstream = await fixture();
  const capture = await startCapture({ upstream, token: 'fixture-secret', fixtureOnly: true,
    allowedTargets: [{ channelId: 'target', channelType: 2 }], record: (r: Record<string, unknown>) => records.push(r) });
  servers.push(capture.server);
  for (const mode of ['ok', 'failed', 'disconnect']) {
    await fetch(capture.url + '/v1/bot/sendMessage', { method: 'POST', headers: {
      Authorization: 'Bearer fixture-secret', 'content-type': 'application/json', 'x-fixture': mode,
    }, body: JSON.stringify({ channel_id: 'target', channel_type: 2, payload: { content: 'Bearer fixture-secret' }, client_msg_no: 'fixture' }) });
  }
  expect(records.filter(r => r.event === 'attempt').map(r => r.requestOrdinal)).toEqual([1, 2, 3]);
  expect(records.filter(r => r.event === 'outcome').map(r => r.transportOutcome)).toEqual(['confirmed', 'failed', 'unknown']);
  expect(records.find(r => r.responseMessageId)?.responseMessageId).toBe('9000000000000001');
  expect(JSON.stringify(records)).not.toContain('fixture-secret');
  if (process.env.ENV02_EVIDENCE_DIR) writeFileSync(`${process.env.ENV02_EVIDENCE_DIR}/capture-fixture.json`, JSON.stringify(records, null, 2));
});
it('captures independent WS frames without persisting CONNECT credentials', async () => {
  const remote = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => remote.once('listening', r));
  remote.on('connection', ws => ws.on('message', data => ws.send(data)));
  const registration = createServer((_req, res) => res.end(JSON.stringify({ robot_id: 'bot-a', im_token: 'fixture-im-token',
    ws_url: `ws://127.0.0.1:${(remote.address() as { port: number }).port}`, owner_uid: 'owner', owner_channel_id: 'dm' })));
  servers.push(registration);
  await new Promise<void>(r => registration.listen(0, '127.0.0.1', r));
  const records: Record<string, unknown>[] = [];
  const capture = await startCapture({ upstream: `http://127.0.0.1:${(registration.address() as { port: number }).port}`,
    token: 'fixture-secret', fixtureOnly: true, allowedTargets: [{ channelId: 'target', channelType: 2 }],
    record: (r: Record<string, unknown>) => records.push(r) });
  try {
    const reg = await (await fetch(capture.url + '/v1/bot/register', { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' }, body: '{}' })).json();
    const socket = new WebSocket(reg.ws_url);
    await new Promise<void>(r => socket.once('open', r));
    const received = new Promise(r => socket.once('message', r));
    socket.send(Buffer.from('fixture-im-token'));
    await received;
    socket.terminate();
    expect(records.filter(r => r.event === 'ws-frame').map(r => r.direction)).toEqual(['outbound', 'inbound']);
    expect(JSON.stringify(records)).not.toContain('fixture-im-token');
  } finally { await capture.close(); await new Promise<void>(r => remote.close(() => r())); }
});
it('redacts known secrets and credential patterns recursively', () => {
  expect(JSON.stringify(sanitize({ Authorization: 'Bearer abc', content: 'bf_secret sk-secret fixture-secret', nested: { token: 'abc' } }, ['fixture-secret']))).not.toMatch(/abc|bf_secret|sk-secret|fixture-secret/);
});
it('refuses unauthorized targets and generic proxy routes without upstream calls', async () => {
  const records: Record<string, unknown>[] = [];
  const capture = await startCapture({ upstream: await fixture(), token: 'fixture-secret', fixtureOnly: true,
    allowedTargets: [{ channelId: 'target', channelType: 2 }], record: (r: Record<string, unknown>) => records.push(r) });
  servers.push(capture.server);
  const denied = await fetch(capture.url + '/private/admin', { headers: { Authorization: 'Bearer fixture-secret' } });
  expect(denied.status).toBe(404);
  const target = await fetch(capture.url + '/v1/bot/sendMessage', { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' },
    body: JSON.stringify({ channel_id: 'production', channel_type: 2 }) });
  expect(target.status).toBe(403);
});

it.each([
  ['send numeric', '/v1/bot/sendMessage', '{"message_id":123}', 'confirmed', '123'],
  ['send string', '/v1/bot/sendMessage', '{"message_id":"123"}', 'confirmed', '123'],
  ['send raw int64', '/v1/bot/sendMessage', '{"message_id":9223372036854775807}', 'confirmed', '9223372036854775807'],
  ['send string int64', '/v1/bot/sendMessage', '{"message_id":"9223372036854775807"}', 'confirmed', '9223372036854775807'],
  ['send empty ID', '/v1/bot/sendMessage', '{"message_id":""}', 'unknown', undefined],
  ['send whitespace ID', '/v1/bot/sendMessage', '{"message_id":" "}', 'unknown', undefined],
  ['send invalid ID', '/v1/bot/sendMessage', '{"message_id":"invalid"}', 'unknown', undefined],
  ['send null ID', '/v1/bot/sendMessage', '{"message_id":null}', 'unknown', undefined],
  ['send object ID', '/v1/bot/sendMessage', '{"message_id":{}}', 'unknown', undefined],
  ['send negative ID', '/v1/bot/sendMessage', '{"message_id":-1}', 'unknown', undefined],
  ['send fractional ID', '/v1/bot/sendMessage', '{"message_id":1.5}', 'unknown', undefined],
  ['send oversized ID', '/v1/bot/sendMessage', '{"message_id":"9223372036854775808"}', 'unknown', undefined],
  ['send malformed', '/v1/bot/sendMessage', 'not-json', 'unknown', undefined],
  ['edit malformed', '/v1/bot/message/edit', 'not-json', 'unknown', undefined],
  ['edit empty body', '/v1/bot/message/edit', '', 'unknown', undefined],
  ['edit unverified object', '/v1/bot/message/edit', '{}', 'unknown', undefined],
  ['edit null response', '/v1/bot/message/edit', 'null', 'unknown', undefined],
  ['edit empty ID', '/v1/bot/message/edit', '{"message_id":""}', 'unknown', undefined],
  ['edit mismatched ID', '/v1/bot/message/edit', '{"message_id":"124"}', 'unknown', undefined],
  ['edit matching numeric ID', '/v1/bot/message/edit', '{"message_id":123}', 'confirmed', '123'],
  ['edit matching string ID', '/v1/bot/message/edit', '{"message_id":"123"}', 'confirmed', '123'],
])('validates the response for %s', async (_name, route, response, expected, id) => {
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    res.end(response);
  });
  servers.push(upstream);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const records: Record<string, unknown>[] = [];
  const capture = await startCapture({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    token: 'fixture-secret', fixtureOnly: true, allowedTargets: [{ channelId: 'target', channelType: 2 }],
    record: (r: Record<string, unknown>) => records.push(r) });
  try {
    await fetch(capture.url + route, { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' },
      body: JSON.stringify({ channel_id: 'target', channel_type: 2, message_id: '123', payload: { content: 'fixture' } }) });
    const outcome = records.find(r => r.event === 'outcome');
    expect(outcome?.transportOutcome).toBe(expected);
    expect(outcome?.responseMessageId).toBe(id);
  } finally { await capture.close(); }
});

it('redacts returned and rotated credentials from REST metadata, markers and WS records', async () => {
  const secrets = ['opaqueOldCredential', 'opaqueNewCredential', 'opaqueRefreshCredential'];
  const remote = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => remote.once('listening', resolve));
  remote.on('connection', ws => ws.on('message', data => ws.send(data)));
  let registrations = 0;
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    if (req.url === '/v1/bot/register') {
      const imToken = secrets[registrations++ % 2];
      res.end(JSON.stringify({ robot_id: 'bot-a', im_token: imToken,
        credentials: { refresh_token: secrets[2] }, owner_uid: imToken, owner_channel_id: 'dm',
        ws_url: `ws://127.0.0.1:${(remote.address() as { port: number }).port}` }));
    } else res.end('{"message_id":123}');
  });
  servers.push(upstream);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const records: Record<string, unknown>[] = [];
  const capture = await startCapture({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    token: 'fixture-secret', fixtureOnly: true, allowedTargets: [{ channelId: 'target', channelType: 2 }],
    record: (r: Record<string, unknown>) => records.push(r) });
  let socket: WebSocket | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const registration = await (await fetch(capture.url + '/v1/bot/register', { method: 'POST',
        headers: { Authorization: 'Bearer fixture-secret' }, body: '{}' })).json();
      expect(registration.im_token).toBe(secrets[i]); // Credentials are forwarded, never retained in evidence.
      socket = new WebSocket(registration.ws_url);
      await new Promise<void>(resolve => socket!.once('open', resolve));
      const echoed = new Promise(resolve => socket!.once('message', resolve));
      socket.send(Buffer.from(secrets.join('/')));
      await echoed;
      socket.terminate();
    }
    for (const secret of secrets) await fetch(capture.url + '/v1/bot/sendMessage', { method: 'POST',
      headers: { Authorization: 'Bearer fixture-secret' }, body: JSON.stringify({ channel_id: 'target', channel_type: 2,
        client_msg_no: `prefix-${secret}-suffix`, payload: { content: `[DLY f=${secret} s=000001/000001]` } }) });
    expect(records.filter(r => r.event === 'ws-frame')).toHaveLength(4);
    expect(records.filter(r => r.event === 'request')).toHaveLength(3);
    for (const secret of secrets) expect(JSON.stringify(records)).not.toContain(secret);
    expect(records.filter(r => r.event === 'request').every(r => String(r.clientMsgNo).includes('[REDACTED]'))).toBe(true);
    if (process.env.ENV02_EVIDENCE_DIR) writeFileSync(`${process.env.ENV02_EVIDENCE_DIR}/rotated-credentials-fixture.json`, JSON.stringify(records, null, 2));
  } finally { socket?.terminate(); await capture.close(); await new Promise<void>(resolve => remote.close(() => resolve())); }
});
