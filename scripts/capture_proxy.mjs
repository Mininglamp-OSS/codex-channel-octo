/** Independent test-only Bot API capture. Never loaded by the gateway. */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { readFileSync, writeSync, fsyncSync, fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Preserve raw response message IDs before JavaScript can round an int64.
const parseOctoJson = text => JSON.parse(text.replace(/"message_id"\s*:\s*(\d{16,})/g, '"message_id":"$1"'));

export function sanitize(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[REDACTED]');
    return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:bf_|app_|sk-)[a-zA-Z0-9_-]+/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => sanitize(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /authorization|token|secret|password|api.?key/i.test(k) ? '[REDACTED]' : sanitize(v, secrets)]));
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// WuKongIM message_id is a positive signed int64, represented losslessly as decimal text.
function messageId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) return undefined;
  return value;
}

function confirmation(route, text, request) {
  let response;
  try { response = parseOctoJson(text); } catch { return {}; }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return {};
  const id = messageId(response.message_id);
  if (!id) return {};
  if (route === '/v1/bot/sendMessage') return { responseMessageId: id };
  // The pinned edit wrapper does not promise a response schema. Only an explicit,
  // matching message identity verifies an edit; an empty 2xx remains unknown.
  if (route === '/v1/bot/message/edit' && id === messageId(request.message_id)) return { responseMessageId: id };
  return { observedResponseMessageId: id };
}

const registrationPublicFields = new Set(['robot_id', 'ws_url', 'api_url', 'owner_uid', 'owner_channel_id']);
export function retainCredentials(value, secretValues, publicRoot = true) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (publicRoot && registrationPublicFields.has(key)) continue;
    if (typeof item === 'string' && item) secretValues.add(item);
    else if (item && typeof item === 'object') retainCredentials(item, secretValues, false);
  }
}

export function validateProtectedDescriptors(descriptors) {
  if (typeof process.getuid !== 'function') throw new Error('Protected capture requires a POSIX platform');
  for (const fd of descriptors) {
    if (!Number.isInteger(fd) || fd < 3) throw new Error('Invalid protected descriptor');
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.uid !== process.getuid()) throw new Error('Invalid protected descriptor');
  }
}

/**
 * @param {{upstream:string, token:string, allowedTargets:Array<{channelId:string,channelType:number}>,
 * record:(record:object)=>void, fixtureOnly?:boolean, timeoutMs?:number}} options
 */
