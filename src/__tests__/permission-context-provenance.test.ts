import { describe, expect, it, vi } from 'vitest';
import { ContextProvenance, type ContextIdentity, type OriginalIdentity } from '../permissions/context-provenance.js';

const identity: ContextIdentity = { origin: 'https://synthetic.invalid', botUid: 'bot', spaceId: 'space',
  recipientId: 'relay:bot', scopeIncarnation: 'a'.repeat(32), contextEpoch: '1' };
const original = (ref: string): OriginalIdentity => ({ headerReference: ref, messageVersion: 'v1', payloadSha256: 'b'.repeat(64) });
const allow = async () => 'allow' as const;

describe('complete context-generation contributor union', () => {
  it('reuses a verified same-generation session with a new exclusive invocation identity', async () => {
    const ledger = new ContextProvenance();
    const first = await ledger.begin(identity, allow);
    first.includeVerifiedOriginal(original('Alice'));
    first.includeVerifiedOriginal(original('Bob'));
    first.bindNativeSession('synthetic-session'); first.close();
    const validate = vi.fn(allow);
    const next = await ledger.begin(identity, validate);
    expect(next.generation).toBe(first.generation);
    expect(next.turnId).not.toBe(first.turnId);
    expect(next.nativeSessionId).toBe('synthetic-session');
    expect(validate).toHaveBeenCalledTimes(2);
    expect(next.contributors().map(x => x.headerReference)).toEqual(['Alice', 'Bob']);
    await expect(ledger.begin(identity, allow)).rejects.toThrow('already owned');
    expect(() => first.assertCurrent()).toThrow('fenced');
  });

  it.each(['deny', 'unknown'] as const)('isolates old context on same-epoch former-contributor %s', async verdict => {
    const ledger = new ContextProvenance();
    const first = await ledger.begin(identity, allow);
    first.includeVerifiedOriginal(original('old-author')); first.bindNativeSession('opaque-old'); first.close();
    const next = await ledger.begin(identity, async () => verdict);
    expect(next.generation).not.toBe(first.generation);
    expect(next.nativeSessionId).toBeUndefined();
    expect(next.contributors()).toEqual([]);
    next.includeVerifiedOriginal(original('allowed-current'));
    expect(next.contributors()).toEqual([original('allowed-current')]);
  });

  it('fences subsequent work if contributor proof changes during an active turn', async () => {
    const ledger = new ContextProvenance();
    const turn = await ledger.begin(identity, allow);
    turn.includeVerifiedOriginal(original('Alice')); turn.includeVerifiedOriginal(original('Bob'));
    await expect(turn.recheck(async item => item.headerReference === 'Alice' ? 'deny' : 'allow')).rejects.toThrow('proof');
    expect(() => turn.assertCurrent()).toThrow('fenced');
    turn.close();
    expect((await ledger.begin(identity, allow)).contributors()).toEqual([]);
  });

  it('rejects a lineage revision race rather than accepting a partial proof', async () => {
    const ledger = new ContextProvenance();
    const turn = await ledger.begin(identity, allow);
    turn.includeVerifiedOriginal(original('first'));
    let release!: () => void;
    const pending = turn.recheck(async () => { await new Promise<void>(resolve => { release = resolve; }); return 'allow'; });
    turn.includeVerifiedOriginal(original('added-while-awaiting'));
    release();
    await expect(pending).rejects.toThrow('proof');
    expect(() => turn.contributors()).toThrow('fenced');
  });

  it.each(['contextEpoch', 'scopeIncarnation', 'recipientId', 'botUid', 'spaceId', 'origin'] as const)(
    'resets on changed %s, including a missed activation epoch', async field => {
      const ledger = new ContextProvenance();
      const turn = await ledger.begin(identity, allow);
      turn.includeVerifiedOriginal(original('old')); turn.bindNativeSession('old'); turn.close();
      const changed = { ...identity, [field]: field === 'contextEpoch' ? '3' : field === 'scopeIncarnation' ? 'c'.repeat(32) : 'other' };
      const next = await ledger.begin(changed, allow);
      expect(next.generation).not.toBe(turn.generation);
      expect(next.nativeSessionId).toBeUndefined();
      expect(next.contributors()).toEqual([]);
    });

  it('does not truncate provenance at 256 originals or restore opaque sessions on restart', async () => {
    const ledger = new ContextProvenance();
    const turn = await ledger.begin(identity, allow);
    for (let i = 0; i < 256; i++) turn.includeVerifiedOriginal(original(`original_${i}`));
    expect(() => turn.includeVerifiedOriginal(original('over_bound'))).toThrow('bound');
    expect(turn.contributors()).toHaveLength(256);
    const restarted = await new ContextProvenance().begin(identity, allow);
    expect(restarted.contributors()).toEqual([]);
    expect(restarted.nativeSessionId).toBeUndefined();
  });
});
