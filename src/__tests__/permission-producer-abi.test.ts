import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const source = `#!${process.execPath}
import tls from 'node:tls';import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
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
const path=cfg.ready_path;const fd=openSync(path,'wx',0o600);writeFileSync(fd,canonical({control_version:1,coordinator_incarnation:id}));fsyncSync(fd);closeSync(fd);});
`;
  writeFileSync(executable, source, { mode: 0o700 });
  return { root, executable, executableSha256: createHash('sha256').update(source).digest('hex'),
    hostConfig: { origin: 'https://synthetic.invalid', bot_uid: 'bot', recipient_id: 'endpoint', relay_url: 'https://synthetic.invalid/mcp', control_address: `127.0.0.1:${port}` },
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

  it('refuses changed executable, ordinary bearer tickets, different endpoints and added relay fields', () => {
    const boot = bootFixture();
    const handle = (endpoint = 'https://synthetic.invalid/mcp', token = 'b'.repeat(64)) => Buffer.from(canonicalControl({ endpoint, token })).toString('base64url');
    const relay = { transport: 'stdio', executable: boot.executable, executableSha256: boot.executableSha256, handle: handle() };
    expect(checkedTurnRelay(relay, boot, 'stdio')).toEqual(relay);
    const htmlEndpoint = 'https://synthetic.invalid/mcp&tail';
    const goTicket = JSON.stringify({ endpoint: htmlEndpoint, token: 'b'.repeat(64) }).replace('&', String.fromCharCode(92) + 'u0026');
    expect(checkedTurnRelay({ ...relay, handle: Buffer.from(goTicket).toString('base64url') },
      { ...boot, hostConfig: { ...boot.hostConfig, relay_url: htmlEndpoint } }, 'stdio').transport).toBe('stdio');
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

  it('composes recovery, journal and the owned coordinator from the main-selected descriptor; missing real adapters stop before boot', async () => {
    const boot = bootFixture();
    const config = { baseDir: root, botId: 'fixture', apiUrl: boot.origin, botToken: boot.botToken } as Config;
    const bot = join(root, 'fixture'); mkdirSync(bot, { mode: 0o700 });
    const hostPath = join(root, 'source-host.json'); writeFileSync(hostPath, canonicalControl(boot.hostConfig), { mode: 0o600 });
    const journalKey = join(root, 'journal.key'); writeFileSync(journalKey, Buffer.alloc(32, 9), { mode: 0o600 });
    const descriptor = { version: 1, key: { origin: boot.origin, bot_uid: 'bot', space_id: 'space' }, recipient_id: 'endpoint',
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
      await expect(managedPermissionFactory(config)!({ config, adapter: db, botId: 'bot' })).rejects.toThrow('BINDINGS_UNAVAILABLE');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='permission_replay_meta'").get()).toBeUndefined();
      endpoint = await managedPermissionFactory(config, { native, worker })!({ config, adapter: db, botId: 'bot' });
      expect(native.recover).toHaveBeenCalledWith(descriptor.key);
      expect(db.prepare('SELECT record_count FROM permission_replay_meta').get()).toEqual({ record_count: 0 });
      expect(worker.execute).not.toHaveBeenCalled();
    } finally { await endpoint?.stop(); db.close(); }
    expect(native.stop).toHaveBeenCalledTimes(1); expect(worker.stop).toHaveBeenCalledTimes(1);
  });
});
