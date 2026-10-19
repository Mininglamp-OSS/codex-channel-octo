import { describe, expect, it } from 'vitest';
import { domainToASCII, domainToUnicode } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { reduceItem, registrableDomain, hasSecretShape, safeNotice } from '../cards/redact.js';
import corpus from '../cards/__fixtures__/privacy-corpus.v3.json' with { type: 'json' };

describe('WP-05 residual R1 representation-complete domain facts corpus v3', () => {
  for (const c of corpus.urlCases) it(c.id, () => {
    expect(domainToASCII(c.hostname).toLowerCase() === c.ascii).toBe(true);
    expect(domainToUnicode(c.ascii) === c.unicode).toBe(true);
    const facts = reduceItem({ type: 'web_search', url: c.url });
    expect(facts.domain === c.expected).toBe(true);
    expect(registrableDomain(c.hostname) === c.expected).toBe(true);
    expect(hasSecretShape(facts.domain ?? '')).toBe(false);
    expect(safeNotice(facts)).toBe('🔧 Searching…');
    expect(Object.isFrozen(facts)).toBe(true);
    expect(reduceItem({ type: 'web_search', url: c.url })).toEqual(facts);
  });
  it('does not inspect discarded userinfo/path/query/fragment as hostname facts', () => {
    const token = 'AKIAIOSFODNN7EXAMPLE';
    for (const url of ['https://' + token + ':omitted@ordinary.com/',
      'https://ordinary.com/' + token, 'https://ordinary.com/?' + token,
      'https://ordinary.com/#' + token]) {
      expect(reduceItem({ type: 'web_search', url })).toEqual({ category: 'web_search', domain: 'ordinary.com' });
    }
  });
  it('rejects decoded-Unicode removal using the real source and full reducer corpus', async () => {
    const path = new URL('../cards/redact.ts', import.meta.url);
    const source = readFileSync(path, 'utf8');
    const marker = 'domainHasSecret(unicode)';
    expect(source.split(marker).length).toBe(2);
    const mutated = source.replace(marker, 'false').replaceAll('import.meta.url', JSON.stringify(path.href));
    const js = ts.transpileModule(mutated, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const candidate = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64')) as { reduceItem: typeof reduceItem };
    const failed = corpus.urlCases.filter(c => candidate.reduceItem({ type: 'web_search', url: c.url }).domain !== c.expected);
    expect(failed.some(c => c.id.endsWith('-punycode'))).toBe(true);
    expect(failed.every(c => c.id.startsWith('vendor-'))).toBe(true);
  });
});
