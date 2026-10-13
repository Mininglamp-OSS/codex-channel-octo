/**
 * FaultPlan seam (R8 §10.4). Components consult a FaultPlan at the named points
 * below; production code uses NO_FAULTS. Scripted plans exist only in test
 * builds and are never reachable from configuration.
 */

export type FaultPoint =
  | { name: 'egress.beforeFirstSend' }
  | { name: 'egress.afterFence' }
  | { name: 'egress.afterSegment'; segment: number }
  | { name: 'cron.afterAdmit' }
  | { name: 'cron.beforeFinalize' }
  | { name: 'runtime.dropInterruptResponse' }
  | { name: 'runtime.dropTurnCompleted' }
  | { name: 'runtime.failUnsubscribe' }
  | { name: 'runtime.killChild' }
  | { name: 'transport.dropConnack' }
  | { name: 'transport.disconnect' }
  | { name: 'api.forceStatus'; endpoint: string };

export type FaultPointName = FaultPoint['name'];

export const FAULT_POINT_NAMES: readonly FaultPointName[] = Object.freeze([
  'egress.beforeFirstSend',
  'egress.afterFence',
  'egress.afterSegment',
  'cron.afterAdmit',
  'cron.beforeFinalize',
  'runtime.dropInterruptResponse',
  'runtime.dropTurnCompleted',
  'runtime.failUnsubscribe',
  'runtime.killChild',
  'transport.dropConnack',
  'transport.disconnect',
  'api.forceStatus',
]);

export type FaultDecision =
  | { kind: 'proceed' }
  | { kind: 'drop' }
  | { kind: 'fail'; message: string }
  | { kind: 'kill' }
  | { kind: 'crash' }
  | { kind: 'status'; status: number };

export interface FaultPlan {
  decide(point: FaultPoint): FaultDecision;
}

const PROCEED: FaultDecision = Object.freeze({ kind: 'proceed' });

export const NO_FAULTS: FaultPlan = Object.freeze({ decide: () => PROCEED });

/** Stable key for a point, e.g. `egress.afterSegment(2)` or `api.forceStatus(register)`. */
export function faultPointKey(point: FaultPoint): string {
  switch (point.name) {
    case 'egress.afterSegment':
      return `${point.name}(${point.segment})`;
    case 'api.forceStatus':
      return `${point.name}(${point.endpoint})`;
    default:
      return point.name;
  }
}
