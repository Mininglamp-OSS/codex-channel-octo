/**
 * agent-bridge (codex) tests — pure unit tests with a mocked @openai/codex-sdk.
 * No real codex process is spawned: we feed synthetic ThreadEvent streams and
 * assert the bridge's mapping (text yield, redacted progress, threadId capture,
 * side-effect gating, stale-resume recovery).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the SDK ────────────────────────────────────────────────────────────
// Each test sets `scriptedRuns`: an array of async generators, one per
// startThread/resumeThread().runStreamed() call, consumed in order. `calls`
// records how each thread was created so we can assert resume vs fresh.
type Ev = Record<string, unknown>;
let scriptedRuns: Array<() => AsyncGenerator<Ev>>;
let runIdx: number;
const calls: Array<{ kind: 'start' | 'resume'; resumeId?: string; opts?: Record<string, unknown> }> = [];

function makeThread() {
  return {
    async runStreamed(_prompt: string) {
      void _prompt;
      const gen = scriptedRuns[runIdx++];
      if (!gen) throw new Error('no scripted run left');
      return { events: gen() };
    },
  };
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread(opts?: Record<string, unknown>) {
      calls.push({ kind: 'start', opts });
      return makeThread();
    }
    resumeThread(id: string, opts?: Record<string, unknown>) {
      calls.push({ kind: 'resume', resumeId: id, opts });
      return makeThread();
    }
  },
}));

import {
  queryAgent,
  buildCodexEnv,
  resolveSandbox,
  summarizeItem,
  buildThreadOptions,
  MAX_TOOL_PARAM_CHARS,
  isStreamInterruptError,
} from '../agent-bridge.js';
import type { Config } from '../config.js';

function cfg(overrides: Partial<Config['sdk']> = {}): Config {
  return {
    botToken: 't',
    apiUrl: 'https://example.com',
    baseDir: '/tmp/cco-test',
    cwd: '/tmp/cco-test/ws',
    cwdBase: '/tmp/cco-test/ws',
    dataDir: '/tmp/cco-test/data',
    sdk: { ...overrides },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
    dispatchTimeoutMs: 300000,
  } as Config;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

// Event helpers
const started = (id: string): Ev => ({ type: 'thread.started', thread_id: id });
const turnDone: Ev = { type: 'turn.completed', usage: {} };
const metadataNotice = 'Model metadata for `gpt-5.6-terra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
const modelChangeNotice = 'This session was recorded with model `gpt-5.5` but is resuming with `gpt-6-astra`. Consider switching back to `gpt-5.5` as it may affect Codex performance.';
const missingRolloutError = 'Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-4000-8000-000000000001 (code -32600)';
const msg = (id: string, text: string): Ev => ({
  type: 'item.completed',
  item: { id, type: 'agent_message', text },
});
const cmd = (id: string, command: string, phase: 'started' | 'completed'): Ev => ({
  type: `item.${phase}`,
  item: { id, type: 'command_execution', command, aggregated_output: 'SECRET OUTPUT', status: 'completed' },
});

beforeEach(() => {
  scriptedRuns = [];
  runIdx = 0;
  calls.length = 0;
});

describe('buildCodexEnv', () => {
  it('returns undefined when nothing to add', () => {
    expect(buildCodexEnv({}, { PATH: '/bin' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it('injects CODEX_HOME and drops undefined base vars', () => {
    const env = buildCodexEnv(
      { codexHome: '/home/bot/.codex' },
      { PATH: '/bin', EMPTY: undefined } as NodeJS.ProcessEnv,
    );
    expect(env?.CODEX_HOME).toBe('/home/bot/.codex');
    expect(env?.PATH).toBe('/bin');
    expect('EMPTY' in (env as object)).toBe(false);
  });
  it('layers operator env over base', () => {
    const env = buildCodexEnv(
      { env: { FOO: 'bar' }, codexHome: '/h' },
      { PATH: '/bin' } as NodeJS.ProcessEnv,
    );
    expect(env?.FOO).toBe('bar');
    expect(env?.CODEX_HOME).toBe('/h');
  });
});

describe('resolveSandbox', () => {
  it('defaults to read-only', () => {
    expect(resolveSandbox({})).toBe('read-only');
  });
  it('honors an explicit danger-full-access opt-out without the workspace-write gate', () => {
    expect(resolveSandbox({ sandboxMode: 'danger-full-access' })).toBe('danger-full-access');
  });
  it('downgrades workspace-write without allowWorkspaceWrite', () => {
    expect(resolveSandbox({ sandboxMode: 'workspace-write' })).toBe('read-only');
  });
  it('honors workspace-write with the gate on', () => {
    expect(resolveSandbox({ sandboxMode: 'workspace-write', allowWorkspaceWrite: true })).toBe(
      'workspace-write',
    );
  });
});

describe('buildThreadOptions', () => {
  it('parses network/webSearch from config (default off)', () => {
    const o = buildThreadOptions(cfg(), '/tmp/x');
    expect(o.networkAccessEnabled).toBe(false);
    expect(o.webSearchEnabled).toBe(false);
    expect(o.webSearchMode).toBe('disabled');
    expect(o.sandboxMode).toBe('read-only');
    expect(o.approvalPolicy).toBe('never');
    expect(o.modelReasoningEffort).toBe('medium');
  });
  it('enables web search live when configured', () => {
    const o = buildThreadOptions(cfg({ webSearchEnabled: true }), '/tmp/x');
    expect(o.webSearchEnabled).toBe(true);
    expect(o.webSearchMode).toBe('live');
  });
  it('reports unrestricted network and omits writable roots when sandboxing is disabled', () => {
    const o = buildThreadOptions(cfg({
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: false,
      additionalDirectories: ['/srv/shared'],
    }), '/tmp/x');
    expect(o.sandboxMode).toBe('danger-full-access');
    expect(o.networkAccessEnabled).toBe(true);
    expect(o.additionalDirectories).toBeUndefined();
    expect(o.approvalPolicy).toBe('never');
  });
  it('rejects invalid approvalPolicy', () => {
    expect(() => buildThreadOptions(cfg({ approvalPolicy: 'bogus' }), '/tmp/x')).toThrow();
  });
  it('attaches additionalDirectories under workspace-write', () => {
    const o = buildThreadOptions(
      cfg({ sandboxMode: 'workspace-write', allowWorkspaceWrite: true, additionalDirectories: ['/Users/caster/work-bus'] }),
      '/tmp/x',
    );
    expect(o.sandboxMode).toBe('workspace-write');
    expect(o.additionalDirectories).toEqual(['/Users/caster/work-bus']);
  });
  it('omits additionalDirectories under read-only (inert without write access)', () => {
    // sandbox stays read-only (gate off) → extra writable roots would be meaningless
    const o = buildThreadOptions(
      cfg({ sandboxMode: 'workspace-write', additionalDirectories: ['/Users/caster/work-bus'] }),
      '/tmp/x',
    );
    expect(o.sandboxMode).toBe('read-only');
    expect(o.additionalDirectories).toBeUndefined();
  });
  it('omits additionalDirectories for an empty array under workspace-write', () => {
    const o = buildThreadOptions(
      cfg({ sandboxMode: 'workspace-write', allowWorkspaceWrite: true, additionalDirectories: [] }),
      '/tmp/x',
    );
    expect(o.sandboxMode).toBe('workspace-write');
    expect(o.additionalDirectories).toBeUndefined();
  });
});

describe('summarizeItem redaction', () => {
  it('command_execution emits only the program name, never args or output', () => {
    const s = summarizeItem({
      id: '1',
      type: 'command_execution',
      command: '/usr/bin/git push --force origin main',
      aggregated_output: 'SECRET',
      status: 'completed',
    });
    // Only the program basename — args (which can carry secrets/paths) stripped.
    expect(s).toEqual({ name: 'command', detail: 'git' });
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(JSON.stringify(s)).not.toContain('force');
  });
  it('file_change emits only basenames, never diff', () => {
    const s = summarizeItem({
      id: '1',
      type: 'file_change',
      changes: [{ path: 'src/secret/keys.ts', kind: 'update' }],
      status: 'completed',
    });
    expect(s).toEqual({ name: 'file_change', detail: 'keys.ts' });
  });
  it('caps long detail at MAX_TOOL_PARAM_CHARS', () => {
    const s = summarizeItem({
      id: '1',
      type: 'web_search',
      query: 'x'.repeat(MAX_TOOL_PARAM_CHARS + 50),
    });
    expect(s!.detail.length).toBeLessThanOrEqual(MAX_TOOL_PARAM_CHARS + 1); // +1 for ellipsis
  });
  it('returns null for agent_message (not a progress item)', () => {
    expect(summarizeItem({ id: '1', type: 'agent_message', text: 'hi' })).toBeNull();
  });
});

describe('queryAgent event mapping', () => {
  it('yields the final agent message and captures threadId', async () => {
    const seen: string[] = [];
    scriptedRuns = [async function* () {
      yield started('tid-1');
      yield msg('m1', 'hello world');
      yield turnDone;
    }];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        onSessionId: (id) => seen.push(id),
      }),
    );
    expect(out.join('')).toBe('hello world');
    expect(seen).toEqual(['tid-1']);
    expect(calls[0].kind).toBe('start');
  });

  it('reports redacted progress for command items, never the final body for them', async () => {
    const progress: Array<[string, unknown]> = [];
    scriptedRuns = [async function* () {
      yield started('tid');
      yield cmd('c1', 'rm -rf /tmp/x', 'started');
      yield cmd('c1', 'rm -rf /tmp/x', 'completed');
      yield msg('m1', 'done');
      yield turnDone;
    }];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, (n, i) => progress.push([n, i])),
    );
    // The reply body is only the agent_message; command output never leaks.
    expect(out.join('')).toBe('done');
    expect(progress.some(([n]) => n === 'command')).toBe(true);
    expect(JSON.stringify(progress)).not.toContain('SECRET');
  });

  it('resumes when a resume id is given', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m', 'resumed reply');
      yield turnDone;
    }];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, { resume: 'old-tid' }),
    );
    expect(out.join('')).toBe('resumed reply');
    expect(calls[0]).toMatchObject({ kind: 'resume', resumeId: 'old-tid' });
  });

  it('throws on turn.failed', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'turn.failed', error: { message: 'boom' } };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('boom');
  });

  it('throws on a stream-level error event', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'error', message: 'stream broke' };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('stream broke');
  });

  it('throws on an ErrorItem (item.type=error) instead of producing no output', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'item.completed', item: { id: 'e1', type: 'error', message: 'tool blew up' } };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('tool blew up');
  });

  it.each([metadataNotice, modelChangeNotice])('drains a non-fatal notice before turn.started and returns the real reply: %s', async (notice) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onResumeFailed = vi.fn();
    const onSessionId = vi.fn();
    let drained = false;
    scriptedRuns = [async function* () {
      yield started('valid-tid');
      yield { type: 'item.completed', item: { id: 'e1', type: 'error', message: notice } };
      yield { type: 'turn.started' };
      yield msg('m1', '收到');
      yield turnDone;
      drained = true;
    }];
    try {
      const out = await collect(queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'valid-tid', onResumeFailed, onSessionId,
      }));
      expect(out).toEqual(['收到']);
      expect(drained).toBe(true);
      expect(warn).toHaveBeenCalledWith(`[codex-channel-octo] non-fatal codex notice: ${notice}`);
      expect(onSessionId).toHaveBeenCalledWith('valid-tid');
      expect(onResumeFailed).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    'Defaulting to fallback provider failed: authentication required',
    'Model metadata for `custom-model` not found. Unable to continue.',
    'Request failed: Model metadata for `custom-model` not found. Defaulting to fallback metadata;',
    'This session was recorded with model `gpt-5.5` but is resuming with `gpt-6-astra`. Authentication failed.',
    `Request failed: ${modelChangeNotice}`,
    `${modelChangeNotice} Authentication failed.`,
    modelChangeNotice.replace('switching back to `gpt-5.5`', 'switching back to `other-model`'),
  ])('still throws for a genuine error resembling a fallback notice: %s', async (message) => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'item.completed', item: { id: 'e1', type: 'error', message } };
      yield msg('m1', 'must not be returned');
      yield turnDone;
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow(message);
    expect(calls).toHaveLength(1);
  });

  it.each([metadataNotice, modelChangeNotice].flatMap((notice) =>
    ['turn.failed', 'error'].map((type) => ({ notice, type })),
  ))('still throws on $type after a benign notice: $notice', async ({ notice, type }) => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'item.completed', item: { id: 'e1', type: 'error', message: notice } };
      yield { type: 'turn.started' };
      yield { type, message: 'authentication failed', error: { message: 'authentication failed' } };
    }];
    await expect(collect(queryAgent('hi', cfg()))).rejects.toThrow('authentication failed');
    expect(calls).toHaveLength(1);
  });

  it('handles item.updated as a snapshot overwrite for agent_message', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'partial' } };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'final full text' } };
      yield turnDone;
    }];
    // Same id → one message, last snapshot wins (no duplication).
    const out = await collect(queryAgent('hi', cfg()));
    expect(out).toEqual(['final full text']);
  });

  it('yields multiple distinct agent_messages in first-seen order', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m1', 'first');
      yield msg('m2', 'second');
      yield turnDone;
    }];
    const out = await collect(queryAgent('hi', cfg()));
    expect(out).toEqual(['first', 'second']);
  });

  it('web_search is NOT a side effect — fresh-retry stays open after it', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        yield started('tid');
        yield { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'q' } };
        throw new Error('thread not found'); // stale resume AFTER a search
      },
      async function* () {
        yield started('new');
        yield msg('m', 'after-search recovery');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'dead',
        onResumeFailed: () => cleared.push(true),
        fallbackRetryPrompt: 'h',
      }),
    );
    expect(out.join('')).toBe('after-search recovery');
    expect(cleared).toEqual([true]);
    expect(calls.length).toBe(2); // resumed, then fresh retry
  });

  it('force-downgrade on AGENTS.md refresh failure also strips additionalDirectories', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m', 'ok');
      yield turnDone;
    }];
    // A cwd under a non-directory forces mkdirSync/writeFileSync to throw, so
    // writeAgentsMd returns false and this turn is forced to read-only.
    const c = cfg({
      sandboxMode: 'workspace-write',
      allowWorkspaceWrite: true,
      additionalDirectories: ['/Users/caster/work-bus'],
    });
    c.cwd = '/dev/null/ws';
    c.cwdBase = '/dev/null/ws';
    await collect(queryAgent('hi', c));
    // Downgraded to read-only AND the extra writable roots were dropped: a stale
    // AGENTS.md must never run with write access, including via lingering roots.
    expect(calls[0].opts?.sandboxMode).toBe('read-only');
    expect(calls[0].opts?.additionalDirectories).toBeUndefined();
  });

  it('stops before starting an unsandboxed turn if AGENTS.md cannot be refreshed', async () => {
    const c = cfg({ sandboxMode: 'danger-full-access' });
    c.cwd = '/dev/null/ws';
    c.cwdBase = '/dev/null/ws';
    await expect(collect(queryAgent('hi', c))).rejects.toThrow(/AGENTS.md refresh failed/);
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, 'tid-existing'])('forwards danger-full-access on fresh/resumed turns (%s)', async (resume) => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m', 'ok');
      yield turnDone;
    }];
    await collect(queryAgent('hi', cfg({ sandboxMode: 'danger-full-access' }), undefined, undefined, { resume }));
    expect(calls[0].opts?.sandboxMode).toBe('danger-full-access');
    expect(calls[0].opts?.networkAccessEnabled).toBe(true);
    expect(calls[0].kind).toBe(resume ? 'resume' : 'start');
  });

  it('forwards additionalDirectories on the resume path too (shared threadOpts)', async () => {
    scriptedRuns = [async function* () {
      yield started('tid');
      yield msg('m', 'resumed ok');
      yield turnDone;
    }];
    const c = cfg({
      sandboxMode: 'workspace-write',
      allowWorkspaceWrite: true,
      additionalDirectories: ['/Users/caster/work-bus'],
    });
    await collect(queryAgent('hi', c, undefined, undefined, { resume: 'tid-r' }));
    // resumeThread(resumeId, threadOpts) shares the same threadOpts as startThread,
    // so the extra writable roots are forwarded on resumed turns as well.
    expect(calls[0]).toMatchObject({ kind: 'resume', resumeId: 'tid-r' });
    expect(calls[0].opts?.additionalDirectories).toEqual(['/Users/caster/work-bus']);
  });
});

describe('isResumeError discrimination (via recovery behavior)', () => {
  // A non-stale error whose text merely contains "resume" must NOT trigger a
  // fresh retry (would drop a valid thread + re-hit upstream). We assert the
  // error propagates and no second run happens.
  it('does not treat a generic error containing the word "resume" as stale', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [async function* () {
      yield started('tid');
      throw new Error('rate limited while running codex exec resume');
    }];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'valid-tid',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'h',
        }),
      ),
    ).rejects.toThrow('rate limited');
    expect(cleared).toEqual([]); // id NOT cleared
    expect(calls.length).toBe(1); // NO fresh retry
  });

  it('treats "thread not found" as stale and recovers', async () => {
    scriptedRuns = [
      async function* () {
        yield started('tid');
        throw new Error('thread not found: abc');
      },
      async function* () {
        yield started('new');
        yield msg('m', 'ok');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'dead',
        fallbackRetryPrompt: 'h',
      }),
    );
    expect(out.join('')).toBe('ok');
    expect(calls.length).toBe(2);
  });
});

describe.each(['thread not found', missingRolloutError])('queryAgent stale-resume recovery: %s', (resumeError) => {
  it('retries fresh (with fallback prompt) when resume fails before any side effect', async () => {
    const cleared: boolean[] = [];
    const sessionIds: string[] = [];
    scriptedRuns = [
      // run 1: resume — fails immediately, no output/side-effect
      async function* () {
        yield started('tid');
        throw new Error(resumeError);
      },
      // run 2: fresh retry — succeeds
      async function* () {
        yield started('new-tid');
        yield msg('m', 'recovered');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'dead',
        onResumeFailed: () => cleared.push(true),
        onSessionId: (id) => sessionIds.push(id),
        fallbackRetryPrompt: 'history + hi',
      }),
    );
    expect(out.join('')).toBe('recovered');
    expect(cleared).toEqual([true]);
    expect(sessionIds).toEqual(['tid', 'new-tid']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ kind: 'resume', resumeId: 'dead' });
    expect(calls[1]).toMatchObject({ kind: 'start' });
  });

  it('does NOT fresh-retry when a side effect already happened (avoids duplicate work)', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        yield started('tid');
        yield cmd('c1', 'touch x', 'completed'); // side effect!
        throw new Error(resumeError);
      },
    ];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'dead',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'history + hi',
        }),
      ),
    ).rejects.toThrow();
    // id is still cleared (so next turn starts fresh) but no fresh retry ran.
    expect(cleared).toEqual([true]);
    expect(calls.length).toBe(1);
  });

  it('does not loop when the fresh retry also fails', async () => {
    const onResumeFailed = vi.fn();
    const fail = async function* () {
      yield { type: 'error', message: resumeError };
    };
    scriptedRuns = [fail, fail];
    await expect(collect(queryAgent('hi', cfg(), undefined, undefined, {
      resume: 'dead', onResumeFailed,
    }))).rejects.toThrow(resumeError);
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: 'start' });
  });
});

// ─── isStreamInterruptError (Step 1) ─────────────────────────────────────────
describe('isStreamInterruptError', () => {
  it('matches stream-interrupt phrases', () => {
    expect(isStreamInterruptError(new Error('stream closed before response.completed'))).toBe(true);
    expect(isStreamInterruptError(new Error('stream disconnected before completion'))).toBe(true);
    // Real log text: SDK wraps code 1 but the interrupt phrase is present.
    expect(
      isStreamInterruptError(
        new Error(
          'Codex Exec exited with code 1: Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)',
        ),
      ),
    ).toBe(true);
  });
  it('is case-insensitive and accepts a raw string', () => {
    expect(isStreamInterruptError('STREAM CLOSED BEFORE RESPONSE.COMPLETED')).toBe(true);
  });
  it('does NOT match non-interrupt errors', () => {
    // A bare code-1 exit with no interrupt phrase must NOT be swallowed into recovery.
    expect(isStreamInterruptError(new Error('Codex Exec exited with code 1: bad config'))).toBe(false);
    expect(isStreamInterruptError(new Error('rate limit exceeded, retry later'))).toBe(false);
    expect(isStreamInterruptError(new Error('thread not found'))).toBe(false);
    expect(isStreamInterruptError(new Error('no session found'))).toBe(false);
    expect(isStreamInterruptError(new Error('codex item error'))).toBe(false);
  });
});

// ─── stream-interrupt recovery (Step 3) ──────────────────────────────────────
const STREAM_ERR = 'stream closed before response.completed';
describe('queryAgent stream-interrupt recovery', () => {
  it('recovers by resuming the same thread after a mid-turn stream interrupt', async () => {
    scriptedRuns = [
      async function* () {
        yield started('tid-1');
        yield cmd('c1', 'ls', 'completed'); // side effect happened
        throw new Error(STREAM_ERR);
      },
      async function* () {
        // recovery run: resumes tid-1, no command re-run
        yield msg('m1', 'final answer');
        yield turnDone;
      },
    ];
    const out = await collect(queryAgent('hi', cfg(), undefined, undefined, {}));
    expect(out.join('')).toBe('final answer');
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ kind: 'resume', resumeId: 'tid-1' });
  });

  it('does NOT recover a non-interrupt error (no resume available)', async () => {
    scriptedRuns = [
      async function* () {
        yield started('tid-1');
        throw new Error('rate limit exceeded');
      },
    ];
    await expect(collect(queryAgent('hi', cfg(), undefined, undefined, {}))).rejects.toThrow(
      /rate limit/,
    );
    expect(calls.length).toBe(1);
  });

  it('recovers at most once (recovery run interrupts again → throws)', async () => {
    scriptedRuns = [
      async function* () {
        yield started('tid-1');
        throw new Error(STREAM_ERR);
      },
      async function* () {
        // recovery run also interrupts
        throw new Error(STREAM_ERR);
      },
    ];
    await expect(collect(queryAgent('hi', cfg(), undefined, undefined, {}))).rejects.toThrow();
    expect(calls.length).toBe(2); // no third attempt
  });

  it('recovers using opts.resume when interrupt hits before thread.started', async () => {
    scriptedRuns = [
      async function* () {
        // no thread.started emitted before the interrupt
        throw new Error(STREAM_ERR);
      },
      async function* () {
        yield msg('m1', 'ok');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, { resume: 'prev-tid' }),
    );
    expect(out.join('')).toBe('ok');
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ kind: 'resume', resumeId: 'prev-tid' });
  });

  it('cannot recover a fresh turn interrupted before thread.started', async () => {
    scriptedRuns = [
      async function* () {
        // fresh (no opts.resume), no thread.started, immediate interrupt
        throw new Error(STREAM_ERR);
      },
    ];
    await expect(collect(queryAgent('hi', cfg(), undefined, undefined, {}))).rejects.toThrow();
    expect(calls.length).toBe(1); // cap.threadId undefined → no recovery
  });

  it('stale-resume → fresh-retry → stream interrupt recovers on the fresh thread id, not the stale one', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        // main run: resume a stale id → resume error (not a stream interrupt)
        throw new Error('thread not found');
      },
      async function* () {
        // fresh-retry run: gets a NEW thread id, does work, then interrupts
        yield started('fresh-tid');
        yield cmd('c1', 'ls', 'completed');
        throw new Error(STREAM_ERR);
      },
      async function* () {
        // recovery run: must resume the FRESH id, not the stale opts.resume
        yield msg('m1', 'recovered answer');
        yield turnDone;
      },
    ];
    const out = await collect(
      queryAgent('hi', cfg(), undefined, undefined, {
        resume: 'stale-tid',
        onResumeFailed: () => cleared.push(true),
        fallbackRetryPrompt: 'history + hi',
      }),
    );
    expect(out.join('')).toBe('recovered answer');
    expect(cleared).toEqual([true]);
    expect(calls.length).toBe(3);
    expect(calls[1]).toMatchObject({ kind: 'start' });
    expect(calls[2]).toMatchObject({ kind: 'resume', resumeId: 'fresh-tid' });
  });

  it('does NOT recover with a stale id when fresh-retry interrupts before thread.started', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        throw new Error('thread not found');
      },
      async function* () {
        // fresh-retry interrupts BEFORE thread.started → cap.threadId stays undefined
        throw new Error(STREAM_ERR);
      },
    ];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'stale-tid',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'history + hi',
        }),
      ),
    ).rejects.toThrow();
    expect(cleared).toEqual([true]);
    // main(resume stale-tid) + fresh-retry(start) = 2; NO third recovery call.
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ kind: 'resume', resumeId: 'stale-tid' });
    expect(calls[1]).toMatchObject({ kind: 'start' });
  });

  it('recovery run failing with a resume error does not trigger another recovery', async () => {
    scriptedRuns = [
      async function* () {
        yield started('tid-1');
        throw new Error(STREAM_ERR);
      },
      async function* () {
        // recovery run throws a resume-type error; must NOT loop into more recovery
        throw new Error('thread not found');
      },
    ];
    await expect(collect(queryAgent('hi', cfg(), undefined, undefined, {}))).rejects.toThrow();
    expect(calls.length).toBe(2);
  });

  it('bounds stream recovery to once across a recovery→fresh-retry→re-interrupt chain', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        // main resume run interrupts → recovery
        yield started('tid-1');
        throw new Error(STREAM_ERR);
      },
      async function* () {
        // recovery run throws a resume error with NO side effect → bubbles to the
        // outer stale-resume branch, which fresh-retries
        throw new Error('thread not found');
      },
      async function* () {
        // fresh-retry run interrupts again — but recovery is already spent, so it
        // must NOT recover a second time
        yield started('fresh-tid');
        throw new Error(STREAM_ERR);
      },
    ];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'tid-1',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'history + hi',
        }),
      ),
    ).rejects.toThrow();
    expect(cleared).toEqual([true]);
    // main(resume) + recovery(resume) + fresh-retry(start) = 3; no 4th call.
    expect(calls.length).toBe(3);
    expect(calls[2]).toMatchObject({ kind: 'start' });
  });

  it('recovery run side effect blocks an outer fresh-retry', async () => {
    const cleared: boolean[] = [];
    scriptedRuns = [
      async function* () {
        // main resume run interrupts → recovery
        yield started('tid-1');
        throw new Error(STREAM_ERR);
      },
      async function* () {
        // recovery run does a side effect, then fails with a resume error
        yield cmd('c1', 'ls', 'completed');
        throw new Error('thread not found');
      },
    ];
    await expect(
      collect(
        queryAgent('hi', cfg(), undefined, undefined, {
          resume: 'tid-1',
          onResumeFailed: () => cleared.push(true),
          fallbackRetryPrompt: 'history + hi',
        }),
      ),
    ).rejects.toThrow();
    // sideEffect.seen carried from recovery run → outer must NOT fresh-retry.
    // calls: main(resume) + recovery(resume) = 2, no fresh start.
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.kind === 'start')).toBe(false);
  });
});
