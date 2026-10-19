import { describe, it, expect, vi } from 'vitest';
import { recover, RECOVERY_DEFAULTS, parseRetryAfter, retryDelay, validateRecovery, canRetry } from '../agent-recovery.js';
import { classifyFailure, AgentFailure, TurnFailure, failureReply } from '../agent-failure.js';
import { TurnContext } from '../turn-context.js';
const temporary = () => Object.assign(new Error('PRIVATE'),{code:'EAGAIN',syscall:'spawn /private/path'});
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> { const out:T[]=[];for await(const item of stream)out.push(item);return out; }
describe('safe recovery eligibility and budgets',()=>{
 it('retries only a proven pre-execution failure, using one shared attempt budget',async()=>{
  let calls=0;const wait=vi.fn().mockResolvedValue(undefined);
  const out=await drain(recover(async function*(){if(++calls<3)throw temporary();yield 'ok';},{config:{enabled:true},risk:()=> 'proven_not_started',wait,random:()=>0.5}));
  expect(out).toEqual(['ok']);expect(calls).toBe(3);expect(wait.mock.calls.map(c=>c[0])).toEqual([750,1500]);
 });
 it('is disabled by default',async()=>{
  let calls=0;await expect(drain(recover(async function*(){calls++;throw temporary();},{risk:()=> 'proven_not_started'}))).rejects.toMatchObject({report:{attempts:1,decision:'not_attempted'}});expect(calls).toBe(1);
 });
 it.each(['unknown','effects_observed'] as const)('never retries risk=%s, including transient HTTP evidence',async risk=>{
  let calls=0;await expect(drain(recover(async function*(){calls++;throw new AgentFailure({stage:'inference',category:'provider_unavailable',source:'sdk_event',evidence:'structured',httpStatus:503});},{config:{enabled:true},risk:()=>risk}))).rejects.toMatchObject({report:{attempts:1,decision:'blocked_uncertain'}});expect(calls).toBe(1);
 });
 it('does not infer execution evidence from a transient error alone',()=>expect(canRetry(classifyFailure(new Error('503 service unavailable'),'sdk_event'),'unknown')).toBe(false));
 it('bounds repeated failure and retains first/final snapshots',async()=>{
  let calls=0;await expect(drain(recover(async function*(){calls++;throw temporary();},{config:{enabled:true,maxAttempts:2},risk:()=> 'proven_not_started',wait:async()=>{}}))).rejects.toMatchObject({report:{attempts:2,decision:'exhausted',first:{stage:'spawn'},final:{stage:'spawn'}}});expect(calls).toBe(2);
 });
 it('a changed permanent failure preserves the original failure',async()=>{
  let calls=0;await expect(drain(recover(async function*(){if(++calls===1)throw temporary();throw new AgentFailure(classifyFailure(new Error('401 unauthorized'),'sdk_event'));},{config:{enabled:true},risk:()=> 'proven_not_started',wait:async()=>{}}))).rejects.toMatchObject({report:{attempts:2,first:{category:'network_transient'},final:{category:'auth'}}});
 });
 it('never truncates a Retry-After to retry before the server permits',async()=>{
  let calls=0;const wait=vi.fn();await expect(drain(recover(async function*(){calls++;throw new AgentFailure({stage:'inference',category:'rate_limited',source:'sdk_event',evidence:'structured',retryAfterMs:1000});},{config:{enabled:true,maxElapsedMs:20},risk:()=> 'proven_not_started',wait}))).rejects.toMatchObject({report:{decision:'exhausted'}});expect(wait).not.toHaveBeenCalled();expect(calls).toBe(1);
 });
 it('cancellation interrupts backoff without starting another run',async()=>{
  const c=new AbortController();let calls=0;const task=drain(recover(async function*(){calls++;throw temporary();},{config:{enabled:true,baseDelayMs:10000},signal:c.signal,risk:()=> 'proven_not_started',random:()=>1}));
  c.abort();await expect(task).rejects.toMatchObject({report:{decision:'cancelled'}});expect(calls).toBe(1);
 });
 it('does not start another attempt after deadline elapses during wait',async()=>{
  let clock=0,calls=0;await expect(drain(recover(async function*(){calls++;throw temporary();},{config:{enabled:true},deadline:3,now:()=>clock,random:()=>0,risk:()=> 'proven_not_started',wait:async()=>{clock=4;}}))).rejects.toMatchObject({report:{decision:'exhausted'}});expect(calls).toBe(1);
 });
 it.each(['-1','Infinity','1.5','token=PRIVATE','9999999999999999999999'])('rejects invalid Retry-After %s',value=>expect(parseRetryAfter(value)).toBeUndefined());
 it('parses seconds/date and respects minimum wait',()=>{
  expect(parseRetryAfter('2')).toBe(2000);expect(parseRetryAfter('Wed, 14 Oct 2026 00:00:02 GMT',Date.parse('2026-10-14T00:00:00Z'))).toBe(2000);
  expect(retryDelay({stage:'inference',category:'rate_limited',source:'sdk_event',evidence:'structured',retryAfterMs:12000},1,RECOVERY_DEFAULTS,()=>0)).toBe(12000);
 });
 it.each([{enabled:'yes'},{maxAttempts:0},{maxAttempts:6},{baseDelayMs:100,maxDelayMs:1},{unknown:true},{toString:1},[],null].map((value): [unknown] => [value]))('rejects invalid config %j',value=>expect(()=>validateRecovery(value)).toThrow());
});
describe('fixed error categories and safe user feedback',()=>{
 it.each([['429 rate limit exceeded','rate_limited'],['429 quota exhausted','quota_exhausted'],['503 service unavailable','provider_unavailable'],['401 unauthorized','auth'],['403 forbidden','permission'],['context_length_exceeded','context_limit'],['invalid encrypted content','invalid_encrypted_content']])('classifies %s', (text,category)=>expect(classifyFailure(new Error(text),'sdk_event').category).toBe(category));
 it('never parses provider statuses from rejected JSONL or subprocess stderr',()=>{
  expect(classifyFailure(new Error('Failed to parse item: 429 rate limit exceeded',{cause:new SyntaxError('bad')}))).toMatchObject({category:'jsonl_invalid'});
  expect(classifyFailure(new Error('Codex Exec exited with code 1: 503 service unavailable'))).toMatchObject({category:'process_exit'});
  expect(classifyFailure(new Error('tool output: 401 unauthorized'),'sdk_event').category).toBe('unknown');
 });
 it('serializes no raw exception fields and reports uncertainty honestly',()=>{
  const error=new TurnFailure({diagnosticId:'local-id',attempts:1,decision:'blocked_uncertain',executionRisk:'unknown',first:classifyFailure(new Error('PRIVATE')),final:classifyFailure(new Error('PRIVATE'))});
  expect(JSON.stringify(error)).not.toContain('PRIVATE');expect(failureReply(error.report)).toContain('未满足');expect(failureReply(error.report)).toContain('可能已部分执行');expect(failureReply(error.report)).not.toContain('已额外尝试');
 });
 it('revokes late callback and synchronous store publication',()=>{
  const turn=new TurnContext(1000);const store={write:vi.fn()};const guarded=turn.guard(store);turn.cancel();expect(()=>guarded.write()).toThrow();expect(store.write).not.toHaveBeenCalled();
 });
});

