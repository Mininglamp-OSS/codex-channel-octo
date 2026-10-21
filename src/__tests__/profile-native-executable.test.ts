import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { queryAgentEvents } from '../agent-bridge.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';

const roots: string[] = [];
const scopes: ManagedExecution[] = [];
let binaryRoot: string;
let native: string;
function isolatedConfig(mode = 'success'): Config {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-profile-'))); roots.push(root);
  mkdirSync(join(root, 'config'), { mode: 0o700 });
  const path = join(root, 'config/config.json');
  writeFileSync(path, '{"apiUrl":"https://example.com","bots":[]}', { mode: 0o600 });
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', root);
  vi.stubEnv('CODEX_OCTO_TEST_CONFIG_PATH', path);
  vi.stubEnv('CODEX_OCTO_TEST_CODEX_PATH', native);
  return { cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' }, baseDir: root, cwd: root, dataDir: root, maxResponseChars: 524288, dispatchTimeoutMs: 10000, botToken: 'synthetic', apiUrl: 'https://example.com',
    sdk: { env: { PINNED_NATIVE_MODE: mode, PINNED_NATIVE_REPORT: join(root, 'native-pids') } },
    rateLimit: { maxPerMinute: 10 }, context: { maxContextChars: 100, historyLimit: 10 } };
}
async function run(c: Config, managed: boolean, signal?: AbortSignal): Promise<string[]> {
  const messages: string[] = [];
  for await (const ev of queryAgentEvents('synthetic native request', c, undefined, undefined,
    { signal, ...(managed ? { onManagedExecution: (scope: ManagedExecution) => scopes.push(scope) } : {}) })) {
    if (ev.kind === 'message') messages.push(ev.text);
  }
  return messages;
}
function live(pid: number): boolean {
  try { const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); return !!state && !state.startsWith('Z'); }
  catch { return false; }
}
describe.skipIf(process.platform === 'win32')('compiled native executable through the actual SDK and managed proxy', () => {
  beforeAll(() => {
    binaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'native-binary-')));
    native = join(binaryRoot, 'native fixture');
    execFileSync('cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./fixtures/pinned-native.c', import.meta.url)), '-o', native]);
    chmodSync(native, 0o700);
    expect(execFileSync(native, ['--version'], { encoding: 'utf8' }).trim()).toBe('codex-cli 0.142.3');
    const hash = createHash('sha256').update(readFileSync(native)).digest('hex');
    // Exercise the actual Python launcher's native executable/checksum validator too.
    execFileSync('python3', ['-c', "import sys;sys.path.insert(0,'scripts');from test_profile import validate_executable;validate_executable(sys.argv[1],sys.argv[2])", native, hash]);
  });
  afterEach(async () => {
    for (const scope of scopes.splice(0)) { await scope.waitForStopped(5000); scope.dispose(); }
    vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  });
  afterAll(() => { if (binaryRoot) rmSync(binaryRoot, { recursive: true, force: true }); });
  it.each([false, true])('executes a real binary and returns JSONL (managed=%s)', async managed => {
    const c = isolatedConfig();
    expect(await run(c, managed)).toEqual(['native synthetic answer']);
    expect(existsSync(join(c.cwd, 'native-pids'))).toBe(true);
    if (managed) { expect(scopes).toHaveLength(1); expect(await scopes[0].waitForStopped(4000)).toBe(true); }
  }, 10000);
  it('retains stop proof when the native child itself fails', async () => {
    const c = isolatedConfig('fail');
    await expect(run(c, true)).rejects.toBeDefined();
    expect(existsSync(join(c.cwd, 'native-pids'))).toBe(true);
    expect(scopes).toHaveLength(1);
    expect(await scopes[0].waitForStopped(4000)).toBe(true);
  }, 10000);
  it('cancels the native process and its stubborn descendant as an owned group', async () => {
    const c = isolatedConfig('hang'); const controller = new AbortController();
    const running = run(c, true, controller.signal).then(() => 'completed', () => 'interrupted');
    const report = join(c.cwd, 'native-pids'); const until = Date.now() + 5000;
    try {
      while (!existsSync(report) && Date.now() < until) await sleep(10);
      expect(existsSync(report)).toBe(true);
      const pids = readFileSync(report, 'utf8').trim().split(' ').map(Number);
      expect(pids.every(pid => pid > 1)).toBe(true);
      controller.abort();
      expect(await running).toBe('interrupted');
      expect(await scopes[0].waitForStopped(5000)).toBe(true);
      expect(pids.map(live)).toEqual([false, false]);
    } finally { controller.abort(); await running; }
  }, 15000);
});
