import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import CryptoJS from 'crypto-js';
import { Md5 } from 'md5-typescript';
import { WKSocket, Encoder, Decoder } from '../../octo/socket.js';
import type { BotMessage } from '../../octo/types.js';

function packet(type: number, encoder: Encoder): Uint8Array {
  const body = encoder.toUint8Array();
  const size: number[] = [];
  let n = body.length;
  do { const v = n % 128; n = Math.floor(n / 128); size.push(v | (n ? 128 : 0)); } while (n);
  return Uint8Array.from([type << 4, ...size, ...body]);
}

function response(connect: Uint8Array, sequence: number): [Uint8Array, Uint8Array] {
  const decoder = new Decoder(connect);
  decoder.readByte(); decoder.readVariableLength(); decoder.readByte(); decoder.readByte();
  decoder.readString(); decoder.readString(); decoder.readString(); decoder.readInt64BigInt();
  const key = Uint8Array.from(Buffer.from(decoder.readString(), 'base64'));
  const server = generateKeyPair(randomBytes(32));
  const shared = sharedKey(server.private, key);
  const aesKey = Md5.init(Buffer.from(shared).toString('base64')).substring(0, 16);
  const iv = '0123456789abcdef';
  const ack = new Encoder();
  ack.writeInt64(0n); ack.writeByte(1);
  ack.writeString(Buffer.from(server.public).toString('base64')); ack.writeString(iv);
  const ciphertext = CryptoJS.AES.encrypt(JSON.stringify({ type: 1, content: `recovered-${sequence}` }),
    CryptoJS.enc.Utf8.parse(aesKey), { iv: CryptoJS.enc.Utf8.parse(iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString();
  const recv = new Encoder();
  recv.writeByte(0); recv.writeString('synthetic-key'); recv.writeString('synthetic-sender');
  recv.writeString('synthetic-channel'); recv.writeByte(1); recv.writeString('synthetic-client');
  recv.writeInt64(BigInt(sequence)); recv.writeInt32(sequence); recv.writeInt32(1);
  recv.writeBytes(Array.from(Buffer.from(ciphertext)));
  return [packet(2, ack), packet(5, recv)];
}

let server: WebSocketServer | undefined;
let client: WKSocket | undefined;
afterEach(async () => {
  await client?.disconnectAndWait(); client = undefined;
  if (server) {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined;
  }
});

async function start(silentFirst = false) {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let attempts = 0;
  server.on('connection', (peer) => {
    const attempt = ++attempts;
    peer.once('message', (data) => {
      if (silentFirst && attempt === 1) return; // accepts WS but never returns CONNACK
      const [ack, recv] = response(new Uint8Array(data as Buffer), attempt);
      peer.send(ack); peer.send(recv);
    });
  });
  const messages: BotMessage[] = [];
  const connected = vi.fn();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  client = new WKSocket({ wsUrl: `ws://127.0.0.1:${address.port}`, uid: 'synthetic-bot', token: 'synthetic-token',
    onConnected: connected, onMessage: (msg) => messages.push(msg) });
  client.connect();
  return { messages, connected, attempts: () => attempts };
}

describe('Issue #18: real loopback WebSocket recovery', () => {
  it('reconnects after an abrupt transport loss and decrypts a new message', async () => {
    const state = await start();
    await vi.waitFor(() => expect(state.messages).toHaveLength(1), { timeout: 3000 });
    for (const peer of server!.clients) peer.terminate();
    await vi.waitFor(() => expect(state.messages).toHaveLength(2), { timeout: 7000 });
    expect(state.connected).toHaveBeenCalledTimes(2);
    expect(state.messages[1].payload.content).toBe('recovered-2');
    expect(state.attempts()).toBe(2);
  }, 12000);

  it('abandons a silent CONNACK handshake, reconnects and receives a real encrypted message', async () => {
    const state = await start(true);
    await vi.waitFor(() => expect(state.messages).toHaveLength(1), { timeout: 22000 });
    expect(state.connected).toHaveBeenCalledOnce();
    expect(state.messages[0].payload.content).toBe('recovered-2');
    expect(state.attempts()).toBe(2);
  }, 25000);
});
