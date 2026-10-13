/**
 * Real-binary harness (R8 §6.3, §10.1 layer 3, §10.4).
 * - The binary is the pinned codex 0.142.3 from the installed SDK vendor
 *   package; anything else fails resolution (no fallback to a PATH codex).
 * - Every case gets a fresh temporary HOME/CODEX_HOME, a scrubbed environment
 *   (no proxies, no real credentials, NO_PROXY for loopback) and a fake key.
 * - Raw JSONL transcripts, stderr and rollouts are copied to
 *   $DEV01_EVIDENCE_DIR/real-binary/<case>/ with the fake key redacted.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonlRpcClient, type RpcMessage } from '../harness/jsonl-client.js';
import { pins } from '../harness/pins.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// Current-run raw evidence goes to $DEV01_EVIDENCE_DIR/real-binary (default: git-ignored
// artifacts/); committed snapshots under test/evidence/dev01/ are never rewritten.
const EVIDENCE_ROOT = join(process.env.DEV01_EVIDENCE_DIR ? join(REPO, process.env.DEV01_EVIDENCE_DIR) : join(REPO, 'artifacts', 'evidence'), 'real-binary');
const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': '@openai/codex-darwin-arm64', 'darwin-x64': '@openai/codex-darwin-x64',
  'linux-x64': '@openai/codex-linux-x64', 'linux-arm64': '@openai/codex-linux-arm64',
  'win32-x64': '@openai/codex-win32-x64', 'win32-arm64': '@openai/codex-win32-arm64',
};

let resolved: { path: string; version: string } | undefined;
export function resolveCodexBinary(): { path: string; version: string } {
  if (resolved) return resolved;
  const req = createRequire(import.meta.url);
  const codexPkgPath = req.resolve('@openai/codex/package.json');
  const codexPkg = JSON.parse(readFileSync(codexPkgPath, 'utf8')) as { version: string };
  if (codexPkg.version !== pins.codex) throw new Error(`@openai/codex ${codexPkg.version} installed, pinned ${pins.codex}`);
  const platPkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!platPkg) throw new Error(`no pinned codex binary for ${process.platform}-${process.arch}`);
  const platDir = join(createRequire(codexPkgPath).resolve(`${platPkg}/package.json`), '..');
  const vendor = join(platDir, 'vendor');
  const triple = readdirSync(vendor).find((d) => existsSync(join(vendor, d, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')));
  if (!triple) throw new Error(`codex binary missing under ${vendor}`);
  const path = join(vendor, triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const version = execFileSync(path, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== `codex-cli ${pins.codex}`) throw new Error(`binary reports "${version}", pinned codex-cli ${pins.codex}`);
  resolved = { path, version };
  return resolved;
}

export interface MockLike { baseUrl: string }

/** Loopback overrides for every endpoint the binary may contact (model provider and ChatGPT backend). */
export function loopbackConfig(mock: MockLike): string[] {
  const origin = mock.baseUrl.replace(/\/v1$/, '');
  // The curated-plugin startup sync runs `git ls-remote https://github.com/openai/plugins.git`
  // directly (not via chatgpt_base_url); the plugins feature is disabled for harness
  // processes and env() also forbids git network protocols (GIT_ALLOW_PROTOCOL=file).
  return ['-c', `openai_base_url="${mock.baseUrl}"`, '-c', `chatgpt_base_url="${origin}/backend-api/"`, '-c', 'features.plugins=false'];
}

export class RealEnv {
  readonly home: string;
  readonly evidenceDir: string;
  readonly fakeKey = `sk-dev01-fake-${randomBytes(6).toString('hex')}`;
  private readonly handles: Array<{ label: string; client: JsonlRpcClient }> = [];

  private constructor(readonly caseId: string, readonly root: string) {
    this.home = join(root, 'home');
    mkdirSync(this.home, { recursive: true });
    this.evidenceDir = join(EVIDENCE_ROOT, caseId);
    rmSync(this.evidenceDir, { recursive: true, force: true });
    mkdirSync(this.evidenceDir, { recursive: true });
  }

  static create(caseId: string): RealEnv {
    return new RealEnv(caseId, realpathSync(mkdtempSync(join(tmpdir(), `dev01-rb-${caseId}-`))));
  }