export async function startCapture(options) {
  const upstream = new URL(options.upstream);
  if (upstream.username || upstream.password || upstream.search || upstream.hash ||
      (upstream.protocol !== 'https:' && !(options.fixtureOnly && upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1')) ||
      !options.token || !Array.isArray(options.allowedTargets) || !options.allowedTargets.length) {
    throw new Error('Invalid capture configuration');
  }
  // Preserve the configured deployment prefix, just like the package REST client.
  const upstreamBase = upstream.href.replace(/\/+$/, '');
  let ordinal = 0;
  let senderUid;
  const captureSessionId = randomBytes(16).toString('hex');
  const pending = new Set();
  let wsUpstream;
  const wsPath = '/ws/' + randomBytes(32).toString('hex');
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const sockets = new Set();
  // Never discard a credential on registration refresh: earlier values may
  // still appear in later metadata, markers or an existing WS session.
  const secretValues = new Set([options.token]);
  const emit = record => options.record(sanitize({ captureSessionId, ...record }, [...secretValues]));
  const server = createServer((req, res) => {
    const work = handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end('{}'); });
    pending.add(work); work.finally(() => pending.delete(work));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== wsPath || !wsUpstream) {
      emit({ event: 'refused', requestOrdinal: ++ordinal, requestAt: Date.now(), route: '/ws', method: 'UPGRADE', reason: 'unregistered-or-unlisted-ws', forwarded: false });
      socket.destroy(); return;
    }
    websocket.handleUpgrade(req, socket, head, local => {
      const remote = new WebSocket(wsUpstream, { maxPayload: 1024 * 1024, handshakeTimeout: 5000, followRedirects: false });
      sockets.add(local); sockets.add(remote);
      const queued = []; let bytes = 0;
      const frame = (data, direction) => emit({ event: 'ws-frame', direction, at: Date.now(),
        bytes: data.length, packetType: data.length ? data[0] >> 4 : null, frameHash: hash(data) });
      const close = () => { local.terminate(); remote.terminate(); sockets.delete(local); sockets.delete(remote); };
      local.on('message', data => {
        frame(data, 'outbound');
        if (remote.readyState === WebSocket.OPEN) remote.send(data);
        else { bytes += data.length; if (bytes > 1024 * 1024) close(); else queued.push(data); }
      });
      remote.on('open', () => { for (const data of queued) remote.send(data); queued.length = 0; });
      remote.on('message', data => { frame(data, 'inbound'); if (local.readyState === WebSocket.OPEN) local.send(data); });
      for (const peer of [local, remote]) { peer.on('error', close); peer.on('close', close); }
    });
  });
  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    const send = ['/v1/bot/sendMessage', '/v1/bot/message/edit'].includes(route);
    const post = ['/v1/bot/sendMessage', '/v1/bot/message/edit', '/v1/bot/register', '/v1/bot/heartbeat', '/v1/bot/messages/sync'].includes(route);
    const group = route.match(/^\/v1\/bot\/groups\/([^/]+)\/members$/);
    const requestOrdinal = ++ordinal;
    const requestAt = Date.now();
    const refuse = (status, reason) => {
      emit({ event: 'refused', requestOrdinal, requestAt, route, method: req.method, reason, httpStatus: status, forwarded: false });
      res.writeHead(status); res.end('{}');
    };
    const permittedQuery = route === '/v1/bot/register' && url.search === '?force_refresh=true';
    if ((url.search && !permittedQuery) || (!post && !group) || req.method !== (post ? 'POST' : 'GET')) {
      refuse(404, 'unsupported-route-method-or-query'); return;
    }
    if (!equal(String(req.headers.authorization ?? ''), `Bearer ${options.token}`)) { refuse(401, 'unauthorized'); return; }
    req.setTimeout(5000, () => req.destroy());
    if (send) emit({ event: 'attempt', requestOrdinal, requestAt, route, transportOutcome: 'unknown' });
    const chunks = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('Body bound exceeded');
        chunks.push(chunk);
      }
    } catch {
      if (send) emit({ event: 'outcome', requestOrdinal, transportOutcome: 'unknown', bytesReceived: size, responseAt: Date.now(), forwarded: false });
      emit({ event: 'refused', requestOrdinal, requestAt, route, method: req.method, reason: 'incomplete-or-oversized-body', forwarded: false });
      res.destroy(); return;
    }
    const raw = Buffer.concat(chunks);
    let body;
    try { body = raw.length ? parseOctoJson(raw.toString()) : {}; }
    catch {
      if (send) emit({ event: 'outcome', requestOrdinal, transportOutcome: 'failed', httpStatus: 400, forwarded: false });
      refuse(400, 'malformed-body'); return;
    }
    let groupNo;
    try { if (group) groupNo = decodeURIComponent(group[1]); }
    catch { refuse(400, 'malformed-group-target'); return; }
    const target = { channelId: body.channel_id, channelType: body.channel_type };
    const record = { requestOrdinal, requestAt, route, target,
      senderUid, requestBodyHash: hash(raw), clientMsgNo: body.client_msg_no,
      fixtureMarker: typeof body.payload?.content === 'string'
        ? body.payload.content.match(/\[DLY [a-zA-Z0-9_= /.-]{1,400}\]/)?.[0] : undefined };
    if (send) emit({ ...record, event: 'request', bytesReceived: size });
    // No send/readback or membership call can accidentally escape the test inventory.
    if ((send || route.endsWith('/messages/sync')) && !options.allowedTargets.some(t => t.channelId === target.channelId && t.channelType === target.channelType) ||
        group && !options.allowedTargets.some(t => t.channelType === 2 && t.channelId === groupNo)) {
      if (send) emit({ event: 'outcome', requestOrdinal, responseAt: Date.now(), httpStatus: 403, transportOutcome: 'failed', forwarded: false });
      refuse(403, 'target-outside-inventory'); return;
    }
    let outcome = 'unknown';
    try {
      const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };
      if (options.fixtureOnly && req.headers['x-fixture']) headers['x-fixture'] = String(req.headers['x-fixture']);
      const response = await fetch(upstreamBase + route + url.search, { method: req.method, headers,
        ...(post ? { body: raw } : {}), redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
      const responseChunks = []; let responseSize = 0;
      for await (const chunk of response.body ?? []) {
        responseSize += chunk.length;
        if (responseSize > 1024 * 1024) throw new Error('Response bound exceeded');
        responseChunks.push(chunk);
      }
      let text = Buffer.concat(responseChunks).toString('utf8');
      if (route === '/v1/bot/register' && response.ok) {
        const registered = parseOctoJson(text);
        retainCredentials(registered, secretValues);
        const ws = new URL(registered.ws_url);
        if (ws.username || ws.password || (ws.protocol !== 'wss:' && !(options.fixtureOnly && ws.protocol === 'ws:' && ws.hostname === '127.0.0.1'))) throw new Error('Unsafe registered WS endpoint');
        wsUpstream = ws.href;
        senderUid = registered.robot_id;
        registered.ws_url = `ws://127.0.0.1:${server.address().port}${wsPath}`;
        text = JSON.stringify(registered);
        emit({ event: 'registration', at: Date.now(), robotId: registered.robot_id, wsScheme: ws.protocol,
          wsHost: ws.hostname, ownerUid: registered.owner_uid, ownerChannelId: registered.owner_channel_id });
      }
      const validated = confirmation(route, text, body);
      outcome = response.ok && validated.responseMessageId ? 'confirmed'
        : [400, 401, 403, 404, 422, 429].includes(response.status) ? 'failed' : 'unknown';
      if (send) emit({ event: 'outcome', requestOrdinal, transportOutcome: outcome,
        httpStatus: response.status, responseAt: Date.now(), ...validated,
        responseBodyHash: hash(text), bytesForwarded: size });
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch {
      if (send) emit({ event: 'outcome', requestOrdinal, transportOutcome: 'unknown', responseAt: Date.now(), bytesForwarded: size });
      else emit({ event: 'incomplete', requestOrdinal, requestAt, route, reason: 'upstream-response-failed', forwarded: true });
      res.writeHead(502); res.end('{}');
    }
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() {
    for (const socket of sockets) socket.terminate();
    websocket.close();
    server.close(); await Promise.all([...pending]); server.closeAllConnections();
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Descriptors are opened under the Python launcher's directory anchor, never path-reopened here.
  const manifestFd = Number(process.env.ENV02_MANIFEST_FD);
  const tokenFd = Number(process.env.ENV02_TOKEN_FD);
  const evidenceFd = Number(process.env.ENV02_EVIDENCE_FD);
  validateProtectedDescriptors([manifestFd, tokenFd, evidenceFd]);
  const manifest = JSON.parse(readFileSync(manifestFd, 'utf8'));
  const token = readFileSync(tokenFd, 'utf8').trim();
  const capture = await startCapture({ upstream: manifest.apiUrl, token, allowedTargets: manifest.targets,
    fixtureOnly: manifest.localTestEndpoint === true,
    record: record => { writeSync(evidenceFd, JSON.stringify(record) + '\n'); fsyncSync(evidenceFd); } });
  console.log(JSON.stringify({ url: capture.url }));
  const seconds = Number(manifest.seconds ?? 30);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('Invalid capture bound');
  const timer = setTimeout(() => capture.close(), seconds * 1000);
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, async () => { clearTimeout(timer); await capture.close(); });
}
