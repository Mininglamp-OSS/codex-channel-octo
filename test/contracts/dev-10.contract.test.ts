/**
 * Named pending contracts for DEV-10 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-10 pending contracts', () => {
  it.todo('CR-4.1 (DEV-10): Global concurrency 8');
  it.todo('CR-4.2 (DEV-10): Same-job overlap excluded; manual → `already-running`');
  it.todo('CR-4.3 (DEV-10): Backoff `[30s,60s,5m,15m,60m]`');
  it.todo('CR-4.4 (DEV-10): Transient retry ×3');
  it.todo('CR-4.5 (DEV-10): One-shot failure handling');
  it.todo('CR-4.6 (DEV-10): Auto-disable 10 / 3 schedule errors');
  it.todo('CR-4.7 (DEV-10): Timeouts (agentTurn 60 min)');
  it.todo('CR-4.8 (DEV-10): Timeout handling: abort + clean up + release session');
  it.todo('CR-4.9 (DEV-10): Shutdown: stop admission, queued → skipped, running awaited/aborted');
  it.todo('CR-5.2 (DEV-10): `isolated` fresh session per run');
  it.todo('CR-5.4 (DEV-10): `session:<id>` persistent named session');
  it.todo('CR-5.5 (DEV-10): Prompt framing, unattended preamble, `NO_REPLY`');
  it.todo('CR-5.6 (DEV-10): Per-job model, no silent fallback');
  it.todo('CR-6.1 (DEV-10): Modes `announce`/`webhook`/`none`; failure/completion destinations');
  it.todo('CR-6.2 (DEV-10): Result belongs to the destination transcript');
  it.todo('CR-6.3 (DEV-10): Delivery fence, ambiguous = unknown, never replayed');
  it.todo('CR-6.4 (DEV-10): Execution status vs completion status');
  it.todo('CR-6.5 (DEV-10): Silent output suppression');
  it.todo('CR-6.7 (DEV-10): Failure alerts (2, 1 h cooldown, incident dedupe)');
  it.todo('CR-8.1 (DEV-10): Owner-only management; caller-scoped reads');
  it.todo('CR-8.2 (DEV-10): Tool authority capped to creator; dangerous tools owner-only');
  it.todo('CR-8.3 (DEV-10): Exec approvals / standing grants in unattended runs');
  it.todo('CR-8.4 (DEV-10): Secret handling / redaction');
  it.todo('CR-8.5 (DEV-10): Events and logs');
});
