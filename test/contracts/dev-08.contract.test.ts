/**
 * Named pending contracts for DEV-08 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-08 pending contracts', () => {
  it.todo('T22 (DEV-08): Shutdown order');
  it.todo('T26 (DEV-08): Status reporting');
  it.todo('S6 (DEV-08): Session TTL schedule');
  it.todo('R8 (DEV-08): Token prefix `bf_`/`app_` check');
  it.todo('C1 (DEV-08): Config source + validation');
  it.todo('C3 (DEV-08): Hot reload of existing bots');
  it.todo('C4 (DEV-08): Per-bot overrides');
  it.todo('C5 (DEV-08): Setup/onboarding (add bot/token)');
  it.todo('C12 (DEV-08): CLI entry');
  it.todo('C13 (DEV-08): Crash containment');
  it.todo('C14 (DEV-08): Logging/audit/status');
  it.todo('K-01 (DEV-08): `botToken` (A: complete)');
  it.todo('K-02 (DEV-08): `apiUrl` (A: stricter)');
  it.todo('K-03 (DEV-08): `wsUrl` (A: missing)');
  it.todo('K-05 (DEV-08): `heartbeatIntervalMs` (30000, ≥5000) (A: hard-coded)');
  it.todo('K-07 (DEV-08): `historyLimit` (20) (A: `context.historyLimit` 40)');
  it.todo('K-08 (DEV-08): `historyPromptTemplate` (A: missing)');
  it.todo('K-10 (DEV-08): `enabled`, `name` (A: missing)');
  it.todo('K-16 (DEV-08): `cardProgress`, `reasoningCardTemplateMode`, `cardDisplay`, `cardInteraction` (A: —)');
});
