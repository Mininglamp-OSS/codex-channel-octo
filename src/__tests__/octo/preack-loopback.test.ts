import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import CryptoJS from 'crypto-js';
import { Md5 } from 'md5-typescript';
import { WKSocket, Encoder, Decoder } from '../../octo/socket.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReplayJournal } from '../../permissions/replay-journal.js';
import { createAdapter } from '../../db-adapter.js';
import type { ProcessingDisposition, ReserveBeforeAck } from '../../permissions/ingress-reservation.js';

// Actual encrypted WKSocket transport, restricted to synthetic loopback data.
// These packets do not attest a native Header/stream incarnation/checkpoint.
function packet(type: number, body: Encoder): Uint8Array {
  const bytes = body.toUint8Array();
  const length: number[] = [];
  let n = bytes.length;
  do { const digit = n % 128; n = Math.floor(n / 128); length.push(digit | (n ? 128 : 0)); } while (n);
  return Uint8Array.from([type << 4, ...length, ...bytes]);
}

let server: WebSocketServer | undefined;
let client: WKSocket | undefined;
afterEach(async () => {
  await client?.disconnectAndWait();
  await client?.drainReceives();
  client = undefined;
  if (server) {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

async function start(
  reserveBeforeAck: NonNullable<ConstructorParameters<typeof WKSocket>[0]['reserveBeforeAck']>,
  handler: () => void | ProcessingDisposition | Promise<void | ProcessingDisposition> = () => {},
) {
  const acks: Uint8Array[] = [];
  const handled = vi.fn(handler);
  let resend = () => {};
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', peer => {
    peer.once('message', raw => {
      const d = new Decoder(new Uint8Array(raw as Buffer));
      d.readByte(); d.readVariableLength(); d.readByte(); d.readByte();
      d.readString(); d.readString(); d.readString(); d.readInt64BigInt();
      const clientKey = Uint8Array.from(Buffer.from(d.readString(), 'base64'));
      const keys = generateKeyPair(randomBytes(32));
      const aes = Md5.init(Buffer.from(sharedKey(keys.private, clientKey)).toString('base64')).substring(0, 16);
      const iv = '0123456789abcdef';
      const ack = new Encoder();
      ack.writeInt64(0n); ack.writeByte(1);
      ack.writeString(Buffer.from(keys.public).toString('base64')); ack.writeString(iv);
      const encrypted = CryptoJS.AES.encrypt(JSON.stringify({ type: 1, content: 'SYNTHETIC_REQUEST' }),
        CryptoJS.enc.Utf8.parse(aes), { iv: CryptoJS.enc.Utf8.parse(iv) }).toString();
      const recv = new Encoder();
      recv.writeByte(0); recv.writeString('synthetic-key'); recv.writeString('synthetic-human');
      recv.writeString('synthetic-channel'); recv.writeByte(1); recv.writeString('synthetic-client');
      recv.writeInt64(9007199254740993n); recv.writeInt32(7); recv.writeInt32(1);
      recv.writeBytes([...Buffer.from(encrypted)]);
      resend = () => peer.send(packet(5, recv));
      peer.on('message', data => { if ((new Uint8Array(data as Buffer)[0] >> 4) === 6) acks.push(new Uint8Array(data as Buffer)); });
      peer.send(packet(2, ack)); resend();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  const errors: string[] = [];
  client = new WKSocket({ wsUrl: `ws://127.0.0.1:${address.port}`, uid: 'synthetic-bot', token: 'synthetic-token',
    reserveBeforeAck, onMessage: handled, onError: err => errors.push(err.message) });
  client.connect();
  return { acks, handled, resend: () => resend(), errors };
}

describe('pre-ACK reservation on a real loopback socket', () => {
  it('does no ACK or handler work until reservation completes', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const finish = vi.fn();
    const reserve = vi.fn<ReserveBeforeAck>(async () => { await wait; return { disposition: 'reserved', finish }; });
    const state = await start(reserve);
    try {
      await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
      expect(state.acks).toHaveLength(0);
      expect(state.handled).not.toHaveBeenCalled();
    } finally { release(); }
    await vi.waitFor(() => expect(state.acks).toHaveLength(1));
    expect(state.handled).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith('terminal');
    const delivery = reserve.mock.calls[0][0];
    expect(delivery.message.message_id).toBe('9007199254740993');
    expect(delivery.recipientUid).toBe('synthetic-bot');
    expect(delivery.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(delivery.message.payload)).toBe(true);
  });

  it('ACKs a durably known duplicate without dispatching it', async () => {
    const state = await start(() => ({ disposition: 'duplicate' }));
    await vi.waitFor(() => expect(state.acks).toHaveLength(1));
    expect(state.handled).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'throw'] as const)('does not ACK or dispatch on %s', async mode => {
    const reserve = vi.fn(() => {
      if (mode === 'throw') throw new Error('PRIVATE_MARKER');
      return { disposition: 'unavailable' as const };
    });
    const state = await start(reserve);
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
    await client!.drainReceives();
    expect(state.acks).toHaveLength(0);
    expect(state.handled).not.toHaveBeenCalled();
    expect(state.errors.join(' ')).not.toContain('PRIVATE_MARKER');
  });

  it('withholds RECVACK until handler and terminal SQLite commit complete, suppressing in-flight redelivery and ACKing post-terminal duplicates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preack-integration-'));
    const db = createAdapter(join(root, 'journal.db'));
    const journal = new ReplayJournal(db, Buffer.alloc(32, 9), '1', { provision: true });
    let finishHandler!: () => void;
    const wait = new Promise<void>(resolve => { finishHandler = resolve; });
    try {
      const state = await start(delivery => journal.reserve({
        // Synthetic native adapter fixture. No actual provider authority is
        // inferred from these invented stream/version fields.
        origin: 'https://synthetic.invalid', recipientBotUid: delivery.recipientUid,
        streamId: 'fixture-stream', streamIncarnation: 'a'.repeat(32), sequence: '7',
        messageId: delivery.message.message_id!, messageVersion: 'fixture_version', payloadSha256: delivery.payloadSha256,
      }), async () => {
        expect(db.inTransaction).toBe(false);
        expect(db.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'reserved' });
        await wait;
      });
      await vi.waitFor(() => expect(state.handled).toHaveBeenCalledOnce());
      // No RECVACK may be sent while handler is still in flight.
      expect(state.acks).toHaveLength(0);
      // Concurrent redelivery while reserved is suppressed without premature ACK.
      state.resend();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(state.acks).toHaveLength(0);
      expect(state.handled).toHaveBeenCalledOnce();
      finishHandler();
      await vi.waitFor(() => expect(state.acks).toHaveLength(1));
      await client!.drainReceives();
      expect(db.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'terminal' });
      // Redelivery after terminal commit is ACKed as a duplicate without re-running handler.
      state.resend();
      await vi.waitFor(() => expect(state.acks).toHaveLength(2));
      expect(state.handled).toHaveBeenCalledOnce();
    } finally {
      finishHandler();
      await client?.disconnectAndWait(); await client?.drainReceives();
      db.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects a late reservation after disconnect without ACK or model work', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const finish = vi.fn();
    const reserve = vi.fn(async () => { await wait; return { disposition: 'reserved' as const, finish }; });
    const state = await start(reserve);
    try {
      await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
      await client!.disconnectAndWait();
    } finally { release(); }
    await client!.drainReceives();
    expect(state.acks).toHaveLength(0);
    expect(state.handled).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('uncertain');
  });

  it('collects handler failures and uncertain outcomes without sending RECVACK or replaying the handler', async () => {
    const finish = vi.fn();
    const state = await start(() => ({ disposition: 'reserved', finish }), async () => { throw new Error('PRIVATE_HANDLER'); });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('uncertain'));
    expect(state.handled).toHaveBeenCalledOnce();
    expect(state.acks).toHaveLength(0);
    expect(state.errors).toEqual(['Managed ingress reservation or handler unavailable']);
  });

  it('does not send RECVACK when handler returns uncertain disposition (e.g. draining/aborted)', async () => {
    const finish = vi.fn();
    const state = await start(() => ({ disposition: 'reserved', finish }), async () => 'uncertain' as const);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('uncertain'));
    await client!.drainReceives();
    expect(state.handled).toHaveBeenCalledOnce();
    expect(state.acks).toHaveLength(0);
  });
});
