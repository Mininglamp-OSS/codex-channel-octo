/**
 * JSON-RPC client for one gateway-owned `codex app-server` stdio child.
 *
 * - R-1: the reader never awaits. Parsing, routing, replies to unsupported
 *   server requests and every uncharged refusal are synchronous; only the
 *   owner's charged work runs elsewhere.
 * - R-6/R-9: one serialized writer per child. A frame must be fully written
 *   (write callback, plus `drain` when `write()` returned false) within
 *   {@link RPC_WRITE_BOUND_MS} of being enqueued, so queue wait counts.
 * - R-9a: finite caps on inbound line size, queued frames and bytes, and
 *   uncharged replies. Reaching any of them, a write breach, a protocol
 *   violation or EOF closes the client once; the owner then kills the
 *   process group. Nothing is enqueued after close.
 * - Outbound methods are allowlisted and `turn/start` is sent at most once.
 */
import type { Readable, Writable } from 'node:stream';

export const RPC_WRITE_BOUND_MS = 2_000;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const WRITER_QUEUE_MAX = 256;
export const WRITER_QUEUE_BYTES_MAX = 1024 * 1024;
export const UNCHARGED_REPLY_MAX = 256;

/** Client requests and notifications the gateway may send (§5.5). */
export const OUTBOUND_METHODS: ReadonlySet<string> = new Set([
  'initialize', 'initialized', 'account/login/start', 'account/read', 'thread/start', 'thread/resume',
  'turn/start', 'turn/interrupt', 'thread/inject_items',
]);

export type RpcId = number | string;
export type JsonObject = { readonly [key: string]: unknown };

export type CloseReason =
  | 'eof' | 'write_timeout' | 'write_error' | 'frame_too_large' | 'invalid_frame'
  | 'queue_full' | 'uncharged_reply_cap' | 'owner';

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'RpcError'; }
}

export class ClientClosed extends Error {
  constructor(readonly reason: CloseReason) { super(`app-server client closed: ${reason}`); this.name = 'ClientClosed'; }
}

export interface ClientTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: ClientTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => performance.now(),
};

export interface ServerRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
  /** Monotonic read time; per-call timers start here (R-2). */
  readonly readAt: number;
}

export interface ClientHandlers {
  /** Synchronous; must not throw (a throw is contained). */
  onNotification(method: string, params: unknown): void;
  /**
   * `item/tool/call` only. Synchronous: the owner answers through
   * {@link AppServerClient.respond} now or later. Absent → uncharged refusal.
   */
  onToolCall?(request: ServerRequest): void;
  /** Called once, synchronously, on the first close. */
  onClose(reason: CloseReason): void;
}

/** Built-in replies (§8). Each counts toward {@link UNCHARGED_REPLY_MAX}. */
const BUILTIN_REPLIES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['item/commandExecution/requestApproval', { decision: 'decline' }],
  ['item/fileChange/requestApproval', { decision: 'decline' }],
  ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
  ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
  ['applyPatchApproval', { decision: { denied: { rejection: 'not permitted by the gateway' } } }],
  ['execCommandApproval', { decision: { denied: { rejection: 'not permitted by the gateway' } } }],
]);

/** Dynamic tool reply when no dispatcher is attached, or for any uncharged refusal. */
export function toolRefusal(text: string): { contentItems: { type: 'inputText'; text: string }[]; success: false } {
  return { contentItems: [{ type: 'inputText', text }], success: false };
}

interface Frame {
  readonly bytes: Buffer;
  readonly enqueuedAt: number;
}