describe('equal jitter bounds', () => {
 it('keeps a positive exponential floor and honors Retry-After', () => {
  const failure = { stage: 'inference', category: 'network_transient', source: 'sdk_event', evidence: 'structured' } as const;
  expect(retryDelay(failure, 1, RECOVERY_DEFAULTS, () => 0)).toBe(500);
  expect(retryDelay(failure, 2, RECOVERY_DEFAULTS, () => 0)).toBe(1000);
  expect(retryDelay(failure, 10, RECOVERY_DEFAULTS, () => 1)).toBe(RECOVERY_DEFAULTS.maxDelayMs);
 });
});


describe('native DOMException classification compatibility', () => {
 it.each([['AbortError','cancelled'],['TimeoutError','timeout']] as const)(
  'preserves %s as structured %s', (name, category) => {
   expect(classifyFailure(new DOMException('PRIVATE',name))).toMatchObject({stage:'inference',category,evidence:'structured'});
  });
 it('classifies cancellation from the real turn publication fence', () => {
  const turn=new TurnContext(0);turn.cancel();let caught:unknown;
  try {turn.assertPublishable();} catch(error) {caught=error;}
  expect(classifyFailure(caught)).toMatchObject({category:'cancelled',evidence:'structured'});
 });
 it('classifies AbortSignal cancellation reasons', () => {
  expect(classifyFailure(AbortSignal.abort().reason)).toMatchObject({category:'cancelled',evidence:'structured'});
 });
});
