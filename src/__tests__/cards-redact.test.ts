import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reduceItem, safeNotice, sanitizeText, hasSecretShape, registrableDomain, PSL_SHA256 } from '../cards/redact.js';
import corpus from '../cards/__fixtures__/privacy-corpus.v1.json' with { type: 'json' };

describe('WP-05 / PN-01–07 privacy corpus v1', () => {
  for (const c of corpus.cases) it(c.id, () => {
    const facts = reduceItem(c.item);
    // Avoid exposing fixture content in failure reports.
    expect(JSON.stringify(facts) === JSON.stringify(c.expected)).toBe(true);
    for (const marker of c.forbidden) expect(JSON.stringify(facts).includes(marker)).toBe(false);
    const notice = safeNotice(facts) ?? '';
    for (const marker of c.forbidden) expect(notice.includes(marker)).toBe(false);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(reduceItem(c.item)).toEqual(facts);
  });
  for (const c of corpus.textCases) it('text corpus '+c.id, () => {
    expect(sanitizeText(c.input,'text',c.scalars,c.bytes) === c.expected).toBe(true);
  });
  for (const c of corpus.secretCases) it('secret corpus '+c.id, () => {
    expect(hasSecretShape(c.input)).toBe(c.secret);
    if(c.secret) expect(sanitizeText(c.input,'text')).toBe('text');
  });
  it('rejects primitives, symbols, prototype and accessor inputs without executing code', () => {
    let calls = 0;
    const getter = () => { calls++; throw new Error('must never run'); };
    const invalid: unknown[] = [null, undefined, 1, 'command_execution', Symbol('x'), [],
      Object.create({ type: 'command_execution', command: 'git' }),
      { type: 'command_execution', get command() { return getter(); } },
      { type: 'web_search', [Symbol('x')]: 'ignored' },
      new Proxy({}, { ownKeys: getter, getPrototypeOf: getter, get: getter }),
      Proxy.revocable({}, {}).proxy,
    ];
    for (const item of invalid) expect(reduceItem(item)).toEqual({ category: 'activity' });
    expect(calls).toBe(0);
    const nested = { type: 'file_change', changes: [{ get path() { return getter(); } }] };
    expect(reduceItem(nested)).toEqual({ category: 'file_change' });
    expect(calls).toBe(0);
  });
  it('bounds malformed, sparse and huge file arrays; completion-only count', () => {
    for (const changes of [null, {}, Array(3), Array(10001), [{path:'a'}, null]])
      expect(reduceItem({type:'file_change', changes})).toEqual({category:'file_change'});
    expect(reduceItem({type:'file_change', changes:[], status:'completed'})).toEqual({category:'file_change',fileCount:0});
  });
  it('command lexical ambiguity fails closed; pinned basename allowlist', () => {
    for (const command of ['env TOKEN=x git', 'git;cat', '"git" x', 'TOKEN="unterminated git', 'git\\x', 'GIT x', 'curl x'])
      expect(reduceItem({type:'command_execution',command})).toEqual({category:'command',program:'command',exitClass:'unknown'});
    expect(reduceItem({type:'command_execution',command:'A=1 B=2 /usr/bin/git --secret'})).toMatchObject({program:'git'});
  });
  it('duration/error are closed facts, never raw error bodies', () => {
    for (const [duration_ms, durationClass] of [[0,'short'],[999,'short'],[1000,'medium'],[59999,'medium'],[60000,'long'],[Infinity,'unknown'],[-1,'unknown']] as const)
      expect(reduceItem({type:'mcp_tool_call',duration_ms, status:'failed',error:'private'})).toEqual({category:'tool',durationClass,errorClass:'failed'});
  });
  it('PSL exact pinned bytes, ICANN/PRIVATE/wildcards/exceptions and unknown suffix fail closed', () => {
    const data=readFileSync(new URL('../cards/data/psl-'+PSL_SHA256+'.dat',import.meta.url));
    expect(createHash('sha256').update(data).digest('hex')).toBe(PSL_SHA256);
    expect(registrableDomain('a.b.github.io')).toBe('b.github.io');
    expect(registrableDomain('github.io')).toBe('link');
    expect(registrableDomain('a.city.kawasaki.jp')).toBe('city.kawasaki.jp');
    expect(registrableDomain('example.com.')).toBe('example.com');
    for (const host of ['com','local','x.internal','x.localhost','x.local','[fc00::1]','169.254.1.1','foo.127.0.0.1','a..com','-a.com','a_.com','a.com:80'])
      expect(registrableDomain(host)).toBe('link');
  });
  it('Unicode controls/bidi/NFC/malformed surrogates and scalar/byte boundaries', () => {
    expect(sanitizeText('e\u0301\u0000\u202e\u2066\u200b', 'text')).toBe('é');
    expect(sanitizeText('a\ud800b\udc00c', 'text')).toBe('abc');
    for (const n of [3,4,5]) expect(sanitizeText('😀'.repeat(n),'text',4,16)).toBe('😀'.repeat(Math.min(n,4)));
    expect(sanitizeText('😀'.repeat(5),'text',10,15)).toBe('😀'.repeat(3));
    for (const n of [191,192,193]) expect(sanitizeText('a'.repeat(n),'text')).toHaveLength(Math.min(n,192));
    expect(sanitizeText('é'.repeat(4),'text',10,7)).toBe('é'.repeat(3));
    for (const [scalars,bytes] of [[-1,4],[4,-1],[NaN,4],[Infinity,4],[4,NaN],[1.5,4]])
      expect(sanitizeText('abc','text',scalars,bytes)).toBe('text');
    expect(sanitizeText('abc','text',0,0)).toBe('');
  });
  it('secret detector true/false positives including normalized split tokens and entropy boundaries', () => {
    const positives = ['PASSWORD=x','export TOKEN=x','DATABASE_URL=postgres://u:p@x/db',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
      'https://u:p@x.com','ghp_1234567890abcdefghijklmnopqrstuv','sk-proj-1234567890abcdefghijklmnopqrstuv',
      'AKIAIOSFODNN7EXAMPLE','a3f07b28c91d4e65f0a9b8c7d6e51423','QUJDREVGR0hJSktMTU5PUFFSUlNUVVZX',
      '-----BEGIN PRIVATE KEY-----','ＴＯＫＥＮ=x','TO\u202eKEN=x','gh\u200bp_1234567890abcdefghijklmnopqrstuv'];
    for (const value of positives) {
      expect(hasSecretShape(value)).toBe(true);
      expect(sanitizeText(value,'text')).toBe('text');
    }
    for (const value of ['git','command','example.com','xn--85x722f.com.cn','ordinary sentence','a'.repeat(100),'0123456789','a3f07b28c91d4e65','Running command'])
      expect(hasSecretShape(value)).toBe(false);
    // Scan complete strings before truncation; a tail credential cannot be hidden by capping.
    expect(sanitizeText('a'.repeat(200)+' TOKEN=x','text')).toBe('text');
  });
  it('never truncates registrable domains into a misleading suffix; final domain secret scan', () => {
    const token='a3f07b28c91d4e65f0a9b8c7d6e51423';
    expect(reduceItem({type:'web_search',url:'https://'+token+'.com'})).toEqual({category:'web_search',domain:'link'});
    expect(safeNotice(reduceItem({type:'unknown',name:'x'}))).toBeNull();
  });
});