export class AppServerClient {
  private readonly timers: ClientTimers;
  private readonly queue: Frame[] = [];
  private queuedBytes = 0;
  private writing = false;
  private deadline: unknown;
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve(v: unknown): void; reject(e: Error): void }>();
  private inbound: Buffer = Buffer.alloc(0);
  private uncharged = 0;
  private turnStartSent = false;
  private turnStartId: RpcId | undefined;
  private turnStartRead = false;
  private closedReason: CloseReason | undefined;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly handlers: ClientHandlers,
    timers?: ClientTimers,
  ) {
    this.timers = timers ?? realTimers;
    stdin.on('error', () => this.close('write_error'));
    stdout.on('data', (chunk: Buffer | string) => this.read(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    stdout.on('end', () => this.close('eof'));
    stdout.on('close', () => this.close('eof'));
    stdout.on('error', () => this.close('eof'));
  }

  get closed(): CloseReason | undefined { return this.closedReason; }
  /** Whether the single `turn/start` frame was enqueued (TB-0). */
  get turnStartEnqueued(): boolean { return this.turnStartSent; }
  /** Whether the `turn/start` response frame was read; set synchronously in the reader (TB-3(c)). */
  get turnStartResponded(): boolean { return this.turnStartRead; }
  get unchargedReplies(): number { return this.uncharged; }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.assertOutbound(method);
    if (this.closedReason !== undefined) return Promise.reject(new ClientClosed(this.closedReason));
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    if (method === 'turn/start') { this.turnStartSent = true; this.turnStartId = id; }
    this.enqueue({ id, method, params });
    return result;
  }

  notify(method: string, params?: unknown): void {
    this.assertOutbound(method);
    this.enqueue(params === undefined ? { method } : { method, params });
  }

  /** Answer a server request. `uncharged` replies count toward the R-9a cap. */
  respond(id: RpcId, result: unknown, opts: { uncharged?: boolean } = {}): boolean {
    if (opts.uncharged && !this.countUncharged()) return false;
    return this.enqueue({ id, result });
  }

  respondError(id: RpcId, code: number, message: string, opts: { uncharged?: boolean } = { uncharged: true }): boolean {
    if (opts.uncharged && !this.countUncharged()) return false;
    return this.enqueue({ id, error: { code, message } });
  }

  close(reason: CloseReason): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.timers.clearTimeout(this.deadline);
    this.queue.length = 0;
    this.queuedBytes = 0;
    for (const p of this.pending.values()) p.reject(new ClientClosed(reason));
    this.pending.clear();
    try { this.handlers.onClose(reason); } catch { /* contained */ }
  }

  // ── writer ──

  private assertOutbound(method: string): void {
    if (!OUTBOUND_METHODS.has(method)) throw new Error(`outbound method not allowed: ${method}`);
    if (method === 'turn/start' && this.turnStartSent) throw new Error('turn/start already sent on this child');
  }

  private countUncharged(): boolean {
    if (this.closedReason !== undefined) return false;
    if (++this.uncharged > UNCHARGED_REPLY_MAX) { this.close('uncharged_reply_cap'); return false; }
    return true;
  }

  private enqueue(message: JsonObject): boolean {
    if (this.closedReason !== undefined) return false;
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(message) + '\n', 'utf8'); } catch { this.close('invalid_frame'); return false; }
    if (this.queue.length + 1 > WRITER_QUEUE_MAX || this.queuedBytes + bytes.length > WRITER_QUEUE_BYTES_MAX) {
      this.close('queue_full');
      return false;
    }
    this.queue.push({ bytes, enqueuedAt: this.timers.now() });
    this.queuedBytes += bytes.length;
    this.arm();
    this.pump();
    return true;
  }

  /** One timer at the earliest unwritten frame's deadline. */
  private arm(): void {
    this.timers.clearTimeout(this.deadline);
    const head = this.queue[0];
    if (head === undefined) return;
    const remaining = head.enqueuedAt + RPC_WRITE_BOUND_MS - this.timers.now();
    if (remaining <= 0) { this.close('write_timeout'); return; }
    this.deadline = this.timers.setTimeout(() => this.close('write_timeout'), remaining);
  }

  private pump(): void {
    if (this.writing || this.closedReason !== undefined) return;
    const head = this.queue[0];
    if (head === undefined) return;
    this.writing = true;
    let callback = false;
    let drained = true;
    const done = (): void => {
      if (!callback || !drained || this.closedReason !== undefined) return;
      this.writing = false;
      this.queue.shift();
      this.queuedBytes -= head.bytes.length;
      this.arm();
      this.pump();
    };
    try {
      const ok = this.stdin.write(head.bytes, (err) => {
        if (err) { this.close('write_error'); return; }
        callback = true; done();
      });
      if (!ok) { drained = false; this.stdin.once('drain', () => { drained = true; done(); }); }
    } catch {
      this.close('write_error');
    }
  }

  // ── reader ──

  private read(chunk: Buffer): void {
    if (this.closedReason !== undefined) return;
    this.inbound = this.inbound.length === 0 ? chunk : Buffer.concat([this.inbound, chunk]);
    for (let end = this.inbound.indexOf(0x0a); end !== -1; end = this.inbound.indexOf(0x0a)) {
      if (end > MAX_FRAME_BYTES) { this.close('frame_too_large'); return; }
      const line = this.inbound.subarray(0, end).toString('utf8');
      this.inbound = this.inbound.subarray(end + 1);
      if (line.trim() !== '') this.dispatch(line);
      if (this.closedReason !== undefined) return;
    }
    if (this.inbound.length > MAX_FRAME_BYTES) this.close('frame_too_large');
  }

  private dispatch(line: string): void {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { this.close('invalid_frame'); return; }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) { this.close('invalid_frame'); return; }
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const hasId = typeof m.id === 'number' || typeof m.id === 'string';
    if (typeof m.method === 'string') {
      if (hasId) this.onServerRequest({ id: m.id as RpcId, method: m.method, params: m.params, readAt: this.timers.now() });
      else { try { this.handlers.onNotification(m.method, m.params); } catch { /* contained */ } }
      return;
    }
    if (!hasId) { this.close('invalid_frame'); return; }
    const waiter = this.pending.get(m.id as RpcId);
    if (waiter === undefined) return; // late or unknown response: ignored
    this.pending.delete(m.id as RpcId);
    if (m.id === this.turnStartId) this.turnStartRead = true;
    if (m.error !== undefined) {
      const e = m.error as { code?: unknown; message?: unknown };
      waiter.reject(new RpcError(typeof e?.code === 'number' ? e.code : -32603, typeof e?.message === 'string' ? e.message : 'error'));
    } else waiter.resolve(m.result);
  }

  private onServerRequest(req: ServerRequest): void {
    if (req.method === 'item/tool/call') {
      if (this.handlers.onToolCall === undefined) { this.respond(req.id, toolRefusal('explicit cards are unavailable'), { uncharged: true }); return; }
      try { this.handlers.onToolCall(req); } catch { this.respond(req.id, toolRefusal('explicit cards are unavailable'), { uncharged: true }); }
      return;
    }
    const builtin = BUILTIN_REPLIES.get(req.method);
    if (builtin !== undefined) { this.respond(req.id, builtin, { uncharged: true }); return; }
    this.respondError(req.id, -32601, 'unsupported by this client');
  }
}