  cwd(name = 'work'): string {
    const p = join(this.root, name);
    mkdirSync(p, { recursive: true });
    return realpathSync(p);
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH, HOME: this.home, CODEX_HOME: this.home, TMPDIR: process.env.TMPDIR ?? tmpdir(),
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', RUST_LOG: 'warn', GIT_ALLOW_PROTOCOL: 'file', ...extra,
    };
  }

  scrub(text: string): string { return text.split(this.fakeKey).join('<fake-key>'); }

  register(label: string, client: JsonlRpcClient): void { this.handles.push({ label, client }); }

  /** Persist transcript + stderr for a handle; returns repo-relative evidence paths. */
  evidence(h: { label: string; transcript: Array<{ dir: string; at: number; message: RpcMessage }>; stderr: string }): string[] {
    const t = join(this.evidenceDir, `${h.label}.jsonl`);
    const e = join(this.evidenceDir, `${h.label}.stderr.log`);
    writeFileSync(t, this.scrub(h.transcript.map((x) => JSON.stringify(x)).join('\n') + '\n'));
    writeFileSync(e, this.scrub(h.stderr));
    assertLoopbackOnly(h.stderr, e);
    return [relative(REPO, t), relative(REPO, e), relative(REPO, join(this.evidenceDir, 'mock-requests.jsonl'))];
  }

  rolloutPath(threadId: string): string {
    const found = findFiles(join(this.home, 'sessions')).find((f) => f.includes(threadId) && f.endsWith('.jsonl'));
    if (!found) throw new Error(`no rollout for ${threadId}`);
    return found;
  }

  /** Repo-relative path the rollout for threadId is copied to by finish(). */
  rolloutEvidencePath(threadId: string): string {
    return relative(REPO, join(this.evidenceDir, 'rollouts', this.rolloutPath(threadId).split('/').at(-1)!));
  }

  async finish(): Promise<void> {
    const dest = join(this.evidenceDir, 'rollouts');
    for (const f of findFiles(join(this.home, 'sessions')).filter((x) => x.endsWith('.jsonl'))) {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, f.split('/').at(-1)!), this.scrub(readFileSync(f, 'utf8')));
    }
    for (const h of this.handles) await h.client.close().catch(() => undefined);
    // The binary may still flush state (sqlite WAL, shell snapshots) right after exit.
    rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function findFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? findFiles(p) : [p];
  });
}

export type AppServerHandle = JsonlRpcClient & {
  label: string;
  initializeParams(): unknown;
  ready(): Promise<void>;
  startThread(params?: Record<string, unknown>): Promise<string>;
  runTurn(threadId: string, text: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<RpcMessage>;
};

let handleCounter = 0;
export function spawnAppServer(env: RealEnv, mock: MockLike, opts: { login?: boolean; ephemeral?: boolean; extraConfig?: string[]; extraEnv?: Record<string, string> } = {}): AppServerHandle {
  const { path } = resolveCodexBinary();
  const login = opts.login ?? true;
  const ephemeral = opts.ephemeral ?? login;
  const args = ['app-server', '--listen', 'stdio://', ...loopbackConfig(mock), '-c', 'approval_policy="never"',
    ...(ephemeral ? ['-c', 'cli_auth_credentials_store="ephemeral"'] : []),
    ...(opts.extraConfig ?? []).flatMap((c) => ['-c', c])];
  const client = JsonlRpcClient.spawn(path, args, { env: env.env(opts.extraEnv), cwd: env.root });
  const label = `app-server-${++handleCounter}`;
  env.register(label, client);
  const threadCwd = new Map<string, string>();
  const h = client as AppServerHandle;
  h.label = label;
  h.initializeParams = () => ({
    clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.0.0-dev01' },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta'] },
  });
  h.ready = async () => {
    await client.request('initialize', h.initializeParams(), { timeoutMs: 10_000 });
    client.notify('initialized', {});
    if (login) await client.request('account/login/start', { type: 'apiKey', apiKey: env.fakeKey }, { timeoutMs: 10_000 });
  };
  h.startThread = async (params = {}) => {
    const full: Record<string, unknown> = { approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, ...params };
    const r = await client.request('thread/start', full) as { thread: { id: string } };
    threadCwd.set(r.thread.id, String(full.cwd));
    return r.thread.id;
  };
  h.runTurn = async (threadId, text, params, timeoutMs = 60_000) => {
    const mark = client.transcript.length;
    const p = params ?? { effort: 'low' };
    const r = await client.request('turn/start', {
      threadId, input: [{ type: 'text', text, text_elements: [] }], cwd: threadCwd.get(threadId) ?? env.cwd(), approvalPolicy: 'never', ...p,
    }) as { turn: { id: string } };
    return client.waitForNotification((n) => n.method === 'turn/completed' && (n.params as { turn: { id: string } }).turn.id === r.turn.id, timeoutMs, mark);
  };
  return h;
}

