import {
  FAULT_POINT_NAMES,
  faultPointKey,
  type FaultDecision,
  type FaultPlan,
  type FaultPoint,
} from '../../src/seams/fault-plan.js';

const KEY_RE = /^([a-zA-Z]+\.[a-zA-Z]+)(?:\(([^)]*)\))?$/;

/** Test-only FaultPlan: arm named points for a number of hits and log every hit. */
export class ScriptedFaultPlan implements FaultPlan {
  private readonly armed = new Map<string, { decision: FaultDecision; remaining: number }>();
  readonly hits: Array<{ key: string; decision: FaultDecision }> = [];

  arm(point: FaultPoint | string, decision: FaultDecision, opts: { times?: number } = {}): this {
    const key = typeof point === 'string' ? point : faultPointKey(point);
    const m = KEY_RE.exec(key);
    if (!m || !(FAULT_POINT_NAMES as readonly string[]).includes(m[1])) {
      throw new Error(`unknown fault point: ${key}`);
    }
    this.armed.set(key, { decision, remaining: opts.times ?? 1 });
    return this;
  }

  /** R8 §10.4 `api.forceStatus(endpoint, code, count)`. */
  forceStatus(endpoint: string, status: number, count: number): this {
    return this.arm({ name: 'api.forceStatus', endpoint }, { kind: 'status', status }, { times: count });
  }

  decide(point: FaultPoint): FaultDecision {
    const key = faultPointKey(point);
    const entry = this.armed.get(key);
    if (!entry || entry.remaining <= 0) return { kind: 'proceed' };
    entry.remaining--;
    this.hits.push({ key, decision: entry.decision });
    return entry.decision;
  }

  unconsumed(): string[] {
    return [...this.armed.entries()].filter(([, v]) => v.remaining > 0).map(([k]) => k);
  }
}
