/**
 * Named pending contracts for DEV-13 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-13 pending contracts', () => {
  it.todo('I35 (DEV-13): Card action intake');
  it.todo('O20 (DEV-13): Reasoning display');
  it.todo('O21 (DEV-13): Cards (wire, profile, display, interactive, action, status edit)');
  it.todo('EP-06 (DEV-13): type 17 cards');
  it.todo('EP-07 (DEV-13): message/edit');
  it.todo('EP-08 (DEV-13): card/profile');
  it.todo('EP-26 (DEV-13): events + ack (long-poll)');
  it.todo('K-11 (DEV-13): `pollIntervalMs`, `eventWaitSeconds` (A: missing)');
  it.todo('K-15 (DEV-13): `commands.fork.scope` (A: missing)');
  it.todo('EP-06.card (DEV-13): type 17 cards — card');
  it.todo('EP-07.edit (DEV-13): message/edit — edit');
  it.todo('EP-08.profile (DEV-13): card/profile — profile');
  it.todo('EP-26.events (DEV-13): events + ack (long-poll) — events');
  it.todo('EP-26.ack (DEV-13): events + ack (long-poll) — ack');
});
