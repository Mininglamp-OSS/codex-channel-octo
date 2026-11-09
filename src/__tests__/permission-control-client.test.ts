import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import tls, { type TLSSocket } from 'node:tls';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createHash } from 'node:crypto';
import { canonicalControl, decodeControl, PermissionControlClient, PermissionRefusal, type ControlConnection, type ControlMethod } from '../permissions/control-client.js';

let root: string;
let cert: Buffer;
let key: Buffer;
const servers: tls.Server[] = [];
const sockets = new Set<TLSSocket>();
const clients: PermissionControlClient[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'permission-control-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  cert = readFileSync(join(root, 'cert.pem')); key = readFileSync(join(root, 'key.pem'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function wire(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalControl(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

async function serve(reply: (frame: Record<string, unknown>, peer: TLSSocket) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const server = tls.createServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, peer => {
    sockets.add(peer); peer.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    peer.on('data', data => {
      buffer = Buffer.concat([buffer, Buffer.from(data)]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32BE() + 4) return;
      const frame = JSON.parse(buffer.subarray(4, buffer.readUInt32BE() + 4).toString()) as Record<string, unknown>;
      buffer = Buffer.alloc(0); requests.push(frame);
      const response = reply(frame, peer);
      if (response !== undefined) peer.write(wire(response));
    });
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const options: ControlConnection = { host: '127.0.0.1', port: address.port, servername: 'localhost', ca: cert, cert, key,
    peerCertificateSha256: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
    configuredOrigin: 'https://synthetic.invalid', recipientId: 'synthetic:relay',
    coordinatorIncarnation: 'a'.repeat(32), endpointIncarnation: 'b'.repeat(32), timeoutMs: 500 };
  return { requests, options };
}

function hello(frame: Record<string, unknown>) {
  return { control_version: 1, request_id: frame.request_id, status: 'ok', payload: {
    session_id: frame.session_id, selected_binding: 2, selected_metadata: 2, selected_identity: 2,
    coordinator_incarnation: 'a'.repeat(32),
  } };
}

describe('private control client over actual mutually authenticated TLS', () => {
  it('negotiates first and carries all seven non-Hello methods on one pinned session', async () => {
    const state = await serve(frame => frame.method === 'hello' ? hello(frame)
      : { control_version: 1, request_id: frame.request_id, status: 'ok', payload: { fixture: frame.method } });
    const client = await PermissionControlClient.connect(state.options); clients.push(client);
    const methods: ControlMethod[] = ['register_ingress', 'admit', 'bind_context', 'open_relay', 'renew', 'checkpoint', 'close'];
    for (const method of methods) expect(await client.call(method, {})).toEqual({ fixture: method });
    expect(state.requests.map(frame => frame.method)).toEqual(['hello', ...methods]);
    expect(new Set(state.requests.map(frame => frame.session_id)).size).toBe(1);
    expect(new Set(state.requests.map(frame => frame.request_id)).size).toBe(8);
    const payload = state.requests[0].payload as Record<string, unknown>;
    expect(payload).toEqual({ versions: [2], metadata_versions: [2], identity_versions: [2],
      configured_origin: 'https://synthetic.invalid', endpoint_incarnation: 'b'.repeat(32), recipient_id: 'synthetic:relay' });
  });

  it('returns a closed typed refusal without retrying or downgrading', async () => {
    const state = await serve(frame => frame.method === 'hello' ? hello(frame) : {
      control_version: 1, request_id: frame.request_id, status: 'refused',
      payload: { version: 1, category: 'invocation_denied', correlation: 'c'.repeat(32) },
    });
    const client = await PermissionControlClient.connect(state.options); clients.push(client);
    await expect(client.call('admit', {})).rejects.toBeInstanceOf(PermissionRefusal);
    expect(state.requests.map(frame => frame.method)).toEqual(['hello', 'admit']);
  });

  it('serializes concurrent host requests without allowing a queued payload to change', async () => {
    const state = await serve(frame => frame.method === 'hello' ? hello(frame)
      : { control_version: 1, request_id: frame.request_id, status: 'ok', payload: { fixture: frame.payload } });
    const client = await PermissionControlClient.connect(state.options); clients.push(client);
    const queued = { capsule_id: 'original' };
    const first = client.call('renew', { capsule_id: 'first' });
    const second = client.call('close', queued); queued.capsule_id = 'mutated';
    await expect(first).resolves.toEqual({ fixture: { capsule_id: 'first' } });
    await expect(second).resolves.toEqual({ fixture: { capsule_id: 'original' } });
    expect(state.requests.map(frame => frame.method)).toEqual(['hello', 'renew', 'close']);
  });

  it('rejects the wrong certificate before sending private Hello', async () => {
    const state = await serve(frame => hello(frame));
    await expect(PermissionControlClient.connect({ ...state.options, peerCertificateSha256: '0'.repeat(64) })).rejects.toThrow('negotiation');
    expect(state.requests).toEqual([]);
  });

  it.each(['coordinator', 'session', 'version', 'refused'] as const)('closes on invalid Hello %s with no second Hello', async fault => {
    const state = await serve(frame => {
      const response = hello(frame);
      if (fault === 'coordinator') response.payload.coordinator_incarnation = 'd'.repeat(32);
      if (fault === 'session') response.payload.session_id = 'e'.repeat(32);
      if (fault === 'version') response.payload.selected_binding = 1;
      if (fault === 'refused') response.status = 'refused';
      return response;
    });
    await expect(PermissionControlClient.connect(state.options)).rejects.toThrow('negotiation');
    expect(state.requests).toHaveLength(1);
  });

  it('closes on an oversized reply prefix without allocating/decoding its body', async () => {
    const state = await serve((frame, peer) => {
      if (frame.method === 'hello') return hello(frame);
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(65_537); peer.write(prefix);
    });
    const client = await PermissionControlClient.connect(state.options); clients.push(client);
    await expect(client.call('admit', {})).rejects.toThrow('unavailable');
    await expect(client.call('admit', {})).rejects.toThrow('unavailable');
    expect(state.requests).toHaveLength(2);
  });

  it('rejects a replayed prior reply instead of rebinding its request correlation', async () => {
    let prior: unknown;
    const state = await serve(frame => {
      if (frame.method === 'hello') { prior = hello(frame); return prior; }
      return prior;
    });
    const client = await PermissionControlClient.connect(state.options); clients.push(client);
    await expect(client.call('admit', {})).rejects.toThrow('unavailable');
    await expect(client.call('admit', {})).rejects.toThrow('unavailable');
    expect(state.requests).toHaveLength(2);
  });

  it('rejects duplicate decoded keys, malformed UTF-8, unknown scalars and noncanonical numbers', () => {
    for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":1.0}', '{"x":"\\ud800"}', 'null', '\ufeff{"x":1}']) {
      expect(() => decodeControl(Buffer.from(text))).toThrow();
    }
    expect(() => decodeControl(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]))).toThrow();
  });
});
