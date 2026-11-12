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
const { preparePrivateWorker, verifyHttpRelayTlsPin, postHttpTurnRelay } = await import(pathToFileURL(join(dist, 'permissions/worker-launch.js')));
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
  // Turn 1 (Journey 1 + Complete contributor union):
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

  const initReq = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } };
  const positiveRequests = [
    ...['execute', 'call_op'].map((name, i) => ({
      jsonrpc: '2.0',
      id: 10 + i,
      method: 'tools/call',
      params: {
        name,
        arguments: {
          operation_id: 'message.send',
          arguments: { channel_id: 'target', channel_type: 2, payload: { text: 'synthetic' } },
        },
      },
    })),
    ...['execute', 'call_op'].map((name, i) => ({
      jsonrpc: '2.0',
      id: 20 + i,
      method: 'tools/call',
      params: {
        name,
        arguments: {
          operation_id: 'docs.scene.export',
          arguments: { docId: 'doc_ok', format: 'png' },
        },
      },
    })),
  ];
  const overflowExportRequests = [];
  let reqSeq = 30;
  for (const docId of ['doc_overflow_cl', 'doc_overflow_stream']) {
    for (const name of ['execute', 'call_op']) {
      overflowExportRequests.push({
        jsonrpc: '2.0',
        id: reqSeq++,
        method: 'tools/call',
        params: {
          name,
          arguments: {
            operation_id: 'docs.scene.export',
            arguments: { docId, format: 'png' },
          },
        },
      });
    }
  }
  const boundSearchRequests = ['execute', 'call_op'].map((name, i) => ({
    jsonrpc: '2.0',
    id: `${'id_'.repeat(58)}${i}`,
    method: 'tools/call',
    params: {
      name,
      arguments: {
        operation_id: 'docs.search',
        arguments: { q: 'bound' },
      },
    },
  }));
  const deniedSceneRequests = ['execute', 'call_op'].map((name, i) => ({
    jsonrpc: '2.0',
    id: 50 + i,
    method: 'tools/call',
    params: {
      name,
      arguments: {
        operation_id: 'docs.scene.get',
        arguments: { docId: 'board_1' },
      },
    },
  }));
  const allRequests = [
    initReq,
    ...positiveRequests,
    ...overflowExportRequests,
    ...boundSearchRequests,
    ...deniedSceneRequests,
  ];

  let results;
  if (fixture.transport === 'stdio') {
    assert.equal(createHash('sha256').update(readFileSync(relay.executable)).digest('hex'), relay.executableSha256);
    const match = /"args"=\["--turn-relay","([A-Za-z0-9_-]+)"\]/.exec(worker.configOverrides[0]);
    assert(match, 'expected rebound stdio turn-relay handle in worker configOverrides[0]');
    const reboundTicket = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    assert.equal(reboundTicket.ca_file, worker.relayCaPath);
    assert.equal(reboundTicket.cert_sha256, fixture.relayCertSha256);
    assert.equal(reboundTicket.server_name, fixture.relayServerName);

    // Negative receiving-connection TLS checks: wrong CA and wrong leaf pin on actual stdio turn-relay connection.
    const wrongCaTicket = Buffer.from(
      JSON.stringify({ ...reboundTicket, ca_file: fixture.otherCaPath }),
      'utf8',
    ).toString('base64url');
    const wrongCaChild = spawnSync(relay.executable, ['--turn-relay', wrongCaTicket], {
      input: JSON.stringify(initReq) + '\n',
      encoding: 'utf8',
      env: { ...worker.env, SSL_CERT_FILE: fixture.otherCaPath, NODE_EXTRA_CA_CERTS: fixture.otherCaPath },
      timeout: 10000,
    });
    assert.notEqual(wrongCaChild.status, 0, 'expected wrong-CA stdio turn-relay to fail closed');
    assert.equal(wrongCaChild.stdout.trim(), '');

    const wrongLeafTicket = Buffer.from(
      JSON.stringify({ ...reboundTicket, cert_sha256: 'f'.repeat(64) }),
      'utf8',
    ).toString('base64url');
    const wrongLeafChild = spawnSync(relay.executable, ['--turn-relay', wrongLeafTicket], {
      input: JSON.stringify(initReq) + '\n',
      encoding: 'utf8',
      env: { ...worker.env },
      timeout: 10000,
    });
    assert.notEqual(wrongLeafChild.status, 0, 'expected wrong-leaf stdio turn-relay to fail closed');
    assert.equal(wrongLeafChild.stdout.trim(), '');

    const child = spawnSync(relay.executable, ['--turn-relay', match[1]], {
      input: allRequests.map(request => JSON.stringify(request) + '\n').join(''),
      encoding: 'utf8',
      env: { ...worker.env },
      timeout: 25000,
    });
    assert.equal(child.status, 0, child.stderr);
    results = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  } else {
    await verifyHttpRelayTlsPin(worker);
    const otherCaSha = createHash('sha256').update(readFileSync(fixture.otherCaPath)).digest('hex');
    const wrongCaWorker = {
      ...worker,
      relayCaPath: fixture.otherCaPath,
      relayTls: {
        ...worker.relayTls,
        ca_file: fixture.otherCaPath,
        ca_sha256: otherCaSha,
      },
    };
    await assert.rejects(
      () => postHttpTurnRelay(wrongCaWorker, relay.handle, initReq),
      /Turn relay TLS verification failed/,
    );
    const wrongLeafWorker = {
      ...worker,
      relayTls: {
        ...worker.relayTls,
        cert_sha256: 'f'.repeat(64),
        peer_sha256: 'f'.repeat(64),
      },
    };
    await assert.rejects(
      () => postHttpTurnRelay(wrongLeafWorker, relay.handle, initReq),
      /Turn relay peer certificate digest mismatch/,
    );

    results = [];
    for (const request of allRequests) {
      results.push(await postHttpTurnRelay(worker, relay.handle, request));
    }
  }

  assert.equal(results.length, allRequests.length);
  assert(!results[0].error);
  // Positive message.send (2) and within-budget binary docs.scene.export (2)
  for (const res of results.slice(1, 3)) {
    assert(!res.error);
    assert(JSON.stringify(res).includes('synthetic-result'));
  }
  for (const res of results.slice(3, 5)) {
    assert(!res.error);
    assert(JSON.stringify(res).includes('content_base64'));
  }
  // Binary export exceeding MaxAcquisitionBytes (Content-Length + chunked stream, execute + call_op)
  for (const res of results.slice(5, 9)) {
    assert(!res.error);
    const text = JSON.stringify(res.result);
    assert(text.includes('RESPONSE_BUDGET_EXCEEDED'), text);
    assert(text.includes('acquisition_bytes'), text);
  }
  // Lower-boundary MaxSerializedRPCBytes (MinSerializedRPCBudgetBytes = 1024) replacement envelope
  for (const res of results.slice(9, 11)) {
    assert(!res.error);
    const serialized = JSON.stringify(res);
    assert(Buffer.byteLength(serialized, 'utf8') <= 1024, `replacement envelope exceeded 1024 bytes: ${serialized.length}`);
    assert(serialized.includes('RESPONSE_BUDGET_EXCEEDED'), serialized);
    assert(serialized.includes('serialized_rpc_bytes'), serialized);
  }
  // Journey 3: Denied capability during admitted turn with zero backend dispatch
  for (const res of results.slice(11, 13)) {
    assert(res.error, 'expected capability_denied JSON-RPC error');
    assert.equal(res.error.code, -32007);
    assert(JSON.stringify(res.error.data).includes('capability_denied'));
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

  // Turn 3 (Journey 4): Revoke / Epoch-Rotation Reset invalidates prior_generation reuse.
  const ingress3 = await control.call('register_ingress', {
    key: fixture.key,
    delivery_reference: 'delivery_epoch_reset',
    stream: fixture.epochHeader.delivery,
    payload_sha256: fixture.epochHeader.payload_sha256,
  });
  const admitted3 = await control.call('admit', {
    ingress_id: ingress3.ingress_id,
    proposed_context_id: context_id,
    prior_generation: admitted.generation,
  });
  assert.equal(admitted3.context_epoch, '1');
  assert.notEqual(admitted3.generation, admitted.generation);
  await control.call('close', { capsule_id: admitted3.capsule_id, reason: 'completed' });

  // Turn 4 (Journey 2): Stage 1 Admission Denied Before Model Work.
  const ingressDenied = await control.call('register_ingress', {
    key: fixture.key,
    delivery_reference: 'delivery_denied',
    stream: fixture.deniedHeader.delivery,
    payload_sha256: fixture.deniedHeader.payload_sha256,
  });
  await assert.rejects(
    control.call('admit', {
      ingress_id: ingressDenied.ingress_id,
      proposed_context_id: randomBytes(16).toString('hex'),
    }),
    (err) => err?.cause?.refusal?.reason === 'invocation_denied' || /invocation_denied|invocation denied|refused/i.test(String(err?.cause ?? err)),
  );
  await assert.rejects(control.call('renew', { capsule_id: admitted.capsule_id, generation: admitted.generation, ingress_id: ingress.ingress_id }));

  console.log(`ENDPOINT_ABI_OK ${fixture.transport} ${bytes.length} complete-core-bytes`);
} finally { control.close(); }
