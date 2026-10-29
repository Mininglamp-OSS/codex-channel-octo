import { describe, expect, it } from 'vitest';
import { canonicalEnvelope, eventKey, validateTopology } from '../cards/topology.js';

export const scope = { environment: 'test', tenant: 'tenant-a', bot: 'bot-a', stream: 'partition-a' };
export const proof = { ...scope, topology: 'T-PART' as const, expiresAt: 10000, nonDestructiveRead: true,
  orderedReplay: true, idempotentPerEventAck: true, partitionIsolated: true, otherOwners: ['documents'] };

describe('fake topology proof', () => {
  it('accepts independently verified isolated partitions and stable renewal identity', () => {
    const a = validateTopology(scope, proof, () => true, 0);
    const b = validateTopology(scope, { ...proof, expiresAt: 20000 }, () => true, 1);
    expect(a?.scope).toBe(b?.scope);
    expect(a).toBeDefined();
  });
  it.each([
    { topology: 'T-WS' }, { expiresAt: 0 }, { tenant: 'tenant-b' }, { bot: 'bot-b' },
    { environment: 'production' }, { stream: 'shared' }, { partitionIsolated: false },
    { nonDestructiveRead: false }, { orderedReplay: false }, { idempotentPerEventAck: false }, { otherOwners: [] },
  ])('denies insufficient evidence %j', (delta) => {
    expect(validateTopology(scope, { ...proof, ...delta }, () => true, 0)).toBeUndefined();
  });
  it('requires an independent verifier and complete exclusivity evidence', () => {
    expect(validateTopology(scope, proof, () => false, 0)).toBeUndefined();
    expect(validateTopology(scope, { ...proof, topology: 'T-EXCL' }, () => true, 0)).toBeUndefined();
    expect(validateTopology(scope, { ...proof, topology: 'T-EXCL', exclusiveAcrossHosts: true,
      excludesNonOwnedClasses: true }, () => true, 0)).toBeDefined();
  });
  it('canonicalizes keys while preserving types, absence, null and array order', () => {
    expect(canonicalEnvelope({ b: 2, a: 1 })).toBe(canonicalEnvelope({ a: 1, b: 2 }));
    for (const pair of [[{}, { a: null }], [1, '1'], [[1, 2], [2, 1]]]) {
      expect(canonicalEnvelope(pair[0])).not.toBe(canonicalEnvelope(pair[1]));
    }
    expect(eventKey('a', '1')).not.toBe(eventKey('b', '1'));
  });
  it.each([undefined, NaN, Infinity, -0, 1n, new Date(), { a: undefined }, Array(2)])('rejects ambiguous encodings', (v) => {
    expect(() => canonicalEnvelope(v)).toThrow();
  });
});
