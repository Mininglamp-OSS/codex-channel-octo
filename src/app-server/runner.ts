/**
 * One attempt on a gateway-owned `codex app-server` stdio child.
 *
 * Lifecycle: spawn (own process group) → `initialize` → `account/login/start`
 * with the API key over the pipe → `account/read` must report API-key auth →
 * `thread/start` or `thread/resume` → exactly one `turn/start` → projected
 * events until `turn/completed` → stdin EOF → exit. The ready phase is bounded
 * by {@link APP_SERVER_READY_MS}.
 *
 * Classification (E10, unchanged from `exec`): the caller sets risk to
 * `unknown` immediately before {@link startAppServerAttempt}. Only a
 * structured OS spawn error, observed before the child reported `spawn` and
 * before any frame was enqueued, propagates as the original spawn error
 * (the only retry-eligible failure). Everything after spawn fails as an
 * {@link AgentFailure} that recovery never retries.
 *
 * Turn binding (TB-0..TB-3, addendum A1): our single `turn/start` binds the
 * first matching `turn/started` or its response, whichever comes first. A
 * JSON-RPC error response, a response id that differs from a bound id, a
 * different `turn/started` read before both were seen, or any turn activity on
 * our thread before `turn/start` was enqueued closes the attempt. After both
 * were seen, other turn ids are foreign and dropped. A terminal that arrives
 * before the response stays provisional until the response settles, within
 * {@link TERMINAL_SETTLE_MS}; no response by then, or a different `turn/started`
 * still queued that was read before the response, also closes the attempt.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { ThreadEvent } from '@openai/codex-sdk';
import { AgentFailure, type FailureCategory } from '../agent-failure.js';
import { processGroupStopped, stopProcessGroup, type ManagedExecution } from '../execution-scope.js';
import { AppServerClient, RpcError, toolRefusal, type CloseReason } from './client.js';
import { TurnProjector } from './events.js';
import type { AppServerLaunch } from './spawn.js';
import type { AppServerAttemptCards, AppServerReplyPort } from '../cards/tool-host.js';

export const APP_SERVER_READY_MS = 10_000;
export const INTERRUPT_BOUND_MS = 5_000;
export const CHILD_EXIT_BOUND_MS = 10_000;
/** Wait for the `turn/start` response after a terminal; within the R-7 interrupt bound. */
export const TERMINAL_SETTLE_MS = INTERRUPT_BOUND_MS;
/** Distinct threads with pre-enqueue turn activity remembered before the thread id is known. */
export const PRESTART_THREADS_MAX = 32;

/** Maximum terminal identities retained while the asynchronous binding settles. */
const READ_TERMINALS_MAX = 32;

/** Bounded failure classes after spawn (§10.1); logged by name only. */
export type AppServerFailureClass =
  | 'auth_login_rejected' | 'auth_mode_mismatch' | 'ready_timeout' | 'child_exit_before_ready'
  | 'thread_rejected' | 'turn_rejected' | 'turn_binding_mismatch' | 'child_exit' | 'transport_closed';

export class AppServerAttemptFailure extends AgentFailure {
  constructor(readonly failureClass: AppServerFailureClass, category: FailureCategory) {
    super({ stage: 'process_exit', category, source: 'local', evidence: 'structured' });
  }
}

export interface AppServerThreadParams {
  readonly cwd: string;
  readonly model?: string;
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approvalPolicy: string;
}

export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface AppServerAttemptInput {
  readonly launch: AppServerLaunch;
  readonly apiKey: string;
  readonly thread: AppServerThreadParams;
  readonly resumeId?: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  /** Called synchronously once the child exists, before any frame is written. */
  readonly onExecution?: (execution: ManagedExecution) => void;
  /** A completed dynamic tool call (card activity, never text). */
  readonly onCardEffect?: () => void;
  readonly spawnImpl?: SpawnImpl;
  readonly clientName?: string;
  /** Test seam for {@link APP_SERVER_READY_MS}. */
  readonly readyMs?: number;
  /** Test seam for {@link TERMINAL_SETTLE_MS}. */
  readonly settleMs?: number;
  /**
   * Explicit cards for this attempt: called once before spawn (the per-attempt
   * G-d admit) with a port that answers on this child. Absent or undefined ⇒
   * every `item/tool/call` gets an uncharged refusal.
   */
  readonly cards?: (port: AppServerReplyPort) => AppServerAttemptCards | undefined;
  /** Toolset digest the resumed thread was created with (T0); null/absent = none. */
  readonly threadToolsetDigest?: string | null;
  /** The toolset of the thread this attempt ran on: the new digest, or the resumed one. */
  readonly onThreadToolset?: (digest: string | null) => void;
  /** Availability line for the model (`developerInstructions` on start and resume). */
  readonly developerInstructions?: string;
  /** Gateway notice sent as its own `turn/start` input item ahead of the prompt (D3). */
  readonly turnNotice?: string;
}

