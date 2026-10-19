import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveBotConfigs } from '../config.js';
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'private-diagnostic-config-'));mkdirSync(join(root,'test'));});
afterEach(()=>{rmSync(root,{recursive:true,force:true});});
function config(global:unknown, local:unknown={}) {
 const path=join(root,'config.json');writeFileSync(path,JSON.stringify({apiUrl:'https://example.com',bots:[{id:'test'}],sdk:global}),{mode:0o600});
 writeFileSync(join(root,'test/config.json'),JSON.stringify({botToken:'FAKE_TOKEN',sdk:local}),{mode:0o600});
 return ()=>resolveBotConfigs(loadConfig(path))[0];
}
describe('private diagnostic configuration',()=>{
 it('is disabled when absent',()=>expect(config({})().sdk.privateDiagnostics).toBeUndefined());
 it.each([true,false])('inherits global value=%s',enabled=>expect(config({privateDiagnostics:enabled})().sdk.privateDiagnostics).toBe(enabled));
 it('permits a per-bot opt-out',()=>expect(config({privateDiagnostics:true},{privateDiagnostics:false})().sdk.privateDiagnostics).toBe(false));
 it.each(['true',1,null,[],{}])('rejects invalid effective value %j',value=>expect(config({privateDiagnostics:value})).toThrow('must be a boolean'));
 it('validates the per-bot override',()=>expect(config({privateDiagnostics:false},{privateDiagnostics:'false'})).toThrow('must be a boolean'));
});

describe('separate detailed diagnostic configuration',()=>{
 it('defaults to absent even when hash-only diagnostics are enabled',()=>expect(config({privateDiagnostics:true})().sdk.privateDiagnosticsDetails).toBeUndefined());
 it.each([true,false])('inherits and overrides detail=%s',value=>{
  expect(config({privateDiagnosticsDetails:value})().sdk.privateDiagnosticsDetails).toBe(value);
  expect(config({privateDiagnosticsDetails:value},{privateDiagnosticsDetails:!value})().sdk.privateDiagnosticsDetails).toBe(!value);
 });
 it.each(['true',1,null,[],{}])('rejects invalid detailed value %j',value=>expect(config({privateDiagnosticsDetails:value})).toThrow('privateDiagnosticsDetails must be a boolean'));
 it('validates per-bot detailed values',()=>expect(config({},{privateDiagnosticsDetails:'false'})).toThrow('privateDiagnosticsDetails must be a boolean'));
});
