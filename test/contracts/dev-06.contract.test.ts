/**
 * Named pending contracts for DEV-06 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-06 pending contracts', () => {
  it.todo('O1 (DEV-06): Plain text send');
  it.todo('O4 (DEV-06): Multi-message join separator');
  it.todo('O11 (DEV-06): Quote original on reply');
  it.todo('O12 (DEV-06): Proactive targeting / thread replies');
  it.todo('O14 (DEV-06): Typing from dispatch');
  it.todo('O15 (DEV-06): Read receipt timing');
  it.todo('O16 (DEV-06): Error reply suppressed after final delivered');
  it.todo('O17 (DEV-06): Tool-failure banner');
  it.todo('O18 (DEV-06): Empty / `NO_REPLY` policy');
  it.todo('O19 (DEV-06): Tool progress UX');
  it.todo('O23 (DEV-06): IM egress guard');
  it.todo('R7 (DEV-06): Empty `channel_id` guard');
  it.todo('EP-03 (DEV-06): sendMessage type 1 (mentions/reply/`client_msg_no`/OBO)');
  it.todo('EP-09 (DEV-06): typing');
  it.todo('EP-10 (DEV-06): readReceipt');
  it.todo('C6 (DEV-06): `/reset`');
  it.todo('C7 (DEV-06): `/new` alias');
  it.todo('C8 (DEV-06): Command authorisation');
  it.todo('C10 (DEV-06): `/config`, `/help`');
  it.todo('EP-03.send (DEV-06): sendMessage type 1 (mentions/reply/`client_msg_no`/OBO) — send');
  it.todo('EP-09.typing (DEV-06): typing — typing');
  it.todo('EP-10.readReceipt (DEV-06): readReceipt — readReceipt');
});
