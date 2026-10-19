import { performance } from 'node:perf_hooks';
import { diagnosticId, type ExecutionRisk, type FailureStage } from './agent-failure.js';
import type { ManagedExecution } from './execution-scope.js';
export interface InterruptedTurn {
  turnId: string;
  reason: 'failed' | 'cancelled' | 'timed_out';
  executionRisk: ExecutionRisk;
  stage: FailureStage;
}
/** A timeout revokes publication immediately; releasing a queue never revives it. */
export class TurnContext {
  readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  readonly deadline: number;
  executionRisk: ExecutionRisk = 'proven_not_started';
  needsReconciliation = false;
  /** Set only after a model response that received interruption context commits. */
  interruptionPresented = false;
  interruption?: InterruptedTurn['reason'];
  stage: FailureStage = 'prepare';
  private readonly managedExecutions: ManagedExecution[] = [];
  private publishable = true;
  constructor(timeoutMs: number, readonly generation = 1, readonly turnId = diagnosticId()) {
    this.deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
  }
  revoke(): void { this.publishable = false; }
  cancel(): void { this.publishable = false; this.controller.abort(); }
  registerExecution(execution: ManagedExecution): void { this.managedExecutions.push(execution); }
  async waitForStopped(timeoutMs: number): Promise<boolean> {
    if (this.executionRisk === 'proven_not_started') { this.disposeExecutions(); return true; }
    if (!this.managedExecutions.length) return false;
    const results = await Promise.all(this.managedExecutions.map(execution => Promise.resolve().then(() => execution.waitForStopped(timeoutMs)).catch(() => false)));
    if (!results.every(Boolean)) return false;
    this.disposeExecutions();
    return true;
  }
  disposeExecutions(): void {
    for (const execution of this.managedExecutions) {
      try { execution.dispose(); } catch { /* Cleanup cannot alter the turn outcome. */ }
    }
  }
  assertPublishable(): void {
    if (performance.now() >= this.deadline) this.cancel();
    if (!this.publishable || this.signal.aborted) {
      throw new DOMException('Turn no longer owns publication', 'AbortError');
    }
  }
  /** All callback/store entrypoints must recheck ownership, including late completions. */
  guard<T extends object>(target: T): T {
    return new Proxy(target, { get: (obj, key) => {
      const value = Reflect.get(obj, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { this.assertPublishable(); return value.apply(obj, args); };
    } });
  }
}
export interface TurnLedger {
  isTurnQuarantined(session: string): boolean;
  getQuarantinedTurnId(session: string): string | undefined;
  getTurnState(session: string): 'active' | 'quarantined' | 'clean' | undefined;
  reconcileTurn(session: string, turnId: string): boolean;
  beginTurn(session: string, turnId: string): number;
  finishTurn(session: string, turnId: string, state: 'clean' | 'quarantined'): void;
  recordInterruption(session: string, turn: InterruptedTurn): void;
  getInterruption(session: string): InterruptedTurn | undefined;
  consumeInterruption(session: string, turnId: string): void;
}
