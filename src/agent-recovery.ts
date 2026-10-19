import { inheritSdkDiagnostic } from './private-diagnostics.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { TurnFailure, classifyFailure, diagnosticId, type FailureReport, type FailureSnapshot, type ExecutionRisk } from './agent-failure.js';
export interface RecoveryConfig { enabled?: boolean; maxAttempts?: number; maxElapsedMs?: number; baseDelayMs?: number; maxDelayMs?: number; }
export const RECOVERY_DEFAULTS = { enabled: false, maxAttempts: 3, maxElapsedMs: 60_000, baseDelayMs: 1000, maxDelayMs: 10_000 };
export function validateRecovery(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sdk.recovery must be an object');
  const v = value as Record<string, unknown>;
  const limits: Record<string, number> = { maxAttempts: 5, maxElapsedMs: 300_000, baseDelayMs: 60_000, maxDelayMs: 60_000 };
  for (const key of Object.keys(v)) {
    if (key === 'enabled') { if (typeof v[key] !== 'boolean') throw new Error('sdk.recovery.enabled must be boolean'); }
    else if (!Object.hasOwn(limits, key) || typeof v[key] !== 'number' || !Number.isInteger(v[key]) || (v[key] as number) < 1 || (v[key] as number) > limits[key]) throw new Error('Invalid sdk.recovery option');
  }
  const opts = { ...RECOVERY_DEFAULTS, ...v };
  if (opts.baseDelayMs > opts.maxDelayMs) throw new Error('sdk.recovery.baseDelayMs exceeds maxDelayMs');
}
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value || value.length > 128) return;
  if (/^\d+$/.test(value)) { const ms = Number(value) * 1000; return Number.isSafeInteger(ms) ? ms : undefined; }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return;
  const date = Date.parse(value); return Number.isFinite(date) && date >= now ? date - now : undefined;
}
export function retryDelay(failure: FailureSnapshot, attempt: number, config: Required<RecoveryConfig>, random = Math.random): number {
  const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.floor(ceiling / 2 + random() * ceiling / 2);
  return Math.max(jitter, failure.retryAfterMs ?? 0);
}
/** Only positive pre-exec evidence is eligible in the current unrestricted tool runtime. */
export function canRetry(failure: FailureSnapshot, risk: ExecutionRisk): boolean {
  return risk === 'proven_not_started' && failure.evidence === 'structured' && ['network_transient', 'rate_limited', 'provider_unavailable'].includes(failure.category);
}
export async function* recover<T>(run: () => AsyncIterable<T>, options: {
  config?: RecoveryConfig; signal?: AbortSignal; deadline?: number; id?: string;
  risk: () => ExecutionRisk; now?: () => number; random?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): AsyncIterable<T> {
  const config = { ...RECOVERY_DEFAULTS, ...options.config }; validateRecovery(config);
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? (async (ms, signal) => { await sleep(ms, undefined, { signal }); });
  const id = options.id ?? diagnosticId(); let first: FailureSnapshot | undefined; let recoveryStart: number | undefined;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    if (now() >= (options.deadline ?? Infinity)) {
      const final: FailureSnapshot = {stage:'inference',category:'timeout',source:'local',evidence:'structured'};
      throw new TurnFailure({diagnosticId:id,attempts:attempt-1,decision:'exhausted',executionRisk:options.risk(),first:first??final,final});
    }
    try { yield* run(); return; }
    catch (error) {
      const final = classifyFailure(error); first ??= final; recoveryStart ??= now();
      const risk = final.stage === 'spawn' && final.evidence === 'structured' && options.risk() === 'proven_not_started' ? 'proven_not_started' : options.risk();
      let decision: FailureReport['decision'] = options.signal?.aborted ? 'cancelled' : risk !== 'proven_not_started' ? 'blocked_uncertain' : 'not_attempted';
      if (config.enabled && !options.signal?.aborted && canRetry(final, risk)) {
        const delay = retryDelay(final, attempt, config, options.random);
        const end = Math.min(options.deadline ?? Infinity, recoveryStart + config.maxElapsedMs);
        if (attempt < config.maxAttempts && now() + delay < end) {
          console.info('[codex-channel-octo] recovery scheduled', JSON.stringify({diagnosticId:id,attempt,category:final.category,delayMs:delay,executionRisk:risk}));
          try { await wait(delay, options.signal); options.signal?.throwIfAborted(); }
          catch { throw inheritSdkDiagnostic(new TurnFailure({ diagnosticId: id, attempts: attempt, first, final, executionRisk: risk, decision: 'cancelled' }),error); }
          if (now() < end) continue;
        }
        decision = 'exhausted';
      }
      throw inheritSdkDiagnostic(new TurnFailure({ diagnosticId: id, attempts: attempt, first, final, executionRisk: risk, decision }),error);
    }
  }
}
