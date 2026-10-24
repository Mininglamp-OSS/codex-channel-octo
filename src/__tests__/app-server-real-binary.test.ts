/**
 * Real-binary harness for the app-server runtime: the packaged Codex 0.163.0
 * native binary, real processes and pipes, and a local mock Responses endpoint
 * with a synthetic key (the model is the only mocked part). Skipped when the
 * pinned binary is not installed for this platform.
 *
 * Covers G-A1 (projection, new/resume, terminal), G-A4 (no listener, no
 * plugin fetch, no remote control), G-A5 (in-memory login, no auth.json) and
 * the G-A8 EOF path for a model shell (darwin only: the shell case relies on
 * the macOS sandbox).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import { queryAgentEvents, type AgentOutputEvent } from '../agent-bridge.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';
import { prepareAppServerLaunch, resolvePinnedCodexBinary } from '../app-server/spawn.js';
import { startAppServerAttempt, AppServerExecution } from '../app-server/runner.js';
import { startMockResponses, type MockResponses } from './fixtures/mock-responses.js';

const BIN = resolvePinnedCodexBinary();
const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

let mock: MockResponses;
let root: string;
beforeAll(async () => {
  if (BIN === null) return;
  mock = await startMockResponses();
  root = mkdtempSync(join(tmpdir(), 'cco-appsrv-'));
});
afterAll(async () => {
  if (BIN === null) return;
  await mock.close();
  rmSync(root, { recursive: true, force: true });
});

function config(home: string, ws: string): Config {
  return {
    botToken: 't', apiUrl: 'https://example.com', baseDir: root, cwd: ws, cwdBase: ws, dataDir: join(root, 'data'),
    sdk: {
      runtime: 'app-server', codexHome: home, codexApiKey: 'sk-synthetic-harness', codexBaseUrl: mock.baseUrl,
      env: NO_PROXY, model: 'gpt-5.1',
    },
    rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288, dispatchTimeoutMs: 300000,
  } as Config;
}

function dirs(): { home: string; ws: string } {
  const home = mkdtempSync(join(root, 'home-'));
  const ws = mkdtempSync(join(root, 'ws-'));
  return { home, ws };
}

async function run(text: string, cfg: Config, resume?: string) {
  const events: AgentOutputEvent[] = [];
  const executions: ManagedExecution[] = [];
  const risks: string[] = [];
  let sessionId: string | undefined;
  for await (const ev of queryAgentEvents(text, cfg, undefined, undefined, {
    onManagedExecution: (e) => executions.push(e),
    onExecutionRisk: (r) => risks.push(r),
    onSessionId: (id) => { sessionId = id; },
    ...(resume ? { resume } : {}),
  })) events.push(ev);
  return { events, executions, risks, sessionId };
}

/** Pids whose parent chain reaches `pid`. */
function descendants(pid: number): number[] {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const out = new Set<number>([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, pp] of rows) if (out.has(pp) && !out.has(p)) { out.add(p); grew = true; }
  }
  out.delete(pid);
  return [...out];
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.runIf(BIN !== null)('app-server runtime on the packaged 0.163.0 binary (real; model mocked)', () => {
  it('G-A1/G-A5: a new conversation completes through the bridge with in-memory API-key login', async () => {
    const { home, ws } = dirs();
    const before = mock.requests.length;
    const r = await run('hello', config(home, ws));
    const messages = r.events.filter((e) => e.kind === 'message');
    expect(messages.map((m) => (m as { text: string }).text)).toEqual(['hello from mock']);
    expect(r.events.at(-1)).toMatchObject({ kind: 'attempt_end', terminal: 'completed' });
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.risks[0]).toBe('unknown');
    const req = mock.requests[before];
    expect(req.authorization).toBe('Bearer sk-synthetic-harness');
    // No explicit card tools are declared (production ops stay empty).
    const tools = (req.body.tools as Array<{ name?: string }> | undefined ?? []).map((t) => t.name);
    expect(tools).not.toContain('display');
    // G-A5: nothing persisted the key.
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect(readdirSync(home).some((f) => /auth/i.test(f))).toBe(false);
    expect(await (r.executions[0] as AppServerExecution).waitForStopped(10_000)).toBe(true);
  }, 60_000);

  it('G-A1/G-A3: a later turn resumes the stored thread with its history', async () => {
    const { home, ws } = dirs();
    const first = await run('remember PINEAPPLE', config(home, ws));
    const before = mock.requests.length;
    const second = await run('what did I say?', config(home, ws), first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    const history = JSON.stringify(mock.requests[before].body.input);
    expect(history).toContain('PINEAPPLE');
    expect(second.events.filter((e) => e.kind === 'message')).toHaveLength(1);
  }, 60_000);

  it('G-A4: no listener, no plugin fetch and remote control disabled during a turn', async () => {
    const { home, ws } = dirs();
    const launch = await prepareAppServerLaunch({ codexHome: home, sdkEnv: NO_PROXY, baseUrl: mock.baseUrl, threadOpts: { approvalPolicy: 'never' } });
    expect(launch.args).not.toContain('--remote-control');
    const executions: AppServerExecution[] = [];
    const remote: unknown[] = [];
    const it = startAppServerAttempt({
      launch, apiKey: 'sk-synthetic-harness', prompt: 'SLOW:1500',
      thread: { cwd: ws, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-5.1' },
      onExecution: (e) => executions.push(e as AppServerExecution),
    })[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: 'thread.started' });
    expect((await it.next()).value).toMatchObject({ type: 'turn.started' });
    const pid = executions[0].pid!;
    const listening = (() => {
      try { return execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }); }
      catch { return ''; } // lsof exits 1 when nothing matches
    })();
    expect(listening.trim()).toBe('');
    const group = execFileSync('/bin/ps', ['-axo', 'pgid=,pid=,args='], { encoding: 'utf8' }).split('\n')
      .map((l) => l.trim().split(/\s+/)).filter((c) => Number(c[0]) === pid && Number(c[1]) !== pid).map((c) => c.slice(2).join(' '));
    expect(group.some((l) => /git|plugins/.test(l))).toBe(false);
    for (let n = await it.next(); !n.done; n = await it.next()) remote.push(n.value as ThreadEvent);
    expect((remote.at(-1) as ThreadEvent).type).toBe('turn.completed');
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
  }, 60_000);

  it.runIf(process.platform === 'darwin')('G-A8: stdin EOF mid-command stops the child and its model shell', async () => {
    const { home, ws } = dirs();
    const launch = await prepareAppServerLaunch({ codexHome: home, sdkEnv: NO_PROXY, baseUrl: mock.baseUrl, threadOpts: { approvalPolicy: 'never' } });
    const executions: AppServerExecution[] = [];
    const it = startAppServerAttempt({
      launch, apiKey: 'sk-synthetic-harness', prompt: 'SHELL:sleep 307',
      thread: { cwd: ws, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-5.1' },
      onExecution: (e) => executions.push(e as AppServerExecution),
    })[Symbol.asyncIterator]();
    for (;;) {
      const n = await it.next();
      if (n.done) throw new Error('turn ended before the command started');
      if (n.value.type === 'item.started' && n.value.item.type === 'command_execution') break;
    }
    const exec = executions[0];
    let shells: number[] = [];
    for (let i = 0; i < 40 && shells.length === 0; i++) {
      shells = descendants(exec.pid!).filter((p) => /sleep 307/.test(execFileSync('/bin/ps', ['-o', 'args=', '-p', String(p)], { encoding: 'utf8' })));
      if (shells.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(shells.length).toBeGreaterThan(0);
    // What the kernel does when the gateway dies: the child's stdin write end closes.
    exec.child.stdin.destroy();
    const t0 = performance.now();
    expect(await exec.waitClosed(5_000)).toBe(true);
    for (let i = 0; i < 100 && shells.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
    expect(shells.filter(alive)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(5_000);
    await it.return(undefined);
  }, 60_000);
});