/** `afterResponse`: the `turn/start` response frame had been read when this arrived. */
interface Notice { readonly method: string; readonly params: unknown; readonly afterResponse: boolean }

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Gateway-owned handle and process group of one child. */
export class AppServerExecution implements ManagedExecution {
  private closed = false;
  private normalExit = false;
  private stopping: Promise<void> | undefined;
  private readonly closedWaiters: Array<() => void> = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.once('close', (code, signal) => {
      this.closed = true;
      this.normalExit = code === 0 && !signal;
      for (const w of this.closedWaiters.splice(0)) w();
    });
  }

  get pid(): number | undefined { return this.child.pid; }
  get exited(): boolean { return this.closed; }

  /** Resolves when the child has closed or after `ms`. */
  waitClosed(ms: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.closed), ms);
      this.closedWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  /** SIGTERM/SIGKILL the whole group, verified; idempotent. */
  kill(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) return Promise.resolve();
    try { this.child.stdin.destroy(); } catch { /* gone */ }
    return this.stopping ??= stopProcessGroup(pid);
  }

  async waitForStopped(timeoutMs: number): Promise<boolean> {
    const pid = this.child.pid;
    if (pid === undefined) return true; // never started
    if (!(this.closed && await processGroupStopped(pid))) void this.kill();
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (this.closed && await processGroupStopped(pid)) return true;
      if (performance.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - performance.now()))));
    }
  }

  dispose(): void {
    if (!this.normalExit) void this.kill();
  }
}

/** Async FIFO of notifications with a terminal close. */
class NoticeQueue {
  private readonly items: Notice[] = [];
  private waiter: (() => void) | undefined;
  private ended: CloseReason | undefined;
  push(n: Notice): void { this.items.push(n); this.wake(); }
  end(reason: CloseReason): void { this.ended ??= reason; this.wake(); }
  get endedBy(): CloseReason | undefined { return this.ended; }
  /** Notices not yet taken, oldest first. */
  pending(): readonly Notice[] { return this.items; }
  private wake(): void { const w = this.waiter; this.waiter = undefined; w?.(); }
  async next(): Promise<Notice | undefined> {
    for (;;) {
      const n = this.items.shift();
      if (n !== undefined) return n;
      if (this.ended !== undefined) return undefined;
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => { t = setTimeout(() => { onTimeout(); reject(new AppServerAttemptFailure('ready_timeout', 'timeout')); }, ms); }),
  ]);
}

