/**
 * SB07-F1 (A-R8-SB07-01): TEST ONLY lifecycle model checks. The model is a
 * reference statement of pending DEV-03/04 host obligations (HB-B7), not the
 * runtime. It is replayed against the raw real-binary capture, then probed
 * with duplicate, late and cross-generation events; mutation controls show
 * each property check kills a plausible wrong model.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HostLifecycleModel, type Effect, type PendingRecord, type RequestId } from './lifecycle-model.js';
import type { TranscriptEntry } from '../jsonl-client.js';

const META = JSON.parse(readFileSync(new URL('../../fixtures/app-server/0.142.3/sb07-rejection.meta.json', import.meta.url), 'utf8')) as { threadId: string; turnId: string; itemId: string; incarnation: string };
const trace = readFileSync(new URL('../../fixtures/app-server/0.142.3/sb07-rejection.transcript.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptEntry);
const parity = (id: RequestId, threadId: string) => `{"id":${JSON.stringify(id)},"error":{"code":-32000,"message":"command execution approval is not supported in exec mode for thread \`${threadId}\`"}}`;
const kinds = (fx: Effect[]) => fx.map((f) => f.kind);
const T = 'thread-A';

type Factory = (incarnation: string) => HostLifecycleModel;

/** Property checks over a model; returns the names of violated properties. */
function violatedProperties(make: Factory): string[] {
  const bad = new Set<string>();
  const req = (m: HostLifecycleModel, inc: string, id: RequestId, turnId = 'turn-1', itemId = 'item-1') => m.serverRequest({ incarnation: inc, threadId: T, id, turnId, itemId });

  // fresh process: id 0 is a valid request id and gets exactly one parity reply
  {
    const m = make('inc-1');
    m.turnStarted('inc-1', T, 'turn-1');
    const fx = req(m, 'inc-1', 0);
    if (JSON.stringify(fx) !== JSON.stringify([{ kind: 'reply', incarnation: 'inc-1', id: 0, bytes: parity(0, T) }])) bad.add('fresh-id-0-replied');
  }
  // resolution only retires; no item/turn completion, no lane release, no reply
  {
    const m = make('inc-1');
    m.turnStarted('inc-1', T, 'turn-1');
    req(m, 'inc-1', 0);
    const fx = m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 0 });
    if (JSON.stringify(kinds(fx)) !== '["retired"]') bad.add('resolution-only-retires');
    if (m.activeTurn(T) !== 'turn-1') bad.add('no-lane-release-on-resolution');
    if (m.pendingCount() !== 0) bad.add('resolution-retires-pending');
    // duplicate and late resolutions are observable no-ops
    const dup = m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 0 });
    if (JSON.stringify(dup) !== JSON.stringify([{ kind: 'ignored', event: 'resolved', reason: 'duplicate' }])) bad.add('duplicate-resolution-ignored');
    m.itemCompleted({ incarnation: 'inc-1', threadId: T, turnId: 'turn-1', itemId: 'item-1', status: 'failed' });
    if (kinds(m.turnCompleted({ incarnation: 'inc-1', threadId: T, turnId: 'turn-1' })).join() !== 'lane-released') bad.add('lane-released-on-turn-completed');
    const late = m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 0 });
    if (late.some((f) => f.kind !== 'ignored') || m.activeTurn(T) !== undefined || m.pendingCount() !== 0) bad.add('late-resolution-no-reopen');
  }
  // number 0 and string "0" are different ids
  {
    const m = make('inc-1');
    req(m, 'inc-1', 0);
    const fx = m.resolved({ incarnation: 'inc-1', threadId: T, requestId: '0' });
    if (kinds(fx).join() !== 'ignored' || m.pendingCount() !== 1) bad.add('typed-id');
  }
  // an old incarnation's id 0 cannot consume the new incarnation's id 0
  {
    const m = make('inc-1');
    req(m, 'inc-1', 0);
    m.restart('inc-2');
    m.turnStarted('inc-2', T, 'turn-2');
    req(m, 'inc-2', 0, 'turn-2', 'item-2');
    const stale = m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 0 });
    if (kinds(stale).join() !== 'ignored' || m.pendingCount() !== 1) bad.add('cross-generation');
    const fresh = m.resolved({ incarnation: 'inc-2', threadId: T, requestId: 0 });
    if (JSON.stringify(fresh) !== JSON.stringify([{ kind: 'retired', incarnation: 'inc-2', threadId: T, id: 0 }]) || m.pendingCount() !== 0) bad.add('cross-generation');
    if (m.activeTurn(T) !== 'turn-2') bad.add('no-lane-release-on-resolution');
  }
  return [...bad].sort();
}

