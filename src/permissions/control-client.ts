import { randomBytes, createHash } from 'node:crypto';
import tls, { type TLSSocket } from 'node:tls';

export type ControlMethod = 'register_ingress' | 'admit' | 'resolve_contributors' | 'bind_context' | 'open_relay' | 'renew' | 'close' | 'checkpoint';
export type RefusalCategory = 'context_untrusted' | 'policy_unavailable' | 'invocation_denied' | 'capability_denied';
export interface RefusalRecord { version: 1; category: RefusalCategory; correlation: string }
const CATEGORIES: readonly string[] = ['context_untrusted', 'policy_unavailable', 'invocation_denied', 'capability_denied'];
const REASONS = ['authority_unavailable', 'disclosure_unavailable', 'receipt_unavailable', 'parent_unavailable',
  'predicate_unsupported', 'mirror_lag', 'authority_conflict', 'expired_reference', 'budget_exhausted'];
const HEX32 = /^[0-9a-f]{32}$/;
const METHODS: readonly string[] = ['register_ingress', 'admit', 'resolve_contributors', 'bind_context', 'open_relay', 'renew', 'close', 'checkpoint'];
const LIMIT = 64 * 1024;

export class PermissionRefusal extends Error {
  readonly record: Readonly<RefusalRecord>;
  constructor(record: RefusalRecord) { super('PERMISSION_REFUSED'); this.record = refusal(record); }
}

export function permissionRefusalText(record: RefusalRecord): string {
  const checked = refusal(record);
  const messages: Record<RefusalCategory, string> = {
    context_untrusted: "This request's context could not be verified.",
    policy_unavailable: 'Permissions could not be checked. Try again later.',
    invocation_denied: 'This Agent cannot accept this request here.',
    capability_denied: 'This attempt was blocked before dispatch.',
  };
  return `${messages[checked.category]} Reference: ${checked.correlation}`;
}

export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control object unavailable');
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) {
    throw new Error('Control fields unavailable');
  }
  return result;
}

