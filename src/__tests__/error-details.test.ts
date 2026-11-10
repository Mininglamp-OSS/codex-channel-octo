import { describe, expect, it, vi } from 'vitest';
import { attachErrorDetails, errorDetails, limitText, snapshotError } from '../error-details.js';
import { classifyFailure, failureReply, TurnFailure, type FailureReport } from '../agent-failure.js';
import { recover } from '../agent-recovery.js';

describe('bounded original error reporting', () => {
  it('preserves original content, code, stack and nested causes without redaction', () => {
    const error = Object.assign(new Error('synthetic-key-value', {cause:new Error('root cause')}), {code:'EPIPE',status:503});
    const detail = snapshotError(error);
    expect(detail.message).toBe('synthetic-key-value');
    expect(detail.details).toContain('EPIPE');expect(detail.details).toContain('503');
    expect(detail.details).toContain('root cause');expect(detail.details).toContain('stack');
  });
  it('bounds huge Unicode messages while preserving the metadata suffix', () => {
    const detail = snapshotError(Object.assign(new Error('😀中'.repeat(100000)), {stderr:'x'.repeat(100000)}));
    expect(Array.from(detail.message).length).toBeLessThanOrEqual(1000);
    expect(Array.from(detail.details).length).toBeLessThanOrEqual(3000);
    expect(detail.message).toContain('［已截断］');
    const snap = classifyFailure(new Error('unknown'));
    const report: FailureReport = {diagnosticId:'id-always-visible',attempts:2,decision:'blocked_uncertain',executionRisk:'unknown',
      first:snap,final:snap,originalError:detail,finalError:detail,recoveryStopReason:'unsafe_effects',sessionMode:'resume',consecutiveFailures:2};
    const text = failureReply(report);
    expect(Array.from(text).length).toBeLessThanOrEqual(4500);
    expect(text).toContain('恢复结果：');expect(text).toContain('id-always-visible');expect(text).toContain('连续失败 2 次');
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it('does not invoke accessors, proxies, toJSON or inherited traps', () => {
    const read=vi.fn(()=>{throw Error('must not run');});
    const value=Object.create(null);
    Object.defineProperty(value,'message',{get:read,enumerable:true});
    value.toJSON=read;value.cause=value;
    expect(snapshotError(value).details).toContain('[circular]');expect(read).not.toHaveBeenCalled();
    expect(snapshotError(new Proxy({}, {get:read,ownKeys:read,getPrototypeOf:read})).details).toContain('[unreadable]');
    expect(read).not.toHaveBeenCalled();
  });
  it('limits object traversal, deep cause chains, bigint and non-Error throws', () => {
    const error: Record<string,unknown> = {message:'base',big:10n**10000n};
    let tail=error;for(let i=0;i<50;i++){tail.cause={message:`cause-${i}`};tail=tail.cause as Record<string,unknown>;}
    const d=snapshotError(error);expect(d.details).toContain('cause-2');expect(d.details).not.toContain('cause-3');
    expect(snapshotError('plain thrown text').message).toBe('plain thrown text');
    expect(limitText('中文😀',3)).toBe('中文😀');
  });
  it('marks only exact SDK thread failures, never an arbitrary repeated error', () => {
    expect(snapshotError({message:'Thread not found'},true).threadProblem).toBe('not_found');
    expect(snapshotError({code:'invalid_encrypted_content',message:'provider details'},true).threadProblem).toBe('invalid_encrypted_content');
    expect(snapshotError({message:'Thread not found'}).threadProblem).toBeUndefined();
    expect(snapshotError({message:'tool said Thread not found'},true).threadProblem).toBeUndefined();
  });
  it('retains the first and final exceptions and leaves the retry budget unchanged', async () => {
    let calls=0;
    try {
      for await(const _ of recover(async function*(){
        calls++;throw Object.assign(new Error(`failure-${calls}`),{syscall:'spawn test',code:'EAGAIN'});
      },{config:{enabled:true,maxAttempts:2},risk:()=> 'proven_not_started',wait:async()=>{}})) void _;
      throw Error('expected failure');
    } catch(error) {
      expect(error).toBeInstanceOf(TurnFailure);
      const report=(error as TurnFailure).report;
      expect(report.originalError?.message).toBe('failure-1');expect(report.finalError?.message).toBe('failure-2');
      expect(report.recoveryStopReason).toBe('attempt_limit');expect(calls).toBe(2);
    }
  });
  it.each([
    {config:{enabled:false},risk:'proven_not_started',message:'spawn failure',spawn:true,expected:'disabled'},
    {config:{enabled:true},risk:'effects_observed',message:'spawn failure',spawn:true,expected:'unsafe_effects'},
    {config:{enabled:true},risk:'proven_not_started',message:'ordinary failure',spawn:false,expected:'ineligible_failure'},
    {config:{enabled:true,maxElapsedMs:1},risk:'proven_not_started',message:'spawn failure',spawn:true,expected:'time_budget'},
  ] as const)('records the actual $expected recovery branch',async ({config,risk,message,spawn,expected})=>{
    let caught:unknown;
    try {for await(const _ of recover(async function*(){throw Object.assign(new Error(message),spawn?{syscall:'spawn test',code:'EAGAIN'}:{});},
      {config,risk:()=>risk,now:()=>0,random:()=>0,wait:async()=>{throw Error('must not wait');}}))void _;}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(TurnFailure);
    expect((caught as TurnFailure).report.recoveryStopReason).toBe(expected);
  });
  it('distinguishes an insufficient request deadline from the recovery time budget',async()=>{
    let caught:unknown;
    try {for await(const _ of recover(async function*(){throw Object.assign(new Error('launch failed'),{syscall:'spawn test',code:'EAGAIN'});},
      {config:{enabled:true},deadline:10,now:()=>0,risk:()=> 'proven_not_started',random:()=>0,wait:async()=>{throw Error('must not wait');}}))void _;}catch(error){caught=error;}
    expect((caught as TurnFailure).report.recoveryStopReason).toBe('deadline');
    expect((caught as TurnFailure).report.attempts).toBe(1);
  });
  it('marks truncation when details fill the budget exactly before another field',()=>{
    const value={message:'error',code:'x'.repeat(3000-'error.code: '.length),status:500};
    const result=snapshotError(value);
    expect(Array.from(result.details).length).toBe(3000);
    expect(result.details).toContain('［已截断］');
  });
  it('keeps SDK error fields when the wrapper has only a classified message', () => {
    const wrapped=attachErrorDetails(new Error('wrapper'),{message:'actual provider response',status:502},true);
    expect(errorDetails(wrapped)).toMatchObject({message:'actual provider response'});
    expect(errorDetails(wrapped).details).toContain('502');
  });
});