/** Resolves when `p` settles or after `ms`, whichever is first. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<void>((r) => { t = setTimeout(r, ms); })]).then(() => undefined).finally(() => clearTimeout(t));
}

/** Wait for the OS to report the child started; a spawn error is rethrown untouched. */
function spawned(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => { child.removeListener('spawn', onSpawn); reject(err); };
    const onSpawn = (): void => { child.removeListener('error', onError); child.on('error', () => {}); resolve(); };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

/**
 * Run one attempt. The returned iterable yields SDK-shaped events, starting
 * with `thread.started`, and ends after the terminal event. Closing it early
 * (abort, consumer error) interrupts the turn and tears the child down within
 * the R-7 bounds.
 */
export async function* startAppServerAttempt(input: AppServerAttemptInput): AsyncGenerator<ThreadEvent> {
  const spawnImpl = input.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  // Per-attempt G-d immediately before spawn; replies go to this child's client once it exists.
  let respond: AppServerReplyPort['respond'] = () => false;
  const cards = input.cards?.({ respond: (id, result, opts) => respond(id, result, opts) });
  const child = spawnImpl(input.launch.executable, input.launch.args, {
    cwd: input.thread.cwd, env: { ...input.launch.env }, detached: process.platform !== 'win32', stdio: 'pipe',
  } as SpawnOptionsWithoutStdio);
  const execution = new AppServerExecution(child);
  input.onExecution?.(execution);
  await spawned(child); // structured spawn errors propagate here, before any frame

  const queue = new NoticeQueue();
  let threadId = '';
  // Admission follows synchronous pipe read order, independently of the
  // consumer's provisional completion/response checks. Bound memory even if
  // a child emits terminals for many foreign turns; overflow denies tools.
  const readTerminals = new Set<string>();
  let terminalOverflow = false;
  const admissionEnded = (id: string): boolean => terminalOverflow || readTerminals.has(id);

  // TB-3(d): turn activity on our thread before our only turn/start was enqueued.
  // A chunk is dispatched synchronously, so activity coalesced with the thread
  // reply arrives before the thread id is known: remember its thread ids and
  // reconcile them once the id is set. Past the cap this fails closed.
  let prestartActivity = false;
  const prestartThreads = new Set<string>();
  const prestart = (params: unknown): void => {
    if (client.turnStartEnqueued) return;
    const t = obj(params).threadId;
    if (threadId !== '') { if (t === threadId) prestartActivity = true; return; }
    if (typeof t !== 'string') return;
    if (prestartThreads.size < PRESTART_THREADS_MAX) prestartThreads.add(t);
    else if (!prestartThreads.has(t)) prestartActivity = true;
  };
  const client: AppServerClient = new AppServerClient(child.stdin, child.stdout, {
    onNotification: (method, params) => {
      // Only a live turn/started counts: a cold resume replays the last turn's token usage.
      if (method === 'turn/started') prestart(params);
      if (method === 'turn/completed' && client.turnStartEnqueued) {
        const p = obj(params), id = obj(p.turn).id;
        if (p.threadId === threadId && typeof id === 'string') {
          if (readTerminals.size < READ_TERMINALS_MAX) readTerminals.add(id);
          else if (!readTerminals.has(id)) terminalOverflow = true;
        }
      }
      // TB-3(c) is judged on read order: the response resolves in this reader, observers a microtask later.
      queue.push({ method, params, afterResponse: client.turnStartResponded });
    },
    onToolCall: (r) => {
      prestart(r.params);
      const p = obj(r.params);
      if (p.threadId === threadId && typeof p.turnId === 'string' && admissionEnded(p.turnId)) {
        client.respond(r.id, toolRefusal('explicit cards are unavailable'), { uncharged: true });
      } else if (cards !== undefined) cards.onToolCall(r.id, r.params);
      else client.respond(r.id, toolRefusal('explicit cards are unavailable'), { uncharged: true });
    },
    onClose: (reason) => { cards?.close(); queue.end(reason); void execution.kill(); },
  });
  respond = (id, result, opts) => client.respond(id, result, opts);
  child.stderr.resume();
  child.once('close', () => { client.close('eof'); });

  let turnId: string | null = null;
  let startedSeen = false;
  let terminal = false;
  const fail = (cls: AppServerFailureClass, category: FailureCategory = 'process_exit'): never => {
    console.warn(`[codex-channel-octo] app-server attempt failed: ${cls}`);
    cards?.close();
    client.close('owner');
    throw new AppServerAttemptFailure(cls, category);
  };
  const onAbort = (): void => { void teardown(true); };
  let tornDown: Promise<void> | undefined;
  const teardown = (interrupt: boolean): Promise<void> => tornDown ??= (async () => {
    if (interrupt && turnId !== null && !terminal && client.closed === undefined) {
      try { client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined); } catch { /* closed */ }
      const deadline = Date.now() + INTERRUPT_BOUND_MS;
      while (!terminal && queue.endedBy === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    }
    try { child.stdin.end(); } catch { /* gone */ }
    if (!(await execution.waitClosed(CHILD_EXIT_BOUND_MS))) await execution.kill();
    else if (execution.pid !== undefined && !(await processGroupStopped(execution.pid))) await execution.kill();
  })();
  input.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // ── ready phase ──
    await withTimeout((async () => {
      await client.request('initialize', {
        clientInfo: { name: input.clientName ?? 'codex_channel_octo', title: null, version: '0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      client.notify('initialized');
      let login: unknown;
      try { login = await client.request('account/login/start', { type: 'apiKey', apiKey: input.apiKey }); }
      catch (e) { if (e instanceof RpcError) fail('auth_login_rejected', 'auth'); throw e; }
      if (obj(login).type !== 'apiKey') fail('auth_mode_mismatch', 'auth');
      const account = obj(obj(await client.request('account/read', {})).account);
      if (account.type !== 'apiKey') fail('auth_mode_mismatch', 'auth');
      const params = {
        cwd: input.thread.cwd, sandbox: input.thread.sandbox, approvalPolicy: input.thread.approvalPolicy,
        ...(input.thread.model ? { model: input.thread.model } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
      };
      let opened: unknown;
      try {
        // T1: tools are declared only when a thread starts, never on resume.
        opened = input.resumeId
          ? await client.request('thread/resume', { threadId: input.resumeId, ...params })
          : await client.request('thread/start', { ...params, ...(cards ? { dynamicTools: cards.dynamicTools } : {}) });
      } catch (e) { if (e instanceof RpcError) fail('thread_rejected', 'invalid_config'); throw e; }
      const o = obj(opened);
      threadId = typeof obj(o.thread).id === 'string' ? obj(o.thread).id as string : '';
      if (!threadId || (input.resumeId && threadId !== input.resumeId)) fail('thread_rejected', 'invalid_config');
      if (prestartThreads.has(threadId)) prestartActivity = true;
      prestartThreads.clear();
      if (o.approvalPolicy !== input.thread.approvalPolicy) fail('thread_rejected', 'invalid_config');
      const toolset = input.resumeId ? (input.threadToolsetDigest ?? null) : (cards?.toolsetDigest ?? null);
      cards?.setThread(threadId, toolset);
      input.onThreadToolset?.(toolset);
    })(), input.readyMs ?? APP_SERVER_READY_MS, () => client.close('owner')).catch((e: unknown) => {
      if (e instanceof AgentFailure) throw e;
      return fail(queue.endedBy === 'eof' || execution.exited ? 'child_exit_before_ready' : 'transport_closed');
    });
    input.signal?.throwIfAborted();
    yield { type: 'thread.started', thread_id: threadId };

    // ── turn ──
    if (prestartActivity) fail('turn_binding_mismatch');
    const turnInput = [
      ...(input.turnNotice ? [{ type: 'text', text: input.turnNotice, text_elements: [] }] : []),
      { type: 'text', text: input.prompt, text_elements: [] },
    ];
    // TB-0: the frame is enqueued synchronously below; nothing runs in between.
    cards?.turnStartEnqueued();
    const response = client.request('turn/start', { threadId, input: turnInput })
      .then((r) => {
        const id = obj(obj(r).turn).id;
        if (typeof id !== 'string') return 'mismatch' as const;
        if (turnId === null) { turnId = id; if (!admissionEnded(id)) cards?.bindTurn(id); return 'ok' as const; }
        return turnId === id ? 'ok' as const : 'mismatch' as const;
      }, (e: unknown) => (e instanceof RpcError ? 'error' as const : 'closed' as const));
    let responseState: 'ok' | 'mismatch' | 'error' | 'closed' | undefined;
    const settled = response.then((s) => { responseState = s; queue.push({ method: '__turn_start_response', params: null, afterResponse: true }); });
    const checkResponse = (): void => {
      if (responseState === 'error') fail('turn_rejected');
      if (responseState === 'mismatch') fail('turn_binding_mismatch');
      if (responseState === 'closed') fail(execution.exited ? 'child_exit' : 'transport_closed');
    };
    /** A different turn starting on our thread. */
    const otherTurnStarted = (n: Notice): boolean => {
      if (n.method !== 'turn/started') return false;
      const p = obj(n.params);
      const id = obj(p.turn).id;
      return p.threadId === threadId && typeof id === 'string' && id !== turnId;
    };

    let projector: TurnProjector | undefined;
    for (;;) {
      const n = await queue.next();
      input.signal?.throwIfAborted();
      if (n === undefined) {
        if (terminal) break;
        fail(execution.exited ? 'child_exit' : 'transport_closed');
      }
      const note = n as Notice;
      if (prestartActivity) fail('turn_binding_mismatch');
      if (note.method === '__turn_start_response') { checkResponse(); continue; }
      const p = obj(note.params);
      if (p.threadId !== threadId) continue; // other threads never reach this projection
      if (note.method === 'turn/started') {
        const id = obj(p.turn).id;
        if (typeof id !== 'string') continue;
        if (turnId === null) { turnId = id; startedSeen = true; if (!admissionEnded(id)) cards?.bindTurn(id); }
        else if (id !== turnId) {
          if (!(note.afterResponse && startedSeen)) fail('turn_binding_mismatch'); // TB-3(c)
          continue; // TB-4 foreign
        } else startedSeen = true;
      } else {
        const noteTurn = typeof p.turnId === 'string' ? p.turnId : obj(p.turn).id;
        if (turnId === null || noteTurn !== turnId) continue; // unbound or foreign
      }
      projector ??= new TurnProjector(turnId!);
      for (const out of projector.project(note.method, note.params)) {
        if (out.kind === 'card_effect') { input.onCardEffect?.(); continue; }
        if (out.kind === 'retry_notice') { console.warn('[codex-channel-octo] app-server reconnect notice'); continue; }
        if (out.kind === 'terminal') {
          // TB-3(a)/(b): provisional until the response settles; an unconfirmed turn never completes.
          if (responseState === undefined) await settledWithin(settled, input.settleMs ?? TERMINAL_SETTLE_MS);
          input.signal?.throwIfAborted();
          checkResponse();
          if (responseState === undefined) fail('turn_binding_mismatch');
          // TB-3(c): another turn read before the response, queued while this terminal settled.
          if (queue.pending().some((q) => !q.afterResponse && otherTurnStarted(q))) fail('turn_binding_mismatch');
          terminal = true; cards?.turnCompleted();
        }
        yield out.event;
      }
      if (terminal) break;
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    cards?.close();
    void teardown(!terminal);
  }
}
