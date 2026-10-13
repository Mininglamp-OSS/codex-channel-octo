/**
 * Scripted fake Octo WebSocket server (R8 §10.1 layer 2). Speaks the WuKongIM
 * binary protocol over loopback, performs the DH/AES handshake, records every
 * frame in both directions with a monotonic sequence, and consults a FaultPlan
 * at transport.dropConnack and transport.disconnect.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import type { FaultPlan } from '../../../src/seams/fault-plan.js';
import { NO_FAULTS } from '../../../src/seams/fault-plan.js';
import {
  PACKET_NAMES, PacketType, aesEncryptToBase64, deriveAesKey, encodeConnack, encodeDisconnect, encodePong, encodeRecv,
  parseConnect, parseRecvack, splitFrames, type RecvSpec,
} from './codec.js';

export interface WireEvent {
  seq: number;
  dir: 'in' | 'out';
  type: string;
  connection: number;
  at: number;
  parsed?: unknown;
  rawHex: string;
}

interface Conn {
  index: number;
  ws: WebSocket;
  buf: Uint8Array;
  serverVersion: number;
  aesKey?: string;
  shared?: Uint8Array;
  salt: string;
}

export interface FakeOctoWsOptions {
  faults?: FaultPlan;
  salt?: string;
  serverVersion?: number;
  connackReason?: number;
  autoConnack?: boolean;
  serverSeed?: Uint8Array;
}

export class FakeOctoWsServer {
  readonly events: WireEvent[] = [];
  private readonly conns: Conn[] = [];
  private seq = 0;
  private readonly keyPair: { public: Uint8Array; private: Uint8Array };

  private constructor(private readonly wss: WebSocketServer, private readonly opts: FakeOctoWsOptions) {
    this.keyPair = generateKeyPair(opts.serverSeed ?? Buffer.alloc(32, 0x5a));
    wss.on('connection', (ws) => this.accept(ws));
  }

  static async start(opts: FakeOctoWsOptions = {}): Promise<FakeOctoWsServer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
    return new FakeOctoWsServer(wss, opts);
  }

  get url(): string { return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`; }
  get connections(): number { return this.conns.length; }

  private log(e: Omit<WireEvent, 'seq' | 'at'>): WireEvent {
    const ev = { ...e, seq: ++this.seq, at: performance.now() };
    this.events.push(ev);
    return ev;
  }

  private accept(ws: WebSocket): void {
    const conn: Conn = { index: this.conns.length + 1, ws, buf: new Uint8Array(0), serverVersion: this.opts.serverVersion ?? 4, salt: this.opts.salt ?? '0123456789abcdefSALT' };
    this.conns.push(conn);
    ws.on('message', (data: Buffer) => this.onData(conn, new Uint8Array(data)));
    ws.on('close', () => this.log({ dir: 'in', type: 'CLOSE', connection: conn.index, rawHex: '' }));
  }

  private onData(conn: Conn, chunk: Uint8Array): void {
    const merged = new Uint8Array(conn.buf.length + chunk.length);
    merged.set(conn.buf); merged.set(chunk, conn.buf.length);
    const { frames, rest } = splitFrames(merged);
    conn.buf = rest;
    for (const f of frames) {
      const type = PACKET_NAMES[f.type] ?? `TYPE${f.type}`;
      let parsed: unknown;
      if (f.type === PacketType.CONNECT) parsed = parseConnect(f.body);
      if (f.type === PacketType.RECVACK) parsed = parseRecvack(f.body);
      this.log({ dir: 'in', type, connection: conn.index, parsed, rawHex: Buffer.from(f.raw).toString('hex') });
      if (f.type === PacketType.CONNECT) this.onConnect(conn, parsed as { clientKey: string });
      if (f.type === PacketType.PING) this.write(conn, encodePong(), 'PONG');
    }
  }

  private onConnect(conn: Conn, connect: { clientKey: string }): void {
    conn.shared = sharedKey(this.keyPair.private, Uint8Array.from(Buffer.from(connect.clientKey, 'base64')));
    conn.aesKey = deriveAesKey(conn.shared);
    if (this.opts.autoConnack === false) return;
    if ((this.opts.faults ?? NO_FAULTS).decide({ name: 'transport.dropConnack' }).kind !== 'proceed') return;
    const packet = encodeConnack({
      serverVersion: conn.serverVersion, reasonCode: this.opts.connackReason ?? 1,
      serverKey: Buffer.from(this.keyPair.public).toString('base64'), salt: conn.salt, timeDiff: 0n, nodeId: 0n,
    });
    this.write(conn, packet, 'CONNACK', { reasonCode: this.opts.connackReason ?? 1, salt: conn.salt });
    if ((this.opts.faults ?? NO_FAULTS).decide({ name: 'transport.disconnect' }).kind !== 'proceed') {
      this.write(conn, encodeDisconnect(0, 'fault: transport.disconnect'), 'DISCONNECT');
    }
  }

  private write(conn: Conn, bytes: Uint8Array, type: string, parsed?: unknown): WireEvent {
    const ev = this.log({ dir: 'out', type, connection: conn.index, parsed, rawHex: Buffer.from(bytes).toString('hex') });
    conn.ws.send(bytes);
    return ev;
  }

  private latest(conn?: number): Conn {
    const c = conn ? this.conns[conn - 1] : this.conns.at(-1);
    if (!c) throw new Error('fake octo ws: no connection');
    return c;
  }

  sharedSecretFor(connection: number): Uint8Array {
    const c = this.latest(connection);
    if (!c.shared) throw new Error('fake octo ws: no CONNECT yet');
    return c.shared;
  }

  /** Send a RECV; payload objects are JSON-encrypted with the session key, rawCiphertext is sent verbatim. */
  async sendRecv(spec: Omit<RecvSpec, 'payload'> & { payload?: unknown; rawCiphertext?: Uint8Array }, connection?: number): Promise<{ eventSeq: number; messageId: string }> {
    const c = this.latest(connection);
    if (!c.aesKey) throw new Error('fake octo ws: handshake incomplete');
    const payload = spec.rawCiphertext ?? Buffer.from(aesEncryptToBase64(JSON.stringify(spec.payload), c.aesKey, c.salt), 'latin1');
    const ev = this.write(c, encodeRecv({ ...spec, payload }, c.serverVersion), 'RECV', { messageId: spec.messageId, messageSeq: spec.messageSeq });
    return { eventSeq: ev.seq, messageId: spec.messageId };
  }

  sendRaw(bytes: Uint8Array, connection?: number): void {
    this.write(this.latest(connection), bytes, 'RAW');
  }

  sendDisconnect(reasonCode: number, reason: string, connection?: number): void {
    this.write(this.latest(connection), encodeDisconnect(reasonCode, reason), 'DISCONNECT');
  }

  /** Resolve with the (skip+1)-th event matching pred. Uses monotonic time only. */
  async waitFor(pred: (e: WireEvent) => boolean, timeoutMs = 2_000, skip = 0): Promise<WireEvent> {
    const start = performance.now();
    for (;;) {
      const hits = this.events.filter(pred);
      if (hits.length > skip) return hits[skip];
      if (performance.now() - start > timeoutMs) throw new Error(`fake octo ws: waitFor timed out after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> {
    for (const c of this.conns) { try { c.ws.terminate(); } catch { /* already closed */ } }
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
