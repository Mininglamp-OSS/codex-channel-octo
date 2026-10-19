import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordPrivateFailure } from '../private-diagnostics.js';
import type { FailureReport } from '../agent-failure.js';
vi.mock('node:fs',async importOriginal=>({...await importOriginal<typeof import('node:fs')>()}));
let root:string;
const report:FailureReport={diagnosticId:'3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2',attempts:1,decision:'blocked_uncertain',executionRisk:'unknown',
 first:{stage:'inference',category:'unknown',source:'sdk_event',evidence:'unknown'},final:{stage:'inference',category:'unknown',source:'sdk_event',evidence:'unknown'}};
beforeEach(()=>{root=fs.mkdtempSync(join(tmpdir(),'diagnostic-io-'));fs.mkdirSync(join(root,'diagnostics'),{mode:0o700});});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
const limits={maxBytes:1024,maxFiles:3};
function record(){return recordPrivateFailure(root,true,report,new Error('PRIVATE'),limits);}
describe('fail-closed private diagnostic IO',()=>{
 it('rejects a hard-linked file without modifying its target',()=>{
  const target=join(root,'target');fs.writeFileSync(target,'KEEP',{mode:0o600});fs.linkSync(target,join(root,'diagnostics/agent-failures.jsonl'));
  expect(record()).toBe(false);expect(fs.readFileSync(target,'utf8')).toBe('KEEP');
 });
 it('rejects a publicly readable pre-existing rotation',()=>{
  fs.writeFileSync(join(root,'diagnostics/agent-failures.jsonl.1'),'KEEP',{mode:0o644});fs.chmodSync(join(root,'diagnostics/agent-failures.jsonl.1'),0o644);expect(record()).toBe(false);
 });
 it('fails closed on a write error and keeps diagnostics disabled without any IO',()=>{
  const writer=vi.spyOn(fs,'writeFileSync').mockImplementation(()=>{throw Error('PRIVATE_IO_ERROR');});
  expect(record()).toBe(false);expect(writer).toHaveBeenCalledTimes(1);
  expect(recordPrivateFailure(root,false,report,new Error('PRIVATE'))).toBe(true);expect(writer).toHaveBeenCalledTimes(1);
 });
 it('detects a symlink introduced during rotation',()=>{
  const file=join(root,'diagnostics/agent-failures.jsonl');fs.writeFileSync(file,'x'.repeat(700),{mode:0o600});fs.writeFileSync(`${file}.1`,'older',{mode:0o600});
  const target=join(root,'target');fs.writeFileSync(target,'KEEP',{mode:0o600});
  const original=fs.renameSync;
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{original(from,to);if(String(from).endsWith('.1'))fs.symlinkSync(target,from);});
  expect(record()).toBe(false);expect(fs.readFileSync(target,'utf8')).toBe('KEEP');expect(fs.readFileSync(file,'utf8')).toBe('x'.repeat(700));
 });
 it('detects a directory substituted after it was opened',()=>{
  const dir=join(root,'diagnostics'),target=join(root,'target');fs.mkdirSync(target);const original=fs.openSync;
  vi.spyOn(fs,'openSync').mockImplementation((path,flags,mode)=>{
   const fd=original(path,flags,mode);
   if(String(path).endsWith('/diagnostics')){fs.renameSync(dir,join(root,'saved'));fs.symlinkSync(target,dir);}
   return fd;
  });
  expect(record()).toBe(false);expect(fs.readdirSync(target)).toEqual([]);
 });
});