export async function runExec(env: RealEnv, mock: MockLike, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}) {
  const { path } = resolveCodexBinary();
  // The base URL override goes right after the subcommand as well: when a case
  // passes its own `-c` after `exec`, a root-level override alone is not applied
  // (observed in run 1: exec contacted wss://api.openai.com). See assertLoopbackOnly.
  const [sub, ...rest] = args;
  const base = loopbackConfig(mock);
  const full = [...base, sub, ...base, ...rest];
  const child = spawn(path, full, { env: env.env({ CODEX_API_KEY: env.fakeKey }), cwd: env.root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(opts.stdin ?? '');
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 90_000);
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  clearTimeout(timer);
  let threadId: string | undefined;
  for (const line of stdout.split('\n')) {
    try { const ev = JSON.parse(line) as { type?: string; thread_id?: string }; if (ev.type === 'thread.started') threadId = ev.thread_id; } catch { /* non-JSON */ }
  }
  const logPath = join(env.evidenceDir, `exec-${Date.now()}-${randomBytes(2).toString('hex')}.log`);
  writeFileSync(logPath, env.scrub(`$ codex ${full.join(' ')}\nexit=${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`));
  assertLoopbackOnly(`${stdout}\n${stderr}`, logPath);
  return { code, stdout, stderr, threadId, logPath: relative(REPO, logPath) };
}

/**
 * Generate the pinned binary's App Server JSON schema (v2 definitions) into the
 * case's temp root. Used by schema-backed probes (SP-T1) instead of hand lists.
 */
export function generateProtocolSchema(env: RealEnv): { definitions: Record<string, { properties?: Record<string, unknown> }>; methods: Record<string, string | null> } {
  const { path } = resolveCodexBinary();
  const out = join(env.root, 'protocol-schema');
  execFileSync(path, ['app-server', 'generate-json-schema', '--out', out, '--experimental'], { env: env.env(), stdio: 'ignore' });
  const v2 = JSON.parse(readFileSync(join(out, 'codex_app_server_protocol.v2.schemas.json'), 'utf8')) as { definitions: Record<string, { properties?: Record<string, unknown> }> };
  const req = JSON.parse(readFileSync(join(out, 'ClientRequest.json'), 'utf8')) as { oneOf: Array<{ properties: { method: { enum?: string[] }; params?: { $ref?: string } } }> };
  const methods: Record<string, string | null> = {};
  for (const v of req.oneOf) methods[v.properties.method.enum?.[0] ?? '?'] = v.properties.params?.$ref?.split('/').at(-1) ?? null;
  return { definitions: v2.definitions, methods };
}

/** Fail the case if the binary reports any non-loopback model endpoint (no external network in this job). */
export function assertLoopbackOnly(text: string, where: string): void {
  const hit = /\b(?:https?|wss?):\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}[^\s"']*/i.exec(text);
  if (hit) throw new Error(`network escape: ${hit[0]} referenced in ${where}`);
}

export function readRolloutTurnContexts(env: RealEnv, threadId: string): Array<Record<string, unknown>> {
  return readFileSync(env.rolloutPath(threadId), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; payload?: Record<string, unknown> })
    .filter((e) => e.type === 'turn_context').map((e) => e.payload ?? {});
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (performance.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A separate host process owns the app-server child (for the host-SIGKILL → EOF case). */
export async function spawnHostedAppServer(env: RealEnv, mock: MockLike) {
  const { path } = resolveCodexBinary();
  const script = join(env.root, 'host.mjs');
  const pidFile = join(env.root, 'child.pid');
  const logPath = join(env.evidenceDir, 'host-child.jsonl');
  writeFileSync(script, `
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
const child = spawn(${JSON.stringify(path)}, ['app-server','--listen','stdio://',...${JSON.stringify(loopbackConfig(mock))},'-c','cli_auth_credentials_store="ephemeral"'], { stdio: ['pipe','pipe','inherit'] });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
let buf=''; let id=0; const send=(m)=>child.stdin.write(JSON.stringify(m)+'\\n');
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
  appendFileSync(${JSON.stringify(logPath)}, l.split(${JSON.stringify(env.fakeKey)}).join('<fake-key>') + '\\n');
  let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id === 3 && m.result) send({ id: 4, method: 'turn/start', params: { threadId: m.result.thread.id, input: [{ type: 'text', text: 'hang', text_elements: [] }], cwd: ${JSON.stringify(env.cwd())}, approvalPolicy: 'never', effort: 'low' } });
} });
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_sdk_ts', title: null, version: '0' }, capabilities: { experimentalApi: true } } });
send({ method: 'initialized', params: {} });
send({ id: 2, method: 'account/login/start', params: { type: 'apiKey', apiKey: ${JSON.stringify(env.fakeKey)} } });
send({ id: 3, method: 'thread/start', params: { cwd: ${JSON.stringify(env.cwd())}, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false } });
setInterval(() => {}, 1000);
`);
  const host = spawn(process.execPath, [script], { env: env.env(), cwd: env.root, stdio: 'ignore' });
  const start = performance.now();
  while (!existsSync(pidFile)) {
    if (performance.now() - start > 10_000) throw new Error('hosted app-server did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 50));
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  return {
    hostPid: host.pid!, childPid, logPath: relative(REPO, logPath),
    cleanup: () => {
      for (const pid of [childPid, host.pid!]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    },
  };
}
