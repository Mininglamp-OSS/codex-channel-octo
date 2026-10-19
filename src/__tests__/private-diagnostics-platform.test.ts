import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPrivateFailure } from '../private-diagnostics.js';
import type { FailureReport } from '../agent-failure.js';
vi.mock('node:fs', async importOriginal => {
 const actual = await importOriginal<typeof import('node:fs')>();
 return {...actual, constants:{...actual.constants}};
});
const original = {...constants};
const roots:string[]=[];
afterEach(()=>{Object.assign(constants,original);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const report:FailureReport={diagnosticId:'3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2',attempts:1,decision:'not_attempted',executionRisk:'unknown',
 first:{stage:'inference',category:'unknown',source:'local',evidence:'unknown'},final:{stage:'inference',category:'unknown',source:'local',evidence:'unknown'}};
describe('required diagnostic filesystem guarantees',()=>{
 it.each(['O_DIRECTORY','O_NOFOLLOW','O_NONBLOCK'] as const)('refuses missing %s before creating the diagnostic directory',key=>{
  const root=mkdtempSync(join(tmpdir(),'diagnostic-flags-'));roots.push(root);
  (constants as unknown as Record<string,unknown>)[key]=undefined;
  expect(recordPrivateFailure(root,true,report,new Error('PRIVATE'))).toBe(false);
  expect(readdirSync(root)).toEqual([]);
  expect(recordPrivateFailure(root,false,report,new Error('PRIVATE'))).toBe(true);
 });
});
