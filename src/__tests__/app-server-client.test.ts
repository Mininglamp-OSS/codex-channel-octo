/**
 * App-server JSON-RPC client: R-1 non-blocking reader, R-6/R-9 serialized
 * writer with the enqueue-measured bound, R-9a caps, the outbound allowlist
 * and the §8 server-request table.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import {
  AppServerClient, ClientClosed, MAX_FRAME_BYTES, RPC_WRITE_BOUND_MS, RpcError, UNCHARGED_REPLY_MAX,
  WRITER_QUEUE_MAX, type ClientHandlers, type ClientTimers, type CloseReason, type ServerRequest,
} from '../app-server/client.js';

class ManualTimers implements ClientTimers {
  t = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; cb: () => void }>();
  setTimeout(cb: () => void, ms: number): unknown { const id = ++this.seq; this.tasks.set(id, { at: this.t + ms, cb }); return id; }
  clearTimeout(h: unknown): void { this.tasks.delete(h as number); }
  now(): number { return this.t; }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]); this.t = due[1].at; due[1].cb();
    }
    this.t = end;
  }
}

/** stdin that records frames and completes writes only when told to. */
class HeldStdin extends Writable {
  readonly frames: string[] = [];
  private readonly held: Array<() => void> = [];
  outstanding = 0;
  maxOutstanding = 0;
  constructor(private readonly auto: boolean) { super({ highWaterMark: 1 << 30 }); }
  override _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    this.frames.push(chunk.toString('utf8'));
    this.outstanding++; this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    const finish = (): void => { this.outstanding--; cb(); };
    if (this.auto) queueMicrotask(finish); else this.held.push(finish);
  }
  release(): void { this.held.shift()?.(); }
  json(): Array<Record<string, unknown>> { return this.frames.map((f) => JSON.parse(f) as Record<string, unknown>); }
}

function harness(opts: { auto?: boolean; onToolCall?: (r: ServerRequest) => void } = {}) {
  const stdin = new HeldStdin(opts.auto ?? true);
  const stdout = new PassThrough();
  const timers = new ManualTimers();
  const notes: Array<[string, unknown]> = [];
  const closes: CloseReason[] = [];
  const handlers: ClientHandlers = {
    onNotification: (m, p) => notes.push([m, p]),
    onClose: (r) => closes.push(r),
    ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
  };
  const client = new AppServerClient(stdin, stdout, handlers, timers);
  const push = (o: unknown): void => { stdout.write(JSON.stringify(o) + '\n'); };
  return { stdin, stdout, timers, notes, closes, client, push };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('requests and responses', () => {
  it('resolves a matching response and rejects a JSON-RPC error', async () => {
    const h = harness();
    const ok = h.client.request('initialize', { clientInfo: { name: 'x', version: '0' } });
    const bad = h.client.request('account/read', {});
    await flush();
    const [a, b] = h.stdin.json();
    h.push({ id: a.id, result: { userAgent: 'u' } });
    h.push({ id: b.id, error: { code: -32600, message: 'nope' } });
    await expect(ok).resolves.toEqual({ userAgent: 'u' });
    await expect(bad).rejects.toBeInstanceOf(RpcError);
  });

  it('ignores a response with an unknown id', async () => {
    const h = harness();
    h.push({ id: 999, result: {} });
    await flush();
    expect(h.closes).toEqual([]);
  });

  it('allows only allowlisted outbound methods and exactly one turn/start (TB-0)', async () => {
    const h = harness();
    expect(() => h.client.request('thread/fork', {})).toThrow(/not allowed/);
    expect(() => h.client.request('remoteControl/enable', {})).toThrow(/not allowed/);
    expect(() => h.client.request('turn/steer', {})).toThrow(/not allowed/);
    expect(h.client.turnStartEnqueued).toBe(false);
    void h.client.request('turn/start', { threadId: 't', input: [] }).catch(() => undefined);
    expect(h.client.turnStartEnqueued).toBe(true);
    expect(() => h.client.request('turn/start', { threadId: 't', input: [] })).toThrow(/already sent/);
  });
});

describe('§8 server requests are answered immediately by the reader', () => {
  it.each([
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
  ])('%s → deny', async (method, result) => {
    const h = harness();
    h.push({ id: 7, method, params: {} });
    await flush();
    expect(h.stdin.json()).toEqual([{ id: 7, result }]);
  });

  it.each(['item/tool/requestUserInput', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read', 'made/up'])(
    '%s → JSON-RPC -32601', async (method) => {
      const h = harness();
      h.push({ id: 'r1', method, params: {} });
      await flush();
      expect(h.stdin.json()).toEqual([{ id: 'r1', error: { code: -32601, message: 'unsupported by this client' } }]);
    });

  it('item/tool/call without a dispatcher gets an uncharged refusal', async () => {
    const h = harness();
    h.push({ id: 3, method: 'item/tool/call', params: { threadId: 't', turnId: 'u', callId: 'c', tool: 'display', arguments: {} } });
    await flush();
    expect(h.stdin.json()[0]).toEqual({ id: 3, result: { contentItems: [{ type: 'inputText', text: 'explicit cards are unavailable' }], success: false } });
    expect(h.client.unchargedReplies).toBe(1);
  });

  it('item/tool/call is handed to the dispatcher synchronously with its read time', async () => {
    const seen: ServerRequest[] = [];
    const h = harness({ onToolCall: (r) => seen.push(r) });
    h.timers.t = 42;
    h.push({ id: 4, method: 'item/tool/call', params: { tool: 'display' } });
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].readAt).toBe(42);
    expect(h.stdin.frames).toEqual([]);
  });

  it('delivers notifications in order without awaiting', async () => {
    const h = harness();
    h.stdout.write(JSON.stringify({ method: 'turn/started', params: { a: 1 } }) + '\n' + JSON.stringify({ method: 'item/started', params: { b: 2 } }) + '\n');
    await flush();
    expect(h.notes.map((n) => n[0])).toEqual(['turn/started', 'item/started']);
  });
});

