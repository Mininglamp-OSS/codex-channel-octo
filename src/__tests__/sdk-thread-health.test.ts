import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';

let root:string, store:SessionStore;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'sdk-health-'));store=new SessionStore(createAdapter(join(root,'db')));store.init();});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
describe('persistent thread replacement for a subsequent admitted user turn',()=>{
  it('counts failures without changing ordinary resume or other sessions',()=>{
    store.setSdkSessionId('a','old');store.setSdkSessionId('b','other');
    expect(store.recordSdkFailure('a','failure-1')).toBe(1);expect(store.recordSdkFailure('a','failure-2')).toBe(2);
    expect(store.prepareSdkSession('a')).toEqual({resume:'old',suppressHistory:false,replaced:false});
    expect(store.getSdkThreadHealth('b').failures).toBe(0);
  });
  it('preserves failed task records, then rotates only on next preparation and suppresses old history after restart',()=>{
    store.setSdkSessionId('a','bad');store.beginTurn('a','old-task');
    store.recordInterruption('a',{turnId:'old-task',reason:'failed',executionRisk:'effects_observed',stage:'inference'});
    store.finishTurn('a','old-task','clean');
    store.recordSdkFailure('a','old-task','invalid_encrypted_content');
    expect(store.getSdkSessionId('a')).toBe('bad');
    store.close();store=new SessionStore(createAdapter(join(root,'db')));store.init();
    expect(store.prepareSdkSession('a')).toEqual({resume:undefined,suppressHistory:true,replaced:true});
    expect(store.getInterruption('a')?.turnId).toBe('old-task');
    expect(store.prepareSdkSession('a').suppressHistory).toBe(true);
    store.setSdkSessionId('a','new');expect(store.recordSdkFailure('a','new-task')).toBe(1);
    expect(store.prepareSdkSession('a').resume).toBe('new');
    store.recordSdkSuccess('a');expect(store.getSdkThreadHealth('a').suppressHistory).toBe(false);
  });
  it('reset clears replacement intent without releasing execution quarantine',()=>{
    store.setSdkSessionId('a','bad');store.recordSdkFailure('a','id','not_found');
    store.beginTurn('a','task');store.finishTurn('a','task','quarantined');store.clearSdkSessionId('a');
    expect(store.prepareSdkSession('a')).toEqual({resume:undefined,suppressHistory:false,replaced:false});
    expect(store.isTurnQuarantined('a')).toBe(true);
  });
});
