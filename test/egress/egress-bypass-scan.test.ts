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
  analysisBudget: { cuts: number; reachCuts: number };
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
    expect(result.cuts).toBeLessThanOrEqual(boundary.analysisBudget.cuts);
    expect(result.reachCuts).toBeLessThanOrEqual(boundary.analysisBudget.reachCuts);
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

describe('egress bypass scan: namespace origin tracking (B-2 review repair)', () => {
  type Usage = { file: string; symbol: string; via: string };
  type Violation = { code: string; file: string; symbol: string; observed?: number; baseline?: number };
  const scan = (name: string, baseline?: Array<{ file: string; symbol: string; count: number }>) =>
    scanEgress(fixtureConfig(name, baseline)) as { usages: Usage[]; violations: Violation[] };
  const keyed = (r: { violations: Violation[] }) => r.violations.map((v) => `${v.code}:${v.file}:${v.symbol}`).sort();
  const tally = (r: { usages: Usage[] }) => r.usages.reduce<Record<string, number>>((acc, u) => {
    const k = `${u.file}#${u.symbol}`; acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {});
  // One extraction site per reference; calls through the extracted local are not recounted.
  const originTally = {
    'src/assigned-variants.ts#sendMessage': 1,
    'src/assigned-variants.ts#sendRichTextMessage': 1,
    'src/assigned-variants.ts#sendTyping': 1,
    'src/assigned.ts#sendMessage': 1,
    'src/chain.ts#sendMessage': 1,
    'src/conditional.ts#sendTyping': 1,
    'src/constkey-variants.ts#sendRichTextMessage': 1,
    'src/constkey-variants.ts#sendTyping': 2,
    'src/constkey.ts#sendMessage': 1,
    'src/cycle.ts#sendTyping': 1,
    'src/nested-deep.ts#sendTyping': 1,
    'src/nested-param.ts#sendTyping': 1,
    'src/nested.ts#sendMessage': 1,
    'src/object-spread.ts#sendTyping': 1,
  };
  const originBaseline = Object.entries(originTally).map(([k, count]) => {
    const [file, symbol] = k.split('#');
    return { file, symbol, count };
  });

  it('EG-19: nested destructuring of an object holding the namespace keeps its origin', () => {
    const r = scan('namespace-origin');
    expect(keyed(r)).toContain('unauthorized-call:src/nested.ts:sendMessage');
    expect(tally(r)['src/nested.ts#sendMessage']).toBe(1);
    expect(tally(r)['src/nested-deep.ts#sendTyping']).toBe(1);
    expect(tally(r)['src/nested-param.ts#sendTyping']).toBe(1);
  });

  it('EG-20: constant computed keys resolve on the namespace (as const, const aliases, assertions, computed destructuring)', () => {
    const r = scan('namespace-origin');
    expect(keyed(r)).toContain('unauthorized-call:src/constkey.ts:sendMessage');
    expect(tally(r)['src/constkey.ts#sendMessage']).toBe(1);
    expect(tally(r)['src/constkey-variants.ts#sendTyping']).toBe(2);
    expect(tally(r)['src/constkey-variants.ts#sendRichTextMessage']).toBe(1);
    expect(keyed(r).filter((k) => k.startsWith('unresolved-boundary-extraction'))).toEqual([]);
  });

  it('EG-21: an assigned erased alias keeps its origin through assignments, assertions, spreads, conditionals and cycles', () => {
    const r = scan('namespace-origin');
    expect(keyed(r)).toContain('unauthorized-call:src/assigned.ts:sendMessage');
    expect(tally(r)['src/assigned.ts#sendMessage']).toBe(1);
    for (const k of ['src/assigned-variants.ts#sendMessage', 'src/assigned-variants.ts#sendRichTextMessage',
      'src/cycle.ts#sendTyping', 'src/object-spread.ts#sendTyping', 'src/conditional.ts#sendTyping', 'src/chain.ts#sendMessage']) {
      expect(tally(r)[k], k).toBe(1);
    }
  });

  it('EG-22: origin-tracked extraction counts exactly once and baselines exactly', () => {
    const r = scan('namespace-origin');
    expect(tally(r)).toEqual(originTally);
    expect(keyed(r)).toEqual(Object.keys(originTally).map((k) => `unauthorized-call:${k.replace('#', ':')}`).sort());
    expect(keyed(scan('namespace-origin', originBaseline))).toEqual([]);
    expect(keyed(scan('namespace-origin', originBaseline.map((b) => (b.file === 'src/nested.ts' ? { ...b, count: 2 } : b)))))
      .toEqual(['stale-baseline:src/nested.ts:sendMessage']);
    expect(keyed(scan('namespace-origin', originBaseline.map((b) => (b.file === 'src/constkey-variants.ts' && b.symbol === 'sendTyping' ? { ...b, count: 1 } : b)))))
      .toEqual(['unauthorized-call:src/constkey-variants.ts:sendTyping']);
  });

  it('EG-23: unresolved keys and untracked stores of a guarded namespace fail closed', () => {
    const r = scan('namespace-origin-unresolved');
    expect(keyed(r)).toEqual([
      'unresolved-boundary-extraction:src/dynamic-key.ts:[pick]',
      'unresolved-boundary-extraction:src/erased-dynamic.ts:[pick2]',
      'unresolved-boundary-extraction:src/erased-dynamic.ts:[pick2]',
      "unresolved-boundary-extraction:src/escape.ts:Reflect.get(api, 'sendTyping')",
      'unresolved-boundary-extraction:src/escape.ts:holder.ns = api',
      'unresolved-boundary-extraction:src/escape2.ts:[api]',
      'unresolved-boundary-extraction:src/escape2.ts:{ sendTyping: sm } = api',
      "unresolved-boundary-extraction:src/let-key.ts:[lk as 'registerBot']",
      // The typed array element still resolves through the checker as one extraction.
      'unauthorized-call:src/escape2.ts:sendMessage',
    ].sort());
    expect(tally(r)).toEqual({ 'src/escape2.ts#sendMessage': 1 });
  });

  it('EG-24: namespace re-exports are reported and their erased aliases keep origin', () => {
    expect(keyed(scan('namespace-origin-reexport'))).toEqual([
      'unauthorized-call:src/consumer-local.ts:sendTyping',
      'unauthorized-call:src/consumer-ns.ts:sendMessage',
      'unauthorized-reexport:src/barrel-local.ts:apiNs',
      'unauthorized-reexport:src/barrel-ns.ts:* as ns',
    ]);
  });

  it('EG-25: no false positives — classified helpers/reads, unrelated namespaces, locals and the egress module', () => {
    const r = scan('namespace-origin-negative');
    expect(r.violations).toEqual([]);
    expect(r.usages).toEqual([]);
  });

  it('EG-26: direct namespace property and literal element access still count once each', () => {
    expect(tally(scan('namespace'))).toEqual({ 'src/handler.ts#sendMessage': 1, 'src/handler.ts#sendTyping': 1 });
  });

  it('EG-27: cyclic object spreads terminate and retain reachable boundary properties', () => {
    const r = scan('namespace-origin-cycle');
    expect(tally(r)).toEqual({ 'src/handler.ts#sendMessage': 1 });
    expect(keyed(r)).toEqual(['unauthorized-call:src/handler.ts:sendMessage']);
  });

  it('EG-28: cyclic unrelated object spreads terminate without boundary violations', () => {
    const r = scan('namespace-origin-cycle-negative');
    expect(r.usages).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  it('EG-29: a namespace exported through an erased local preserves its boundary origin', () => {
    expect(keyed(scan('namespace-origin-erased-export'))).toEqual([
      'unauthorized-call:src/consumer.ts:sendMessage',
      'unauthorized-reexport:src/barrel.ts:alias',
    ]);
  });

  it('EG-30: shorthand object properties retain an erased namespace origin', () => {
    const r = scan('namespace-origin-shorthand');
    expect(tally(r)).toEqual({ 'src/handler.ts#sendMessage': 1 });
    expect(keyed(r)).toEqual(['unauthorized-call:src/handler.ts:sendMessage']);
  });
});

describe('egress bypass scan: namespaces nested in checker types (B-2 deep repair)', () => {
  type Usage = { file: string; symbol: string; via: string };
  type Violation = { code: string; file: string; symbol: string; observed?: number; baseline?: number };
  const scan = (name: string, baseline?: Array<{ file: string; symbol: string; count: number }>) =>
    scanEgress(fixtureConfig(name, baseline)) as { usages: Usage[]; violations: Violation[] };
  const keyed = (r: { violations: Violation[] }) => r.violations.map((v) => `${v.code}:${v.file}:${v.symbol}`).sort();
  const inFile = (r: { violations: Violation[] }, file: string) => keyed(r).filter((k) => k.split(':')[1] === file);
  const tally = (r: { usages: Usage[] }) => r.usages.reduce<Record<string, number>>((acc, u) => {
    const k = `${u.file}#${u.symbol}`; acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {});
  const unresolved = (file: string, symbols: string[]) => symbols.map((s) => `unresolved-boundary-extraction:${file}:${s}`).sort();
  // Literal extraction through nested property, array element, index signature and asserted types.
  const literalTally = {
    'src/literal.ts#sendMessage': 2,
    'src/literal.ts#sendRichTextMessage': 1,
    'src/literal.ts#sendTyping': 2,
  };
  const literalBaseline = Object.entries(literalTally).map(([k, count]) => {
    const [file, symbol] = k.split('#');
    return { file, symbol, count };
  });
  const deepUnresolved = [
    ...unresolved('src/repro-index.ts', ['[key]']),
    ...unresolved('src/repro-rest.ts', ['...rest']),
    ...unresolved('src/deep-wrapper.ts', ['[k1]', '[k2]']),
    ...unresolved('src/array-wrapper.ts', ['[k1]', '[k2]', '[k3]']),
    ...unresolved('src/index-signature.ts', ['[k1]', '[k2]', '[k3]', '[k4]']),
    ...unresolved('src/recursive.ts', ['[k1]', '[k2]', '[k3]', '[k4]']),
    ...unresolved('src/rest-variants.ts', ['...rp', '...rn', '...rd']),
    ...unresolved('src/dynamic.ts', ['Reflect.get(x, key)', '[k as keyof typeof x]']),
  ];

  it('EG-31: the review repro sources (dynamic key and rest over an asserted wrapper of a namespace) fail closed', () => {
    const r = scan('namespace-origin-deep');
    expect(inFile(r, 'src/repro-index.ts')).toEqual(['unresolved-boundary-extraction:src/repro-index.ts:[key]']);
    expect(inFile(r, 'src/repro-rest.ts')).toEqual(['unresolved-boundary-extraction:src/repro-rest.ts:...rest']);
  });

  it('EG-32: deeper contextual wrappers, arrays, tuples, index signatures, recursive, mutual and generic types fail closed', () => {
    const r = scan('namespace-origin-deep');
    expect(inFile(r, 'src/deep-wrapper.ts')).toEqual(unresolved('src/deep-wrapper.ts', ['[k1]', '[k2]']));
    expect(inFile(r, 'src/array-wrapper.ts')).toEqual(unresolved('src/array-wrapper.ts', ['[k1]', '[k2]', '[k3]']));
    expect(inFile(r, 'src/index-signature.ts')).toEqual(unresolved('src/index-signature.ts', ['[k1]', '[k2]', '[k3]', '[k4]']));
    expect(inFile(r, 'src/recursive.ts')).toEqual(unresolved('src/recursive.ts', ['[k1]', '[k2]', '[k3]', '[k4]']));
  });

  it('EG-33: rest bindings and dynamic reads of a nested namespace wrapper fail closed', () => {
    const r = scan('namespace-origin-deep');
    expect(inFile(r, 'src/rest-variants.ts')).toEqual(unresolved('src/rest-variants.ts', ['...rp', '...rn', '...rd']));
    expect(inFile(r, 'src/dynamic.ts')).toEqual(unresolved('src/dynamic.ts', ['Reflect.get(x, key)', '[k as keyof typeof x]']));
  });

  it('EG-34: literal extraction through nested checker types counts exactly once and baselines exactly', () => {
    const r = scan('namespace-origin-deep');
    expect(tally(r)).toEqual(literalTally);
    expect(inFile(r, 'src/literal.ts')).toEqual(Object.keys(literalTally).map((k) => `unauthorized-call:${k.replace('#', ':')}`).sort());
    expect(keyed(scan('namespace-origin-deep', literalBaseline))).toEqual(deepUnresolved.slice().sort());
    expect(keyed(scan('namespace-origin-deep', literalBaseline.map((b) => (b.symbol === 'sendRichTextMessage' ? { ...b, count: 2 } : b)))))
      .toEqual([...deepUnresolved, 'stale-baseline:src/literal.ts:sendRichTextMessage'].sort());
    expect(keyed(scan('namespace-origin-deep', literalBaseline.map((b) => (b.symbol === 'sendTyping' ? { ...b, count: 1 } : b)))))
      .toEqual([...deepUnresolved, 'unauthorized-call:src/literal.ts:sendTyping'].sort());
  });

  it('EG-35: the deep fixture reports exactly the expected findings and nothing else', () => {
    const r = scan('namespace-origin-deep');
    expect(keyed(r)).toEqual([...deepUnresolved,
      ...Object.keys(literalTally).map((k) => `unauthorized-call:${k.replace('#', ':')}`)].sort());
  });

  it('EG-36: no false positives — classified helpers/reads, unrelated recursive types, locals, lib types and the egress module', () => {
    const r = scan('namespace-origin-deep-negative');
    expect(r.violations).toEqual([]);
    expect(r.usages).toEqual([]);
  });

  it('EG-37: a namespace introduced after several generic layers still fails closed', () => {
    expect(keyed(scan('namespace-origin-late'))).toEqual([
      'unresolved-boundary-extraction:src/handler.ts:...rest',
      'unresolved-boundary-extraction:src/handler.ts:...rest',
    ]);
  });

  it('EG-38: late mapped helper selections do not reintroduce excluded boundary writes', () => {
    const r = scan('namespace-origin-late-negative');
    expect(r.usages).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  it('EG-39: an imported ambient wrapper retains nested namespace origins', () => {
    expect(keyed(scan('namespace-origin-ambient'))).toEqual(['unresolved-boundary-extraction:src/handler.ts:[key]']);
  });
});