describe('R-9a inbound limits and protocol violations fail closed', () => {
  it('closes on a line longer than MAX_FRAME_BYTES, even before its newline', async () => {
    const h = harness();
    h.stdout.write('x'.repeat(MAX_FRAME_BYTES + 1));
    await flush();
    expect(h.closes).toEqual(['frame_too_large']);
  });

  it('closes on invalid JSON and on a non-object frame', async () => {
    const a = harness(); a.stdout.write('{not json\n'); await flush();
    expect(a.closes).toEqual(['invalid_frame']);
    const b = harness(); b.stdout.write('[1,2]\n'); await flush();
    expect(b.closes).toEqual(['invalid_frame']);
  });

  it('closes at the uncharged-reply cap and enqueues nothing beyond it', async () => {
    const h = harness();
    for (let i = 0; i < UNCHARGED_REPLY_MAX + 5; i++) h.push({ id: i, method: 'made/up' });
    await flush(); await flush();
    expect(h.closes).toEqual(['uncharged_reply_cap']);
    expect(h.stdin.frames.length).toBeLessThanOrEqual(UNCHARGED_REPLY_MAX);
  });

  it('rejects pending requests and closes once on EOF', async () => {
    const h = harness();
    const p = h.client.request('thread/start', {});
    h.stdout.end();
    await expect(p).rejects.toBeInstanceOf(ClientClosed);
    expect(h.closes).toEqual(['eof']);
    expect(h.client.respond(1, {})).toBe(false);
  });
});

describe('R-6/R-9 single serialized writer', () => {
  it('never has more than one frame in flight and preserves order', async () => {
    const h = harness({ auto: false });
    h.client.notify('initialized');
    void h.client.request('account/read', {}).catch(() => undefined);
    h.client.respond(9, {});
    expect(h.stdin.maxOutstanding).toBe(1);
    expect(h.stdin.frames).toHaveLength(1);
    h.stdin.release(); await flush();
    h.stdin.release(); await flush();
    expect(h.stdin.maxOutstanding).toBe(1);
    expect(h.stdin.json().map((f) => f.method ?? f.id)).toEqual(['initialized', 'account/read', 9]);
  });

  it('tears down when a frame is not written within the bound', () => {
    const h = harness({ auto: false });
    h.client.notify('initialized');
    h.timers.advance(RPC_WRITE_BOUND_MS - 1);
    expect(h.closes).toEqual([]);
    h.timers.advance(1);
    expect(h.closes).toEqual(['write_timeout']);
  });

  it('measures the bound from enqueue: queue wait behind a stalled head counts', async () => {
    const h = harness({ auto: false });
    h.client.notify('initialized');
    h.timers.advance(100);
    h.client.respond(1, {}); // enqueued at 100 → must be written by 2100
    h.timers.advance(1_800);
    h.stdin.release(); await flush(); // head written at 1900; frame 1 starts writing now
    expect(h.closes).toEqual([]);
    h.timers.advance(199);
    expect(h.closes).toEqual([]);
    h.timers.advance(1);
    expect(h.closes).toEqual(['write_timeout']);
  });

  it('closes when the queue exceeds WRITER_QUEUE_MAX frames', () => {
    const h = harness({ auto: false });
    for (let i = 0; i <= WRITER_QUEUE_MAX; i++) h.client.respond(i, {});
    expect(h.closes).toEqual(['queue_full']);
  });

  it('closes on a stdin error', async () => {
    const h = harness({ auto: false });
    h.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    expect(h.closes).toEqual(['write_error']);
  });
});
