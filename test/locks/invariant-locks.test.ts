/**
 * R8 §7.1 source invariants (P1–P10, INV-C1–C6) and §1.2 hard boundaries
 * (B1–B11). Aspects A@dd12980 already implements are locked here through
 * production APIs. Aspects that depend on features later DEV stages build are
 * `it.todo` — reported as pending, never as passing — and the parity matrix
 * marks those rows pending.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createCipheriv } from 'node:crypto';
import Database from 'better-sqlite3';
import { WKSocket } from '../../src/octo/socket.js';
import { OctoGateway } from '../../src/gateway.js';
import { SessionRouter } from '../../src/session-router.js';
import { SessionStore } from '../../src/session-store.js';
import { createAdapter } from '../../src/db-adapter.js';
import { handleCommand } from '../../src/commands.js';
import { buildCodexEnv, resolveSandbox } from '../../src/agent-bridge.js';
import { resolveSessionCwd } from '../../src/cwd-resolver.js';
import { fetchWithRedirectGuard } from '../../src/url-policy.js';
import { assembleUserMessage, MAX_USER_LLM_BYTES } from '../../src/file-inline-wrap.js';
import { CRON_FIRE_NONCE, CRON_FIRE_NONCE_KEY } from '../../src/cron-fire-marker.js';
import { loadConfig, resolveBotConfigs } from '../../src/config.js';
import type { BotMessage } from '../../src/octo/types.js';
import type { Config } from '../../src/config.js';
import { FakeOctoWsServer } from '../harness/fake-octo/ws-server.js';
import { FakeOctoRest } from '../harness/fake-octo/rest-server.js';

let ws: FakeOctoWsServer | undefined;
let rest: FakeOctoRest | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await ws?.close(); ws = undefined;
  await rest?.close(); rest = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const cfg = (over: Record<string, unknown> = {}) => ({ apiUrl: 'http://127.0.0.1:9', botToken: 'bf_secret_token_value', rateLimit: { maxPerMinute: 1000 }, dispatchTimeoutMs: 0, ...over } as unknown as Config);
const m = (over: Record<string, unknown>) => ({ message_id: '1', message_seq: 1, from_uid: 'u_alice', channel_id: 'g1', channel_type: 2, timestamp: 1, payload: { type: 1, content: 'x' }, ...over } as unknown as BotMessage);

describe('INV-P1 protocol constants', () => {
  it('INV-P1: CONNECT carries PROTO_VERSION=4, deviceFlag=0, a W-suffixed deviceID; AES-128-CBC key=MD5(base64(shared))[0:16], IV=salt[0:16]', async () => {
    ws = await FakeOctoWsServer.start({ salt: '0123456789abcdefXYZ' });
    const got: BotMessage[] = [];
    const s = new WKSocket({ wsUrl: ws.url, uid: 'u', token: 't', onMessage: (x) => got.push(x) });
    cleanups.push(() => s.disconnect());
    s.connect();
    const c = await ws.waitFor((e) => e.dir === 'in' && e.type === 'CONNECT');
    expect(c.parsed).toMatchObject({ version: 4, deviceFlag: 0 });
    expect((c.parsed as { deviceID: string }).deviceID.endsWith('W')).toBe(true);
    await ws.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    // independent server-side encryption with node:crypto using the P1 derivation
    const shared = ws.sharedSecretFor(1);
    const key = createHash('md5').update(Buffer.from(shared).toString('base64')).digest('hex').slice(0, 16);
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from('0123456789abcdef', 'utf8'));
    const ct = Buffer.concat([cipher.update(JSON.stringify({ type: 1, content: 'p1-vector' }), 'utf8'), cipher.final()]).toString('base64');
    await ws.sendRecv({ messageId: '1', messageSeq: 1, fromUid: 'u_a', channelId: 'u_a', channelType: 1, rawCiphertext: Buffer.from(ct, 'latin1') });
    await until(() => got.length === 1);
    expect(got[0].payload.content).toBe('p1-vector');
  });
});

describe('INV-P2 transport hardening', () => {
  it('INV-P2: a remaining-length varint longer than 4 bytes is rejected and the link closed', async () => {
    ws = await FakeOctoWsServer.start({});
    const s = new WKSocket({ wsUrl: ws.url, uid: 'u', token: 't', onMessage: () => undefined });
    cleanups.push(() => s.disconnect());
    s.connect();
    await ws.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    ws.sendRaw(Buffer.from([0x50, 0x80, 0x80, 0x80, 0x80, 0x01]));
    await ws.waitFor((e) => e.type === 'CLOSE');
  });
  // CSPRNG seed, salt>=16, 1 MiB cap and decoder bounds: BX-3, FO-04, BX-2, GB-03.
});

describe('INV-P3 delivery', () => {
  it('INV-P3: ACK only after decrypt+parse; a poison message is ACK-dropped at the third failure', async () => {
    ws = await FakeOctoWsServer.start({});
    const s = new WKSocket({ wsUrl: ws.url, uid: 'u', token: 't', onMessage: () => undefined });
    cleanups.push(() => s.disconnect());
    s.connect();
    await ws.waitFor((e) => e.dir === 'out' && e.type === 'CONNACK');
    for (let i = 0; i < 3; i++) await ws.sendRecv({ messageId: '9', messageSeq: 9, fromUid: 'u', channelId: 'u', channelType: 1, rawCiphertext: Buffer.from('zz', 'latin1') });
    const ack = await ws.waitFor((e) => e.dir === 'in' && e.type === 'RECVACK');
    expect(ack.parsed).toEqual({ messageId: '9', messageSeq: 9 });
    expect(ws.events.filter((e) => e.type === 'RECVACK')).toHaveLength(1);
  });
  it.todo('INV-P3 (DEV-08): intake stops (no further RECVACK) before handler drain at shutdown');
});

describe('INV-P4 liveness', () => {
  it('INV-P4: a kicked CONNACK (reason 0) closes the socket and surfaces the kick for token refresh', async () => {
    ws = await FakeOctoWsServer.start({ connackReason: 0 });
    const errors: string[] = [];
    const s = new WKSocket({ wsUrl: ws.url, uid: 'u', token: 't', onMessage: () => undefined, onError: (e) => errors.push(e.message) });
    cleanups.push(() => s.disconnect());
    s.connect();
    await ws.waitFor((e) => e.type === 'CLOSE');
    expect(errors).toContain('Kicked by server');
  });
  it.todo('INV-P4 (DEV-02): every needReconnect=false path hands off to refresh, deferred reconnect or the watchdog');
  it.todo('INV-P4 (DEV-02): REST heartbeat failures never tear down the socket (429 counted separately)');
  it.todo('INV-P4 (DEV-02): stopped is re-checked after every await; a failed CONNACK closes and nulls the ws; a fired reconnect timer nulls its handle');
});

describe('INV-P5 URL policy', () => {
  it('INV-P5: plaintext ws:// to a non-loopback host is refused before any socket opens', async () => {
    const dataDir = tmp('dev01-p5-');
    rest = await FakeOctoRest.start({ register: { robot_id: 'u_b', im_token: 't', ws_url: 'ws://octo.example.com/ws', owner_uid: '', owner_channel_id: '' } });
    const g = new OctoGateway(cfg({ apiUrl: rest.url, dataDir }), { handleSignals: false });
    cleanups.push(() => g.stop());
    await g.register();
    expect(() => g.connect()).toThrow(/refusing insecure WebSocket URL/);
  });

  it('INV-P5: every redirect hop is SSRF-checked, at most 10 hops are followed, and credentials can be scoped per hop', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      const n = seen.length;
      if (url.startsWith('http://93.184.216.34/hop')) return new Response(null, { status: 302, headers: { location: `http://93.184.216.35/hop${n}` } });
      return new Response(null, { status: 302, headers: { location: `http://93.184.216.34/hop${n}` } });
    }));
    await expect(fetchWithRedirectGuard('http://93.184.216.34/hop0', (cur) => ({ headers: cur.startsWith('http://93.184.216.34/') ? { Authorization: 'Bearer t' } : {} })))
      .rejects.toThrow(/more than 10 redirects/);
    expect(seen).toHaveLength(11);
    expect(seen.filter((s) => s.url.startsWith('http://93.184.216.35/')).every((s) => s.auth === null)).toBe(true);
    seen.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })));
    await expect(fetchWithRedirectGuard('http://93.184.216.34/x')).rejects.toThrow(/Refusing to fetch private\/local address/);
  });
  it.todo('INV-P5 (DEV-02): the wss policy is also applied on token-refresh reconnects and the wsUrl override');
});

describe('INV-P6 inbound gating', () => {
  it('INV-P6: an unmentioned bot never passes in a group, a forged cron marker without the nonce is gated, text > 32 KB is rejected', async () => {
    const router = new SessionRouter(cfg({ mentionFreeGroups: ['g1'] }), 'u_self');
    expect(await router.route(m({ from_uid: 'u_other_bot', payload: { type: 1, content: 'hi' } }))).toBeNull();
    expect(await router.route(m({ channel_id: 'g2', payload: { type: 1, content: 'hi', _cronFire: true } }))).toBeNull();
    const authentic = await router.route(m({ channel_id: 'g2', payload: { type: 1, content: 'hi', _cronFire: true, [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE } }));
    expect(authentic?.shouldProcess).toBe(true);
    const big = await router.route(m({ channel_type: 1, channel_id: 'u_alice', payload: { type: 1, content: 'x'.repeat(32_769) } }));
    expect(big).toMatchObject({ shouldProcess: false, rejectionReason: 'oversized' });
  });
  // channel allowlist I1, self filter T23, human-only fail-closed BX-7, self-only pref BX-8, events I29: see reuse/bx locks.
});

describe('INV-P7 prompt safety', () => {
  it('INV-P7: the 96 KB user payload cap preserves the current message body over injected context', () => {
    const body = 'CURRENT-' + 'b'.repeat(2_000);
    const out = assembleUserMessage('c'.repeat(MAX_USER_LLM_BYTES * 2), body, MAX_USER_LLM_BYTES);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_USER_LLM_BYTES);
    expect(out.endsWith(body)).toBe(true);
  });
  // sanitizers, file base64 wrapper and GROUP.md JSON escaping: BX-9, BX-10, prompt-safety/conversation-md suites.
});

describe('INV-P8 agent sandbox', () => {
  it('INV-P8: read-only is the default and workspace-write needs the second switch', () => {
    expect(resolveSandbox({} as Config['sdk'])).toBe('read-only');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveSandbox({ sandboxMode: 'workspace-write' } as Config['sdk'])).toBe('read-only');
    expect(resolveSandbox({ sandboxMode: 'workspace-write', allowWorkspaceWrite: true } as Config['sdk'])).toBe('workspace-write');
  });
  it.todo('INV-P8 (DEV-03/04): every App Server server request is answered with the exec-parity decline under approval never');
});

describe('INV-P9 secrets', () => {
  it('INV-P9: the bot token never enters the Codex child environment or the /config reply', () => {
    const token = 'bf_secret_token_value';
    const env = buildCodexEnv({ codexHome: '/tmp/ch', env: { FOO: 'bar' } }, { PATH: '/usr/bin', HOME: '/h' });
    expect(Object.values(env ?? {}).join('\n')).not.toContain(token);
    const store = new SessionStore(createAdapter(':memory:')); store.init();
    const reply = handleCommand('/config', 'k', store, { ...cfg(), sdk: { codexApiKey: 'sk-should-not-show', codexBaseUrl: 'https://llm.example' }, rateLimit: { maxPerMinute: 5 }, context: { historyLimit: 40, maxContextChars: 1 } } as unknown as Config).reply ?? '';
    expect(reply.startsWith('Current settings:')).toBe(true);
    expect(reply).not.toContain(token);
    expect(reply).not.toContain('sk-should-not-show');
    store.close();
  });
  it.todo('INV-P9 (DEV-02): every REST error body is capped at 500 chars and Bearer-scrubbed (postJson/getJson today return the raw body)');
});

describe('INV-P10 authorization for ported tools', () => {
  it.todo('INV-P10 (DEV-14/16): cross-channel reads use checkPermission against the trusted requester; task turns use entry allowlists and the egress chokepoint');
});

describe('INV-C compatibility', () => {
  it('INV-C1: top-level "_" keys are stripped, bot ids are case-sensitive path segments, and unsafe ids are rejected', () => {
    const base = tmp('dev01-c1-');
    writeFileSync(join(base, 'config.json'), JSON.stringify({ _comment: 'x', apiUrl: 'https://octo.example.com', bots: [{ id: 'Bot', botToken: 'bf_1' }, { id: 'bot', botToken: 'bf_2' }] }), { mode: 0o600 });
    const conf = loadConfig(join(base, 'config.json'));
    expect((conf as unknown as Record<string, unknown>)._comment).toBeUndefined();
    const bots = resolveBotConfigs(conf);
    expect(bots.map((b) => b.dataDir)).toEqual([join(conf.baseDir, 'Bot', 'data'), join(conf.baseDir, 'bot', 'data')]);
    expect(() => resolveBotConfigs({ ...conf, bots: [{ id: '../x', botToken: 'bf_3' }] })).toThrow(/invalid id/);
  });

  it('INV-C2: the guarded additive migration upgrades a legacy messages table without data loss', () => {
    const dir = tmp('dev01-c2-');
    const db = new Database(join(dir, 'legacy.db'));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_type INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, timestamp INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      INSERT INTO sessions VALUES ('s', 'c', 1, ${Date.now()}, ${Date.now()});
      INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', 'user', 'legacy row', 1);`);
    db.close();
    const store = new SessionStore(createAdapter(join(dir, 'legacy.db')));
    store.init();
    expect(store.buildHistoryPrefix('s', 10)).toBe('[user user]: legacy row');
    store.close();
    const cols = new Database(join(dir, 'legacy.db')).prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(['id', 'session_id', 'role', 'content', 'timestamp', 'message_seq', 'from_name']);
  });

  it('INV-C3: per-session cwd names are byte-stable sha256(kind:key)[0:16] partitions', () => {
    const base = tmp('dev01-c3-');
    const dm = resolveSessionCwd(base, { kind: 'dm', sessionKey: '42:s42_alice' });
    const group = resolveSessionCwd(base, { kind: 'group', sessionKey: 'g1____t1' });
    const expectName = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
    expect(dm).toBe(join(base, expectName('dm:42:s42_alice')));
    expect(group).toBe(join(base, expectName('group:g1____t1')));
    expect(expectName('dm:same')).not.toBe(expectName('group:same'));
  });

  it('INV-C4: /reset deletes the session, raises the monotonic barrier and clears the thread mapping with its document state', () => {
    const store = new SessionStore(createAdapter(':memory:')); store.init();
    store.getOrCreate('k', 'c', 1);
    store.appendUser('k', 'before', 5, 'A');
    store.setSdkSessionId('k', 'thread-1');
    store.setConversationDocumentSignature('k', 'thread-1', 'sig');
    handleCommand('/reset', 'k', store, cfg(), 10);
    expect(store.buildHistoryPrefix('k', 10)).toBe('');
    expect(store.getResetBarrier('k')).toBe(10);
    expect(store.getSdkSessionId('k')).toBeUndefined();
    expect(store.getConversationDocumentSignature('k', 'thread-1')).toBeNull();
    handleCommand('/reset', 'k', store, cfg(), 7);
    expect(store.getResetBarrier('k')).toBe(10);
    store.close();
  });

  it('INV-C5: the gateway lock is atomic, nonce-guarded and never released by another instance', async () => {
    const dataDir = tmp('dev01-c5-');
    rest = await FakeOctoRest.start({ register: { robot_id: 'u_b', im_token: 't', ws_url: 'ws://127.0.0.1:1', owner_uid: '', owner_channel_id: '' } });
    const a = new OctoGateway(cfg({ apiUrl: rest.url, dataDir }), { handleSignals: false });
    const b = new OctoGateway(cfg({ apiUrl: rest.url, dataDir }), { handleSignals: false });
    await a.register();
    await expect(b.register()).rejects.toThrow(`Another instance is running (PID ${process.pid})`);
    b.releaseLock();
    expect(existsSync(join(dataDir, 'gateway.lock')), 'other instance must not release lock').toBe(true);
    const lock = readFileSync(join(dataDir, 'gateway.lock'), 'utf8');
    expect(lock).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36}$`));
    a.releaseLock();
    expect(readdirSync(dataDir)).not.toContain('gateway.lock');
  });

  it('INV-C6: CODEX_HOME, DB, cwd and lock directories default to per-bot subtrees', () => {
    const base = tmp('dev01-c6-');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'config.json'), JSON.stringify({ apiUrl: 'https://octo.example.com', bots: [{ id: 'a', botToken: 'bf_a' }, { id: 'b', botToken: 'bf_b' }] }), { mode: 0o600 });
    const [a, b] = resolveBotConfigs(loadConfig(join(base, 'config.json')));
    expect(a.sdk.codexHome).toBe(join(a.baseDir, 'a', 'codex-home'));
    expect(b.sdk.codexHome).toBe(join(b.baseDir, 'b', 'codex-home'));
    expect(new Set([a.dataDir, b.dataDir, a.cwdBase, b.cwdBase]).size).toBe(4);
  });
});

describe('hard boundaries (R8 §1.2)', () => {
  it.todo('HB-B1 (DEV-04): each bot owns its own codex app-server child, -c overrides and auth; two-bot no-cross-talk');
  it('HB-B1: per-bot data/cwd/codex-home isolation holds at the configuration layer today', () => {
    const base = tmp('dev01-b1-');
    writeFileSync(join(base, 'config.json'), JSON.stringify({ apiUrl: 'https://octo.example.com', bots: [{ id: 'x', botToken: 'bf_x' }, { id: 'y', botToken: 'bf_y' }] }), { mode: 0o600 });
    const [x, y] = resolveBotConfigs(loadConfig(join(base, 'config.json')));
    for (const k of ['dataDir', 'cwdBase', 'memoryBase'] as const) expect(x[k]).not.toBe(y[k]);
    expect(x.sdk.codexHome).not.toBe(y.sdk.codexHome);
  });
  it.todo('HB-B2 (DEV-04): queryAgent stays byte-compatible across both executors (agent-bridge.test.ts 48 cases green against the App Server executor)');
  it('HB-B3: sdk_sessions is the only sessionKey → thread map in the baseline schema', () => {
    const adapter = createAdapter(':memory:');
    new SessionStore(adapter).init();
    const tables = (adapter.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all() as Array<{ name: string; sql: string }>);
    const mappers = tables.filter((t) => /sdk_session_id/.test(t.sql)).map((t) => t.name).sort();
    // conversation_document_state is keyed to sdk_sessions by FK and is not a second map
    expect(mappers).toEqual(['conversation_document_state', 'sdk_sessions']);
    expect(tables.find((t) => t.name === 'conversation_document_state')!.sql).toMatch(/REFERENCES sdk_sessions\(session_id\) ON DELETE CASCADE/);
  });
  it.todo('HB-B3 (DEV-06): thread-map writes are compare-and-set against the reset generation');
  it.todo('HB-B4 (DEV-04): at most one active turn per thread per process generation; lanes release only on matching terminal or confirmed exit');
  it.todo('HB-B5 (DEV-06): every Octo message/control write goes through OctoEgress (the egress bypass scan baseline shrinks to zero permitted callers)');
  it.todo('HB-B6 (DEV-02): migrations run only while the ownership lock is held (today the DB opens before register() takes the lock)');
  it.todo('HB-B7 (DEV-03/04): every App Server server request is answered (real-binary SB-07 proves the parity reply shape)');
  it('HB-B8: no OpenClaw framework or axios dependency or import', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    expect(deps.filter((d) => /openclaw|^axios$/.test(d))).toEqual([]);
    const srcDir = new URL('../../src/', import.meta.url);
    for (const f of readdirSync(srcDir, { recursive: true }).map(String).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(new URL(f, srcDir), 'utf8');
      expect(text, f).not.toMatch(/from\s+['"](openclaw|@openclaw\/[^'"]+|axios)['"]/);
    }
  });
  it.todo('HB-B10 (DEV-10): cron-origin input is never command-parsed and reminders bypass the router');
  it.todo('HB-B11 (DEV-09/10): every run finalizer is fenced by job generation');
});

async function until(pred: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > timeoutMs) throw new Error('until() timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
