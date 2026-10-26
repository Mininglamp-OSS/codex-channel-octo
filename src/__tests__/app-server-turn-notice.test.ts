/**
 * D3 through the bridge: the legacy-thread notice is built per attempt and
 * handed to the runner as turn input, separate from the framed prompt. The
 * runner and the launch preparation are stubbed; the bridge, its recovery
 * loop and the session callbacks are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import type { AppServerAttemptInput } from '../app-server/runner.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';
import type { CardInjectionLaunch } from '../cards/tool-host.js';

const calls: AppServerAttemptInput[] = [];
let failFirst = false;

vi.mock('../app-server/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-server/spawn.js')>()),
  prepareAppServerLaunch: async () => ({ executable: '/nonexistent/codex', args: [], env: {} }),
}));

vi.mock('../app-server/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-server/runner.js')>()),
  startAppServerAttempt: async function* (input: AppServerAttemptInput): AsyncGenerator<ThreadEvent> {
    calls.push(input);
    if (failFirst && calls.length === 1) {
      // A structured OS spawn error: the only retry-eligible app-server failure.
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN', syscall: 'spawn /nonexistent/codex' });
    }
    input.onThreadToolset?.(input.resumeId ? (input.threadToolsetDigest ?? null) : null);
    yield { type: 'thread.started', thread_id: input.resumeId ?? 'thr-new' };
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } };
    yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  },
}));

const { queryAgentEvents, LEGACY_TOOLSET_NOTICE } = await import('../agent-bridge.js');
const { appServerToolset } = await import('../cards/tool-host.js');

let root: string;
beforeEach(() => { calls.length = 0; failFirst = false; root = mkdtempSync(join(tmpdir(), 'cco-d3-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

function config(recovery?: Record<string, unknown>): Config {
  return {
    botToken: 't', apiUrl: 'https://example.com', baseDir: root, cwd: root, cwdBase: root, dataDir: join(root, 'data'),
    sdk: { runtime: 'app-server', codexHome: root, codexApiKey: 'sk-synthetic', model: 'gpt-5.1', ...(recovery ? { recovery } : {}) },
    rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288, dispatchTimeoutMs: 300000,
  } as Config;
}

/** Cards offered on this turn; the runner is stubbed, so the launch is never used. */
const cardsOffered = { prepareAppServerAttempt: () => undefined } as unknown as CardInjectionLaunch;

async function run(text: string, opts: { cards?: boolean; resume?: string; digest?: string | null; recovery?: Record<string, unknown> } = {}) {
  const sessions: Array<{ id: string; prompt: string; digest: string | null | undefined }> = [];
  for await (const _ of queryAgentEvents(text, config(opts.recovery), undefined, undefined, {
    onManagedExecution: (_e: ManagedExecution) => {},
    onSessionId: (id, prompt, digest) => { sessions.push({ id, prompt, digest }); },
    ...(opts.cards ? { cardInjection: cardsOffered } : {}),
    ...(opts.resume ? { resume: opts.resume, threadToolsetDigest: opts.digest ?? null } : {}),
  })) { /* drain */ }
  return sessions;
}

describe('D3: model-visible notice on resumed legacy threads (bridge, runner stubbed)', () => {
  it('a resumed thread without the current toolset gets the notice as turn input, apart from the prompt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = await run('USER TEXT', { cards: true, resume: 'thr-old', digest: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].turnNotice).toMatch(/^\[Card tools notice — gateway, not user text\]\n/);
    expect(calls[0].turnNotice).toBe(LEGACY_TOOLSET_NOTICE);
    expect(calls[0].prompt).not.toContain('[Card tools notice');
    expect(calls[0].prompt.endsWith('USER TEXT')).toBe(true);
    // The existing R1 developerInstructions line is kept as is.
    expect(calls[0].developerInstructions).toMatch(/^Explicit card tools are not available/);
    // History and the stored digest see the unchanged prompt and the old thread's digest.
    expect(sessions).toEqual([{ id: 'thr-old', prompt: calls[0].prompt, digest: null }]);
  });

  it('a retried attempt carries the notice once, never a duplicated prefix', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    failFirst = true;
    await run('USER TEXT', { cards: true, resume: 'thr-old', digest: 'v0:old', recovery: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 } });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(typeof c.turnNotice).toBe('string');
      expect(c.turnNotice).toBe(LEGACY_TOOLSET_NOTICE);
      expect(c.prompt).not.toContain('[Card tools notice');
    }
    expect(calls[1].prompt).toBe(calls[0].prompt);
  });

  it('new T2a threads, current threads and card-off resumes get no notice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run('a', { cards: true });
    await run('b', { cards: true, resume: 'thr-cur', digest: appServerToolset().digest });
    await run('c', { resume: 'thr-old', digest: null });
    await run('d', { resume: 'thr-cur', digest: appServerToolset().digest });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c).not.toHaveProperty('turnNotice');
      expect(c.prompt).not.toContain('[Card tools notice');
    }
    // Policy-denied/unprovisioned stay truthful: a thread with tools says they are disabled.
    expect(calls[3].developerInstructions).toMatch(/disabled for this bot/);
    expect(calls[2]).not.toHaveProperty('developerInstructions');
  });
});
