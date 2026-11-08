import { createHmac, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DbAdapter } from '../db-adapter.js';
import type { IngressReservation } from './ingress-reservation.js';

/** All fields must come from configured/native authority, never arrival order. */
export interface ReplayIdentity {
  origin: string;
  recipientBotUid: string;
  streamId: string;
  streamIncarnation: string;
  sequence: string;
  messageId: string;
  messageVersion: string;
  payloadSha256: string;
}

type State = 'reserved' | 'terminal' | 'uncertain';
interface Row { delivery_key: string; state: State; checksum: string }
const HEX = /^[0-9a-f]{64}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;

/** Four-byte big-endian UTF-8 byte lengths; no delimiter or Unicode folding. */
export function replayComponents(parts: readonly string[]): Buffer {
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length === 0 || bytes.length > 0xffff_ffff || bytes.toString('utf8') !== part) {
      throw new Error('Invalid replay component');
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    buffers.push(size, bytes);
  }
  return Buffer.concat(buffers);
}

/**
 * Local durable reservation component, not a native recovery authority.
 * The host must hold exclusive ownership during initialization/recovery and
 * validate its native checkpoint/restore fence BEFORE exposing this component
 * to ingress. No compaction, key rotation, automatic restore or TTL is offered.
 */
export class ReplayJournal {
  private readonly key: Buffer;
  private readonly version: string;
  private readonly file: string;
  private failed = false;

  constructor(
    private readonly db: DbAdapter,
    key: Uint8Array,
    keyVersion: string,
    options: { provision?: boolean; maxRecords?: number; maxBytes?: number } = {},
  ) {
    if (key.byteLength !== 32 || !/^[1-9][0-9]*$/.test(keyVersion) || db.inTransaction) {
      throw new Error('Replay journal configuration unavailable');
    }
    this.key = Buffer.from(key);
    this.version = keyVersion;
    this.maxRecords = options.maxRecords ?? 100_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 100_000
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 64 * 1024 * 1024) {
      throw new Error('Replay journal bounds unavailable');
    }
    const databases = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
    this.file = databases.find(database => database.name === 'main')?.file ?? '';
    if (!this.file) throw new Error('Replay journal requires file-backed SQLite');
    db.exec('PRAGMA synchronous = FULL');
    if ((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous !== 2) {
      throw new Error('Replay journal durability unavailable');
    }
    const check = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error('Replay journal integrity unavailable');
    this.write(() => {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='permission_replay_meta'").get();
      if (!exists && !options.provision) throw new Error('Replay journal missing');
      if (!exists) {
        db.exec(`CREATE TABLE permission_replay_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), key_version TEXT NOT NULL,
          record_count INTEGER NOT NULL CHECK(record_count>=0), checksum TEXT NOT NULL);
          CREATE TABLE permission_replay (
          delivery_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('reserved','terminal','uncertain')),
          checksum TEXT NOT NULL);`);
        db.prepare('INSERT INTO permission_replay_meta VALUES (1, ?, 0, ?)').run(this.version, this.mac(['meta', this.version, '0']));
      }
      this.verifyMeta();
      for (const row of db.prepare('SELECT * FROM permission_replay').all() as Row[]) this.verify(row);
    });
  }

  private readonly maxRecords: number;
  private readonly maxBytes: number;

  /** Called only after exclusive ownership and external native recovery proof. */
  recoverInterrupted(): void {
    this.write(() => {
      this.verifyMeta();
      for (const row of this.db.prepare("SELECT * FROM permission_replay WHERE state='reserved'").all() as Row[]) {
        this.verify(row);
        this.setState(row.delivery_key, 'uncertain');
      }
    });
  }

