import { randomBytes } from 'node:crypto';

export interface ContextIdentity {
  origin: string;
  botUid: string;
  spaceId: string;
  recipientId: string;
  scopeIncarnation: string;
  contextEpoch: string;
}

/** Native token binds the complete Header; versions/hashes are never relabelled. */
export interface OriginalIdentity {
  headerReference: string;
  messageVersion: string;
  payloadSha256: string;
}

export type RevalidateOriginal = (original: Readonly<OriginalIdentity>) => Promise<'allow' | 'deny' | 'unknown'>;

export interface ContextInvocation {
  readonly turnId: string;
  readonly generation: string;
  readonly nativeSessionId: string | undefined;
  assertCurrent(): void;
  includeVerifiedOriginal(original: OriginalIdentity): void;
  /** Every managed derivative inherits this complete union, not the last caller. */
  contributors(): readonly Readonly<OriginalIdentity>[];
  recheck(validate: RevalidateOriginal): Promise<void>;
  bindNativeSession(id: string): void;
  close(): void;
}

/**
 * Host-local lineage/exclusive invocation component. It issues no permission or
 * capsule. The caller supplies fresh coordinator/native revalidation, performs
 * admission before including originals, and wires fencing into its real worker,
 * publication and isolated state. Restart deliberately restores no native ID.
 */
export class ContextProvenance {
  private identity = '';
  private generation = '';
  private nativeSessionId: string | undefined;
  private originals = new Map<string, Readonly<OriginalIdentity>>();
  private owner: object | undefined;
  private revision = 0;

  async begin(identity: ContextIdentity, validate: RevalidateOriginal): Promise<ContextInvocation> {
    if (this.owner) throw new Error('Context already owned');
    const fields = [identity.origin, identity.botUid, identity.spaceId, identity.recipientId,
      identity.scopeIncarnation, identity.contextEpoch];
    if (fields.some(field => typeof field !== 'string' || !field)
      || !/^[0-9a-f]{32}$/.test(identity.scopeIncarnation)
      || !/^(0|[1-9][0-9]{0,19})$/.test(identity.contextEpoch)
      || BigInt(identity.contextEpoch) > 18_446_744_073_709_551_615n) {
      throw new Error('Context identity unavailable');
    }
    const owner = {};
    this.owner = owner; // Claim before asynchronous validation; no caller swap.
    const key = JSON.stringify(fields);
    if (key !== this.identity || !this.generation) this.reset(key);
    try {
      let reusable = true;
      for (const original of this.originals.values()) {
        if (await validate(original) !== 'allow') { reusable = false; break; }
      }
      if (!reusable) this.reset(key);
    } catch {
      // Unknown native authority cannot validate opaque old state. A separately
      // admitted new invocation may still use an empty isolated generation.
      this.reset(key);
    }
    const generation = this.generation;
    const assertCurrent = () => {
      if (this.owner !== owner || this.generation !== generation) throw new Error('Context invocation fenced');
    };
    return Object.freeze({
      turnId: randomBytes(16).toString('hex'), generation, nativeSessionId: this.nativeSessionId,
      assertCurrent,
      includeVerifiedOriginal: (original: OriginalIdentity) => {
        assertCurrent();
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(original.headerReference)
          || !/^[A-Za-z0-9_-]{1,512}$/.test(original.messageVersion)
          || !/^[0-9a-f]{64}$/.test(original.payloadSha256)) throw new Error('Original identity unavailable');
        const copy = Object.freeze({ headerReference: original.headerReference,
          messageVersion: original.messageVersion, payloadSha256: original.payloadSha256 });
        const id = JSON.stringify(copy);
        if (this.originals.has(id)) return;
        const union = [...this.originals.values(), copy];
        if (union.length > 256 || Buffer.byteLength(JSON.stringify(union), 'utf8') > 1024 * 1024) {
          throw new Error('Complete contributor union exceeds bound');
        }
        this.originals.set(id, copy); this.revision++;
      },
      contributors: () => { assertCurrent(); return Object.freeze([...this.originals.values()]); },
      recheck: async (revalidate: RevalidateOriginal) => {
        assertCurrent();
        const revision = this.revision;
        const originals = [...this.originals.values()];
        let valid = true;
        try {
          for (const original of originals) {
            if (await revalidate(original) !== 'allow') { valid = false; break; }
          }
        } catch { valid = false; }
        assertCurrent();
        if (!valid || this.revision !== revision) {
          this.reset(key);
          throw new Error('Context contributor proof unavailable');
        }
      },
      bindNativeSession: (id: string) => {
        assertCurrent();
        if (!id || this.nativeSessionId && this.nativeSessionId !== id) throw new Error('Native context ownership conflict');
        this.nativeSessionId = id;
      },
      close: () => { if (this.owner === owner) this.owner = undefined; },
    });
  }

  private reset(identity: string): void {
    this.identity = identity;
    this.generation = randomBytes(16).toString('hex');
    this.nativeSessionId = undefined;
    this.originals.clear();
    this.revision++;
  }
}
