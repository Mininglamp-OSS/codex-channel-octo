import { describe, expect, it } from 'vitest';
import { nativeErrorMessage } from '../native-error.js';
import { classifyFailure } from '../agent-failure.js';
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
