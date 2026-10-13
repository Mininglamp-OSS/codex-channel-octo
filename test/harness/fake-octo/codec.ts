/**
 * Server-side WuKongIM codec for the fake Octo WS server. Written from the
 * protocol layout (R8 §7.1 P1) independently of src/octo/socket.ts; its frames
 * are cross-checked against B-generated goldens (test/goldens/b-wire.golden.test.ts).
 */
import { createCipheriv, createHash } from 'node:crypto';

export const PacketType = {
  CONNECT: 1, CONNACK: 2, SEND: 3, SENDACK: 4, RECV: 5, RECVACK: 6, PING: 7, PONG: 8, DISCONNECT: 9,
} as const;
export const PACKET_NAMES: Record<number, string> = Object.fromEntries(Object.entries(PacketType).map(([k, v]) => [v, k]));

export interface Frame { type: number; flags: number; body: Uint8Array; raw: Uint8Array }

export function encodeVarint(n: number): number[] {
  const out: number[] = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    out.push(digit);
  } while (n > 0);
  return out;
}

/** Split complete frames off the front of buf. Throws on a >4-byte varint. */
export function splitFrames(buf: Uint8Array): { frames: Frame[]; rest: Uint8Array } {
  const frames: Frame[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const header = buf[pos];
    const type = header >> 4;
    if (type === PacketType.PING || type === PacketType.PONG) {
      frames.push({ type, flags: header & 0x0f, body: new Uint8Array(0), raw: buf.slice(pos, pos + 1) });
      pos += 1;
      continue;
    }
    let len = 0;
    let mult = 1;
    let i = pos + 1;
    let complete = false;
    for (let n = 0; n < 4; n++) {
      if (i >= buf.length) break;
      const d = buf[i++];
      len += (d & 0x7f) * mult;
      mult *= 128;
      if ((d & 0x80) === 0) { complete = true; break; }
      if (n === 3) throw new Error('varint longer than 4 bytes');
    }
    if (!complete || i + len > buf.length) break;
    frames.push({ type, flags: header & 0x0f, body: buf.slice(i, i + len), raw: buf.slice(pos, i + len) });
    pos = i + len;
  }
  return { frames, rest: buf.slice(pos) };
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  private need(n: number) { if (this.o + n > this.b.length) throw new RangeError('fake codec: truncated packet'); }
  byte() { this.need(1); return this.b[this.o++]; }
  int16() { this.need(2); const v = (this.b[this.o] << 8) | this.b[this.o + 1]; this.o += 2; return v; }
  int32() { this.need(4); const v = Buffer.from(this.b.subarray(this.o, this.o + 4)).readUInt32BE(0); this.o += 4; return v; }
  int64() { this.need(8); const v = Buffer.from(this.b.subarray(this.o, this.o + 8)).readBigUInt64BE(0); this.o += 8; return v; }
  str() { const n = this.int16(); this.need(n); const s = Buffer.from(this.b.subarray(this.o, this.o + n)).toString('utf8'); this.o += n; return s; }
  rest() { const r = this.b.subarray(this.o); this.o = this.b.length; return r; }
}

class Writer {
  readonly out: number[] = [];
  byte(v: number) { this.out.push(v & 0xff); return this; }
  int16(v: number) { this.out.push((v >> 8) & 0xff, v & 0xff); return this; }
  int32(v: number) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.out.push(...b); return this; }
  int64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt.asUintN(64, v)); this.out.push(...b); return this; }
  str(s: string) { const b = Buffer.from(s, 'utf8'); this.int16(b.length); for (const x of b) this.out.push(x); return this; }
  bytes(b: Uint8Array) { for (const x of b) this.out.push(x); return this; }
}

function frame(type: number, flags: number, body: number[]): Uint8Array {
  return Uint8Array.from([(type << 4) | flags, ...encodeVarint(body.length), ...body]);
}

export interface ConnectPacket { version: number; deviceFlag: number; deviceID: string; uid: string; token: string; clientTimestamp: string; clientKey: string }
export function parseConnect(body: Uint8Array): ConnectPacket {
  const r = new Reader(body);
  return { version: r.byte(), deviceFlag: r.byte(), deviceID: r.str(), uid: r.str(), token: r.str(), clientTimestamp: r.int64().toString(), clientKey: r.str() };
}

export function parseRecvack(body: Uint8Array): { messageId: string; messageSeq: number } {
  const r = new Reader(body);
  return { messageId: r.int64().toString(), messageSeq: r.int32() };
}

export function encodeConnack(o: { serverVersion?: number; timeDiff?: bigint; reasonCode: number; serverKey: string; salt: string; nodeId?: bigint }): Uint8Array {
  const w = new Writer();
  const hasVersion = o.serverVersion !== undefined;
  if (hasVersion) w.byte(o.serverVersion!);
  w.int64(o.timeDiff ?? 0n).byte(o.reasonCode).str(o.serverKey).str(o.salt);
  if ((o.serverVersion ?? 0) >= 4) w.int64(o.nodeId ?? 0n);
  return frame(PacketType.CONNACK, hasVersion ? 1 : 0, w.out);
}

export interface RecvSpec {
  setting?: number; msgKey?: string; fromUid: string; channelId: string; channelType: number; expire?: number;
  clientMsgNo?: string; messageId: string; messageSeq: number; timestamp?: number; topic?: string; payload: Uint8Array;
}
export function encodeRecv(o: RecvSpec, serverVersion: number): Uint8Array {
  const setting = o.setting ?? 0;
  const w = new Writer().byte(setting).str(o.msgKey ?? '').str(o.fromUid).str(o.channelId).byte(o.channelType);
  if (serverVersion >= 3) w.int32(o.expire ?? 0);
  w.str(o.clientMsgNo ?? '').int64(BigInt(o.messageId)).int32(o.messageSeq).int32(o.timestamp ?? 0);
  if ((setting >> 3) & 1) w.str(o.topic ?? '');
  w.bytes(o.payload);
  return frame(PacketType.RECV, 0, w.out);
}

export function encodeDisconnect(reasonCode: number, reason: string): Uint8Array {
  return frame(PacketType.DISCONNECT, 0, new Writer().byte(reasonCode).str(reason).out);
}
export const encodePong = () => Uint8Array.from([PacketType.PONG << 4]);

/** P1: AES key = MD5(base64(sharedSecret)) hex, first 16 chars. */
export function deriveAesKey(sharedSecret: Uint8Array): string {
  return createHash('md5').update(Buffer.from(sharedSecret).toString('base64')).digest('hex').slice(0, 16);
}
/** P1: IV = first 16 bytes of the salt. */
export const deriveIv = (salt: string) => Buffer.from(salt, 'utf8').subarray(0, 16);

export function aesEncryptToBase64(plaintext: string, key: string, salt: string): string {
  const c = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), deriveIv(salt));
  return Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
}
