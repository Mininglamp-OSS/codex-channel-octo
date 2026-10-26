/**
 * App-server attempt runner against a scripted child (mocked app-server, real
 * processes, pipes and process groups): ready sequence and C1 login, TB-0..TB-3
 * turn binding, event projection, the §6.3 classification and teardown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThreadEvent } from '@openai/codex-sdk';
import { startAppServerAttempt, AppServerAttemptFailure, AppServerExecution, type AppServerAttemptInput } from '../app-server/runner.js';
import { classifyFailure } from '../agent-failure.js';
import { processGroupStopped } from '../execution-scope.js';
import type { ManagedExecution } from '../execution-scope.js';
import type { AppServerAttemptCards } from '../cards/tool-host.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(scenario: string, extra: Partial<AppServerAttemptInput> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cco-runner-'));
  dirs.push(dir);
  const log = join(dir, 'frames.jsonl');
  const executions: ManagedExecution[] = [];
  const input: AppServerAttemptInput = {
    launch: { executable: process.execPath, args: [FAKE, scenario, log], env: { PATH: process.env.PATH ?? '' } },
    apiKey: 'sk-synthetic', prompt: 'hi',
    thread: { cwd: dir, sandbox: 'read-only', approvalPolicy: 'never' },
    onExecution: (e) => executions.push(e),
    readyMs: 2_000,
    ...extra,
  };
  const frames = (): Array<Record<string, unknown>> => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  return { input, frames, executions };
}

async function drain(it: AsyncIterable<ThreadEvent>): Promise<{ events: ThreadEvent[]; error?: unknown }> {
  const events: ThreadEvent[] = [];
  try { for await (const ev of it) events.push(ev); } catch (error) { return { events, error }; }
  return { events };
}

async function stopped(executions: ManagedExecution[]): Promise<boolean> {
  return (executions[0] as AppServerExecution).waitForStopped(5_000);
}

describe('ready sequence and C1 login (mocked app-server)', () => {
  it('logs in with the API key over the pipe, then checks account/read, before thread/start', async () => {
    const h = setup('ok');
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeUndefined();
    const methods = h.frames().map((f) => f.method).filter(Boolean);
    expect(methods.slice(0, 5)).toEqual(['initialize', 'initialized', 'account/login/start', 'account/read', 'thread/start']);
    const login = h.frames().find((f) => f.method === 'account/login/start')!;
    expect(login.params).toEqual({ type: 'apiKey', apiKey: 'sk-synthetic' });
    const init = h.frames()[0].params as { capabilities: Record<string, unknown> };
    expect(init.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(await stopped(h.executions)).toBe(true);
  });

  it.each([
    ['login-reject', 'auth_login_rejected'],
    ['account-mismatch', 'auth_mode_mismatch'],
    ['hang-ready', 'ready_timeout'],
  ])('%s fails post-spawn as %s, never retry-eligible', async (scenario, cls) => {
    const h = setup(scenario, { readyMs: 300 });
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeInstanceOf(AppServerAttemptFailure);
    expect((r.error as AppServerAttemptFailure).failureClass).toBe(cls);
    expect(classifyFailure(r.error).stage).not.toBe('spawn');
    expect(h.frames().some((f) => f.method === 'turn/start')).toBe(false);
    expect(await stopped(h.executions)).toBe(true);
  });

  it('resumes by the stored id with no tool parameter (T1)', async () => {
    const h = setup('ok', { resumeId: 'thr-1' });
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeUndefined();
    const resume = h.frames().find((f) => f.method === 'thread/resume')!;
    expect(resume.params).toMatchObject({ threadId: 'thr-1', sandbox: 'read-only', approvalPolicy: 'never' });
    expect(resume.params).not.toHaveProperty('dynamicTools');
    expect(h.frames().some((f) => f.method === 'thread/start')).toBe(false);
  });
});

describe('§6.3 start classification', () => {
  it('a structured OS spawn error propagates untouched, before any frame', async () => {
    const h = setup('ok');
    const r = await drain(startAppServerAttempt({ ...h.input, launch: { ...h.input.launch, executable: join(h.input.thread.cwd, 'missing-binary') } }));
    const snap = classifyFailure(r.error);
    expect(snap.stage).toBe('spawn');
    expect(snap.evidence).toBe('structured');
    expect(r.events).toEqual([]);
    expect(await (h.executions[0] as AppServerExecution).waitForStopped(100)).toBe(true);
  });

  it('a crash after turn/start is a post-spawn failure', async () => {
    const h = setup('crash');
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeInstanceOf(AppServerAttemptFailure);
    expect(classifyFailure(r.error).stage).toBe('process_exit');
  });
});

describe('turn binding (TB-0..TB-3, addendum A1)', () => {
  it('binds from turn/started that precedes the turn/start response (E2)', async () => {
    const h = setup('ok');
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.events.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.started', 'item.completed', 'item.completed', 'turn.completed']);
    expect(h.frames().filter((f) => f.method === 'turn/start')).toHaveLength(1);
  });

  it('binds from the response when it arrives first (TB-2)', async () => {
    const r = await drain(startAppServerAttempt(setup('response-first').input));
    expect(r.error).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe('turn.completed');
  });

  it.each([
    ['mismatch', 'turn_binding_mismatch'],      // (b) response id differs from the bound id
    ['second-turn', 'turn_binding_mismatch'],   // (c) another turn/started inside the window
    ['prestart', 'turn_binding_mismatch'],      // (d) turn activity before our turn/start
    ['turn-error', 'turn_rejected'],            // (a) JSON-RPC error response
  ])('%s closes the attempt (%s)', async (scenario, cls) => {
    const h = setup(scenario, scenario === 'prestart' ? { resumeId: 'thr-1' } : {});
    const r = await drain(startAppServerAttempt(h.input));
    expect((r.error as AppServerAttemptFailure).failureClass).toBe(cls);
    expect(await stopped(h.executions)).toBe(true);
  });

  // B1: the thread reply and the old turn's frames arrive in one chunk, before the thread id is known.
  it.each([
    ['coalesced-prestart', {}],
    ['coalesced-prestart', { resumeId: 'thr-1' }],
    ['coalesced-prestart-call', { resumeId: 'thr-1' }],
  ] as const)('%s %o: activity coalesced with the thread reply closes as turn_binding_mismatch (TB-3(d))', async (scenario, extra) => {
    const h = setup(scenario, extra);
    const r = await drain(startAppServerAttempt(h.input));
    expect((r.error as AppServerAttemptFailure).failureClass).toBe('turn_binding_mismatch');
    expect(r.events.map((e) => e.type)).toEqual(['thread.started']);
    expect(JSON.stringify(r.events)).not.toContain('OLD TURN OUTPUT');
    expect(await stopped(h.executions)).toBe(true);
  });

  it('a resumed thread replaying the last turn\'s token usage is not pre-start activity', async () => {
    const h = setup('resume-usage-replay', { resumeId: 'thr-1' });
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe('turn.completed');
  });

  // B2: our turn reaches its terminal before the turn/start response settles.
  it.each([
    ['terminal-error', 'turn_rejected'],
    ['terminal-error-split', 'turn_rejected'],
    ['terminal-mismatch', 'turn_binding_mismatch'],
    ['terminal-mismatch-split', 'turn_binding_mismatch'],
    ['terminal-no-response', 'turn_binding_mismatch'],
  ])('%s: the terminal stays provisional and the attempt closes as %s (TB-3(a)/(b))', async (scenario, cls) => {
    const h = setup(scenario, { settleMs: 300 });
    const t0 = performance.now();
    const r = await drain(startAppServerAttempt(h.input));
    expect((r.error as AppServerAttemptFailure).failureClass).toBe(cls);
    expect(classifyFailure(r.error).stage).not.toBe('spawn');
    expect(r.events.some((e) => e.type === 'turn.completed')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(await stopped(h.executions)).toBe(true);
  });

  it.each(['terminal-ok', 'terminal-ok-split'])('%s: the terminal is released once the response matches', async (scenario) => {
    const h = setup(scenario, { settleMs: 2_000 });
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe('turn.completed');
    expect(await stopped(h.executions)).toBe(true);
  });

  // TB-3(c) during terminal settlement: a different turn/started on our thread that
  // was read before the turn/start response keeps ownership uncertain, wherever it
  // falls relative to our terminal and however the frames were chunked.
  const recordingCards = (calls: string[]) => (): AppServerAttemptCards => ({
    dynamicTools: [], toolsetDigest: 'd',
    setThread: () => calls.push('setThread'),
    turnStartEnqueued: () => calls.push('turnStartEnqueued'),
    bindTurn: (id) => calls.push(`bindTurn:${id}`),
    turnCompleted: () => calls.push('turnCompleted'),
    onToolCall: (id) => calls.push(`call:${String(id)}`),
    close: () => calls.push('close'),
  });
  const STREAMED = ['thread.started', 'turn.started', 'item.started', 'item.completed', 'item.completed'];

  it.each([
    ['terminal-conflict-split', {}, 'turn_binding_mismatch'],
    ['terminal-conflict-split', { resumeId: 'thr-1' }, 'turn_binding_mismatch'],
    ['terminal-conflict', {}, 'turn_binding_mismatch'],
    ['terminal-conflict', { resumeId: 'thr-1' }, 'turn_binding_mismatch'],
    ['conflict-response', {}, 'turn_binding_mismatch'],
    ['conflict-response', { resumeId: 'thr-1' }, 'turn_binding_mismatch'],
    ['terminal-conflict-error-split', {}, 'turn_rejected'],
    ['terminal-conflict-mismatch-split', {}, 'turn_binding_mismatch'],
    ['terminal-conflict-no-response', {}, 'turn_binding_mismatch'],
  ] as const)('%s %o: a conflict read before the response closes as %s, never completed (TB-3(c))', async (scenario, extra, cls) => {
    const calls: string[] = [];
    const h = setup(scenario, { ...extra, cards: recordingCards(calls), settleMs: scenario === 'terminal-conflict-no-response' ? 300 : 2_000 });
    const t0 = performance.now();
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeInstanceOf(AppServerAttemptFailure);
    expect((r.error as AppServerAttemptFailure).failureClass).toBe(cls);
    expect(classifyFailure(r.error).stage).not.toBe('spawn');
    expect(r.events.some((e) => e.type === 'turn.completed')).toBe(false);
    if (scenario !== 'terminal-conflict-mismatch-split') expect(r.events.map((e) => e.type)).toEqual(scenario === 'conflict-response' ? ['thread.started', 'turn.started'] : STREAMED);
    expect(calls).not.toContain('turnCompleted');
    expect(calls).toContain('close');
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(h.frames().filter((f) => f.method === 'turn/start')).toHaveLength(1);
    expect(await stopped(h.executions)).toBe(true);
  });

  it.each([
    ['terminal-response-conflict', {}],
    ['terminal-response-conflict', { resumeId: 'thr-1' }],
    ['terminal-other-thread-split', {}],
    ['terminal-same-turn-split', {}],
    ['terminal-same-turn-split', { resumeId: 'thr-1' }],
  ] as const)('%s %o: activity that is not a conflict before the response still completes', async (scenario, extra) => {
    const calls: string[] = [];
    const h = setup(scenario, { ...extra, cards: recordingCards(calls), settleMs: 2_000 });
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeUndefined();
    expect(r.events.map((e) => e.type)).toEqual([...STREAMED, 'turn.completed']);
    expect(calls).toContain('turnCompleted');
    expect(await stopped(h.executions)).toBe(true);
  });

  // The abort is observed when the settle wait ends (bounded by settleMs), as before.
  it('an abort while a conflicted terminal settles fails without completing', async () => {
    const calls: string[] = [];
    const ac = new AbortController();
    const h = setup('terminal-conflict-no-response', { cards: recordingCards(calls), settleMs: 600, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const t0 = performance.now();
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeDefined();
    expect(r.events.some((e) => e.type === 'turn.completed')).toBe(false);
    expect(calls).not.toContain('turnCompleted');
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(await stopped(h.executions)).toBe(true);
  });

  it('a held call does not outlive a terminal whose response errors', async () => {
    const calls: string[] = [];
    const cards = (): AppServerAttemptCards => ({
      dynamicTools: [], toolsetDigest: 'd',
      setThread: () => calls.push('setThread'),
      turnStartEnqueued: () => calls.push('turnStartEnqueued'),
      bindTurn: (id) => calls.push(`bindTurn:${id}`),
      turnCompleted: () => calls.push('turnCompleted'),
      onToolCall: (id) => calls.push(`call:${String(id)}`),
      close: () => calls.push('close'),
    });
    const h = setup('held-call-terminal-error', { cards, settleMs: 2_000 });
    const r = await drain(startAppServerAttempt(h.input));
    expect((r.error as AppServerAttemptFailure).failureClass).toBe('turn_rejected');
    expect(r.events.some((e) => e.type === 'turn.completed')).toBe(false);
    expect(calls).toContain('call:srv-held');
    expect(calls).not.toContain('turnCompleted');
    expect(calls).toContain('close');
    expect(await stopped(h.executions)).toBe(true);
  });

  it('drops foreign turns and other threads after the window (TB-4)', async () => {
    const r = await drain(startAppServerAttempt(setup('foreign').input));
    expect(r.error).toBeUndefined();
    const texts = r.events.flatMap((e) => (e.type === 'item.completed' && e.item.type === 'agent_message' ? [e.item.text] : []));
    expect(texts).toEqual(['hello']);
  });
});

describe('event projection (G-A1, mocked)', () => {
  it('projects items to the SDK shape with phase, status and usage', async () => {
    const r = await drain(startAppServerAttempt(setup('ok').input));
    const cmd = r.events.find((e) => e.type === 'item.completed' && e.item.type === 'command_execution');
    expect(cmd).toMatchObject({ item: { id: 'cmd1', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } });
    const msg = r.events.find((e) => e.type === 'item.completed' && e.item.type === 'agent_message');
    expect(msg).toMatchObject({ item: { text: 'hello', phase: 'final_answer' } });
    expect(r.events.at(-1)).toEqual({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } });
  });

  it('a willRetry notice projects to nothing', async () => {
    const r = await drain(startAppServerAttempt(setup('retry').input));
    expect(r.events.some((e) => e.type === 'error')).toBe(false);
    expect(r.events.at(-1)?.type).toBe('turn.completed');
  });

  it('a final error projects to error then turn.failed', async () => {
    const r = await drain(startAppServerAttempt(setup('failed').input));
    expect(r.events.slice(-2)).toEqual([
      { type: 'error', message: 'stream disconnected before completion' },
      { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
    ]);
  });

  it('answers item/tool/call with an uncharged refusal and approvals with decline', async () => {
    const h = setup('tool-call');
    const r = await drain(startAppServerAttempt(h.input));
    expect(r.error).toBeUndefined();
    const replies = h.frames().filter((f) => f.method === undefined);
    expect(replies).toEqual([
      { id: 'srv-1', result: { contentItems: [{ type: 'inputText', text: 'explicit cards are unavailable' }], success: false } },
      { id: 'srv-2', result: { decision: 'decline' } },
    ]);
  });
});

describe('cancel, interrupt and EOF', () => {
  it('closing the stream mid-turn sends turn/interrupt, then EOF; the group stops', async () => {
    const h = setup('interrupt');
    const it = startAppServerAttempt(h.input)[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: 'thread.started' });
    expect((await it.next()).value).toMatchObject({ type: 'turn.started' });
    await it.return(undefined);
    expect(await stopped(h.executions)).toBe(true);
    expect(h.frames().some((f) => f.method === 'turn/interrupt')).toBe(true);
    expect(await processGroupStopped((h.executions[0] as AppServerExecution).pid!)).toBe(true);
  });

  it('an abort signal interrupts a hanging turn', async () => {
    const ac = new AbortController();
    const h = setup('hang', { signal: ac.signal });
    const it = startAppServerAttempt(h.input)[Symbol.asyncIterator]();
    await it.next(); await it.next();
    const pending = it.next();
    ac.abort();
    const r = await pending.then(() => undefined, (e: unknown) => e);
    expect(r).toBeDefined();
    expect(await stopped(h.executions)).toBe(true);
    expect(h.frames().some((f) => f.method === 'turn/interrupt')).toBe(true);
  });

  it('after a completed turn the child exits on stdin EOF', async () => {
    const h = setup('ok');
    await drain(startAppServerAttempt(h.input));
    const exec = h.executions[0] as AppServerExecution;
    expect(await exec.waitClosed(5_000)).toBe(true);
    expect(exec.exited).toBe(true);
  });
});
