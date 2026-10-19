import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';
import { TurnFailure } from '../agent-failure.js';
import { privateDiagnosticRow } from '../private-diagnostics.js';

vi.mock('../jsonl-proxy-path.js', () => ({
  resolveJsonlProxyPath: () => fileURLToPath(new URL('./fixtures/notification-proxy.mjs', import.meta.url)),
}));
vi.mock('../execution-scope.js', async importOriginal => {
  const original = await importOriginal<typeof import('../execution-scope.js')>();
  return { ...original, ExecutionScope: class extends original.ExecutionScope {
    constructor() { super(fileURLToPath(new URL('./fixtures/notification-cli.mjs', import.meta.url))); }
  } };
});
import { queryAgent } from '../agent-bridge.js';

let root: string;
let scopes: ManagedExecution[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recoverable-notifications-'));
  scopes = [];
  for (const name of ['notification-cli.mjs', 'notification-proxy.mjs']) {
    chmodSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 0o755);
  }
});
afterEach(async () => {
  for (const scope of scopes) {
    await scope.waitForStopped(4000);
    scope.dispose();
  }
  rmSync(root, { recursive: true, force: true });
});

function config(mode: string): Config {
  return {
    baseDir: root, cwd: root, cwdBase: root, dataDir: join(root, 'data'),
    apiUrl: 'https://test.invalid', botToken: 'synthetic',
    cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
    rateLimit: { maxPerMinute: 100 }, context: { historyLimit: 40, maxContextChars: 6000 },
    maxResponseChars: 524288, dispatchTimeoutMs: 10000,
    sdk: { sandboxMode: 'read-only', privateDiagnostics: true,
      recovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 },
      env: { NOTIFICATION_FIXTURE_MODE: mode, NOTIFICATION_RECORD_FILE: join(root, 'records') } },
  };
}
const records = () => existsSync(join(root, 'records')) ? readFileSync(join(root, 'records'), 'utf8').trim().split('\n') : [];
async function collect(mode: string, managed: boolean, signal?: AbortSignal): Promise<string[]> {
  const output: string[] = [];
  for await (const part of queryAgent('synthetic request', config(mode), undefined, undefined, {
    signal, resume: '11111111-1111-4111-8111-111111111111',
    ...(managed ? { onManagedExecution: (scope: ManagedExecution) => { scopes.push(scope); } } : {}),
  })) output.push(part);
  return output;
}

describe.skipIf(process.platform === 'win32')('real SDK and proxy notification handling', () => {
  it.each([false, true].flatMap(managed =>
    ['success', 'warning-success', 'partial-success', 'work-success'].map(mode => ({ mode, managed })),
  ))('keeps one process alive until completion ($mode, managed=$managed)', async ({ mode, managed }) => {
    expect(await collect(mode, managed)).toEqual(['completed answer']);
    expect(records().filter(value => value === 'launched')).toHaveLength(1);
    expect(records()).toContain('completed');
    expect(records()).not.toContain('cancelled');
    if (managed) {
      expect(scopes).toHaveLength(1);
      expect(await scopes[0].waitForStopped(4000)).toBe(true);
    }
  });

  it.each(['failed', 'eof', 'partial-eof', 'malformed', 'exit-failure'])('rejects %s without replay or a partial reply', async mode => {
    let failure: unknown;
    try { await collect(mode, true); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TurnFailure);
    const report = (failure as TurnFailure).report;
    expect(report).toMatchObject({ attempts: 1, decision: 'blocked_uncertain' });
    if (mode === 'failed') {
      expect(report.final.category).toBe('auth');
      expect(privateDiagnosticRow(report, failure)).toMatchObject({ sdk: { event: 'turn.failed' } });
    } else if (mode === 'eof') {
      expect(privateDiagnosticRow(report, failure)).toMatchObject({ sdk: { event: 'error' } });
    } else if (mode === 'partial-eof') {
      expect(report.final).toMatchObject({ category: 'stream_interrupted', source: 'local' });
    } else if (mode === 'malformed') {
      expect(report.final.stage).toBe('jsonl_parse');
    } else {
      expect(report.final.stage).toBe('process_exit');
    }
    expect(records().filter(value => value === 'launched')).toHaveLength(1);
    expect(scopes).toHaveLength(1);
    expect(await scopes[0].waitForStopped(4000)).toBe(true);
  });

  it.each([false, true].flatMap(managed =>
    ['silent-stream', 'silent-item', 'work-silent', 'blank-completed', 'erased-completed'].map(mode => ({ mode, managed })),
  ))('rejects silent completion without replay ($mode, managed=$managed)', async ({ mode, managed }) => {
    let failure: unknown;
    try { await collect(mode, managed); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TurnFailure);
    const report = (failure as TurnFailure).report;
    expect(report).toMatchObject({ attempts: 1, decision: 'blocked_uncertain',
      executionRisk: mode === 'work-silent' ? 'effects_observed' : 'unknown' });
    if (mode.startsWith('silent-') || mode === 'work-silent') expect(report.final.category).toBe('auth');
    expect(privateDiagnosticRow(report, failure)).toMatchObject({ sdk: { event: mode === 'silent-item' ? 'item.error' : 'error' } });
    expect(records().filter(value => value === 'launched')).toHaveLength(1);
    expect(records()).toContain('completed');
  });

  it.each(['cancel', 'deadline'] as const)('stops a waiting owned process on %s without replay', async reason => {
    const controller = new AbortController();
    const run = collect('wait', true, controller.signal);
    const result = run.then(() => undefined, error => error as unknown);
    try {
      await vi.waitFor(() => expect(records()).toContain('notification'), { timeout: 4000 });
      controller.abort(reason === 'deadline' ? new DOMException('Synthetic deadline exceeded', 'TimeoutError') : undefined);
      const failure = await result;
      expect(failure).toBeInstanceOf(TurnFailure);
      expect((failure as TurnFailure).report).toMatchObject({ attempts: 1, decision: 'cancelled' });
      // The SDK child-process abort is an AbortError even when the caller's
      // reason is a timeout; the router retains the deadline bookkeeping.
      if (reason === 'deadline') expect(controller.signal.reason).toMatchObject({ name: 'TimeoutError' });
      expect(scopes).toHaveLength(1);
      expect(await scopes[0].waitForStopped(4000)).toBe(true);
      expect(records().filter(value => value === 'launched')).toHaveLength(1);
      expect(records()).not.toContain('completed');
    } finally {
      controller.abort();
      await result;
    }
  });
});
