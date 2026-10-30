/** Fake-source proof boundary. No production transport or credential capability. */
import { createHash } from 'node:crypto';
import type { CursorTopology } from './store.js';
import { EVENT_SCOPE_PREFIX } from './migrations.js';

export interface EventScope {
  readonly environment: string;
  readonly tenant: string;
  readonly bot: string;
  /** Stable server stream/partition identity, independent of attestation renewal. */
  readonly stream: string;
}

export interface TopologyProof extends EventScope {
  readonly topology: string;
  readonly expiresAt: number;
  readonly nonDestructiveRead: boolean;
  readonly orderedReplay: boolean;
  readonly idempotentPerEventAck: boolean;
  readonly partitionIsolated?: boolean;
  readonly otherOwners?: readonly string[];
  readonly exclusiveAcrossHosts?: boolean;
  readonly excludesNonOwnedClasses?: boolean;
}

export interface ProvenTopology {
  readonly scope: string;
  readonly binding: EventScope;
  readonly topology: CursorTopology;
  readonly expiresAt: number;
}

export function boundedId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= 1024
    && !/[\u0000-\u001f\u007f]/u.test(v) && !/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
}

export function sameScope(a: EventScope, b: EventScope): boolean {
  return ['environment', 'tenant', 'bot', 'stream'].every((k) => {
    const key = k as keyof EventScope;
    return boundedId(a[key]) && a[key] === b[key];
  });
}

/** Strict JSON: reject lossy JS encodings, accessors, prototypes, cycles and sparse arrays. */
export function canonicalEnvelope(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): string {
    if (++nodes > 10000 || depth > 32) throw new Error('invalid_envelope');
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) throw new Error('invalid_envelope');
      return JSON.stringify(v);
    }
    if (typeof v === 'string') {
      if (/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''))) throw new Error('invalid_envelope');
      return JSON.stringify(v);
    }
    if (typeof v !== 'object' || active.has(v)) throw new Error('invalid_envelope');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('invalid_envelope');
    if (Object.getOwnPropertySymbols(v).length) throw new Error('invalid_envelope');
    active.add(v);
    const keys = Object.keys(v);
    let out: string;
    if (array) {
      if (keys.length !== v.length || keys.some((k, i) => k !== String(i))) throw new Error('invalid_envelope');
      out = '[' + keys.map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !('value' in d)) throw new Error('invalid_envelope');
        return visit(d.value, depth + 1);
      }).join(',') + ']';
    } else {
      if (Object.getOwnPropertyNames(v).length !== keys.length) throw new Error('invalid_envelope');
      out = '{' + keys.sort().map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !('value' in d)) throw new Error('invalid_envelope');
        return JSON.stringify(k) + ':' + visit(d.value, depth + 1);
      }).join(',') + '}';
    }
    active.delete(v);
    if (Buffer.byteLength(out, 'utf8') > 65536) throw new Error('invalid_envelope');
    return out;
  }
  return visit(value, 0);
}

export function eventKey(scope: string, wireId: string): string {
  if (!boundedId(scope) || !boundedId(wireId)) throw new Error('invalid_event_key');
  return createHash('sha256').update(canonicalEnvelope([scope, wireId])).digest('hex');
}

export function validateTopology(binding: EventScope, proof: TopologyProof,
  verify: (proof: TopologyProof) => boolean, now: number): ProvenTopology | undefined {
  try {
    if (!sameScope(binding, proof) || !Number.isSafeInteger(now) || now < 0
      || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now || verify(proof) !== true
      || proof.nonDestructiveRead !== true || proof.orderedReplay !== true || proof.idempotentPerEventAck !== true) return undefined;
    if (proof.topology === 'T-PART') {
      if (proof.partitionIsolated !== true || !Array.isArray(proof.otherOwners) || proof.otherOwners.length === 0
        || !proof.otherOwners.every(boundedId)) return undefined;
    } else if (proof.topology === 'T-EXCL') {
      if (proof.exclusiveAcrossHosts !== true || proof.excludesNonOwnedClasses !== true) return undefined;
    } else return undefined;
    const frozen = Object.freeze({ environment: binding.environment, tenant: binding.tenant, bot: binding.bot, stream: binding.stream });
    return Object.freeze({ binding: frozen, topology: proof.topology,
      scope: EVENT_SCOPE_PREFIX + eventKey(canonicalEnvelope([binding.environment, binding.tenant]), canonicalEnvelope([binding.bot, binding.stream])),
      expiresAt: proof.expiresAt });
  } catch { return undefined; }
}
