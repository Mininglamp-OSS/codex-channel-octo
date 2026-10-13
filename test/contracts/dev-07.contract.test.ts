/**
 * Named pending contracts for DEV-07 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-07 pending contracts', () => {
  it.todo('T24 (DEV-07): DM ownership filter');
  it.todo('T25 (DEV-07): Transport dedupe');
  it.todo('I5 (DEV-07): entities-first @bot detection');
  it.todo('I6 (DEV-07): `ais` broadcast suppression');
  it.todo('I7 (DEV-07): Strict flag coercion (`===true||===1`)');
  it.todo('I8 (DEV-07): `@BotName` text fallback (CJK-safe)');
  it.todo('I11 (DEV-07): Server mention pref + cache');
  it.todo('I14 (DEV-07): Leading @bot strip');
  it.todo('I16 (DEV-07): Bot-to-bot loop budget');
  it.todo('I19 (DEV-07): Content-type admission allowlist');
  it.todo('I20 (DEV-07): Empty/non-string text');
  it.todo('I24 (DEV-07): File inline / large-file cap');
  it.todo('I25 (DEV-07): Merged forward (hardened) + uid→name fill');
  it.todo('I27 (DEV-07): InteractiveCard inbound text');
  it.todo('I28 (DEV-07): Type-aware quote');
  it.todo('I32 (DEV-07): SSRF/redirect/auth scoping');
  it.todo('I34 (DEV-07): Sender display name');
  it.todo('S8 (DEV-07): Backfill on gaps');
  it.todo('S9 (DEV-07): Segmentation, `historyPromptTemplate`, persisted reply cursor');
  it.todo('S10 (DEV-07): Sender identity on turn');
  it.todo('S11 (DEV-07): Roster injection');
  it.todo('S12 (DEV-07): Roster refresh/learning');
  it.todo('O7 (DEV-07): `@[uid:name]` usable');
  it.todo('O8 (DEV-07): v1 `@name` → uid + forced refresh');
  it.todo('EP-11 (DEV-07): messages/sync');
  it.todo('EP-14 (DEV-07): mention_pref');
  it.todo('EP-11.sync (DEV-07): messages/sync — sync');
  it.todo('EP-14.get (DEV-07): mention_pref — get');
});
