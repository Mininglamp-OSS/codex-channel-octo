/**
 * Named pending contracts for DEV-04 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-04 pending contracts', () => {
  it.todo('S5 (DEV-04): SQLite + `sdk_sessions`');
  it.todo('S16 (DEV-04): Dispatch timeout semantics');
  it.todo('S17 (DEV-04): Session-init conflict retry');
  it.todo('C2 (DEV-04): Multi-account lifecycle');
});
