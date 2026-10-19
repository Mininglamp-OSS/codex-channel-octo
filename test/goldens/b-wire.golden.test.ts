/**
 * Wire / AES / framing goldens (R8 §10.3, T1–T10, P1/P2): vectors are produced
 * by scripts/goldens/gen-b.mjs executing pinned B source (openclaw-channel-octo
 * @ 2e710e9). A's production socket is compared against them byte-for-byte
 * through the fake Octo WS server; documented divergences (BX-1/2/3) are
 * asserted as divergences, not hidden.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createDecipheriv } from 'node:crypto';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import { Encoder, Decoder, WKSocket } from '../../src/octo/socket.js';
import type { BotMessage } from '../../src/octo/types.js';
import { FakeOctoWsServer } from '../harness/fake-octo/ws-server.js';
import { encodeConnack, encodeRecv, parseConnect, parseRecvack, splitFrames } from '../harness/fake-octo/codec.js';
import { pins } from '../harness/pins.js';

const ctl = vi.hoisted(() => ({ seed: null as Buffer | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = ((size: number, cb?: unknown) => {
    if (ctl.seed && size === 32 && cb === undefined) return Buffer.from(ctl.seed);
    return (actual.randomBytes as (n: number, cb?: unknown) => Buffer)(size, cb);
  }) as typeof actual.randomBytes;
  return { ...actual, randomBytes, default: { ...actual, randomBytes } };
});

const GOLDEN_PATH = new URL('./b/wire-aes-framing.json', import.meta.url);
const raw = readFileSync(GOLDEN_PATH);
const golden = JSON.parse(raw.toString('utf8')) as BGolden;

interface BGolden {
  generator: string;
  source: { repo: string; commit: string; files: Record<string, string> };
  dependencies: Record<string, string>;
  vectors: {
    encoder: Array<{ ops: Array<[string, string | number]>; bytesHex: string }>;
    truncatedDecode: Array<{ op: string; bytesHex: string; bResult: unknown }>;
    connect: Array<{ uid: string; token: string; clientTimestamp: number; mathRandom: number; clientSeedHex: string; deviceID: string; clientKey: string; frameHex: string }>;
    aes: Array<{ clientSeedHex: string; serverSeedHex: string; sharedSecretBase64: string; aesKey: string; salt: string; aesIV: string; plaintext: string; ciphertextBase64: string; bDecrypted: string }>;
    session: Array<{
      name: string; clientSeedHex: string; serverVersion: number; connackFrameHex: string; serverKey: string; salt: string;
      recv: Array<{ spec: RecvSpecJson; frameHex: string; bOnMessage: Record<string, unknown> | null; bRecvackHex: string | null }>;
    }>;
  };
}
interface RecvSpecJson {
  setting: number; msgKey: string; fromUid: string; channelId: string; channelType: number; expire: number;
  clientMsgNo: string; messageId: string; messageSeq: number; timestamp: number; topic?: string; payloadBase64Ascii: string;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('B golden metadata and integrity', () => {
  it('GB-00: golden bytes match the committed sha256 and the pinned B source', () => {
    const recorded = readFileSync(new URL('./b/wire-aes-framing.json.sha256', import.meta.url), 'utf8').trim().split(/\s+/)[0];
    expect(createHash('sha256').update(raw).digest('hex')).toBe(recorded);
    expect(golden.source.repo).toBe('Mininglamp-OSS/openclaw-channel-octo');
    expect(golden.source.commit).toBe(pins.B);
    expect(golden.source.files['src/socket.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(golden.generator).toBe('scripts/goldens/gen-b.mjs');
    expect(existsSync(new URL('../../scripts/goldens/gen-b.mjs', import.meta.url))).toBe(true);
    expect(golden.dependencies).toMatchObject({ 'crypto-js': '4.2.0', 'curve25519-js': '0.0.4', 'md5-typescript': '1.0.5' });
    // every vector family is populated (no silently empty golden)
    for (const [k, v] of Object.entries(golden.vectors)) expect(v.length, k).toBeGreaterThan(0);
  });
});

describe('T1/T2/T3: A Encoder/Decoder vs B', () => {
  it('GB-01: A Encoder produces the B bytes for every primitive vector (incl. CJK, emoji, empty, int64)', () => {
    for (const v of golden.vectors.encoder) {
      const e = new Encoder();
      for (const [op, arg] of v.ops) {
        if (op === 'writeInt64') e.writeInt64(BigInt(arg as string));
        else (e as unknown as Record<string, (a: unknown) => void>)[op](arg);
      }
      expect(hex(e.toUint8Array()), JSON.stringify(v.ops)).toBe(v.bytesHex);
    }
  });

  it('GB-02: A Decoder reads back the encoded primitives', () => {
    for (const v of golden.vectors.encoder) {
      const d = new Decoder(Buffer.from(v.bytesHex, 'hex'));
      for (const [op, arg] of v.ops) {
        if (op === 'writeByte') expect(d.readByte()).toBe(arg);
        if (op === 'writeInt16') expect(d.readInt16()).toBe(arg);
        if (op === 'writeInt32') expect(d.readInt32()).toBe((arg as number) >>> 0);
        if (op === 'writeInt64') expect(d.readInt64String()).toBe(arg);
        if (op === 'writeString') expect(d.readString()).toBe(arg);
      }
    }
  });

  it('GB-03 (BX-2): B silently over-reads truncated input; A raises a typed bounds error instead', () => {
    for (const v of golden.vectors.truncatedDecode) {
      const d = new Decoder(Buffer.from(v.bytesHex, 'hex'));
      expect(v.bResult, `B result recorded for ${v.op}`).not.toBeUndefined();
      expect(() => (d as unknown as Record<string, () => unknown>)[v.op](), v.op).toThrow(RangeError);
    }
  });
});

describe('P1 handshake and AES vs B (production WKSocket through the fake server)', () => {
  let server: FakeOctoWsServer | undefined;
  let sock: WKSocket | undefined;
  afterEach(async () => {
    sock?.disconnect();
    sock = undefined;
    await server?.close();
    server = undefined;
    ctl.seed = null;
    vi.restoreAllMocks();
  });

  it('GB-04 (T1/T3/T5): A CONNECT equals the B CONNECT frame byte-for-byte for identical inputs', async () => {
    for (const v of golden.vectors.connect) {
      server = await FakeOctoWsServer.start({ autoConnack: false });
      ctl.seed = Buffer.from(v.clientSeedHex, 'hex');
      vi.spyOn(Math, 'random').mockReturnValue(v.mathRandom);
      vi.spyOn(Date, 'now').mockReturnValue(v.clientTimestamp);
      sock = new WKSocket({ wsUrl: server.url, uid: v.uid, token: v.token, onMessage: () => undefined });
      sock.connect();
      const connect = await server.waitFor((e) => e.dir === 'in' && e.type === 'CONNECT');
      vi.restoreAllMocks();
      expect(connect.rawHex).toBe(v.frameHex);
      // the fake codec decodes the B frame to the same inputs (codec fidelity)
      const [frame] = splitFrames(Buffer.from(v.frameHex, 'hex')).frames;
      expect(parseConnect(frame.body)).toMatchObject({ version: 4, deviceFlag: 0, deviceID: v.deviceID, uid: v.uid, token: v.token, clientKey: v.clientKey });
      sock.disconnect();
      await server.close();
      server = undefined;
    }
  });

  it('GB-05 (T6): the B AES key/IV/ciphertext vectors satisfy the P1 derivation independently', () => {
    for (const v of golden.vectors.aes) {
      const client = generateKeyPair(Buffer.from(v.clientSeedHex, 'hex'));
      const srv = generateKeyPair(Buffer.from(v.serverSeedHex, 'hex'));
      const secret = Buffer.from(sharedKey(client.private, srv.public)).toString('base64');
      expect(secret).toBe(v.sharedSecretBase64);
      const key = createHash('md5').update(secret).digest('hex').slice(0, 16);
      expect(key).toBe(v.aesKey);
      expect(v.aesIV).toBe(Buffer.from(v.salt, 'utf8').subarray(0, 16).toString('latin1'));
      const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(v.aesIV, 'latin1'));
      const plain = Buffer.concat([decipher.update(Buffer.from(v.ciphertextBase64, 'base64')), decipher.final()]).toString('utf8');
      expect(plain).toBe(v.plaintext);
      expect(v.bDecrypted).toBe(v.plaintext);
    }
  });

  it('GB-06 (T9/T10/BX-1): A decodes every B RECV vector to the B message and ACKs with the B RECVACK bytes only after decrypt', async () => {
    for (const s of golden.vectors.session) {
      server = await FakeOctoWsServer.start({ autoConnack: false });
      ctl.seed = Buffer.from(s.clientSeedHex, 'hex');
      const got: BotMessage[] = [];
      sock = new WKSocket({ wsUrl: server.url, uid: 'u_bot', token: 't', onMessage: (m) => got.push(m) });
      sock.connect();
      await server.waitFor((e) => e.dir === 'in' && e.type === 'CONNECT');
      server.sendRaw(Buffer.from(s.connackFrameHex, 'hex'));
      for (const r of s.recv) {
        const before = got.length;
        const acksBefore = server.events.filter((e) => e.dir === 'in' && e.type === 'RECVACK').length;
        server.sendRaw(Buffer.from(r.frameHex, 'hex'));
        if (r.bOnMessage) {
          await waitUntil(() => got.length === before + 1);
          const { streamOn, ...rest } = got[before];
          expect(rest, `${s.name}/${r.spec.messageId}`).toEqual(r.bOnMessage);
          expect(streamOn).toBe(((r.spec.setting >> 1) & 1) === 1);
          const ack = await server.waitFor((e) => e.dir === 'in' && e.type === 'RECVACK', 2_000, acksBefore);
          expect(ack.rawHex).toBe(r.bRecvackHex);
        } else {
          // B ACKs undecryptable input immediately (BX-1); A must not ACK the first failure.
          expect(r.bRecvackHex).not.toBeNull();
          await sleep(60);
          expect(got.length).toBe(before);
          expect(server.events.filter((e) => e.dir === 'in' && e.type === 'RECVACK').length).toBe(acksBefore);
        }
      }
      sock.disconnect();
      sock = undefined;
      await server.close();
      server = undefined;
    }
  });

  it('GB-07: the fake codec reproduces the B-verified CONNACK/RECV frames and parses the B RECVACK', () => {
    for (const s of golden.vectors.session) {
      expect(hex(encodeConnack({ serverVersion: s.serverVersion, reasonCode: 1, serverKey: s.serverKey, salt: s.salt, timeDiff: 0n, nodeId: 0n }))).toBe(s.connackFrameHex);
      for (const r of s.recv) {
        const frame = encodeRecv({ ...r.spec, payload: Buffer.from(r.spec.payloadBase64Ascii, 'latin1') }, s.serverVersion);
        expect(hex(frame)).toBe(r.frameHex);
        if (r.bRecvackHex) {
          const [f] = splitFrames(Buffer.from(r.bRecvackHex, 'hex')).frames;
          expect(parseRecvack(f.body)).toEqual({ messageId: r.spec.messageId, messageSeq: r.spec.messageSeq });
        }
      }
    }
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await sleep(5);
  }
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
