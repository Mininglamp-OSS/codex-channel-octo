/**
 * Named pending contracts for DEV-02 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-02 pending contracts', () => {
  it.todo('T8 (DEV-02): CONNACK reasonCode≠0 close+null');
  it.todo('T13 (DEV-02): Connect deadline 15 s');
  it.todo('T14 (DEV-02): Backoff + jitter, timer null');
  it.todo('T16 (DEV-02): Token refresh guard/stagger/`stopped`');
  it.todo('T17 (DEV-02): Deferred reconnect on cooldown');
  it.todo('T18 (DEV-02): Retry after failed re-register');
  it.todo('T19 (DEV-02): Connection watchdog');
  it.todo('T20 (DEV-02): REST heartbeat log-only, 429 not counted');
  it.todo('T21 (DEV-02): wss-only URL policy');
  it.todo('R1 (DEV-02): Timeouts, 60 s hard ceiling, PUT/DELETE helpers');
  it.todo('R2 (DEV-02): `OctoApiError` + 429 loop');
  it.todo('R3 (DEV-02): Error body cap + Bearer scrub');
  it.todo('EP-01 (DEV-02): register (+`plugin_version`)');
  it.todo('EP-02 (DEV-02): heartbeat');
  it.todo('C15 (DEV-02): Version reporting');
  it.todo('EP-01.register (DEV-02): register (+`plugin_version`) — register');
  it.todo('EP-01.register.force_refresh (DEV-02): register (+`plugin_version`) — register.force_refresh');
  it.todo('EP-02.heartbeat (DEV-02): heartbeat — heartbeat');
});
