import { describe, expect, it, vi } from 'vitest';
import { isSdkJsonlParseError, summarizeAgentError } from '../agent-errors.js';
import { AgentFailure, TurnFailure, classifyFailure } from '../agent-failure.js';
import { StreamRelay } from '../stream-relay.js';

vi.mock('../octo/api.js',()=>({sendTyping:vi.fn().mockResolvedValue(undefined),sendMessage:vi.fn()}));

describe('agent error redaction', () => {
  it.each(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'])('preserves safe syscall code %s without payloads', (code) => {
    expect(summarizeAgentError(Object.assign(new Error('SYNTHETIC_PRIVATE_OUTPUT'), { code })))
      .toBe(`Error: agent operation failed (${code})`);
  });
  it('retains builtin error class without trusting mutable name/code fields', () => {
    expect(summarizeAgentError(new TypeError('private output'))).toContain('TypeError:');
    const error = Object.assign(new Error('private'), { name: 'SYNTHETIC_SECRET', code: 'SYNTHETIC_SECRET' });
    expect(summarizeAgentError(error)).toBe('Error: agent operation failed (details withheld)');
  });
  it('reports a known bootstrap failure with safe recovery instructions', () => {
    expect(summarizeAgentError(new Error('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE: synthetic'))).toContain('reinstall dependencies');
    expect(summarizeAgentError(new Error('Codex Exec exited with code 1: CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE: synthetic'))).toBe('Codex process exited with code 1');
  });
  it('recognizes actual SDK parse errors without echoing their payload or cause', () => {
    const error = new Error('Failed to parse item: SYNTHETIC_PRIVATE_PAYLOAD', {
      cause: new SyntaxError('Unterminated string in JSON at position 12'),
    });
    expect(isSdkJsonlParseError(error)).toBe(true);
    expect(summarizeAgentError(error)).toBe('Codex SDK JSONL parse failure (incomplete-json)');
    expect(summarizeAgentError(error)).not.toContain('SYNTHETIC');
  });
  it('does not classify message-text lookalikes as parser failures', () => {
    expect(isSdkJsonlParseError(new Error('Failed to parse item: claimed error'))).toBe(false);
    expect(isSdkJsonlParseError(new Error('Failed to parse item: claimed error', { cause: new Error('bad') }))).toBe(false);
  });
  it.each([new Error('secret token and tool output'), 'secret output',
    new Error('Codex Exec exited with code 1: SYNTHETIC_SECRET'),
    new Error('Codex Exec exited with signal SIGTERM: SYNTHETIC_SECRET')])('never includes arbitrary error details', (error) => {
    expect(summarizeAgentError(error)).not.toMatch(/secret|SYNTHETIC/i);
  });
});

