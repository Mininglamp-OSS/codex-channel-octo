import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile, ReconciliationError, reconciliationMessage } from '../reconcile-turn.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
let root:string;let db:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'reconcile-'));db=join(root,'cc-octo.db');const s=new SessionStore(createAdapter(db));s.init();s.beginTurn('s','t');s.finishTurn('s','t','quarantined');s.close();});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
describe('offline execution reconciliation',()=>{
 it('requires explicit acknowledgment and the exact turn ID',()=>{
  expect(()=>reconcile(db,'s','t',false)).toThrow();expect(reconcile(db,'s','wrong',true)).toBe(false);expect(reconcile(db,'s','t',true)).toBe(true);expect(existsSync(join(root,'gateway.lock'))).toBe(false);
  const s=new SessionStore(createAdapter(db));s.init();expect(s.isTurnQuarantined('s')).toBe(false);s.close();
 });
 it('cannot release a quarantine while any gateway lock exists',()=>{
  const path=join(root,'gateway.lock');writeFileSync(path,'existing');expect(()=>reconcile(db,'s','t',true)).toThrow();expect(existsSync(path)).toBe(true);unlinkSync(path);expect(reconcile(db,'s','t',true)).toBe(true);
 });
 it('does not create a missing database',()=>{const missing=join(root,'missing.db');expect(()=>reconcile(missing,'s','t',true)).toThrow();expect(existsSync(missing)).toBe(false);});
});

 describe('safe maintenance diagnostics', () => {
  it('distinguishes operator actions without exposing raw exceptions', () => {
    expect(reconciliationMessage(new ReconciliationError('gateway_locked'))).toContain('gateway lock');
    expect(reconciliationMessage(new ReconciliationError('database_missing'))).toContain('does not exist');
    expect(reconciliationMessage(new ReconciliationError('turn_mismatch'))).toContain('matches');
    expect(reconciliationMessage(new Error('PRIVATE_DATABASE_PATH'))).not.toContain('PRIVATE_DATABASE_PATH');
  });
 });
