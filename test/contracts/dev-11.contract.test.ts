/**
 * Named pending contracts for DEV-11 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-11 pending contracts', () => {
  it.todo('CR-7.1 (DEV-11): RPC methods');
  it.todo('CR-7.2 (DEV-11): CLI');
  it.todo('CR-7.5 (DEV-11): Manual run `force`/`due`/`if-enabled`');
  it.todo('CR-7.6 (DEV-11): History fields + paging');
  it.todo('CR-7.7 (DEV-11): Retention 7 d / 2000 / 24 h lost; session reaper');
});