describe('shared error reflection boundary at diagnostic sinks',()=>{
  const generic='Agent operation failed (details withheld)';
  function hostile(field:string,location:string){
    const getter=vi.fn(()=>{throw Error('SYNTHETIC_HOSTILE_GETTER');});
    const error=new Error('Failed to parse item: synthetic');
    if(location==='own')Object.defineProperty(error,field,{get:getter});
    else {
      Reflect.deleteProperty(error,field);
      Object.setPrototypeOf(error,Object.create(Error.prototype,{[field]:{get:getter}}));
    }
    return {error,getter};
  }
  it.each(['own','inherited'])('rejects %s cause/message/code getters without calling them',location=>{
    for(const field of ['cause','message','code']){
      const {error,getter}=hostile(field,location);
      expect(isSdkJsonlParseError(error)).toBe(false);
      expect(summarizeAgentError(error)).toBe(generic);
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it.each(['own','inherited'])('rejects a data cause with a %s message getter',location=>{
    const getter=vi.fn(()=>{throw Error('SYNTHETIC_HOSTILE_GETTER');});
    const cause=new SyntaxError('synthetic cause');
    if(location==='own')Object.defineProperty(cause,'message',{get:getter});
    else {
      Reflect.deleteProperty(cause,'message');
      Object.setPrototypeOf(cause,Object.create(SyntaxError.prototype,{message:{get:getter}}));
    }
    const error=new Error('Failed to parse item: synthetic',{cause});
    expect(isSdkJsonlParseError(error)).toBe(false);
    expect(summarizeAgentError(error)).toBe(generic);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['root','cause','prototype','revoked'])('never invokes traps on a %s Proxy',location=>{
    const trap=vi.fn(()=>{throw Error('SYNTHETIC_PROXY_TRAP');});
    const handler={get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap};
    let error:unknown=new Error('Failed to parse item: synthetic');
    if(location==='root')error=new Proxy(error as Error,handler);
    else if(location==='cause')error=new Error('Failed to parse item: synthetic',{cause:new Proxy(new SyntaxError('synthetic'),handler)});
    else if(location==='prototype')Object.setPrototypeOf(error,new Proxy(Error.prototype,handler));
    else {const revoked=Proxy.revocable(error as Error,handler);revoked.revoke();error=revoked.proxy;}
    expect(isSdkJsonlParseError(error)).toBe(false);
    expect(summarizeAgentError(error)).toBe(generic);
    expect(trap).not.toHaveBeenCalled();
  });
  it('rejects object-valued messages without invoking conversion hooks',()=>{
    const convert=vi.fn(()=>{throw Error('SYNTHETIC_CONVERSION');});
    const error=new Error();Object.defineProperty(error,'message',{value:{toString:convert,[Symbol.toPrimitive]:convert}});
    expect(isSdkJsonlParseError(error)).toBe(false);expect(summarizeAgentError(error)).toBe(generic);
    expect(convert).not.toHaveBeenCalled();
  });
  it.each(['own','inherited'])('preserves JSONL summaries with a valid %s data cause',location=>{
    const error=new Error('Failed to parse item: synthetic');
    const cause=new SyntaxError('Unterminated string');
    if(location==='own')Object.defineProperty(error,'cause',{value:cause});
    else Object.setPrototypeOf(error,Object.create(Error.prototype,{cause:{value:cause}}));
    expect(isSdkJsonlParseError(error)).toBe(true);
    expect(summarizeAgentError(error)).toBe('Codex SDK JSONL parse failure (incomplete-json)');
  });
  it('does not invoke metadata serializers or getters on wrapped failures',()=>{
    const call=vi.fn(()=>{throw Error('SYNTHETIC_METADATA_HOOK');});
    const snapshot={...classifyFailure(new Error('synthetic')),toJSON:call};
    const failure=new AgentFailure(snapshot);
    expect(summarizeAgentError(failure)).toContain('unknown');
    const report={diagnosticId:'metadata-id',attempts:1,decision:'blocked_uncertain' as const,executionRisk:'unknown' as const,
      first:snapshot,final:snapshot};
    const turn=new TurnFailure(report);
    Object.defineProperty(report,'originalError',{get:call,enumerable:true});
    expect(summarizeAgentError(turn)).toContain('metadata-id');
    Object.defineProperty(turn,'report',{get:call});
    expect(summarizeAgentError(turn)).toBe(generic);
    expect(call).not.toHaveBeenCalled();
  });
  it('keeps bounded original text and diagnostic IDs for normal TurnFailure reports',()=>{
    const snapshot=classifyFailure(new Error('synthetic'));
    const details={message:'ORIGINAL_SYNTHETIC_ERROR',details:'synthetic details'};
    const error=new TurnFailure({diagnosticId:'still-visible',attempts:1,decision:'blocked_uncertain',executionRisk:'unknown',
      first:snapshot,final:snapshot,originalError:details,finalError:details});
    const text=summarizeAgentError(error);
    expect(text).toContain(details.message);expect(text).toContain(details.details);expect(text).toContain('still-visible');
    expect(Array.from(text).length).toBeLessThanOrEqual(4500);
  });
  it.each(['own','inherited'])('preserves the original relay failure after a %s cause getter is rejected',async location=>{
    const {error,getter}=hostile('cause',location);
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      async function* chunks():AsyncIterable<string>{throw error;}
      await expect(new StreamRelay().deliver('synthetic-channel',1,chunks(),'https://test.invalid','synthetic-token')).rejects.toBe(error);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(generic));
      expect(getter).not.toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
});
