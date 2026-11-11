// Test-only virtual routing: approved public IPs dial a real local TLS fixture.
// The DNS resolver independently rebinds to loopback. No fetch/HTTP is mocked.
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const [compiled, scenario, certPath, keyPath] = process.argv.slice(2);
const counts = { presign: 0, publicPut: 0, privatePut: 0, send: 0, get: 0 };
const targets = [], identities = [], bodies = [], headers = [], resolverCalls = [];
const routes = new Map();
let privateNow = scenario === 'private';
let secondPublic = false;
const approved = scenario === 'aaaa' ? [{ address: '2606:4700::1111', family: 6 }]
  : scenario === 'mapped' ? [{ address: '::ffff:808:808', family: 6 }]
  : scenario === 'fallback' ? [{ address: '2606:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]
  : [{ address: '8.8.8.8', family: 4 }];
if (scenario === 'mixed') approved.push({ address: '127.0.0.1', family: 4 });
if (scenario === 'mapped-private') approved[0] = { address: '::ffff:7f00:1', family: 6 };
const oldLookup = dns.lookup;
dnsPromises.lookup = async host => {
  resolverCalls.push(host);
  if (host === 'other.test' && scenario === 'redirect-private') return [{ address: '127.0.0.1', family: 4 }];
  return privateNow ? [{ address: '127.0.0.1', family: 4 }] : secondPublic ? [{ address: '8.8.4.4', family: 4 }] : approved;
};
dns.lookup = (host, opts, cb) => {
  if (!host.endsWith('.test')) return oldLookup(host, opts, cb);
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  queueMicrotask(() => opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
};
syncBuiltinESMExports();
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opts = args[0];
  if (opts && typeof opts === 'object' && opts.host?.endsWith('.test')) {
    const lookup = opts.lookup ?? dns.lookup;
    const socket = this;
    let selected;
    opts.lookup = (host, options, callback) => lookup(host, options, (error, address, family) => {
      if (error) return callback(error);
      const rows = Array.isArray(address) ? address : [{ address, family }];
      targets.push(...rows.map(r => r.address));
      selected = rows.some(r => r.address === '127.0.0.1') ? 'private' : 'public';
      const routed = rows.map(r => ({ address: scenario === 'aaaa' || (scenario === 'fallback' && r.family === 6) ? '::1' : '127.0.0.1', family: scenario === 'aaaa' || (scenario === 'fallback' && r.family === 6) ? 6 : 4 }));
      if (options.all) callback(null, routed); else callback(null, routed[0].address, routed[0].family);
    });
    socket.once('connect', () => routes.set(socket.localPort, selected));
  }
  return originalConnect.apply(this, args);
};

const { uploadArtifact, sendNativeImage } = await import(pathToFileURL(`${compiled}/octo/media.js`));
const { fetchWithRedirectGuard } = await import(pathToFileURL(`${compiled}/url-policy.js`));
let tlsPort;
const storage = httpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, async (req, res) => {
  identities.push({ host: req.headers.host, sni: req.socket.servername });
  if (req.method === 'PUT') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    counts[routes.get(req.socket.remotePort) === 'public' ? 'publicPut' : 'privatePut']++;
    bodies.push(Buffer.concat(chunks).toString('hex')); headers.push(req.headers);
    if (scenario === 'put-redirect') res.writeHead(307, { location: `https://other.test:${tlsPort}/second` });
    res.end('ok');
  } else {
    counts.get++;
    if (req.url === '/redirect') { res.writeHead(302, { location: `https://other.test:${tlsPort}/final` }); res.end(); }
    else if (req.url === '/slow') { res.writeHead(200); res.write('first'); }
    else if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('content')); }
    else { res.end('content'); }
  }
});
storage.on('tlsClientError', () => {});
await new Promise(r => storage.listen(0, scenario === 'aaaa' ? '::1' : '127.0.0.1', r));
tlsPort = storage.address().port;
const host = scenario === 'wrong-cert' ? 'wrong.test' : 'rebind.test';
const api = httpServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  if (req.url.startsWith('/v1/bot/upload/presigned')) {
    counts.presign++;
    res.end(JSON.stringify({ contentType: 'ImAgE/PnG', uploadUrl: `https://${host}:${tlsPort}/put`, downloadUrl: `https://${host}:${tlsPort}/image` }));
  } else { counts.send++; res.end('{"message_id":12345}'); }
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
let outcome, second;
try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), scenario === 'abort' ? 200 : 3000);
  try {
    if (scenario === 'redirect-private' || scenario === 'redirect-public' || scenario === 'abort' || scenario === 'gzip') {
      const response = await fetchWithRedirectGuard(`https://rebind.test:${tlsPort}/${scenario === 'abort' ? 'slow' : scenario === 'gzip' ? 'gzip' : 'redirect'}`, { signal: controller.signal });
      outcome = await response.text();
    } else {
      const params = { apiUrl: `http://127.0.0.1:${api.address().port}`, botToken: 'fixture-token', name: 'x.png', mime: 'image/png', bytes: Buffer.from('000102feff', 'hex'), signal: controller.signal, check() {} };
      const url = await uploadArtifact(params);
      await sendNativeImage({ ...params, channelId: 'fixture', channelType: 1, url, size: 5, width: 1, height: 1, clientMsgNo: 'fixture' });
      outcome = 'success';
      if (scenario === 'reuse' || scenario === 'reuse-public') {
        privateNow = scenario === 'reuse'; secondPublic = scenario === 'reuse-public';
        try { await uploadArtifact(params); second = 'success'; } catch (e) { second = e.code; }
      }
    }
  } catch (e) { outcome = e.name === 'AbortError' ? e.name : e.code ?? e.name; }
  finally { clearTimeout(timeout); }
} finally {
  api.closeAllConnections(); storage.closeAllConnections();
  await Promise.all([new Promise(r => api.close(r)), new Promise(r => storage.close(r))]);
}
console.log(JSON.stringify({ scenario, outcome, second, counts, targets, identities, bodies, headers, resolverCalls }));
