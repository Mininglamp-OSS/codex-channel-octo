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
const { preparePrivateWorker, verifyHttpRelayTlsPin } = await import(pathToFileURL(join(dist, 'permissions/worker-launch.js')));
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
  // Register only the invoking delivery_0 via register_ingress; resolve 253 unseen
  // contributor references via resolve_contributors (>32 batching) and 1 unseen
  // contributor reference via bind_context contributor_references, leaving delivery_255
  // for Turn 2 same-generation reuse verification.
  const ingress = await control.call('register_ingress', {
    key: fixture.key,
    delivery_reference: 'delivery_0',
    stream: fixture.headers[0].delivery,
    payload_sha256: fixture.headers[0].payload_sha256,
  });
  const context_id = randomBytes(16).toString('hex');
  const admitted = await control.call('admit', { ingress_id: ingress.ingress_id, proposed_context_id: context_id });
  assert.match(String(admitted.scope_incarnation), /^[0-9a-f]{32}$/);
  assert.match(String(admitted.context_epoch), /^(0|[1-9][0-9]{0,19})$/);
  const resolveRefs = Array.from({ length: 253 }, (_, i) => `delivery_${i + 1}`);
  const resolvedHeaders = [];
  for (let start = 0; start < resolveRefs.length; start += 32) {
    const batch = resolveRefs.slice(start, start + 32);
    const resolved = await control.call('resolve_contributors', {
      capsule_id: admitted.capsule_id,
      delivery_references: batch,
    });
    assert.equal(resolved.headers.length, batch.length);
    resolvedHeaders.push(...resolved.headers);
  }
  assert.equal(resolvedHeaders.length, 253);
  const turn1Originals = fixture.headers.slice(0, 255);
  const core = { context_id, context_generation: admitted.generation, originals: turn1Originals };
  const bytes = Buffer.from(canonicalControl(core));
  assert(bytes.length > 65536);
  await assert.rejects(control.call('bind_context', { capsule_id: admitted.capsule_id,
    manifest: { ...core, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }));
  await bindContextManifest(control, admitted.capsule_id, core, AbortSignal.timeout(10000), {
    contributorReferences: ['delivery_254'],
  });
  const renewed = await control.call('renew', { capsule_id: admitted.capsule_id,
    generation: admitted.generation, ingress_id: ingress.ingress_id });
  assert(Date.parse(renewed.lease_expires_at) > Date.now());
  const relay = await control.call('open_relay', {
    capsule_id: admitted.capsule_id,
    recipient_id: 'endpoint-1',
    transport: fixture.transport,
    relay_nonce: randomBytes(16).toString('hex'),
    include_tls_trust: true,
  });
  const relayCaSha256 = createHash('sha256').update(readFileSync(fixture.relayCaPath)).digest('hex');
  assert.equal(relay.tls.ca_file, fixture.relayCaPath);
  assert.equal(relay.tls.cert_sha256, fixture.relayCertSha256);
  assert.equal(relay.tls.server_name, fixture.relayServerName);
  if (relay.tls.ca_sha256 !== undefined) {
    assert.equal(relay.tls.ca_sha256, relayCaSha256);
  }
  if (relay.tls.peer_sha256 !== undefined) {
    assert.equal(relay.tls.peer_sha256, fixture.relayCertSha256);
  }
  const checked = checkedTurnRelay(
    relay,
    {
      executable: fixture.binary,
      executableSha256: fixture.binarySha256,
      hostConfig: {
        relay_url: fixture.transport === 'http' ? relay.url : JSON.parse(Buffer.from(relay.handle, 'base64url').toString('utf8')).endpoint,
        relay_ca: fixture.relayCaPath,
        relay_ca_sha256: relayCaSha256,
        relay_peer_sha256: fixture.relayCertSha256,
        relay_cert_sha256: fixture.relayCertSha256,
        relay_server_name: fixture.relayServerName,
      },
    },
    fixture.transport,
  );
  const worker = preparePrivateWorker({
    root: fixture.workerRoot,
    launcher: fixture.binary,
    launcherSha256: fixture.binarySha256,
    relay: checked,
    instructions: 'SYNTHETIC_TLS_RELAY_CHECK',
  });
  assert(worker.relayCaPath);
  assert.equal(worker.env.SSL_CERT_FILE, worker.relayCaPath);
  assert.equal(worker.env.NODE_EXTRA_CA_CERTS, worker.relayCaPath);
  assert.equal(worker.relayTls.ca_file, worker.relayCaPath);
  assert.equal(worker.relayTls.cert_sha256, fixture.relayCertSha256);
  assert.equal(worker.relayTls.server_name, fixture.relayServerName);
  if (worker.relayTls.ca_sha256 !== undefined) {
    assert.equal(worker.relayTls.ca_sha256, relayCaSha256);
  }
  const requests = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
    ...['execute', 'call_op'].map((name, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call',
      params: { name, arguments: { operation_id: 'message.send', arguments: {
        channel_id: 'target', channel_type: 2, payload: { text: 'synthetic' },
      } } } }))];
  if (fixture.transport === 'stdio') {
    assert.equal(createHash('sha256').update(readFileSync(relay.executable)).digest('hex'), relay.executableSha256);
    const match = /"args"=\["--turn-relay","([A-Za-z0-9_-]+)"\]/.exec(worker.configOverrides[0]);
    assert(match, 'expected rebound stdio turn-relay handle in worker configOverrides[0]');
    const reboundTicket = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    assert.equal(reboundTicket.ca_file, worker.relayCaPath);
    assert.equal(reboundTicket.cert_sha256, fixture.relayCertSha256);
    assert.equal(reboundTicket.server_name, fixture.relayServerName);
    const child = spawnSync(relay.executable, ['--turn-relay', match[1]], {
      input: requests.map(request => JSON.stringify(request) + '\n').join(''),
      encoding: 'utf8',
      env: { ...worker.env },
      timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr);
    const results = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(results.length, 3);
    for (const result of results.slice(1)) { assert(!result.error); assert(JSON.stringify(result).includes('synthetic-result')); }
  } else {
    await verifyHttpRelayTlsPin(worker);
    const https = await import('node:https');
    const ca = readFileSync(worker.relayCaPath);
    const url = new URL(relay.url);
    const post = (reqBody) => new Promise((resolve, reject) => {
      const data = JSON.stringify(reqBody);
      const r = https.request({
        host: '127.0.0.1',
        port: Number(url.port),
        servername: worker.relayTls.server_name,
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
  }
  await control.call('close', { capsule_id: admitted.capsule_id, reason: 'completed' });
  // Turn 2: verify same-generation context reuse via prior_generation under identical (key, scope_incarnation, context_epoch).
  const ingress2 = await control.call('register_ingress', {
    key: fixture.key,
    delivery_reference: 'delivery_255',
    stream: fixture.headers[255].delivery,
    payload_sha256: fixture.headers[255].payload_sha256,
  });
  const admitted2 = await control.call('admit', {
    ingress_id: ingress2.ingress_id,
    proposed_context_id: context_id,
    prior_generation: admitted.generation,
  });
  assert.equal(admitted2.generation, admitted.generation);
  assert.equal(admitted2.scope_incarnation, admitted.scope_incarnation);
  assert.equal(admitted2.context_epoch, admitted.context_epoch);
  const core2 = { context_id, context_generation: admitted2.generation, originals: fixture.headers };
  await bindContextManifest(control, admitted2.capsule_id, core2, AbortSignal.timeout(10000));
  await control.call('close', { capsule_id: admitted2.capsule_id, reason: 'completed' });
  await assert.rejects(control.call('renew', { capsule_id: admitted.capsule_id, generation: admitted.generation, ingress_id: ingress.ingress_id }));
  console.log(`ENDPOINT_ABI_OK ${fixture.transport} ${bytes.length} complete-core-bytes`);
} finally { control.close(); }