  reserve(identity: ReplayIdentity): IngressReservation {
    if (this.failed) return { disposition: 'unavailable' };
    try {
      const deliveryKey = this.deliveryKey(identity);
      return this.write((): IngressReservation => {
        const count = this.verifyMeta();
        const existing = this.db.prepare('SELECT * FROM permission_replay WHERE delivery_key=?').get(deliveryKey) as Row | undefined;
        if (existing) {
          this.verify(existing);
          return { disposition: 'duplicate' };
        }
        // Include current WAL, not just live rows. Reserve overhead before the
        // next transaction; saturation never evicts older replay fences.
        const bytes = [this.file, `${this.file}-wal`, `${this.file}-shm`].reduce((total, file) => {
          try { return total + statSync(file).size; } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file !== this.file) return total;
            throw error;
          }
        }, 0);
        if (count >= this.maxRecords || bytes + 64 * 1024 > this.maxBytes) return { disposition: 'unavailable' };
        this.db.prepare('INSERT INTO permission_replay VALUES (?, ?, ?)')
          .run(deliveryKey, 'reserved', this.mac(['row', deliveryKey, 'reserved']));
        this.db.prepare('UPDATE permission_replay_meta SET record_count=?, checksum=? WHERE singleton=1')
          .run(count + 1, this.mac(['meta', this.version, String(count + 1)]));
        // write() commits with FULL synchronous before this object escapes.
        return { disposition: 'reserved', finish: state => this.finish(deliveryKey, state) };
      });
    } catch {
      this.failed = true;
      return { disposition: 'unavailable' };
    }
  }

  private deliveryKey(identity: ReplayIdentity): string {
    if (!/^[0-9a-f]{32}$/.test(identity.streamIncarnation) || !/^[\x21-\x7e]{1,128}$/.test(identity.streamId)
      || !U64.test(identity.sequence) || BigInt(identity.sequence) > 18_446_744_073_709_551_615n
      || !/^[1-9][0-9]{0,18}$/.test(identity.messageId) || BigInt(identity.messageId) > 9_223_372_036_854_775_807n
      || !HEX.test(identity.payloadSha256) || !/^[A-Za-z0-9_-]{1,512}$/.test(identity.messageVersion)) {
      throw new Error('Replay identity unavailable');
    }
    return this.mac(['delivery', identity.origin, identity.recipientBotUid, identity.streamId,
      identity.streamIncarnation, identity.sequence, identity.messageId, identity.messageVersion, identity.payloadSha256]);
  }

  private finish(deliveryKey: string, state: 'terminal' | 'uncertain'): void {
    if (this.failed) throw new Error('Replay journal unavailable');
    try {
      this.write(() => {
        this.verifyMeta();
        const row = this.db.prepare('SELECT * FROM permission_replay WHERE delivery_key=?').get(deliveryKey) as Row | undefined;
        if (!row) throw new Error('Replay reservation missing');
        this.verify(row);
        if (row.state === 'reserved') this.setState(deliveryKey, state);
      });
    } catch {
      this.failed = true;
      throw new Error('Replay journal completion unavailable');
    }
  }

  private setState(deliveryKey: string, state: State): void {
    this.db.prepare('UPDATE permission_replay SET state=?, checksum=? WHERE delivery_key=?')
      .run(state, this.mac(['row', deliveryKey, state]), deliveryKey);
  }

  private verify(row: Row): void {
    if (!HEX.test(row.delivery_key) || !['reserved', 'terminal', 'uncertain'].includes(row.state)
      || !this.matches(row.checksum, this.mac(['row', row.delivery_key, row.state]))) {
      throw new Error('Replay journal record unavailable');
    }
  }

  private verifyMeta(): number {
    const meta = this.db.prepare('SELECT * FROM permission_replay_meta WHERE singleton=1').get() as
      { key_version: string; record_count: number; checksum: string } | undefined;
    if (!meta || meta.key_version !== this.version || !Number.isSafeInteger(meta.record_count)
      || meta.record_count < 0 || !this.matches(meta.checksum, this.mac(['meta', this.version, String(meta.record_count)]))) {
      throw new Error('Replay journal key or metadata unavailable');
    }
    const count = this.db.prepare('SELECT count(*) AS n FROM permission_replay').get() as { n: number };
    if (count.n !== meta.record_count) throw new Error('Replay journal incomplete');
    return count.n;
  }

  private mac(parts: string[]): string {
    return createHmac('sha256', this.key).update(replayComponents(['octo-permission-replay-v1', this.version, ...parts])).digest('hex');
  }

  private matches(actual: string, expected: string): boolean {
    return HEX.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  }

  private write<T>(fn: () => T): T {
    if (this.db.inTransaction) throw new Error('Replay journal cannot use an outer transaction');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
