/**
 * Test-only JSONL JSON-RPC client for App Server processes (the real binary or
 * the scripted fake). Records a full transcript, answers server requests via
 * onServerRequest (default: the exec-parity rejection) and never pauses stdout.
 * This is harness code, not the DEV-03 production client.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface RpcMessage { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export interface TranscriptEntry { dir: 'in' | 'out'; at: number; message: RpcMessage }
export interface ServerRequest { id: number | string; method: string; params: unknown }
export type ServerRequestAnswer = { result: unknown } | { error: { code: number; message: string } } | undefined;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export class JsonlRpcClient {
  readonly transcript: TranscriptEntry[] = [];
  readonly serverRequests: ServerRequest[] = [];
  stderr = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  onServerRequest: (r: ServerRequest) => ServerRequestAnswer = (r) => ({
    error: { code: -32000, message: `${r.method} is not supported in exec mode for thread \`${(r.params as { threadId?: string })?.threadId ?? ''}\`` },
  });
  private nextId = 1;
  private buf = '';
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }>();
  private readonly consumed = new Set<TranscriptEntry>();
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  private constructor(readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => this.onData(d));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-64_000); });
    this.exited = new Promise((resolve) => child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      for (const p of this.pending.values()) p.reject(new Error(`process exited (code=${code}, signal=${signal}) during ${p.method}`));
      this.pending.clear();
      resolve(this.exitInfo);
    }));
    child.stdin!.on('error', () => undefined);
  }

  static spawn(command: string, args: string[], opts: SpawnOptions = {}): JsonlRpcClient {
    return new JsonlRpcClient(spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }));
  }

  get pid(): number | undefined { return this.child.pid; }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: RpcMessage;
      try { msg = JSON.parse(line) as RpcMessage; } catch { continue; }
      this.transcript.push({ dir: 'in', at: performance.now(), message: msg });
      if (msg.method !== undefined && msg.id !== undefined) {
        const req = { id: msg.id, method: msg.method, params: msg.params };
        this.serverRequests.push(req);
        const answer = this.onServerRequest(req);
        if (answer) this.write({ id: msg.id, ...answer });
      } else if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        else p.resolve(msg.result);
      }
    }
  }

  private write(message: RpcMessage): void {
    this.transcript.push({ dir: 'out', at: performance.now(), message });
    if (this.exitInfo || !this.child.stdin!.writable) return;
    this.child.stdin!.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }

  notifications(): RpcMessage[] {
    return this.transcript.filter((e) => e.dir === 'in' && e.message.method !== undefined && e.message.id === undefined).map((e) => e.message);
  }

  /** Resolve with the first not-yet-consumed notification matching pred (consumes it). */
  async waitForNotification(pred: (n: RpcMessage) => boolean, timeoutMs = 30_000, since = 0): Promise<RpcMessage> {
    const start = performance.now();
    for (;;) {
      const hit = this.transcript.slice(since).find((e) => e.dir === 'in' && e.message.method !== undefined && e.message.id === undefined && !this.consumed.has(e) && pred(e.message));
      if (hit) { this.consumed.add(hit); return hit.message; }
      if (performance.now() - start > timeoutMs) throw new Error(`waitForNotification timed out after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitForServerRequest(pred: (r: ServerRequest) => boolean, timeoutMs = 30_000): Promise<ServerRequest> {
    const start = performance.now();
    for (;;) {
      const hit = this.serverRequests.find(pred);
      if (hit) return hit;
      if (performance.now() - start > timeoutMs) throw new Error(`waitForServerRequest timed out after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  endStdin(): void { this.child.stdin!.end(); }
  kill(signal: NodeJS.Signals): void { this.child.kill(signal); }

  /** End stdin, wait for exit (≤ graceMs), then SIGKILL. Always settles. */
  async close(graceMs = 5_000): Promise<void> {
    if (this.exitInfo) return;
    this.endStdin();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs);
    await this.exited;
    clearTimeout(timer);
  }
}
