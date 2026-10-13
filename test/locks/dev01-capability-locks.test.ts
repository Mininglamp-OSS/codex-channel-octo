/**
 * R8 §4 rows staged "DEV-01" as "REUSE + test" whose behavior had no direct
 * test at dd12980: T12 (WS ping 60 s × 3), T15 (stable reset, rapid-disconnect),
 * I3 (topic id ≠ parent) and S2 (group/topic session). Timer-driven rows use a
 * unit-level ws stand-in with fake timers (R8 §10.1: timing at layers 1–2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPair } from 'curve25519-js';
import { SessionRouter } from '../../src/session-router.js';
import { parentGroupNo } from '../../src/channel-id.js';
import type { BotMessage } from '../../src/octo/types.js';
import type { Config } from '../../src/config.js';
import { encodeConnack } from '../harness/fake-octo/codec.js';

const wsState = vi.hoisted(() => ({ instances: [] as Array<EventEmitter & { sent: Uint8Array[]; readyState: number; closed: boolean; close(): void }> }));
vi.mock('ws', async () => {
  const { EventEmitter: Base } = await import('node:events');
  class MockWS extends Base {
    static OPEN = 1;
    binaryType = 'arraybuffer';
    readyState = 1;
    sent: Uint8Array[] = [];
    closed = false;
    constructor() { super(); wsState.instances.push(this as never); }
    send(d: Uint8Array) { this.sent.push(d); }
    close() { if (!this.closed) { this.closed = true; this.readyState = 3; setTimeout(() => this.emit('close'), 0); } }
    terminate() { this.close(); }
  }
  return { default: MockWS, WebSocket: MockWS };
});

const { WKSocket } = await import('../../src/octo/socket.js');

function connack(): Buffer {
  const server = generateKeyPair(Buffer.alloc(32, 7));
  return Buffer.from(encodeConnack({ serverVersion: 4, reasonCode: 1, serverKey: Buffer.from(server.public).toString('base64'), salt: '0123456789abcdef', timeDiff: 0n, nodeId: 0n }));
}
const PING = 0x70;
const pings = (w: { sent: Uint8Array[] }) => w.sent.filter((d) => d.length === 1 && d[0] === PING).length;

describe('T12 / T15 transport timers (A@dd12980 behavior)', () => {
  beforeEach(() => { vi.useFakeTimers(); wsState.instances.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  async function open(opts: Partial<ConstructorParameters<typeof WKSocket>[0]> = {}) {
    const s = new WKSocket({ wsUrl: 'ws://127.0.0.1:1', uid: 'u', token: 't', onMessage: () => undefined, ...opts });
    s.connect();
    const w = wsState.instances.at(-1)!;
    w.emit('open');
    w.emit('message', connack());
    return { s, w };
  }

  it('T12: after CONNACK a PING is sent every 60 s; three unanswered pings close and reconnect on the fourth tick', async () => {
    const disconnected = vi.fn();
    const { s, w } = await open({ onDisconnected: disconnected });
    vi.advanceTimersByTime(59_999);
    expect(pings(w)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pings(w)).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(pings(w)).toBe(3);
    expect(w.closed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(w.closed).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(1);
    // backoff reconnect (3 s ± 25 %) opens a new socket
    vi.advanceTimersByTime(3_750);
    expect(wsState.instances.length).toBe(2);
    s.disconnect();
  });

  it('T12: a PONG resets the unanswered-ping counter', async () => {
    const { s, w } = await open();
    vi.advanceTimersByTime(180_000);
    expect(pings(w)).toBe(3);
    w.emit('message', Buffer.from([0x80])); // PONG
    vi.advanceTimersByTime(180_000);
    expect(pings(w)).toBe(6);
    expect(w.closed).toBe(false);
    s.disconnect();
  });

  it('T15: three consecutive sub-5 s connections stop reconnecting and surface a rapid-disconnect error', async () => {
    const errors: string[] = [];
    const { s } = await open({ onError: (e) => errors.push(e.message) });
    for (let i = 0; i < 3; i++) {
      const w = wsState.instances.at(-1)!;
      vi.advanceTimersByTime(1_000);
      w.close();
      vi.advanceTimersByTime(1);
      if (i < 2) {
        vi.advanceTimersByTime(60_000);
        const next = wsState.instances.at(-1)!;
        next.emit('open');
        next.emit('message', connack());
      }
    }
    expect(errors).toContain('Connect failed: rapid disconnect detected');
    const count = wsState.instances.length;
    vi.advanceTimersByTime(300_000);
    expect(wsState.instances.length).toBe(count);
    s.disconnect();
  });

  it('T15: a connection that stays up 30 s resets the backoff to the base delay', async () => {
    const { s } = await open();
    // drive two failed attempts so the exponential backoff grows
    for (let i = 0; i < 2; i++) {
      const w = wsState.instances.at(-1)!;
      w.close();
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(60_000);
    }
    const w = wsState.instances.at(-1)!;
    w.emit('open');
    w.emit('message', connack());
    vi.advanceTimersByTime(30_000); // stable timer
    w.close();
    vi.advanceTimersByTime(1);
    const before = wsState.instances.length;
    vi.advanceTimersByTime(3_750); // base delay upper bound (3 s × 1.25)
    expect(wsState.instances.length).toBe(before + 1);
    s.disconnect();
  });
});

describe('I3 / S2 topic and group sessions', () => {
  const cfg = { apiUrl: 'http://127.0.0.1:9', botToken: 'bf', rateLimit: { maxPerMinute: 1000 }, dispatchTimeoutMs: 0 } as unknown as Config;
  const m = (channel_id: string, channel_type: number, from_uid = 'u_a') =>
    ({ message_id: '1', message_seq: 1, from_uid, channel_id, channel_type, timestamp: 1, payload: { type: 1, content: 'x', mention: { uids: ['u_bot'] } } }) as unknown as BotMessage;

  it('I3: a topic id <group>____<short> is its own session, distinct from its parent group, and resolves its parent group number', () => {
    const r = new SessionRouter(cfg, 'u_bot');
    expect(r.sessionKey(m('g1____t9', 5))).toBe('g1____t9');
    expect(r.sessionKey(m('g1', 2))).toBe('g1');
    expect(parentGroupNo('g1____t9')).toBe('g1');
    expect(parentGroupNo('g1')).toBe('g1');
  });

  it('S2: every member of a group or topic shares one session key; DMs stay per peer', () => {
    const r = new SessionRouter(cfg, 'u_bot');
    expect(r.sessionKey(m('g1', 2, 'u_a'))).toBe(r.sessionKey(m('g1', 2, 'u_b')));
    expect(r.sessionKey(m('g1____t9', 5, 'u_a'))).toBe(r.sessionKey(m('g1____t9', 5, 'u_b')));
    expect(r.sessionKey(m('u_a', 1, 'u_a'))).not.toBe(r.sessionKey(m('u_b', 1, 'u_b')));
    expect(() => r.sessionKey(m('', 2))).toThrow(/no channel_id/);
  });
});
