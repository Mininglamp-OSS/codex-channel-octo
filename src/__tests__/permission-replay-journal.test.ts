import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { ReplayJournal, replayComponents, type ReplayIdentity } from '../permissions/replay-journal.js';

const key = Buffer.alloc(32, 7); // Synthetic fixture; never a host credential.
const delivery: ReplayIdentity = {
  origin: 'https://synthetic.invalid', recipientBotUid: 'synthetic-bot', streamId: 'synthetic-stream',
  streamIncarnation: '1'.repeat(32), sequence: '18446744073709551615', messageId: '9223372036854775807',
  messageVersion: 'native_version', payloadSha256: '2'.repeat(64),
};

describe('file-backed FULL-sync replay journal', () => {
  let root: string;
  let file: string;
  let adapters: DbAdapter[];
  function open() { const db = createAdapter(file); adapters.push(db); return db; }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'permission-replay-'));
    file = join(root, 'replay.db'); adapters = [];
  });
  afterEach(() => {
    for (const db of adapters) db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns only after a separate connection can see a committed reservation', () => {
    const db = open();
    const journal = new ReplayJournal(db, key, '1', { provision: true });
    const reservation = journal.reserve(delivery);
    expect(reservation.disposition).toBe('reserved');
    // Independently calculated Python struct/HMAC vector, also published in
    // the component contract for the coordinator owner.
    expect(db.prepare('SELECT delivery_key FROM permission_replay').get()).toEqual({
      delivery_key: '4248066b16de16e17b8f1868fab00e0b8bf81f6d6bcb2efb402f28907914e6f8',
    });
    expect(db.inTransaction).toBe(false);
    const other = open();
    expect(other.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'reserved' });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    const competitor = new ReplayJournal(other, key, '1');
    expect(other.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(competitor.reserve(delivery).disposition).toBe('duplicate');
    if (reservation.disposition !== 'reserved') throw new Error('Expected reservation');
    reservation.finish('terminal');
    expect(other.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'terminal' });
    expect(journal.reserve(delivery).disposition).toBe('duplicate');
    // No raw identifiers, source body or authority tokens are stored in rows.
    expect(JSON.stringify(other.prepare('SELECT * FROM permission_replay').all())).not.toContain('synthetic');
  });

  it('retains a crash-window reservation; recovery marks uncertainty without replay', () => {
    const db = open();
    const journal = new ReplayJournal(db, key, '1', { provision: true });
    expect(journal.reserve(delivery).disposition).toBe('reserved');
    db.close(); adapters = [];
    const next = open();
    const restarted = new ReplayJournal(next, key, '1');
    restarted.recoverInterrupted(); // Synthetic exclusive-recovery fixture only.
    expect(next.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'uncertain' });
    expect(restarted.reserve(delivery).disposition).toBe('duplicate');
    expect(next.prepare('SELECT count(*) AS n FROM permission_replay').get()).toEqual({ n: 1 });
  });

  it('retains the committed WAL reservation after a writer is killed without cleanup', async () => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../../node_modules/vite-node/vite-node.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/replay-crash.ts', import.meta.url)), file,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    try {
      await vi.waitFor(() => expect(output).toContain('RESERVED\n'), { timeout: 5000 });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const db = open();
    const recovered = new ReplayJournal(db, key, '1');
    recovered.recoverInterrupted();
    expect(recovered.reserve(delivery).disposition).toBe('duplicate');
    expect(db.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'uncertain' });
  });

  it('refuses missing journal, wrong key/version, corruption and outer transactions', () => {
    const db = open();
    expect(() => new ReplayJournal(db, key, '1')).toThrow('missing');
    const journal = new ReplayJournal(db, key, '1', { provision: true });
    expect(() => new ReplayJournal(db, Buffer.alloc(32, 8), '1')).toThrow('key');
    expect(() => new ReplayJournal(db, key, '2')).toThrow('key');
    db.exec('BEGIN');
    expect(journal.reserve(delivery).disposition).toBe('unavailable');
    db.exec('ROLLBACK');
    const fresh = new ReplayJournal(db, key, '1');
    fresh.reserve(delivery);
    db.exec("UPDATE permission_replay SET state='terminal'");
    expect(() => new ReplayJournal(db, key, '1')).toThrow('record');
    expect(fresh.reserve(delivery).disposition).toBe('unavailable');
  });

  it('saturates without evicting duplicate/uncertain fences', () => {
    const db = open();
    const journal = new ReplayJournal(db, key, '1', { provision: true, maxRecords: 1 });
    const first = journal.reserve(delivery);
    if (first.disposition !== 'reserved') throw new Error('Expected reservation');
    first.finish('uncertain');
    expect(journal.reserve({ ...delivery, sequence: '1' }).disposition).toBe('unavailable');
    expect(journal.reserve(delivery).disposition).toBe('duplicate');
    expect(db.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'uncertain' });
  });

  it('detects deletion of a replay row without minting a new reservation', () => {
    const db = open();
    const journal = new ReplayJournal(db, key, '1', { provision: true });
    expect(journal.reserve(delivery).disposition).toBe('reserved');
    db.exec('DELETE FROM permission_replay');
    expect(journal.reserve(delivery).disposition).toBe('unavailable');
    expect(() => new ReplayJournal(db, key, '1')).toThrow('incomplete');
  });

  it('refuses the byte bound and noncanonical native identity', () => {
    const db = open();
    const small = new ReplayJournal(db, key, '1', { provision: true, maxBytes: 1 });
    expect(small.reserve(delivery).disposition).toBe('unavailable');
    const journal = new ReplayJournal(db, key, '1');
    expect(journal.reserve({ ...delivery, sequence: '01' }).disposition).toBe('unavailable');
    expect(db.prepare('SELECT count(*) AS n FROM permission_replay').get()).toEqual({ n: 0 });
  });

  it('length-delimits exact UTF-8 bytes and separates recipient/stream/version/digest', () => {
    expect(replayComponents(['ab', 'c'])).not.toEqual(replayComponents(['a', 'bc']));
    expect(replayComponents(['ab', 'c']).toString('hex')).toBe('0000000261620000000163');
    expect(replayComponents(['é'])).not.toEqual(replayComponents(['e\u0301']));
    const db = open();
    const journal = new ReplayJournal(db, key, '1', { provision: true });
    for (const identity of [delivery, { ...delivery, recipientBotUid: 'other-bot' },
      { ...delivery, streamIncarnation: '3'.repeat(32) }, { ...delivery, messageVersion: 'other_version' },
      { ...delivery, payloadSha256: '4'.repeat(64) }]) {
      expect(journal.reserve(identity).disposition).toBe('reserved');
    }
    expect(db.prepare('SELECT count(*) AS n FROM permission_replay').get()).toEqual({ n: 5 });
    expect(readFileSync(file).includes(Buffer.from(delivery.origin))).toBe(false);
  });
});
