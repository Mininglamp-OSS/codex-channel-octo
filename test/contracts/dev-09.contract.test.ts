/**
 * Named pending contracts for DEV-09 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-09 pending contracts', () => {
  it.todo('C11 (DEV-09): Cron');
  it.todo('CR-1.1 (DEV-09): Identity (`id`, `name`, `description`, `displayName`, `declarationKey`, `agentId`, `sessionKey`, `owner{…}`)');
  it.todo('CR-1.2 (DEV-09): Schedule kinds `at`/`every`/`cron`/`on-exit`/`stream`');
  it.todo('CR-1.3 (DEV-09): Payload kinds `systemEvent`/`agentTurn`/`command`/`script`');
  it.todo('CR-1.4 (DEV-09): Session target `main`/`isolated`/`current`/`session:<id>`');
  it.todo('CR-1.5 (DEV-09): Flags `enabled`, `deleteAfterRun` (default true for `at`), `wakeMode`');
  it.todo('CR-1.6 (DEV-09): Runtime state fields');
  it.todo('CR-1.7 (DEV-09): Optimistic concurrency `configRevision`');
  it.todo('CR-2.1 (DEV-09): croner, 5- or 6-field, DOM/DOW OR, LRU');
  it.todo('CR-2.2 (DEV-09): tz default host; `at` without offset = UTC');
  it.todo('CR-2.3 (DEV-09): DST: nonexistent times skipped; repeated times run once at the first occurrence');
  it.todo('CR-2.4 (DEV-09): `every` anchor math');
  it.todo('CR-2.5 (DEV-09): One-shot validation (−1 min / +10 years); due until consumed');
  it.todo('CR-2.6 (DEV-09): Top-of-hour stagger ≤5 min, `--exact`');
  it.todo('CR-3.1 (DEV-09): SQLite store, run receipts, history');
  it.todo('CR-3.2 (DEV-09): Atomic transactions + revision checks');
  it.todo('CR-3.3 (DEV-09): Corrupt-row quarantine');
  it.todo('CR-3.4 (DEV-09): Single flight (unique partial index, owner pid)');
  it.todo('CR-3.5 (DEV-09): Timer ≤60 s, ≥2 s gap, clock-jump handling');
  it.todo('CR-3.6 (DEV-09): One catch-up per job, 5 immediate + 5 s stagger, 120 s agent deferral, `skipMissedJobs`, activation fence');
  it.todo('CR-3.7 (DEV-09): Interrupted runs → error, no replay; one-shot disabled; queued timed resumes, queued manual skipped');
});
