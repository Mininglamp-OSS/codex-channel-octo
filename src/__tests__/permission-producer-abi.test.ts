import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, type BotMessage } from '../octo/types.js';
import { bindContextManifest } from '../permissions/context-manifest.js';
import { canonicalControl, PermissionRefusal } from '../permissions/control-client.js';
import { TurnLease } from '../permissions/turn-lease.js';
import { startPermissionCoordinator, type CoordinatorBoot } from '../permissions/coordinator-process.js';
import { checkedTurnRelay, managedPermissionFactory } from '../permissions/endpoint-factory.js';
import { privateFile } from '../permissions/private-files.js';
import { createAdapter } from '../db-adapter.js';
import type { Config } from '../config.js';
import type { PermissionEndpoint } from '../permissions/endpoint-host.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'permission-abi-'))); chmodSync(root, 0o700); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
const id = '1'.repeat(32);
const core = (count: number, size = 1024) => ({ context_id: id, context_generation: '2'.repeat(32),
  originals: Array.from({ length: count }, (_, i) => ({ header_reference: `reference_${i}`, inert: 'ü'.repeat(size) })) });

describe('CLI 14f9b53d canonical manifest ABI', () => {
  it('transfers a complete >64KiB UTF-8 core with fixed hash and continuous offsets, without losing an original', async () => {
    const manifest = core(256);
    const expected = Buffer.from(canonicalControl(manifest));
    const received: Buffer[] = [];
    let offset = 0;
    const call = vi.fn(async (_method: string, payload: Record<string, unknown>) => {
      const m = payload.manifest as Record<string, unknown>;
      expect(m.carrier).toBe('canonical-json-chunks-v1'); expect(m.offset).toBe(offset);
      expect(m.bytes).toBe(expected.length); expect(m.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
      const wire = Buffer.from(canonicalControl({ control_version: 1, request_id: id, session_id: id, method: 'bind_context', payload }));
      expect(wire.length).toBeLessThanOrEqual(65536);
      const chunk = Buffer.from(String(m.data_base64), 'base64'); received.push(chunk); offset += chunk.length;
      // Mutation after the first await cannot retarget an accepted transfer.
      manifest.originals[255].inert = 'changed';
      return offset === expected.length ? { context_generation: '2'.repeat(32) } : { accepted_bytes: offset };
    });
    await bindContextManifest({ call }, id, manifest, new AbortController().signal);
    expect(call.mock.calls.length).toBeGreaterThan(2);
    expect(Buffer.concat(received).equals(expected)).toBe(true);
    expect(JSON.parse(Buffer.concat(received).toString()).originals).toHaveLength(256);
  });

  it('hashes only the inline core and rejects changed generation or an early final response', async () => {
    const manifest = core(1, 1);
    const call = vi.fn(async (_method: string, payload: Record<string, unknown>) => {
      const m = payload.manifest as Record<string, unknown>;
      expect(m).toEqual({ ...manifest, bytes: Buffer.byteLength(canonicalControl(manifest)),
        sha256: createHash('sha256').update(canonicalControl(manifest)).digest('hex') });
      return { context_generation: '3'.repeat(32) };
    });
    await expect(bindContextManifest({ call }, id, manifest, new AbortController().signal)).rejects.toThrow('generation');
    await expect(bindContextManifest({ call: async () => ({ context_generation: '2'.repeat(32) }) }, id,
      core(256), new AbortController().signal)).rejects.toThrow();
  });

  it('stops at an offset conflict, cancellation or the complete metadata bound, with no retry', async () => {
    const call = vi.fn(async () => ({ accepted_bytes: 1 }));
    await expect(bindContextManifest({ call }, id, core(256), new AbortController().signal)).rejects.toThrow('offset');
    expect(call).toHaveBeenCalledTimes(1);
    call.mockClear();
    await expect(bindContextManifest({ call }, id, core(257), new AbortController().signal)).rejects.toThrow('bound');
    await expect(bindContextManifest({ call }, id, core(256, 4096), new AbortController().signal)).rejects.toThrow('bound');
    await expect(bindContextManifest({ call }, id, core(1), AbortSignal.abort())).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});

describe('owned lease renewal', () => {
  it('serializes renewals, drains an in-flight renewal before close, and never schedules again', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Record<string, unknown>) => void;
    const call = vi.fn(() => new Promise<Record<string, unknown>>(done => { resolve = done; }));
    const controller = new AbortController();
    const lease = new TurnLease({ call }, { capsuleId: id, generation: id, ingressId: id }, controller, 100);
    await vi.advanceTimersByTimeAsync(1000); expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual(['renew', { capsule_id: id, generation: id, ingress_id: id }]);
    let stopped = false; const stop = lease.stop().then(() => { stopped = true; });
    expect(stopped).toBe(false);
    resolve({ lease_expires_at: new Date(Date.now() + 10000).toISOString() }); await stop;
    await vi.advanceTimersByTimeAsync(1000); expect(call).toHaveBeenCalledTimes(1); lease.assertCurrent();
  });

  it.each(['denied', 'malformed', 'expired'] as const)('aborts the worker and preserves %s authority failure', async fault => {
    vi.useFakeTimers();
    const refusal = new PermissionRefusal({ version: 1, category: 'invocation_denied', correlation: id });
    const call = vi.fn(async () => {
      if (fault === 'denied') throw refusal;
      return fault === 'malformed' ? { lease_expires_at: 'tomorrow' } : { lease_expires_at: new Date(Date.now() - 1).toISOString() };
    });
    const controller = new AbortController();
    const lease = new TurnLease({ call }, { capsuleId: id, generation: id, ingressId: id }, controller, 100);
    await vi.advanceTimersByTimeAsync(100); expect(controller.signal.aborted).toBe(true);
    expect(() => lease.assertCurrent()).toThrow();
    if (fault === 'denied') expect(controller.signal.reason).toBe(refusal);
    await lease.stop(); await vi.advanceTimersByTimeAsync(1000); expect(call).toHaveBeenCalledTimes(1);
  });
});

/** Synthetic host process, not a production native provider/release. */
function bootFixture(mode = 'normal'): CoordinatorBoot {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  chmodSync(join(root, 'key.pem'), 0o600); chmodSync(join(root, 'cert.pem'), 0o600);
  const cert = readFileSync(join(root, 'cert.pem')); const key = readFileSync(join(root, 'key.pem'));
  const port = Number(execFileSync(process.execPath, ['-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' }).trim());
  const executable = join(root, 'synthetic-coordinator');
  const release = canonicalControl({ format: 'permission-release-manifest-v1', catalog_version: 'synthetic-identity-only',
    contract_revision: 2, semantics_version: '1' });
  const releasePath = join(root, 'release.json'); writeFileSync(releasePath, release, { mode: 0o600 });
  const source = `#!${process.execPath}
import tls from 'node:tls';import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs';
const cfg=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--permission-config')+1]));
const mode=${JSON.stringify(mode)};const id='a'.repeat(32);
if(mode==='exit')process.exit(42);
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const server=tls.createServer({key:readFileSync(${JSON.stringify(join(root, 'key.pem'))}),cert:readFileSync(${JSON.stringify(join(root, 'cert.pem'))}),ca:readFileSync(${JSON.stringify(join(root, 'cert.pem'))}),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},socket=>{
let buffer=Buffer.alloc(0);socket.on('error',()=>{});socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4||buffer.length<buffer.readUInt32BE()+4)return;
const f=JSON.parse(buffer.subarray(4,buffer.readUInt32BE()+4));buffer=Buffer.alloc(0);
const payload=f.method==='hello'?{session_id:f.session_id,selected_binding:2,selected_metadata:2,selected_identity:2,coordinator_incarnation:mode==='wrong-id'?'b'.repeat(32):id}:{fixture:true};
const b=Buffer.from(canonical({control_version:1,request_id:f.request_id,status:'ok',payload}));const n=Buffer.alloc(4);n.writeUInt32BE(b.length);socket.write(Buffer.concat([n,b]));});});
server.listen(Number(cfg.control_address.split(':').pop()),'127.0.0.1',()=>{writeFileSync(${JSON.stringify(join(root, 'observed.json'))},JSON.stringify({env:process.env,cfg,port:server.address().port}));
const path=cfg.ready_path;const tmp=path+'.tmp';const fd=openSync(tmp,'wx',0o600);writeFileSync(fd,canonical({control_version:1,coordinator_incarnation:id}));fsyncSync(fd);closeSync(fd);renameSync(tmp,path);});
`;
  writeFileSync(executable, source, { mode: 0o700 });
  return { root, executable, executableSha256: createHash('sha256').update(source).digest('hex'),
    hostConfig: { origin: 'https://synthetic.invalid', bot_uid: 'bot', recipient_id: 'endpoint', relay_url: 'https://synthetic.invalid/mcp', control_address: `127.0.0.1:${port}`,
      release_path: releasePath, release_sha256: createHash('sha256').update(release).digest('hex') },
    origin: 'https://synthetic.invalid', botUid: 'bot', recipientId: 'endpoint', botToken: 'bf_SYNTHETIC_ONLY', timeoutMs: 5000,
    tls: { host: '127.0.0.1', port, servername: 'localhost', ca: cert, cert, key,
      peerCertificateSha256: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'), timeoutMs: 500 } };
}

describe('private bootstrap and relay selection', () => {
  it('boots one real private child, pins its fresh ready identity and excludes ambient CLI credentials/config', async () => {
    const boot = bootFixture();
    const running = await startPermissionCoordinator(boot);
    try {
      expect(await running.control.call('checkpoint', {})).toEqual({ fixture: true });
      expect(running.catalog.catalog_format).toBe('permission-release-manifest-v1');
      const observed = JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8'));
      // macOS adds this locale marker while initializing the child runtime.
      delete observed.env.__CF_USER_TEXT_ENCODING;
      expect(observed.env).toEqual({ HOME: join(running.directory, 'home'), OCTO_TOKEN: 'bf_SYNTHETIC_ONLY',
        OCTO_API_BASE_URL: boot.origin, OCTO_MCP_REQUEST_LOG_DIR: join(running.directory, 'requests') });
      expect(observed.cfg.endpoint_incarnation).toMatch(/^[0-9a-f]{32}$/);
      expect(observed.cfg.relay_executable).toBe(boot.executable);
      expect(observed.cfg.ready_path).toBe(join(running.directory, 'ready.json'));
    } finally { await running.stop(); }
    await expect(running.control.call('checkpoint', {})).rejects.toThrow();
  });

  it('collects an exited or wrong-pinned boot, without attaching to old readiness or falling back', async () => {
    await expect(startPermissionCoordinator(bootFixture('exit'))).rejects.toThrow('boot');
    // Deliberately wrong boot ID: even a valid new readiness record cannot
    // substitute another listener's identity or cause an unmanaged retry.
    await expect(startPermissionCoordinator(bootFixture('wrong-id'))).rejects.toThrow('negotiation');
  });

  it('refuses changed executable, ordinary bearer tickets, different endpoints and added relay fields, and validates TurnRelayTrust (ca_file, cert_sha256, server_name)', () => {
    const boot = bootFixture();
    const caFile = join(root, 'cert.pem');
    const certSha256 = boot.tls.peerCertificateSha256;
    const handle = (endpoint = 'https://synthetic.invalid/mcp', token = 'b'.repeat(64)) => Buffer.from(canonicalControl({ endpoint, token })).toString('base64url');
    const relay = { transport: 'stdio', executable: boot.executable, executableSha256: boot.executableSha256, handle: handle() };
    expect(checkedTurnRelay(relay, boot, 'stdio')).toEqual(relay);
    const htmlEndpoint = 'https://synthetic.invalid/mcp&tail';
    const goTicket = JSON.stringify({ endpoint: htmlEndpoint, token: 'b'.repeat(64) }).replace('&', String.fromCharCode(92) + 'u0026');
    expect(checkedTurnRelay({ ...relay, handle: Buffer.from(goTicket).toString('base64url') },
      { ...boot, hostConfig: { ...boot.hostConfig, relay_url: htmlEndpoint } }, 'stdio').transport).toBe('stdio');

    const trustTicket = JSON.stringify({
      ca_file: caFile,
      cert_sha256: certSha256,
      endpoint: 'https://synthetic.invalid/mcp',
      server_name: 'localhost',
      token: 'b'.repeat(64),
    });
    const trustBoot = {
      ...boot,
      hostConfig: {
        ...boot.hostConfig,
        relay_ca: caFile,
        relay_cert_sha256: certSha256,
        relay_server_name: 'localhost',
      },
    };
    const stdioWithTrust = {
      transport: 'stdio',
      executable: boot.executable,
      executableSha256: boot.executableSha256,
      handle: Buffer.from(trustTicket).toString('base64url'),
      tls: { ca_file: caFile, cert_sha256: certSha256, server_name: 'localhost' },
    };
    expect(checkedTurnRelay(stdioWithTrust, trustBoot, 'stdio')).toEqual(stdioWithTrust);
    expect(() => checkedTurnRelay({
      ...stdioWithTrust,
      tls: { ca_file: caFile, cert_sha256: 'f'.repeat(64), server_name: 'localhost' },
    }, trustBoot, 'stdio')).toThrow();

    const httpWithTrust = {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      handle: 'b'.repeat(64),
      ca_sha256: createHash('sha256').update(readFileSync(caFile)).digest('hex'),
      peer_sha256: certSha256,
      tls: { ca_file: caFile, ca_sha256: createHash('sha256').update(readFileSync(caFile)).digest('hex'), peer_sha256: certSha256, cert_sha256: certSha256, server_name: 'localhost' },
    };
    expect(checkedTurnRelay(httpWithTrust, trustBoot, 'http')).toMatchObject({
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      handle: 'b'.repeat(64),
      caSha256: createHash('sha256').update(readFileSync(caFile)).digest('hex'),
      peerSha256: certSha256,
    });
    expect(() => checkedTurnRelay({
      ...httpWithTrust,
      ca_sha256: '0'.repeat(64),
    }, trustBoot, 'http')).toThrow('CA digest');
    expect(() => checkedTurnRelay({
      ...httpWithTrust,
      tls: { ca_file: '/wrong/ca.pem', cert_sha256: certSha256, server_name: 'localhost' },
    }, trustBoot, 'http')).toThrow();

    const cli29d8Ticket = JSON.stringify({
      ca_sha256: createHash('sha256').update(readFileSync(caFile)).digest('hex'),
      endpoint: 'https://synthetic.invalid/mcp',
      peer_sha256: certSha256,
      token: 'b'.repeat(64),
    });
    expect(checkedTurnRelay({
      transport: 'stdio',
      executable: boot.executable,
      executableSha256: boot.executableSha256,
      handle: Buffer.from(cli29d8Ticket).toString('base64url'),
    }, trustBoot, 'stdio').transport).toBe('stdio');

    expect(() => checkedTurnRelay({ ...relay, handle: handle(undefined, 'bf_synthetic') }, boot, 'stdio')).toThrow();
    expect(() => checkedTurnRelay({ ...relay, handle: handle('https://different.invalid') }, boot, 'stdio')).toThrow();
    expect(() => checkedTurnRelay({ ...relay, credential: 'extra' }, boot, 'stdio')).toThrow();
    writeFileSync(boot.executable, '#changed');
    expect(() => checkedTurnRelay(relay, boot, 'stdio')).toThrow('executable');
  });

  it('never downgrades an unsafe or incomplete opt-in to legacy startup', () => {
    const config = { baseDir: root, botId: 'fixture' } as Config;
    expect(managedPermissionFactory(config)).toBeUndefined();
    const bot = join(root, 'fixture'); mkdirSync(bot, { mode: 0o700 });
    const path = join(bot, 'permission-endpoint.json'); writeFileSync(path, '{}', { mode: 0o644 });
    expect(() => managedPermissionFactory(config)).toThrow();
    rmSync(path); symlinkSync(join(root, 'missing'), path);
    expect(() => managedPermissionFactory(config)).toThrow();
  });

  it('reads bounded private descriptors through a non-symlink fd', () => {
    const file = join(root, 'private'); writeFileSync(file, '1234', { mode: 0o600 });
    expect(privateFile(file, 4).toString()).toBe('1234');
    expect(() => privateFile(file, 3)).toThrow();
    symlinkSync(file, join(root, 'alias')); expect(() => privateFile(join(root, 'alias'), 4)).toThrow();
  });

  it.each([1, 2])('composes recovery, journal and the owned coordinator from private descriptor v%s; missing real adapters stop before boot', async version => {
    const boot = bootFixture();
    const config = { baseDir: root, botId: 'fixture', apiUrl: boot.origin, botToken: boot.botToken } as Config;
    const bot = join(root, 'fixture'); mkdirSync(bot, { mode: 0o700 });
    const hostPath = join(root, 'source-host.json'); writeFileSync(hostPath, canonicalControl(boot.hostConfig), { mode: 0o600 });
    const journalKey = join(root, 'journal.key'); writeFileSync(journalKey, Buffer.alloc(32, 9), { mode: 0o600 });
    const descriptor = { version, ...(version === 2 ? { catalog: { catalog_format: 'permission-release-manifest-v1',
      catalog_version: 'synthetic-identity-only', catalog_digest: boot.hostConfig.release_sha256 } } : {}),
      key: { origin: boot.origin, bot_uid: 'bot', space_id: 'space' }, recipient_id: 'endpoint',
      transport: 'stdio', coordinator: { root, executable: boot.executable, sha256: boot.executableSha256, host_config: hostPath },
      tls: { host: '127.0.0.1', port: boot.tls.port, servername: 'localhost', ca: join(root, 'cert.pem'), cert: join(root, 'cert.pem'),
        key: join(root, 'key.pem'), peer_sha256: boot.tls.peerCertificateSha256 },
      journal: { key: journalKey, key_version: '1', provision: true },
      worker: { root, launcher: boot.executable, sha256: boot.executableSha256, instructions: 'SYNTHETIC_STATIC', provider: null } };
    writeFileSync(join(bot, 'permission-endpoint.json'), canonicalControl(descriptor), { mode: 0o600 });
    const db = createAdapter(join(root, 'journal.db'));
    let endpoint: PermissionEndpoint | undefined;
    const native = { recover: vi.fn(async () => {}), inspect: vi.fn(async () => { throw new Error('no synthetic receipt'); }),
      candidate: vi.fn(async () => true), prepareInput: vi.fn(async () => ({ input: '', originals: [] })),
      publish: vi.fn(async () => {}), refuse: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const worker = { execute: vi.fn(async () => 'SYNTHETIC'), stop: vi.fn(async () => {}) };
    try {
      if (version === 2) {
        writeFileSync(join(bot, 'permission-endpoint.json'), canonicalControl({ ...descriptor,
          catalog: { ...descriptor.catalog, catalog_version: 'wrong' } }), { mode: 0o600 });
        expect(() => managedPermissionFactory(config, { native, worker })).toThrow('selection');
        expect(native.recover).not.toHaveBeenCalled();
        writeFileSync(join(bot, 'permission-endpoint.json'), canonicalControl(descriptor), { mode: 0o600 });
      }
      await expect(managedPermissionFactory(config)!({ config, adapter: db, botId: 'bot' })).rejects.toThrow('BINDINGS_UNAVAILABLE');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='permission_replay_meta'").get()).toBeUndefined();
      endpoint = await managedPermissionFactory(config, { native, worker })!({ config, adapter: db, botId: 'bot' });
      expect(native.recover).toHaveBeenCalledWith(descriptor.key);
      expect(db.prepare('SELECT record_count FROM permission_replay_meta').get()).toEqual({ record_count: 0 });
      expect(worker.execute).not.toHaveBeenCalled();
    } finally { await endpoint?.stop(); db.close(); }
    expect(native.stop).toHaveBeenCalledTimes(1); expect(worker.stop).toHaveBeenCalledTimes(1);
  });

  it('composes default NativeEndpointDriver and ContainedWorkerDriver with OS-sandboxed launcher against server v7 native routes and real TLS 1.3 HTTP relay', async () => {
    const boot = bootFixture();
    const sentMessages: Array<Record<string, unknown>> = [];
    const factsOps: string[] = [];
    let includeRecoveryFence = false;
    let proveOriginalVisibility = false;
    const msgUnknownVis: BotMessage = {
      message_id: '776', message_seq: 10, from_uid: 'alice', channel_id: 'alice@bot',
      channel_type: ChannelType.DM, timestamp: 1, payload: { type: 1, content: 'UNKNOWN_ORIGINAL_VISIBILITY' },
    };
    const payloadShaUnknown = createHash('sha256').update(JSON.stringify(msgUnknownVis.payload)).digest('hex');
    const msg: BotMessage = {
      message_id: '777', message_seq: 11, from_uid: 'alice', channel_id: 'alice@bot',
      channel_type: ChannelType.DM, timestamp: 1, payload: { type: 1, content: 'HELLO_CONTAINED_DEFAULT' },
    };
    const rawPayloadJson = JSON.stringify(msg.payload);
    const payloadSha256 = createHash('sha256').update(rawPayloadJson).digest('hex');
    const authorities = {
      sql: {
        authority_id: 'octo-server-message-store',
        incarnation: 'a'.repeat(32),
        commit_epoch: '11',
        ack_before_read_start: true,
      },
      im: {
        authority_id: 'octo-server-im-channel-seq',
        incarnation: 'b'.repeat(32),
        commit_epoch: '11',
        ack_before_read_start: true,
      },
    };
    const header776 = {
      header_version: 1 as const,
      header_reference: 'h1-native_hdr_776',
      message_id: '776',
      source: { kind: 'dm' as const, id: 'alice@bot' },
      parent_group: null,
      space_id: 'space',
      author_uid: 'alice',
      author_kind: 'human' as const,
      recipient_bot_uid: 'bot',
      native_message_version: `x1_${payloadShaUnknown.slice(0, 16)}`,
      payload_sha256: payloadShaUnknown,
      delivery: { stream_id: 'dm:1:alice@bot', stream_incarnation: 'b'.repeat(32), sequence: '10' },
    };
    const header = {
      header_version: 1 as const,
      header_reference: 'h1-native_hdr_777',
      message_id: '777',
      source: { kind: 'dm' as const, id: 'alice@bot' },
      parent_group: null,
      space_id: 'space',
      author_uid: 'alice',
      author_kind: 'human' as const,
      recipient_bot_uid: 'bot',
      native_message_version: `x1_${payloadSha256.slice(0, 16)}`,
      payload_sha256: payloadSha256,
      delivery: { stream_id: 'dm:1:alice@bot', stream_incarnation: 'b'.repeat(32), sequence: '11' },
    };

    const relayHttpsServer = createHttpsServer({
      key: readFileSync(join(root, 'key.pem')),
      cert: readFileSync(join(root, 'cert.pem')),
      minVersion: 'TLSv1.3',
    }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    relayHttpsServer.listen(0, '127.0.0.1');
    await once(relayHttpsServer, 'listening');
    const relayAddr = relayHttpsServer.address();
    if (!relayAddr || typeof relayAddr === 'string') throw new Error('No relay address');
    const relayHttpsUrl = `https://localhost:${relayAddr.port}/mcp`;

    const nativeServer = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
      if (req.url === '/v1/bot/permission-facts/v1/fence?space_id=space') {
        factsOps.push('fence');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          fence_version: 1,
          space_id: 'space',
          read_id: parsed.read_id,
          read_nonce: parsed.read_nonce,
          authority_id: 'octo-server-message-store',
          commit_marker: 'ms:777:11:1',
          ...(includeRecoveryFence ? {
            recovery_fence_v1: {
              sql_incarnation: 'a'.repeat(32),
              im_incarnation: 'b'.repeat(32),
              ack_before_read_start: true,
            },
          } : {}),
        }));
        return;
      }
      if (req.url === '/v1/bot/permission-facts/v1/bind-delivery?space_id=space') {
        expect(parsed.operation).toBe('bind_delivery');
        factsOps.push('bind_delivery');
        const is776 = parsed.message_id === '776';
        const targetHeader = is776 ? header776 : header;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          schema_version: 1,
          request_id: parsed.request_id,
          authorities,
          binding: {
            status: 'bound',
            current: true,
            delivery_reference: is776 ? 's1-deliv_776' : 's1-deliv_777',
            header_reference: targetHeader.header_reference,
            native_message_version: targetHeader.native_message_version,
            observed_payload_sha256: targetHeader.payload_sha256,
            header: targetHeader,
            proven_predicates: [
              'bot_current_visible',
              'caller_current_visible',
              'delivery_current_exact',
              'message_space_exact',
              'sender_identity_exact',
              ...(proveOriginalVisibility ? ['bot_original_visible', 'caller_original_visible'] : []),
            ],
            unknown_predicates: proveOriginalVisibility ? [] : ['bot_original_visible', 'caller_original_visible'],
            resolvable_purposes: proveOriginalVisibility ? ['admit', 'contributor', 'reply'] : ['reply'],
          },
        }));
        return;
      }
      if (req.url === '/v1/bot/permission-facts/v1?space_id=space') {
        const operation = String(parsed.operation);
        factsOps.push(operation);
        res.setHeader('Content-Type', 'application/json');
        if (operation === 'history_disclosure') {
          res.end(JSON.stringify({
            schema_version: 1,
            profile_version: 1,
            request_id: parsed.request_id,
            authorities,
            results: [
              proveOriginalVisibility
                ? {
                    header_reference: header.header_reference,
                    status: 'disclosed',
                    header,
                    content: rawPayloadJson,
                  }
                : {
                    header_reference: header776.header_reference,
                    status: 'unknown',
                    reason: 'caller_original_visibility_unknown',
                  },
            ],
          }));
          return;
        }
        if (operation === 'resolve') {
          const refs = parsed.references as Array<{ delivery_reference: string }>;
          const ref = refs[0].delivery_reference;
          res.end(JSON.stringify({
            schema_version: 1,
            profile_version: 1,
            request_id: parsed.request_id,
            authorities,
            results: [
              {
                delivery_reference: ref,
                status: 'resolved',
                header: ref === 's1-deliv_776' ? header776 : header,
              },
            ],
          }));
          return;
        }
      }
      if (req.url === '/v1/bot/sendMessage') {
        sentMessages.push(parsed);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message_id: '888', client_msg_no: 'c1', message_seq: 12 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    nativeServer.listen(0, '127.0.0.1');
    await once(nativeServer, 'listening');
    const addr = nativeServer.address();
    if (!addr || typeof addr === 'string') throw new Error('No address');
    const apiUrl = `http://127.0.0.1:${addr.port}`;
    const caSha256 = createHash('sha256').update(readFileSync(join(root, 'cert.pem'))).digest('hex');

    // Coordinator script that handles register_ingress, admit, bind_context, renew, open_relay, close
    const coordExec = join(root, 'full-coordinator');
    const coordSource = `#!${process.execPath}
import tls from 'node:tls';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--permission-config') + 1], 'utf8'));
const id = 'a'.repeat(32);
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
const server = tls.createServer({
  key: readFileSync(${JSON.stringify(join(root, 'key.pem'))}),
  cert: readFileSync(${JSON.stringify(join(root, 'cert.pem'))}),
  ca: readFileSync(${JSON.stringify(join(root, 'cert.pem'))}),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
}, socket => {
  let buffer = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
      const len = buffer.readUInt32BE();
      const f = JSON.parse(buffer.subarray(4, len + 4).toString('utf8'));
      buffer = buffer.subarray(len + 4);
      let payload = { fixture: true };
      if (f.method === 'hello') payload = { session_id: f.session_id, selected_binding: 2, selected_metadata: 2, selected_identity: 2, coordinator_incarnation: id };
      else if (f.method === 'register_ingress') payload = { ingress_id: '1'.repeat(32) };
      else if (f.method === 'admit') payload = { capsule_id: '2'.repeat(32), turn_id: '3'.repeat(32), generation: '4'.repeat(32), scope_incarnation: '5'.repeat(32), context_epoch: '1' };
      else if (f.method === 'bind_context') payload = { context_generation: '4'.repeat(32) };
      else if (f.method === 'renew') payload = { lease_expires_at: new Date(Date.now() + 60000).toISOString() };
      else if (f.method === 'open_relay') payload = {
        transport: 'http',
        url: ${JSON.stringify(relayHttpsUrl)},
        handle: 'b'.repeat(64),
        ca_sha256: ${JSON.stringify(caSha256)},
        peer_sha256: ${JSON.stringify(boot.tls.peerCertificateSha256)},
        ...(f.payload?.include_tls_trust ? {
          tls: {
            ca_file: ${JSON.stringify(join(root, 'cert.pem'))},
            ca_sha256: ${JSON.stringify(caSha256)},
            peer_sha256: ${JSON.stringify(boot.tls.peerCertificateSha256)},
            cert_sha256: ${JSON.stringify(boot.tls.peerCertificateSha256)},
            server_name: 'localhost',
          },
        } : {}),
      };
      else if (f.method === 'close') payload = {};
      const b = Buffer.from(canonical({ control_version: 1, request_id: f.request_id, status: 'ok', payload }));
      const n = Buffer.alloc(4);
      n.writeUInt32BE(b.length);
      socket.write(Buffer.concat([n, b]));
    }
  });
});
server.listen(Number(cfg.control_address.split(':').pop()), '127.0.0.1', () => {
  const tmpPath = cfg.ready_path + '.tmp';
  const fd = openSync(tmpPath, 'wx', 0o600);
  writeFileSync(fd, canonical({ control_version: 1, coordinator_incarnation: id }));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmpPath, cfg.ready_path);
});
`;
    writeFileSync(coordExec, coordSource, { mode: 0o700 });
    const coordSha256 = createHash('sha256').update(coordSource).digest('hex');

    const workerExec = join(root, 'worker-bin');
    const workerSource = `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
let keyLeak = 'NONE';
try { keyLeak = fs.readFileSync(${JSON.stringify(join(root, 'journal.key'))}, 'utf8'); } catch (e) { keyLeak = 'BLOCKED:' + e.code; }
console.log(JSON.stringify({ type: 'thread.started', thread_id: '33333333-3333-4333-8333-333333333333' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'CONTAINED_REPLY|' + keyLeak } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
    writeFileSync(workerExec, workerSource, { mode: 0o700 });
    const workerSha256 = createHash('sha256').update(workerSource).digest('hex');

    const botDir = join(root, 'fixture');
    mkdirSync(botDir, { mode: 0o700 });
    const workerRoot = join(root, 'worker-root');
    mkdirSync(workerRoot, { mode: 0o700 });
    const hostConfig = { ...boot.hostConfig, origin: apiUrl, relay_url: relayHttpsUrl };
    const hostPath = join(root, 'source-host-full.json');
    writeFileSync(hostPath, canonicalControl(hostConfig), { mode: 0o600 });
    const journalKey = join(root, 'journal.key');
    writeFileSync(journalKey, Buffer.alloc(32, 9), { mode: 0o600 });

    const descriptor = {
      version: 2,
      catalog: {
        catalog_format: 'permission-release-manifest-v1',
        catalog_version: 'synthetic-identity-only',
        catalog_digest: String(boot.hostConfig.release_sha256),
      },
      key: { origin: apiUrl, bot_uid: 'bot', space_id: 'space' },
      recipient_id: 'endpoint',
      transport: 'http',
      coordinator: { root, executable: coordExec, sha256: coordSha256, host_config: hostPath },
      tls: {
        host: '127.0.0.1', port: boot.tls.port, servername: 'localhost',
        ca: join(root, 'cert.pem'), cert: join(root, 'cert.pem'), key: join(root, 'key.pem'),
        peer_sha256: boot.tls.peerCertificateSha256,
      },
      journal: { key: journalKey, key_version: '1', provision: true },
      worker: { root: workerRoot, launcher: workerExec, sha256: workerSha256, instructions: 'SYNTHETIC_INSTRUCTIONS', provider: null },
    };
    writeFileSync(join(botDir, 'permission-endpoint.json'), canonicalControl(descriptor), { mode: 0o600 });

    const config: Config = {
      baseDir: root, dataDir: root, cwd: root, cwdBase: root, botId: 'fixture',
      apiUrl, botToken: boot.botToken,
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 5000, dispatchTimeoutMs: 10000,
      cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      sdk: {},
    };
    const db = createAdapter(join(root, 'journal-full.db'));
    let endpoint: PermissionEndpoint | undefined;
    try {
      // Default server v7 fence returns only octo-server-message-store read-time marker -> fails closed!
      await expect(managedPermissionFactory(config)!({ config, adapter: db, botId: 'bot' })).rejects.toThrow('PERMISSION_NATIVE_RECOVERY_FENCE_UNAVAILABLE');

      // Opt-in synthetic recovery_fence_v1 allows component test to proceed past startup recovery gate
      includeRecoveryFence = true;
      endpoint = await managedPermissionFactory(config)!({ config, adapter: db, botId: 'bot' });

      // 1. When bind_delivery reports bot_original_visible / caller_original_visible in unknown_predicates,
      // prepareInput fails closed and sends refusal via operation="resolve", purpose="reply" without starting worker.
      const resUnknown = await endpoint.reserveBeforeAck({ recipientUid: 'bot', message: msgUnknownVis, payloadSha256: payloadShaUnknown });
      expect(resUnknown.disposition).toBe('reserved');
      if (resUnknown.disposition === 'reserved') {
        const disp = await endpoint.handle(msgUnknownVis);
        expect(disp).toBe('terminal');
        resUnknown.finish(disp);
      }
      expect(sentMessages).toHaveLength(1);
      expect(String((sentMessages[0].payload as Record<string, unknown>).content)).toContain('Permissions could not be checked. Try again later.');

      // 2. When original visibility is proven and history_disclosure returns status="disclosed",
      // full pipeline executes worker (after verifying HTTP relay TLS 1.3 leaf pin) and publishes reply.
      proveOriginalVisibility = true;
      const res = await endpoint.reserveBeforeAck({ recipientUid: 'bot', message: msg, payloadSha256 });
      expect(res.disposition).toBe('reserved');
      if (res.disposition === 'reserved') {
        const disp = await endpoint.handle(msg);
        expect(disp).toBe('terminal');
        res.finish(disp);
      }
      expect(factsOps).toEqual(['fence', 'fence', 'bind_delivery', 'resolve', 'bind_delivery', 'history_disclosure', 'history_disclosure', 'resolve']);
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toMatchObject({
        channel_id: 'alice@bot',
        channel_type: ChannelType.DM,
        payload: {
          type: 1,
          content: expect.stringMatching(/^CONTAINED_REPLY\|BLOCKED:(EPERM|EACCES|ENOENT)$/),
          reply: { message_id: '777' },
        },
      });
    } finally {
      await endpoint?.stop();
      db.close();
      relayHttpsServer.closeAllConnections();
      await new Promise<void>(resolve => relayHttpsServer.close(() => resolve()));
      nativeServer.closeAllConnections();
      await new Promise<void>(resolve => nativeServer.close(() => resolve()));
    }
  });
});
