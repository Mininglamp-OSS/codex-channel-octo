/**
 * Named pending contracts for DEV-17 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-17 pending contracts', () => {
  it.todo('S15 (DEV-17): Persona clone / OBO');
  it.todo('EP-23 (DEV-17): voice/context GET/PUT/DELETE');
  it.todo('EP-24 (DEV-17): obo-grant');
  it.todo('EP-25 (DEV-17): secrets/resolve');
  it.todo('EP-23.GET (DEV-17): voice/context GET/PUT/DELETE — GET');
  it.todo('EP-23.PUT (DEV-17): voice/context GET/PUT/DELETE — PUT');
  it.todo('EP-23.DELETE (DEV-17): voice/context GET/PUT/DELETE — DELETE');
  it.todo('EP-24.get (DEV-17): obo-grant — get');
  it.todo('EP-25.resolve (DEV-17): secrets/resolve — resolve');
  it.todo('O24.mgmt.voice-context-read (DEV-17): octo_management action voice-context-read');
  it.todo('O24.mgmt.voice-context-update (DEV-17): octo_management action voice-context-update');
  it.todo('O24.mgmt.voice-context-delete (DEV-17): octo_management action voice-context-delete');
  it.todo('O24.mgmt.write-secret (DEV-17): octo_management action write-secret');
});
