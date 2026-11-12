// Opt-in cross-repository synthetic fixture. Import the built endpoint bytes;
// exercise the actual pinned Go host/CLI against its native/policy fixtures.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const dist = process.argv[3];
const { PermissionControlClient, canonicalControl } = await import(pathToFileURL(join(dist, 'permissions/control-client.js')));
const { bindContextManifest } = await import(pathToFileURL(join(dist, 'permissions/context-manifest.js')));
const { catalogBootPin, verifyCatalogBoot } = await import(pathToFileURL(join(dist, 'permissions/catalog-boot.js')));
const { checkedTurnRelay } = await import(pathToFileURL(join(dist, 'permissions/endpoint-factory.js')));
const { preparePrivateWorker } = await import(pathToFileURL(join(dist, 'permissions/worker-launch.js')));
if (fixture.catalogManifestPath) {
  const manifestBytes = readFileSync(fixture.catalogManifestPath);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const verifiedPin = verifyCatalogBoot(
    { release_path: fixture.catalogManifestPath, release_sha256: manifestSha256 },
    catalogBootPin({
      catalog_format: 'permission-catalog-package-v2',
      catalog_version: fixture.catalogVersion,
      catalog_digest: manifestSha256,
    }),
  );
  assert.equal(verifiedPin.catalog_digest, manifestSha256);
}
const control = await PermissionControlClient.connect(fixture.control);
const call = control.call.bind(control);
control.call = async (method, payload) => {
  try { return await call(method, payload); }
  catch (cause) { throw new Error(`Synthetic CLI consumer stopped at ${method}`, { cause }); }
};
try {
  let ingress;
  for (const [i, header] of fixture.headers.entries()) {
    const observed = await control.call('register_ingress', { key: fixture.key, delivery_reference: `delivery_${i}`,
      stream: header.delivery, payload_sha256: header.payload_sha256 });
    if (i === 0) ingress = observed;
  }
  const context_id = randomBytes(16).toString('hex');
  const admitted = await control.call('admit', { ingress_id: ingress.ingress_id, proposed_context_id: context_id });
  // Each complete Header has already been resolved by this actual CLI host;
  // no Header/delivery token alias or unseen-history bridge is invented.
  const core = { context_id, context_generation: admitted.generation, originals: fixture.headers };
  const bytes = Buffer.from(canonicalControl(core));
  assert(bytes.length > 65536);
  await assert.rejects(control.call('bind_context', { capsule_id: admitted.capsule_id,
    manifest: { ...core, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }));
  await bindContextManifest(control, admitted.capsule_id, core, AbortSignal.timeout(10000));
  const renewed = await control.call('renew', { capsule_id: admitted.capsule_id,
    generation: admitted.generation, ingress_id: ingress.ingress_id });
  assert(Date.parse(renewed.lease_expires_at) > Date.now());
  const relay = await control.call('open_relay', { capsule_id: admitted.capsule_id,
    recipient_id: 'endpoint-1', transport: fixture.transport, relay_nonce: randomBytes(16).toString('hex') });
  const requests = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
    ...['execute', 'call_op'].map((name, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call',
      params: { name, arguments: { operation_id: 'message.send', arguments: {
        channel_id: 'target', channel_type: 2, payload: { text: 'synthetic' },
      } } } }))];
  if (fixture.transport === 'stdio') {
    assert.equal(createHash('sha256').update(readFileSync(relay.executable)).digest('hex'), relay.executableSha256);
    const child = spawnSync(relay.executable, ['--turn-relay', relay.handle], {
      input: requests.map(request => JSON.stringify(request) + '\n').join(''), encoding: 'utf8', env: {}, timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr);
    const results = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(results.length, 3);
    for (const result of results.slice(1)) { assert(!result.error); assert(JSON.stringify(result).includes('synthetic-result')); }
  } else if (fixture.relayTls) {
    const checked = checkedTurnRelay(
      relay,
      { executable: fixture.binary, executableSha256: fixture.binarySha256, hostConfig: { relay_url: relay.url } },
      'http',
    );
    const worker = preparePrivateWorker({
      root: fixture.workerRoot,
      launcher: fixture.binary,
      launcherSha256: fixture.binarySha256,
      relay: { ...checked, caCert: fixture.relayCa },
      instructions: 'SYNTHETIC_TLS_RELAY_CHECK',
    });
    assert(worker.relayCaPath);
    assert.equal(worker.env.SSL_CERT_FILE, worker.relayCaPath);
    assert.equal(worker.env.NODE_EXTRA_CA_CERTS, worker.relayCaPath);
    const https = await import('node:https');
    const ca = readFileSync(worker.relayCaPath);
    const url = new URL(relay.url);
    const post = (reqBody) => new Promise((resolve, reject) => {
      const data = JSON.stringify(reqBody);
      const r = https.request({
        host: '127.0.0.1',
        port: Number(url.port),
        servername: 'localhost',
        path: url.pathname,
        method: 'POST',
        ca,
        minVersion: 'TLSv1.3',
        agent: false,
        headers: {
          Authorization: `Bearer ${relay.handle}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => resolve(JSON.parse(out)));
      });
      r.on('error', reject);
      r.end(data);
    });
    for (const request of requests) {
      const result = await post(request);
      assert(!result.error);
      if (request.id > 1) assert(JSON.stringify(result).includes('synthetic-result'));
    }
  } else {
    for (const request of requests) {
      const response = await fetch(relay.url, { method: 'POST', headers: { Authorization: `Bearer ${relay.handle}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(10000) });
      const result = await response.json(); assert(!result.error);
      if (request.id > 1) assert(JSON.stringify(result).includes('synthetic-result'));
    }
  }
  await control.call('close', { capsule_id: admitted.capsule_id, reason: 'completed' });
  await assert.rejects(control.call('renew', { capsule_id: admitted.capsule_id, generation: admitted.generation, ingress_id: ingress.ingress_id }));
  console.log(`ENDPOINT_ABI_OK ${fixture.transport} ${bytes.length} complete-core-bytes`);
} finally { control.close(); }