describe('SB07-F1 lifecycle model (TEST ONLY; runtime pending DEV-03/04)', () => {
  it('SB07-F1-LM-04: restart drops old pending records before an old id 0 can affect the new incarnation', () => {
    const m = new HostLifecycleModel('old');
    m.turnStarted('old', T, 'old-turn');
    m.serverRequest({ incarnation: 'old', threadId: T, id: 0, turnId: 'old-turn', itemId: 'old-item' });
    m.restart('new');
    expect(m.pendingCount()).toBe(0);
    expect(m.activeTurn(T)).toBeUndefined();
    m.turnStarted('new', T, 'new-turn');
    m.serverRequest({ incarnation: 'new', threadId: T, id: 0, turnId: 'new-turn', itemId: 'new-item' });
    expect(m.resolved({ incarnation: 'old', threadId: T, requestId: 0 })).toEqual([{ kind: 'ignored', event: 'resolved', reason: 'stale-incarnation' }]);
    expect(m.pendingCount()).toBe(1);
    expect(m.activeTurn(T)).toBe('new-turn');
  });
  it('SB07-F1-LM-01: replaying the raw real capture yields the recorded reply bytes and releases the lane only at turn/completed', () => {
    const m = new HostLifecycleModel(META.incarnation);
    const seen: Array<[string, Effect[], string | undefined]> = [];
    let replied: string | undefined;
    for (const e of trace) {
      const msg = e.message as { id?: RequestId; method?: string; params?: Record<string, any> };
      const p = msg.params ?? {};
      if (e.dir !== 'in' || p.threadId !== META.threadId) continue;
      let fx: Effect[] = [];
      if (msg.method === 'turn/started') fx = m.turnStarted(e.incarnation!, p.threadId, p.turn.id);
      else if (msg.method === 'item/commandExecution/requestApproval' && msg.id !== undefined) fx = m.serverRequest({ incarnation: e.incarnation!, threadId: p.threadId, id: msg.id, turnId: p.turnId, itemId: p.itemId });
      else if (msg.method === 'serverRequest/resolved') fx = m.resolved({ incarnation: e.incarnation!, threadId: p.threadId, requestId: p.requestId });
      else if (msg.method === 'item/completed' && p.item?.type === 'commandExecution') fx = m.itemCompleted({ incarnation: e.incarnation!, threadId: p.threadId, turnId: p.turnId, itemId: p.item.id, status: p.item.status });
      else if (msg.method === 'turn/completed') fx = m.turnCompleted({ incarnation: e.incarnation!, threadId: p.threadId, turnId: p.turn.id });
      else continue;
      seen.push([msg.method!, fx, m.activeTurn(META.threadId)]);
      const r = fx.find((f) => f.kind === 'reply');
      if (r && r.kind === 'reply') replied = r.bytes;
    }
    expect(seen.map(([method, fx, lane]) => [method, kinds(fx), lane ?? null])).toEqual([
      ['turn/started', [], META.turnId],
      ['item/commandExecution/requestApproval', ['reply'], META.turnId],
      ['serverRequest/resolved', ['retired'], META.turnId],
      ['item/completed', ['item-failed'], META.turnId],
      ['turn/completed', ['lane-released'], null],
    ]);
    const actual = trace.find((e) => e.dir === 'out' && e.message.method === undefined && e.message.id === 0)!;
    expect(replied).toBe(actual.raw);
    expect(replied).toBe(parity(0, META.threadId));
  });

  it('SB07-F1-LM-02: the reference model satisfies every lifecycle property', () => {
    expect(violatedProperties((inc) => new HostLifecycleModel(inc))).toEqual([]);
  });

  it('SB07-F1-LM-03: duplicate and late resolutions are observable no-ops (no reply, reopen, completion or lane release)', () => {
    const m = new HostLifecycleModel('inc-1');
    m.turnStarted('inc-1', T, 'turn-1');
    m.serverRequest({ incarnation: 'inc-1', threadId: T, id: 0, turnId: 'turn-1', itemId: 'item-1' });
    m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 0 });
    const before = m.effects.length;
    expect(m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 0 })).toEqual([{ kind: 'ignored', event: 'resolved', reason: 'duplicate' }]);
    expect(m.resolved({ incarnation: 'inc-0', threadId: T, requestId: 0 })).toEqual([{ kind: 'ignored', event: 'resolved', reason: 'stale-incarnation' }]);
    expect(m.resolved({ incarnation: 'inc-1', threadId: T, requestId: 1 })).toEqual([{ kind: 'ignored', event: 'resolved', reason: 'unknown' }]);
    expect(m.effects.slice(before).every((f) => f.kind === 'ignored')).toBe(true);
    expect(m.activeTurn(T)).toBe('turn-1');
  });

  // Mutation controls: plausible wrong host models, each killed by a named property.
  class CoercingKey extends HostLifecycleModel { protected override key(i: string, t: string, id: RequestId) { return JSON.stringify([i, t, String(id)]); } }
  class IncarnationBlind extends HostLifecycleModel {
    protected override key(_i: string, t: string, id: RequestId) { return JSON.stringify([t, typeof id, id]); }
    override resolved(e: { incarnation: string; threadId: string; requestId: RequestId }) { return super.resolved({ ...e, incarnation: this.incarnation }); }
  }
  class ReleaseOnResolve extends HostLifecycleModel {
    protected override retire(k: string, rec: PendingRecord) {
      const fx = super.retire(k, rec);
      return [...fx, ...this.turnCompleted({ incarnation: rec.incarnation, threadId: rec.threadId, turnId: rec.turnId })];
    }
  }
  class CompleteOnResolve extends HostLifecycleModel {
    protected override retire(k: string, rec: PendingRecord) {
      return [...super.retire(k, rec), ...this.emit({ kind: 'item-failed', threadId: rec.threadId, turnId: rec.turnId, itemId: rec.itemId })];
    }
  }
  class ReplyOnResolve extends HostLifecycleModel {
    override resolved(e: { incarnation: string; threadId: string; requestId: RequestId }) {
      const fx = super.resolved(e);
      return [...fx, ...this.emit({ kind: 'reply', incarnation: e.incarnation, id: e.requestId, bytes: parity(e.requestId, e.threadId) })];
    }
  }
  class TruthyId extends HostLifecycleModel {
    override serverRequest(e: Parameters<HostLifecycleModel['serverRequest']>[0]) { return e.id ? super.serverRequest(e) : []; }
  }
  const mutants: Array<[string, Factory, string]> = [
    ['coerces number 0 and string "0"', (i) => new CoercingKey(i), 'typed-id'],
    ['ignores the process incarnation', (i) => new IncarnationBlind(i), 'cross-generation'],
    ['releases the lane on resolution', (i) => new ReleaseOnResolve(i), 'no-lane-release-on-resolution'],
    ['completes the item on resolution', (i) => new CompleteOnResolve(i), 'resolution-only-retires'],
    ['replies again on (duplicate) resolution', (i) => new ReplyOnResolve(i), 'duplicate-resolution-ignored'],
    ['truthy-checks the request id', (i) => new TruthyId(i), 'fresh-id-0-replied'],
  ];
  it.each(mutants)('SB07-F1-LM-MUT: a model that %s is rejected', (_n, make, property) => {
    expect(violatedProperties(make)).toContain(property);
  });
});
