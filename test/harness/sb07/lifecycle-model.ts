/**
 * TEST ONLY reference model of the host-side server-request lifecycle for the
 * SB-07 exec-parity rejection path (A-R8-SB07-01).
 *
 * It states the obligations the DEV-03/04 runtime must meet (HB-B7) so tests
 * can check duplicate, late and cross-generation event handling; it is NOT the
 * host runtime and nothing in src/ implements it yet (pending DEV-03/04).
 *
 *  - every server request gets exactly one parity error reply;
 *  - a pending request is recorded under (incarnation, threadId, typed id), so
 *    number 0 and string "0" differ and a restarted process's id 0 is a new key;
 *  - serverRequest/resolved only retires the matching pending record; it never
 *    replies, reopens, completes the item or turn, or releases the thread lane;
 *  - duplicate, late, unknown or old-incarnation resolutions are observable
 *    no-ops;
 *  - the lane is released only by turn/completed for the active turn.
 */
import { sb07ReplyBytes } from './oracle.js';

export type RequestId = number | string;

export type Effect =
  | { kind: 'reply'; incarnation: string; id: RequestId; bytes: string }
  | { kind: 'retired'; incarnation: string; threadId: string; id: RequestId }
  | { kind: 'ignored'; event: 'resolved' | 'item' | 'turn'; reason: 'unknown' | 'duplicate' | 'stale-incarnation' | 'not-active' }
  | { kind: 'item-failed'; threadId: string; turnId: string; itemId: string }
  | { kind: 'lane-released'; threadId: string; turnId: string };

export interface PendingRecord { incarnation: string; threadId: string; id: RequestId; turnId: string; itemId: string }

export class HostLifecycleModel {
  private current: string;
  private readonly pending = new Map<string, PendingRecord>();
  private readonly retired = new Set<string>();
  private readonly lanes = new Map<string, string>(); // threadId → active turnId
  private readonly items = new Set<string>();
  readonly effects: Effect[] = [];

  constructor(incarnation: string) { this.current = incarnation; }

  get incarnation(): string { return this.current; }
  activeTurn(threadId: string): string | undefined { return this.lanes.get(threadId); }
  pendingCount(): number { return this.pending.size; }

  /** Typed key: the JSON type is part of the identity. */
  protected key(incarnation: string, threadId: string, id: RequestId): string {
    return JSON.stringify([incarnation, threadId, typeof id, id]);
  }

  /** The child process was replaced; old records can never be resolved by the new process. */
  restart(incarnation: string): void {
    this.current = incarnation;
    this.pending.clear();
    this.retired.clear();
    this.items.clear();
    this.lanes.clear();
  }

  turnStarted(incarnation: string, threadId: string, turnId: string): Effect[] {
    if (incarnation !== this.current) return this.emit({ kind: 'ignored', event: 'turn', reason: 'stale-incarnation' });
    this.lanes.set(threadId, turnId);
    return [];
  }

  serverRequest(e: { incarnation: string; threadId: string; id: RequestId; turnId: string; itemId: string }): Effect[] {
    this.pending.set(this.key(e.incarnation, e.threadId, e.id), { ...e });
    return this.emit({ kind: 'reply', incarnation: e.incarnation, id: e.id, bytes: sb07ReplyBytes(e.id, e.threadId) });
  }

  resolved(e: { incarnation: string; threadId: string; requestId: RequestId }): Effect[] {
    if (e.incarnation !== this.current) return this.emit({ kind: 'ignored', event: 'resolved', reason: 'stale-incarnation' });
    const k = this.key(e.incarnation, e.threadId, e.requestId);
    if (this.retired.has(k)) return this.emit({ kind: 'ignored', event: 'resolved', reason: 'duplicate' });
    const rec = this.pending.get(k);
    if (!rec) return this.emit({ kind: 'ignored', event: 'resolved', reason: 'unknown' });
    return this.retire(k, rec);
  }

  /** Resolution's only effect: drop the pending record. */
  protected retire(k: string, rec: PendingRecord): Effect[] {
    this.pending.delete(k);
    this.retired.add(k);
    return this.emit({ kind: 'retired', incarnation: rec.incarnation, threadId: rec.threadId, id: rec.id });
  }

  itemCompleted(e: { incarnation: string; threadId: string; turnId: string; itemId: string; status: string }): Effect[] {
    if (e.incarnation !== this.current) return this.emit({ kind: 'ignored', event: 'item', reason: 'stale-incarnation' });
    const k = JSON.stringify([e.threadId, e.turnId, e.itemId]);
    if (this.items.has(k)) return this.emit({ kind: 'ignored', event: 'item', reason: 'duplicate' });
    this.items.add(k);
    return e.status === 'failed' ? this.emit({ kind: 'item-failed', threadId: e.threadId, turnId: e.turnId, itemId: e.itemId }) : [];
  }

  turnCompleted(e: { incarnation: string; threadId: string; turnId: string }): Effect[] {
    if (e.incarnation !== this.current) return this.emit({ kind: 'ignored', event: 'turn', reason: 'stale-incarnation' });
    if (this.lanes.get(e.threadId) !== e.turnId) return this.emit({ kind: 'ignored', event: 'turn', reason: 'not-active' });
    this.lanes.delete(e.threadId);
    return this.emit({ kind: 'lane-released', threadId: e.threadId, turnId: e.turnId });
  }

  protected emit(...effects: Effect[]): Effect[] {
    this.effects.push(...effects);
    return effects;
  }
}
