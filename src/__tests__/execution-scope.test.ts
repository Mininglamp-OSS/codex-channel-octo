import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionScope } from '../execution-scope.js';
let root:string;let scope:ExecutionScope;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'execution-scope-test-'));scope=new ExecutionScope(fileURLToPath(new URL('./fixtures/owned-cli.mjs',import.meta.url)));});
afterEach(()=>{scope.dispose();rmSync(root,{recursive:true,force:true});});
const environment=()=>scope.environment({PATH:process.env.PATH!});
describe('closed teardown acknowledgment',()=>{
  it('knows a runner was never launched without treating missing events as evidence',async()=>{expect(await scope.waitForStopped(0)).toBe(true);scope.expectLaunch();expect(await scope.waitForStopped(0)).toBe(false);});
  it.each(['missing','wrong-token','running','malformed','oversized','symlink'])('rejects %s proof',async kind=>{
    scope.expectLaunch();const env=environment();const path=join(env.CODEX_CHANNEL_EXECUTION_DIR,'status.json');
    if(kind==='wrong-token')writeFileSync(path,JSON.stringify({token:'wrong',state:'stopped'}));
    if(kind==='running')writeFileSync(path,JSON.stringify({token:env.CODEX_CHANNEL_EXECUTION_TOKEN,state:'running'}));
    if(kind==='malformed')writeFileSync(path,'{');
    if(kind==='oversized')writeFileSync(path,'x'.repeat(1025));
    if(kind==='symlink'){const target=join(root,'fake');writeFileSync(target,JSON.stringify({token:env.CODEX_CHANNEL_EXECUTION_TOKEN,state:'stopped'}));symlinkSync(target,path);}
    expect(await scope.waitForStopped(0)).toBe(false);
  });
  it('rejects a correct-nonce stopped file without independently observed closure',async()=>{
    scope.expectLaunch();const env=environment();
    expect(lstatSync(env.CODEX_CHANNEL_EXECUTION_DIR).mode & 0o777).toBe(0o700);
    writeFileSync(join(env.CODEX_CHANNEL_EXECUTION_DIR,'status.json'),JSON.stringify({token:env.CODEX_CHANNEL_EXECUTION_TOKEN,state:'stopped'}),{mode:0o600});
    expect(await scope.waitForStopped(0)).toBe(false);
    scope.dispose();expect(existsSync(env.CODEX_CHANNEL_EXECUTION_DIR)).toBe(false);
  });
});
describe.skipIf(process.platform==='win32')('real owned process teardown',()=>{
  it('cancels a managed transport under stdout backpressure without losing teardown tracking',async()=>{
    scope.expectLaunch();await scope.prepare();
    const proxy=fileURLToPath(new URL('./fixtures/owned-proxy.mjs',import.meta.url));
    const pidFile=join(root,'flood-pid');
    const child=spawn(process.execPath,[proxy],{env:{...process.env,...environment(),OWNED_MODE:'flood',OWNED_PID_FILE:pidFile},stdio:['pipe','pipe','pipe']});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    child.stdin.end();child.stderr.resume();
    try{
      for(let i=0;i<100 && !existsSync(pidFile);i++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(existsSync(pidFile)).toBe(true);await new Promise(resolve=>setTimeout(resolve,100));
      child.kill('SIGTERM');
      expect(await scope.waitForStopped(4000)).toBe(true);await exited;
      child.stdout.resume();await closed;
    }finally{child.kill('SIGKILL');}
  },7000);
  it('does not terminate intentional background work on normal successful disposal',async()=>{
    scope.expectLaunch();await scope.prepare();
    const proxy=fileURLToPath(new URL('./fixtures/owned-proxy.mjs',import.meta.url));
    const pidFile=join(root,'background-pid'),effects=join(root,'background-effects');
    const child=spawn(process.execPath,[proxy],{env:{...process.env,...environment(),OWNED_MODE:'background-success',OWNED_PID_FILE:pidFile,OWNED_PARENT_PID_FILE:join(root,'background-parent'),OWNED_EFFECT_FILE:effects},stdio:['pipe','pipe','pipe']});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    child.stdin.end();child.stdout.resume();child.stderr.resume();
    try{
      await closed;scope.dispose();
      const size=existsSync(effects)?lstatSync(effects).size:0;
      await new Promise(resolve=>setTimeout(resolve,75));expect(lstatSync(effects).size).toBeGreaterThan(size);
    }finally{await scope.waitForStopped(4000);child.kill('SIGKILL');}
  },7000);
  it.each([false,true])('acknowledges exit only after a stubborn child and its descendant stop (shadowed ps=%s)',async shadowedPs=>{
    scope.expectLaunch();await scope.prepare();const proxy=fileURLToPath(new URL('./fixtures/owned-proxy.mjs',import.meta.url));chmodSync(proxy,0o755);
    const pidFile=join(root,'pid');const parentPidFile=join(root,'parent-pid');const effects=join(root,'effects');
    const env:Record<string,string|undefined>={...process.env,...environment(),OWNED_MODE:'descendant',OWNED_PID_FILE:pidFile,OWNED_PARENT_PID_FILE:parentPidFile,OWNED_EFFECT_FILE:effects};
    if(shadowedPs){const bin=join(root,'bin');mkdirSync(bin);writeFileSync(join(bin,'ps'),'#!/bin/sh\nexit 0\n',{mode:0o755});env.PATH=bin;}
    const child=spawn(process.execPath,[proxy],{env,stdio:['pipe','pipe','pipe']});
    child.stdin.end();child.stdout.resume();child.stderr.resume();let descendant:number|undefined;
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    try{
      for(let i=0;i<100 && !existsSync(pidFile);i++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(existsSync(pidFile)).toBe(true);descendant=Number(readFileSync(pidFile,'utf8'));
      expect(await scope.waitForStopped(0)).toBe(false);
      child.kill('SIGTERM');expect(await scope.waitForStopped(4000)).toBe(true);await closed;
      let state='';try{state=execFileSync('ps',['-p',String(descendant),'-o','stat='],{encoding:'utf8'}).trim();}catch{/* Reaped. */}
      expect(state==='' || state.startsWith('Z')).toBe(true);
      const size=existsSync(effects)?lstatSync(effects).size:0;
      await new Promise(resolve=>setTimeout(resolve,60));expect(existsSync(effects)?lstatSync(effects).size:0).toBe(size);
    }finally{
      child.kill('SIGKILL');if(descendant){try{process.kill(descendant,'SIGKILL');}catch{/* Already stopped. */}}
      if(existsSync(parentPidFile)){
        const parent=Number(readFileSync(parentPidFile,'utf8'));
        try{if(execFileSync('/bin/ps',['-p',String(parent),'-o','command='],{encoding:'utf8'}).includes('owned-cli.mjs'))process.kill(parent,'SIGKILL');}catch{/* Reaped. */}
      }
    }
  },7000);
});
