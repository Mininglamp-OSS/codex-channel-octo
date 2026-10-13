/**
 * Egress bypass guard (R8 §1.2 B5, §3.5.5 "Static bypass scan"). The guard is a
 * TypeScript-checker scan of the outbound API module boundary: every export of
 * src/octo/api.ts is a guarded primitive unless explicitly classified as
 * non-message infrastructure or a read. OctoEgress does not exist at DEV-01, so
 * the current call sites are an explicit, exact baseline that later stages must
 * shrink to zero. Negative controls inject the bypass shapes R8 names.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanEgress } from '../../scripts/egress-bypass-scan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const boundary = JSON.parse(readFileSync(new URL('./egress-boundary.json', import.meta.url), 'utf8')) as {
  boundaryModules: string[]; classification: Record<string, { class: string; reason: string }>;
  baselinePermittedCallers: Array<{ file: string; symbol: string; count: number }>;
};
const fixtureConfig = (name: string, baseline: Array<{ file: string; symbol: string; count: number }> = []) => ({
  root: `${FIX}${name}`,
  srcDir: 'src',
  boundaryModules: ['src/octo/api.ts'],
  egressModules: ['src/egress/'],
  classification: {
    sendMessage: { class: 'primitive', reason: 'message send' },
    sendRichTextMessage: { class: 'primitive', reason: 'type-14 send' },
    sendTyping: { class: 'primitive', reason: 'control op' },
    registerBot: { class: 'infrastructure', reason: 'transport register' },
    getGroupMembers: { class: 'read', reason: 'roster read' },
  },
  baselinePermittedCallers: baseline,
});

describe('egress bypass scan: repository at DEV-01', () => {
  const result = scanEgress({ root: ROOT, ...boundary, srcDir: 'src', egressModules: ['src/egress/'] });

  it('EG-01: every boundary export is classified; message/control writes are guarded primitives', () => {
    expect(result.unclassified).toEqual([]);
    for (const p of ['sendMessage', 'sendTyping', 'sendReadReceipt']) expect(result.primitives, p).toContain(p);
    for (const i of ['registerBot', 'sendHeartbeat', 'getUploadCredentials']) expect(result.primitives, i).not.toContain(i);
  });

  it('EG-02: the observed outbound call sites equal the explicit baseline exactly (no new caller, no stale entry)', () => {
    expect(result.violations).toEqual([]);
    const observed = result.usages.reduce<Record<string, number>>((acc, u: { file: string; symbol: string }) => {
      const k = `${u.file}#${u.symbol}`; acc[k] = (acc[k] ?? 0) + 1; return acc;
    }, {});
    const expected = Object.fromEntries(boundary.baselinePermittedCallers.map((b) => [`${b.file}#${b.symbol}`, b.count]));
    expect(observed).toEqual(expected);
  });

  it('EG-03: the baseline records the R8 §0.3 bypass sites (router replySafe, command/progress/placeholder/error replies, StreamRelay)', () => {
    const files = new Set(boundary.baselinePermittedCallers.map((b) => b.file));
    expect([...files].sort()).toEqual(['src/index.ts', 'src/session-router.ts', 'src/stream-relay.ts']);
    expect(boundary.baselinePermittedCallers.find((b) => b.file === 'src/session-router.ts' && b.symbol === 'sendMessage')?.count).toBe(1);
  });
});

describe('egress bypass scan: negative controls', () => {
  const codes = (name: string, baseline?: Array<{ file: string; symbol: string; count: number }>) =>
    scanEgress(fixtureConfig(name, baseline)).violations.map((v: { code: string; file: string; symbol: string }) => `${v.code}:${v.file}:${v.symbol}`);

  it('EG-04: the clean fixture (egress module only) passes', () => {
    expect(codes('clean')).toEqual([]);
  });
  it('EG-05: an unauthorized sendRichTextMessage call fails', () => {
    expect(codes('richtext')).toContain('unauthorized-call:src/tool.ts:sendRichTextMessage');
  });
  it('EG-06: an aliased import fails', () => {
    expect(codes('alias')).toContain('unauthorized-call:src/handler.ts:sendMessage');
  });
  it('EG-07: a namespace import fails (property and element access)', () => {
    const got = codes('namespace');
    expect(got).toContain('unauthorized-call:src/handler.ts:sendMessage');
    expect(got).toContain('unauthorized-call:src/handler.ts:sendTyping');
  });
  it('EG-08: a named re-export, a star re-export and a caller through the re-export chain all fail', () => {
    const got = codes('reexport');
    expect(got).toContain('unauthorized-reexport:src/barrel.ts:sendMessage');
    expect(got).toContain('unauthorized-reexport:src/star.ts:*');
    expect(got).toContain('unauthorized-call:src/consumer.ts:sendMessage');
  });
  it('EG-09: a dynamic import of the boundary module fails', () => {
    expect(codes('dynamic')).toContain('unauthorized-dynamic-import:src/late.ts:src/octo/api.ts');
  });
  it('EG-10: a new unclassified boundary export is treated as guarded and reported', () => {
    const r = scanEgress(fixtureConfig('unclassified'));
    expect(r.unclassified).toEqual(['sendCard']);
    expect(r.violations.map((v: { code: string; symbol: string }) => `${v.code}:${v.symbol}`)).toContain('unauthorized-call:sendCard');
  });
  it('EG-11: baseline accounting is exact — one extra call over a baselined count fails, a stale baseline entry fails', () => {
    expect(codes('alias', [{ file: 'src/handler.ts', symbol: 'sendMessage', count: 1 }])).toEqual([]);
    expect(codes('alias', [{ file: 'src/handler.ts', symbol: 'sendMessage', count: 2 }])).toContain('stale-baseline:src/handler.ts:sendMessage');
    expect(codes('alias', [])).toContain('unauthorized-call:src/handler.ts:sendMessage');
  });
  it('EG-12: classified infrastructure and reads stay permitted outside egress', () => {
    expect(codes('infra')).toEqual([]);
  });
});

describe('egress bypass scan: namespace destructuring (B-2)', () => {
  type Usage = { file: string; symbol: string; via: string };
  type Violation = { code: string; file: string; symbol: string; observed?: number; baseline?: number };
  const scan = (name: string, baseline?: Array<{ file: string; symbol: string; count: number }>) =>
    scanEgress(fixtureConfig(name, baseline)) as { usages: Usage[]; violations: Violation[] };
  const keyed = (r: { violations: Violation[] }) => r.violations.map((v) => `${v.code}:${v.file}:${v.symbol}`).sort();
  const tally = (r: { usages: Usage[] }) => r.usages.reduce<Record<string, number>>((acc, u) => {
    const k = `${u.file}#${u.symbol}`; acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {});

  it('EG-13: same-name shorthand destructuring of the boundary namespace keeps its origin (variable and parameter patterns)', () => {
    const r = scan('namespace-shorthand');
    expect(keyed(r)).toEqual([
      'unauthorized-call:src/handler.ts:sendMessage',
      'unauthorized-call:src/mixed.ts:sendRichTextMessage',
      'unauthorized-call:src/param.ts:sendTyping',
    ]);
    // One extraction site per binding, exactly like renamed destructuring and `const f = api.f`:
    // the declaration identifier is counted once, later calls through the local are not recounted.
    expect(tally(r)).toEqual({ 'src/handler.ts#sendMessage': 1, 'src/mixed.ts#sendRichTextMessage': 1, 'src/param.ts#sendTyping': 1 });
  });

  it('EG-14: shorthand and renamed destructuring account identically', () => {
    const renamed = scan('namespace-renamed');
    expect(keyed(renamed)).toEqual(['unauthorized-call:src/handler.ts:sendMessage']);
    expect(tally(renamed)).toEqual({ 'src/handler.ts#sendMessage': 1 });
    expect(tally(scan('namespace-shorthand'))['src/handler.ts#sendMessage']).toBe(tally(renamed)['src/handler.ts#sendMessage']);
  });

  it('EG-15: shorthand destructuring baselines exactly — matching count passes, an over-stated count is stale', () => {
    const base = [
      { file: 'src/handler.ts', symbol: 'sendMessage', count: 1 },
      { file: 'src/mixed.ts', symbol: 'sendRichTextMessage', count: 1 },
      { file: 'src/param.ts', symbol: 'sendTyping', count: 1 },
    ];
    expect(keyed(scan('namespace-shorthand', base))).toEqual([]);
    expect(keyed(scan('namespace-shorthand', base.map((b) => (b.file === 'src/handler.ts' ? { ...b, count: 2 } : b)))))
      .toEqual(['stale-baseline:src/handler.ts:sendMessage']);
    expect(keyed(scan('namespace-renamed', [{ file: 'src/handler.ts', symbol: 'sendMessage', count: 1 }]))).toEqual([]);
  });

  it('EG-16: shorthand destructuring of a re-exporting namespace resolves through one- and two-hop alias chains', () => {
    expect(keyed(scan('namespace-chain'))).toEqual([
      'unauthorized-call:src/consumer.ts:sendMessage',
      'unauthorized-call:src/consumer2.ts:sendMessage',
      'unauthorized-reexport:src/barrel.ts:sendMessage',
      'unauthorized-reexport:src/barrel2.ts:sendMessage',
    ]);
  });

  it('EG-17: no false positives — egress module, classified infrastructure/reads, unrelated namespaces and same-named locals', () => {
    const r = scan('namespace-negative');
    expect(r.violations).toEqual([]);
    expect(r.usages).toEqual([]);
  });

  it('EG-18: rest and non-literal computed extraction from the boundary namespace fail closed; literal computed keys resolve', () => {
    const got = keyed(scan('namespace-unresolved'));
    expect(got).toContain('unresolved-boundary-extraction:src/rest.ts:...rest');
    expect(got).toContain('unresolved-boundary-extraction:src/computed.ts:[key]');
    expect(got).toContain('unauthorized-call:src/computed.ts:sendTyping');
    expect(got).toContain('unauthorized-call:src/cast.ts:sendMessage');
  });
});
