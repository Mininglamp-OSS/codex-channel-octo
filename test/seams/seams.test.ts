/**
 * DEV-01 deterministic seams (R8 §10.4): the Clock and FaultPlan interfaces live
 * in src/seams (interface-only, never reachable from configuration) and the
 * test-only implementations live under test/harness.
 */
import { describe, it, expect } from 'vitest';
import { systemClock, type Clock } from '../../src/seams/clock.js';
import {
  FAULT_POINT_NAMES,
  NO_FAULTS,
  faultPointKey,
  type FaultPoint,
} from '../../src/seams/fault-plan.js';
import { FakeClock } from '../harness/fake-clock.js';
import { ScriptedFaultPlan } from '../harness/scripted-fault-plan.js';

describe('Clock seam', () => {
  it('SEAM-CLOCK-01: systemClock tracks wall time and a monotonic source', async () => {
    const before = Date.now();
    const wall = systemClock.now();
    const m1 = systemClock.monotonicNow();
    await new Promise((r) => systemClock.setTimeout(() => r(undefined), 5));
    const m2 = systemClock.monotonicNow();
    expect(wall).toBeGreaterThanOrEqual(before);
    expect(m2).toBeGreaterThan(m1);
  });

  it('SEAM-CLOCK-02: systemClock.clearTimeout cancels a pending timer', async () => {
    let fired = false;
    const h = systemClock.setTimeout(() => { fired = true; }, 1);
    systemClock.clearTimeout(h);
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(false);
  });

  it('SEAM-CLOCK-03: FakeClock fires timers in deadline order and only when advanced', () => {
    const clock: Clock & FakeClock = new FakeClock({ now: 1_000_000, monotonic: 0 });
    const order: string[] = [];
    clock.setTimeout(() => order.push('b@20'), 20);
    clock.setTimeout(() => order.push('a@10'), 10);
    clock.setTimeout(() => order.push('c@20'), 20);
    expect(order).toEqual([]);
    clock.advance(10);
    expect(order).toEqual(['a@10']);
    expect(clock.now()).toBe(1_000_010);
    expect(clock.monotonicNow()).toBe(10);
    clock.advance(10);
    // equal deadlines keep scheduling order
    expect(order).toEqual(['a@10', 'b@20', 'c@20']);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('SEAM-CLOCK-04: FakeClock runs timers scheduled from inside a callback within the same advance window', () => {
    const clock = new FakeClock({ now: 0 });
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.monotonicNow());
      clock.setTimeout(() => fired.push(clock.monotonicNow()), 5);
    }, 5);
    clock.advance(10);
    expect(fired).toEqual([5, 10]);
  });

  it('SEAM-CLOCK-05: a wall-clock jump moves now() but never fires or skips monotonic timers', () => {
    const clock = new FakeClock({ now: 10_000, monotonic: 0 });
    let fired = 0;
    clock.setTimeout(() => { fired++; }, 1_000);
    clock.jumpWall(-2 * 60 * 60 * 1000); // backward 2 h (R8 §3.4.5 row 17)
    expect(clock.now()).toBe(10_000 - 7_200_000);
    expect(fired).toBe(0);
    clock.jumpWall(4 * 60 * 60 * 1000); // forward
    expect(fired).toBe(0);
    clock.advance(999);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  it('SEAM-CLOCK-06: FakeClock.clearTimeout removes a pending timer and rejects negative advance', () => {
    const clock = new FakeClock();
    let fired = false;
    const h = clock.setTimeout(() => { fired = true; }, 1);
    clock.clearTimeout(h);
    clock.clearTimeout(null);
    clock.advance(5);
    expect(fired).toBe(false);
    expect(() => clock.advance(-1)).toThrow(/negative/);
  });
});

describe('FaultPlan seam', () => {
  it('SEAM-FAULT-01: the named fault points are exactly the R8 §10.4 list', () => {
    expect([...FAULT_POINT_NAMES].sort()).toEqual([
      'api.forceStatus',
      'cron.afterAdmit',
      'cron.beforeFinalize',
      'egress.afterFence',
      'egress.afterSegment',
      'egress.beforeFirstSend',
      'runtime.dropInterruptResponse',
      'runtime.dropTurnCompleted',
      'runtime.failUnsubscribe',
      'runtime.killChild',
      'transport.disconnect',
      'transport.dropConnack',
    ]);
  });

  it('SEAM-FAULT-02: parameterized points render stable keys', () => {
    expect(faultPointKey({ name: 'egress.afterSegment', segment: 2 })).toBe('egress.afterSegment(2)');
    expect(faultPointKey({ name: 'api.forceStatus', endpoint: 'register' })).toBe('api.forceStatus(register)');
    expect(faultPointKey({ name: 'transport.dropConnack' })).toBe('transport.dropConnack');
  });

  it('SEAM-FAULT-03: NO_FAULTS always proceeds', () => {
    for (const name of FAULT_POINT_NAMES) {
      const point = (name === 'egress.afterSegment'
        ? { name, segment: 0 }
        : name === 'api.forceStatus' ? { name, endpoint: 'x' } : { name }) as FaultPoint;
      expect(NO_FAULTS.decide(point)).toEqual({ kind: 'proceed' });
    }
  });

  it('SEAM-FAULT-04: ScriptedFaultPlan fires an armed point exactly the armed number of times and logs hits', () => {
    const plan = new ScriptedFaultPlan()
      .arm({ name: 'runtime.dropTurnCompleted' }, { kind: 'drop' }, { times: 2 })
      .forceStatus('register', 503, 1);
    expect(plan.decide({ name: 'runtime.dropTurnCompleted' })).toEqual({ kind: 'drop' });
    expect(plan.decide({ name: 'runtime.dropTurnCompleted' })).toEqual({ kind: 'drop' });
    expect(plan.decide({ name: 'runtime.dropTurnCompleted' })).toEqual({ kind: 'proceed' });
    expect(plan.decide({ name: 'api.forceStatus', endpoint: 'heartbeat' })).toEqual({ kind: 'proceed' });
    expect(plan.decide({ name: 'api.forceStatus', endpoint: 'register' })).toEqual({ kind: 'status', status: 503 });
    expect(plan.decide({ name: 'api.forceStatus', endpoint: 'register' })).toEqual({ kind: 'proceed' });
    expect(plan.hits.map((h) => h.key)).toEqual([
      'runtime.dropTurnCompleted',
      'runtime.dropTurnCompleted',
      'api.forceStatus(register)',
    ]);
    expect(plan.unconsumed()).toEqual([]);
  });

  it('SEAM-FAULT-05: segment-scoped points only match their own segment index', () => {
    const plan = new ScriptedFaultPlan().arm({ name: 'egress.afterSegment', segment: 1 }, { kind: 'crash' });
    expect(plan.decide({ name: 'egress.afterSegment', segment: 0 })).toEqual({ kind: 'proceed' });
    expect(plan.decide({ name: 'egress.afterSegment', segment: 1 })).toEqual({ kind: 'crash' });
  });

  it('SEAM-FAULT-06: arming an unknown point name is rejected (typo guard)', () => {
    const plan = new ScriptedFaultPlan();
    expect(() => plan.arm({ name: 'runtime.dropTurnComplete' } as unknown as FaultPoint, { kind: 'drop' })).toThrow(/unknown fault point/);
    expect(() => plan.arm('egress.afterSegmnt(1)', { kind: 'drop' })).toThrow(/unknown fault point/);
  });

  it('SEAM-FAULT-07: unconsumed() reports armed faults that never fired', () => {
    const plan = new ScriptedFaultPlan().arm({ name: 'cron.beforeFinalize' }, { kind: 'crash' });
    expect(plan.unconsumed()).toEqual(['cron.beforeFinalize']);
  });
});
