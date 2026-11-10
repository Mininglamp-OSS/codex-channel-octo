import { describe, expect, it } from 'vitest';
import { nativeErrorMessage } from '../native-error.js';
import { classifyFailure, failureReply, TurnFailure } from '../agent-failure.js';
import { recover } from '../agent-recovery.js';
describe('native exception accessor boundary',()=>{
 it('does not invoke custom own accessors on native DOMExceptions',()=>{
  let reads=0;const error=new DOMException('PRIVATE','AbortError');
  Object.defineProperty(error,'message',{get(){reads++;throw Error('PRIVATE_GETTER');}});
  expect(nativeErrorMessage(error)).toBeUndefined();expect(classifyFailure(error).category).toBe('unknown');expect(reads).toBe(0);
 });
 it('does not trust prototype getters on an ordinary Error subclass',()=>{
  let reads=0;class Custom extends Error {get code(){reads++;throw Error('PRIVATE_GETTER');}}
  expect(classifyFailure(new Custom('PRIVATE')).category).toBe('unknown');expect(reads).toBe(0);
 });
 it.each(['own','inherited'] as const)('never invokes a throwing %s cause getter during classification or recovery',async location=>{
  let reads=0, runs=0;
  const error=new Error('Failed to parse item: synthetic payload');
  const descriptor={get(){reads++;throw Error('hostile cause getter');},configurable:true};
  if(location==='own')Object.defineProperty(error,'cause',descriptor);
  else Object.setPrototypeOf(error,Object.create(Error.prototype,{cause:descriptor}));
  for(const source of ['sdk_exception','sdk_event'] as const) {
   expect(classifyFailure(error,source)).toEqual({stage:'inference',category:'unknown',source,evidence:'unknown'});
  }
  let caught:unknown;
  try {
   for await(const event of recover(async function*(){runs++;throw error;},
    {config:{enabled:true},id:'cause-getter-regression',risk:()=> 'unknown'}))void event;
  } catch(failure){caught=failure;}
  expect(caught).toBeInstanceOf(TurnFailure);
  const report=(caught as TurnFailure).report;
  expect(report).toMatchObject({attempts:1,decision:'blocked_uncertain',final:{category:'unknown'},
   originalError:{message:error.message}});
  expect(failureReply(report)).toContain('cause-getter-regression');
  expect(failureReply(report)).toContain('synthetic payload');
  expect(reads).toBe(0);expect(runs).toBe(1);
 });
 it.each(['own','inherited'] as const)('retains JSONL classification for a validated %s data cause',location=>{
  const error=new Error('Failed to parse item: synthetic payload');
  const cause=new SyntaxError('Unterminated string');
  if(location==='own')Object.defineProperty(error,'cause',{value:cause});
  else Object.setPrototypeOf(error,Object.create(Error.prototype,{cause:{value:cause}}));
  expect(classifyFailure(error)).toEqual({stage:'jsonl_parse',category:'jsonl_incomplete',source:'sdk_exception',evidence:'structured'});
 });
 it('does not invoke a message getter on an own data cause',()=>{
  let reads=0;const cause=new SyntaxError('synthetic cause');
  Object.defineProperty(cause,'message',{get(){reads++;throw Error('hostile nested getter');}});
  const error=new Error('Failed to parse item: synthetic payload',{cause});
  expect(classifyFailure(error)).toMatchObject({category:'unknown',evidence:'unknown'});
  expect(reads).toBe(0);
 });
 it.each(['message','name','code','syscall','cause.message'])('rejects non-string %s data without invoking string/coercion hooks',field=>{
  let calls=0;
  const hostile={get startsWith(){calls++;throw Error('hostile startsWith');},
    toString(){calls++;throw Error('hostile coercion');},[Symbol.toPrimitive](){calls++;throw Error('hostile primitive');}};
  const error=new Error('Failed to parse item: synthetic');
  if(field==='cause.message')Object.defineProperty(error,'cause',{value:Object.defineProperty(new SyntaxError('bad'),'message',{value:hostile})});
  else Object.defineProperty(error,field,{value:hostile});
  for(const source of ['sdk_exception','sdk_event'] as const)
   expect(classifyFailure(error,source)).toEqual({stage:'inference',category:'unknown',source,evidence:'unknown'});
  expect(calls).toBe(0);
 });
 it.each([null,42,true,Symbol('synthetic'),{},()=>{}])('handles malformed message type %s without throwing',value=>{
  const error=Object.defineProperty(new Error('synthetic'),'message',{value});
  expect(classifyFailure(error).category).toBe('unknown');
 });
 it('requires a real native DOMException brand, not just the prototype',()=>{
  const fake=Object.create(DOMException.prototype);
  expect(nativeErrorMessage(fake)).toBeUndefined();expect(classifyFailure(fake).category).toBe('unknown');
  const error=new Error();Object.setPrototypeOf(error,DOMException.prototype);
  expect(nativeErrorMessage(error)).toBeUndefined();expect(classifyFailure(error).category).toBe('unknown');
 });
 it('never reflects a revoked proxy',()=>{
  const {proxy,revoke}=Proxy.revocable(new DOMException('PRIVATE','AbortError'),{});revoke();
  expect(nativeErrorMessage(proxy)).toBeUndefined();expect(classifyFailure(proxy).category).toBe('unknown');
 });
 it('classifies the native timeout signal reason',async()=>{
  const signal=AbortSignal.timeout(1);await new Promise(resolve=>setTimeout(resolve,5));
  expect(classifyFailure(signal.reason)).toMatchObject({category:'timeout',evidence:'structured'});
 });
});