/** Canonical private JSON only; no decoded duplicate keys, coercion or scalars. */
export function canonicalControl(value: unknown): string {
  function encode(item: unknown, depth: number): string {
    if (depth > 12) throw new Error('Control depth exceeded');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item)) return String(item);
    if (typeof item === 'string') {
      if (Buffer.from(item, 'utf8').toString('utf8') !== item) throw new Error('Control scalar unavailable');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(child => encode(child, depth + 1)).join(',')}]`;
    const record = object(item);
    return `{${Object.keys(record).sort().map(key => `${encode(key, depth + 1)}:${encode(record[key], depth + 1)}`).join(',')}}`;
  }
  return encode(value, 0);
}

export function decodeControl(bytes: Uint8Array): Record<string, unknown> {
  if (!bytes.length || bytes.length > LIMIT) throw new Error('Control frame unavailable');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  // Re-encoding catches duplicate decoded keys, noncanonical numbers/escapes,
  // trailing input, whitespace and key order without a permissive JSON reviver.
  if (!Buffer.from(canonicalControl(parsed), 'utf8').equals(bytes)) throw new Error('Noncanonical control frame');
  return object(parsed);
}

export function refusal(value: unknown): Readonly<RefusalRecord> {
  const record = object(value, ['version', 'category', 'correlation']);
  if (record.version !== 1 || typeof record.category !== 'string' || !CATEGORIES.includes(record.category)
    || typeof record.correlation !== 'string' || !HEX32.test(record.correlation)) throw new Error('Invalid permission refusal');
  return Object.freeze({ version: 1, category: record.category as RefusalCategory, correlation: record.correlation });
}

export interface ControlConnection {
  host: string;
  port: number;
  servername: string;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  peerCertificateSha256: string;
  configuredOrigin: string;
  recipientId: string;
  coordinatorIncarnation: string;
  endpointIncarnation: string;
  timeoutMs?: number;
}

/** Host-only mTLS connection. Neither key nor this object goes to the worker. */
export class PermissionControlClient {
  private readonly session = randomBytes(16).toString('hex');
  private buffer: Buffer = Buffer.alloc(0);
  private pending?: { request: string; hello: boolean; resolve: (value: Record<string, unknown>) => void; reject: (error?: Error) => void; timer: NodeJS.Timeout };
  private ready = false;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  private constructor(private readonly socket: TLSSocket, private readonly options: ControlConnection) {
    socket.on('data', (data: Buffer) => this.receive(data));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  static async connect(options: ControlConnection): Promise<PermissionControlClient> {
    if (!HEX32.test(options.endpointIncarnation) || !HEX32.test(options.coordinatorIncarnation)
      || !/^[\x21-\x7e]{1,256}$/.test(options.recipientId)
      || !/^[\x21-\x7e]{1,2048}$/.test(options.configuredOrigin)
      || !/^[0-9a-f]{64}$/.test(options.peerCertificateSha256)
      || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535
      || (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000))) {
      throw new Error('Permission control configuration unavailable');
    }
    const socket = tls.connect({ host: options.host, port: options.port, servername: options.servername,
      ca: options.ca, cert: options.cert, key: options.key, rejectUnauthorized: true, minVersion: 'TLSv1.3' });
    const client = new PermissionControlClient(socket, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => { cleanup(); reject(new Error('Permission control authentication unavailable')); };
        const timer = setTimeout(fail, options.timeoutMs ?? 2000);
        const secure = () => {
          const peer = socket.getPeerCertificate();
          if (!socket.authorized || !peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== options.peerCertificateSha256) { fail(); return; }
          cleanup(); resolve();
        };
        const cleanup = () => { clearTimeout(timer); socket.off('error', fail); socket.off('close', fail); socket.off('secureConnect', secure); };
        socket.once('error', fail); socket.once('close', fail); socket.once('secureConnect', secure);
      });
      const reply = await client.request('hello', { versions: [2], metadata_versions: [2], identity_versions: [2],
        endpoint_incarnation: options.endpointIncarnation, configured_origin: options.configuredOrigin, recipient_id: options.recipientId }, true);
      const selection = object(reply.payload, ['session_id', 'selected_binding', 'selected_metadata', 'selected_identity', 'coordinator_incarnation']);
      if (selection.session_id !== client.session || selection.selected_binding !== 2 || selection.selected_metadata !== 2
        || selection.selected_identity !== 2 || selection.coordinator_incarnation !== options.coordinatorIncarnation) {
        throw new Error('Permission control negotiation unavailable');
      }
      client.ready = true;
      return client;
    } catch {
      client.close(); throw new Error('Permission control negotiation unavailable');
    }
  }

  /** Closed method set; one outstanding request, no retransmit/rebind/fallback. */
  async call(method: ControlMethod, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ready || !METHODS.includes(method) || this.queued >= 64) throw new Error('Permission control unavailable');
    // Snapshot before a queue wait; another turn cannot retarget the payload.
    const fixed = decodeControl(Buffer.from(canonicalControl(payload)));
    this.queued++;
    const task = this.tail.then(() => this.request(method, fixed, false));
    this.tail = task.then(() => undefined, () => undefined);
    try { return object((await task).payload); } finally { this.queued--; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.buffer = Buffer.alloc(0);
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(); }
    this.socket.destroy();
  }

  private request(method: ControlMethod | 'hello', payload: Record<string, unknown>, hello: boolean): Promise<Record<string, unknown>> {
    if (this.closed || this.pending) return Promise.reject(new Error('Permission control unavailable'));
    const request = randomBytes(16).toString('hex');
    const bytes = Buffer.from(canonicalControl({ control_version: 1, request_id: request, session_id: this.session, method, payload }));
    if (bytes.length > LIMIT) return Promise.reject(new Error('Permission control frame unavailable'));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.options.timeoutMs ?? 2000);
      this.pending = { request, hello, timer, resolve, reject: error => reject(error ?? new Error('Permission control unavailable')) };
      this.socket.write(Buffer.concat([prefix, bytes]), error => { if (error) this.close(); });
    });
  }

  private receive(data: Buffer): void {
    try {
      if (this.closed || !this.pending || this.buffer.length + data.length > LIMIT + 4) throw new Error('Control framing unavailable');
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length < 4) return;
      const size = this.buffer.readUInt32BE();
      if (!size || size > LIMIT) throw new Error('Control framing unavailable');
      if (this.buffer.length < size + 4) return;
      if (this.buffer.length !== size + 4) throw new Error('Unsolicited control frame');
      const frame = decodeControl(this.buffer.subarray(4)); this.buffer = Buffer.alloc(0);
      const pending = this.pending;
      object(frame, pending.hello && frame.status === 'unavailable'
        ? ['control_version', 'request_id', 'session_id', 'status', 'payload'] : ['control_version', 'request_id', 'status', 'payload']);
      if (frame.control_version !== 1 || frame.request_id !== pending.request) throw new Error('Control correlation unavailable');
      if (frame.status === 'unavailable') {
        const payload = object(frame.payload, ['reason']);
        const reasons = pending.hello ? ['authority_conflict', 'authority_unavailable', 'predicate_unsupported'] : REASONS;
        if (!reasons.includes(String(payload.reason)) || pending.hello && frame.session_id !== this.session) throw new Error('Control unavailable arm invalid');
        this.close(); return;
      }
      if (frame.status === 'refused' && !pending.hello) {
        const record = refusal(frame.payload);
        this.pending = undefined; clearTimeout(pending.timer);
        pending.reject(new PermissionRefusal(record));
        return;
      }
      if (frame.status !== 'ok') throw new Error('Control status unavailable');
      this.pending = undefined; clearTimeout(pending.timer); pending.resolve(frame);
    } catch { this.close(); }
  }
}
