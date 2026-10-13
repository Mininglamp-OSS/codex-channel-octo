/**
 * test/milestone-manifest.json is the sole authoritative selection (R8 §10.8/§10.9).
 * The file must be byte-identical to the R8 §10.9 block, every selected ID must
 * bind to a checked-in procedure + evidence oracle, and omitting a mandatory
 * procedure case (the R8 negative fixture: M2-18 or M2-20) must fail the linter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as lintModule from '../../scripts/manifest/lint.mjs';
import { lintManifest, normalizeId } from '../../scripts/manifest/lint.mjs';
import { evaluateMilestone } from '../../scripts/manifest/evaluate.mjs';

const manifestBytes = readFileSync(new URL('../milestone-manifest.json', import.meta.url));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
const catalog = JSON.parse(readFileSync(new URL('../acceptance/case-catalog.json', import.meta.url), 'utf8')) as Catalog;

interface Milestone { requiresGate?: string[]; requiredCases?: string[]; requiredSpikes?: string[]; requiredSuites?: string[]; requiredDiscoveriesConsumed?: string[]; requiredArtifacts?: string[]; dependencyBuilds?: string[]; requiredContractCases?: string[]; requiredOracleCases?: string[] }
interface Manifest { schemaVersion: number; revision: string; file: string; policies: Record<string, string>; M1: Milestone; M2: Milestone; 'M3-dispatch': unknown; 'M3-G6': unknown }
interface Catalog { revision: string; entries: Array<{ id: string; family: string; mandatoryFor: string[]; procedure: string; evidenceOracle: string; source: string }> }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const codes = (issues: Array<{ code: string; id?: string }>) => issues.map((i) => `${i.code}:${i.id ?? ''}`);

describe('milestone manifest: R8 §10.9 bytes', () => {
  it('MM-01: the checked-in manifest is byte-identical to the R8 §10.9 JSON block', () => {
    // sha256 of the R8 §10.9 fenced block content plus its terminating LF.
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe('5e2fe1d44d3aa94f95ca4979066cdf2a3b00bbcc17e8e9a417253717b4efefc8');
    expect(manifest.revision).toBe('R8');
    expect(manifest.file).toBe('test/milestone-manifest.json');
  });

  it('MM-02: the R8 document-QA selection counts hold (38 M1 / 20 M2 cases, 45 M2 contract selections, SB-01..14)', () => {
    expect(manifest.M1.requiredCases).toHaveLength(38);
    expect(manifest.M2.requiredCases).toHaveLength(20);
    expect(manifest.M2.requiredContractCases).toHaveLength(45);
    expect(manifest.M1.requiredContractCases).toEqual(Array.from({ length: 14 }, (_, i) => `SB-${String(i + 1).padStart(2, '0')}`));
    expect(manifest.M2.requiredCases).toContain('M2-18');
    expect(manifest.M2.requiredCases).toContain('M2-20');
  });
});

describe('milestone manifest: linter', () => {
  it('MM-03: the checked-in manifest binds every selected ID to a procedure and evidence oracle', () => {
    expect(lintManifest(manifest, catalog)).toEqual([]);
  });

  it('MM-04: negative fixture — omitting M2-18 fails as an omitted mandatory case', () => {
    const m = clone(manifest);
    m.M2.requiredCases = m.M2.requiredCases!.filter((c) => c !== 'M2-18');
    expect(codes(lintManifest(m, catalog))).toContain('omitted-mandatory-case:M2-18');
  });

  it('MM-05: negative fixture — omitting M2-20 fails as an omitted mandatory case', () => {
    const m = clone(manifest);
    m.M2.requiredCases = m.M2.requiredCases!.filter((c) => c !== 'M2-20');
    expect(codes(lintManifest(m, catalog))).toContain('omitted-mandatory-case:M2-20');
  });

  it('MM-06: negative fixtures — omitted contract/oracle selections (SB-07, OP-05, ORACLE-04) fail', () => {
    const m = clone(manifest);
    m.M1.requiredContractCases = m.M1.requiredContractCases!.filter((c) => c !== 'SB-07');
    m.M2.requiredContractCases = m.M2.requiredContractCases!.filter((c) => c !== 'OP-05');
    m.M2.requiredOracleCases = m.M2.requiredOracleCases!.filter((c) => c !== 'ORACLE-04');
    const got = codes(lintManifest(m, catalog));
    expect(got).toContain('omitted-mandatory-case:SB-07');
    expect(got).toContain('omitted-mandatory-case:OP-05');
    expect(got).toContain('omitted-mandatory-case:ORACLE-04');
  });

  it('MM-07: negative fixtures — unknown, duplicate, non-canonical and unbound IDs fail', () => {
    const m = clone(manifest);
    m.M1.requiredCases!.push('M1-39');
    m.M1.requiredCases!.push('M1-01');
    m.M1.requiredSpikes!.push('SO-3');
    m.M2.requiredContractCases!.push('XX-01');
    const got = codes(lintManifest(m, catalog));
    expect(got).toContain('unknown-id:M1-39');
    expect(got).toContain('duplicate-id:M1-01');
    expect(got).toContain('non-canonical-id:SO-3');
    expect(got).toContain('unknown-family:XX-01');

    const c = clone(catalog);
    c.entries = c.entries.filter((e) => e.id !== 'SO-04');
    expect(codes(lintManifest(manifest, c))).toContain('unbound-case:SO-04');

    const c2 = clone(catalog);
    c2.entries.find((e) => e.id === 'M1-10')!.evidenceOracle = '';
    expect(codes(lintManifest(manifest, c2))).toContain('missing-oracle:M1-10');
  });

  it('MM-08: family aliases normalize to the zero-padded canonical form', () => {
    expect(normalizeId('SO-3')).toBe('SO-03');
    expect(normalizeId('SR-1')).toBe('SR-01');
    expect(normalizeId('SB-14')).toBe('SB-14');
    expect(normalizeId('D1')).toBe('D-01');
    expect(normalizeId('MAN-01')).toBe('MAN-01');
  });
});

describe('milestone manifest: gate evaluator', () => {
  const manifestSha = createHash('sha256').update(manifestBytes).digest('hex');
  const provenance = { manifestSha256: manifestSha, head: 'candidate-head', profile: 'profile-hash' };
  const allItems = (ms: Milestone) => [
    ...(ms.requiresGate ?? []), ...(ms.requiredCases ?? []), ...(ms.requiredSpikes ?? []), ...(ms.requiredSuites ?? []),
    ...(ms.requiredDiscoveriesConsumed ?? []), ...(ms.requiredArtifacts ?? []), ...(ms.dependencyBuilds ?? []),
    ...(ms.requiredContractCases ?? []), ...(ms.requiredOracleCases ?? []),
  ];
  const passAll = (ms: Milestone) => Object.fromEntries(allItems(ms).map((id) => [id, {
    status: 'passed', manifestSha256: manifestSha, head: 'candidate-head', profile: 'profile-hash', source: 'independent-tester',
  }]));

  it('MM-09: passed only when every required item passed on the verified head/profile with independent evidence', () => {
    expect(evaluateMilestone(manifest, 'M1', passAll(manifest.M1), provenance).status).toBe('passed');
  });

  it('MM-10: a single failed item fails; a missing or skipped item is pending (distinct, neither approves)', () => {
    const failed = passAll(manifest.M1); failed['M1-17'] = { ...failed['M1-17'], status: 'failed' };
    expect(evaluateMilestone(manifest, 'M1', failed, provenance).status).toBe('failed');
    const missing = passAll(manifest.M1); delete missing['SR-04'];
    expect(evaluateMilestone(manifest, 'M1', missing, provenance)).toMatchObject({ status: 'pending' });
    const skipped = passAll(manifest.M2); skipped['SO-18'] = { ...skipped['SO-18'], status: 'skipped' };
    expect(evaluateMilestone(manifest, 'M2', skipped, provenance).status).toBe('pending');
  });

  it('MM-11: a pass from another head, another manifest or an implementer-only assertion is not a pass', () => {
    for (const mutate of [
      (e: Record<string, unknown>) => { e.head = 'older-head'; },
      (e: Record<string, unknown>) => { e.manifestSha256 = '0'.repeat(64); },
      (e: Record<string, unknown>) => { e.profile = 'other-profile'; },
      (e: Record<string, unknown>) => { e.source = 'implementer'; },
    ]) {
      const ev = passAll(manifest.M2);
      mutate(ev['REPLAY-01'] as Record<string, unknown>);
      const r = evaluateMilestone(manifest, 'M2', ev, provenance);
      expect(r.status).toBe('pending');
      expect(r.items.find((i: { id: string }) => i.id === 'REPLAY-01')).toMatchObject({ status: 'pending' });
    }
  });

  it('MM-12: with no evidence at all every declared milestone is pending, never passed', () => {
    const declared = Object.keys(manifest).filter((k) => !['schemaVersion', 'revision', 'file', 'policies'].includes(k));
    expect(declared).toEqual(['M1', 'M2', 'M3-dispatch', 'M3-G6']);
    for (const ms of declared) expect(evaluateMilestone(manifest, ms, {}, provenance).status, ms).toBe('pending');
  });
});

describe('milestone manifest: fail-closed evaluation (B-1)', () => {
  it('MM-26: evaluation cannot approve omitted mandatory cases or unbound requirements even with matching passed claims', () => {
    const omitted = clone(manifest);
    omitted.M2.requiredCases = omitted.M2.requiredCases!.filter(id => id !== 'M2-18');
    expect(evalWith(omitted, 'M2', passEverything(omitted)).status).not.toBe('passed');
    const unbound = clone(manifest);
    unbound.M1.requiredArtifacts = [...unbound.M1.requiredArtifacts!, 'unbound-artifact'];
    expect(evalWith(unbound, 'M1', passEverything(unbound)).status).not.toBe('passed');
  });
  const manifestSha = createHash('sha256').update(manifestBytes).digest('hex');
  const provenance = { manifestSha256: manifestSha, head: 'candidate-head', profile: 'profile-hash' };
  const pass = { status: 'passed', manifestSha256: manifestSha, head: 'candidate-head', profile: 'profile-hash', source: 'independent-tester' };
  const STATIC_LISTS = ['requiresGate', 'requiredCases', 'requiredSpikes', 'requiredSuites', 'requiredDiscoveriesConsumed',
    'requiredArtifacts', 'dependencyBuilds', 'requiredContractCases', 'requiredOracleCases'] as const;
  /** Passing evidence for every string ID reachable anywhere in a selection (the most permissive caller). */
  const passEverything = (sel: unknown): Record<string, typeof pass> => {
    const ids = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === 'string') ids.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { ids.add(k); walk(x); }
    };
    walk(sel);
    return Object.fromEntries([...ids].map((id) => [id, { ...pass }]));
  };
  const evalWith = (m: unknown, ms: string, ev: Record<string, unknown> = passAll(manifest.M1), prov: unknown = provenance) =>
    evaluateMilestone(m, ms, ev, prov) as { status: string; reason?: string; items: Array<{ id: string; list: string; status: string; reason: string }> };
  const passAll = (ms: Milestone) => Object.fromEntries(STATIC_LISTS.flatMap((l) => ms[l] ?? []).map((id) => [id, { ...pass }]));

  it('MM-13: unknown, empty and prototype milestone keys fail closed (failed, never passed)', () => {
    for (const key of ['UNKNOWN', '', 'M4', 'm1', 'M3', '__proto__', 'constructor', 'toString', 'policies', 'revision', 'schemaVersion']) {
      const r = evalWith(manifest, key, passEverything(manifest));
      expect(r.status, JSON.stringify(key)).toBe('failed');
      expect(r.reason, JSON.stringify(key)).toBe('unknown-milestone');
    }
  });

  it('MM-14: a missing, null or wrongly typed milestone selection fails closed', () => {
    for (const [name, mutate] of [
      ['missing', (m: Record<string, unknown>) => { delete m.M1; }],
      ['null', (m: Record<string, unknown>) => { m.M1 = null; }],
      ['array', (m: Record<string, unknown>) => { m.M1 = []; }],
      ['string', (m: Record<string, unknown>) => { m.M1 = 'M1-01'; }],
      ['empty object', (m: Record<string, unknown>) => { m.M1 = {}; }],
    ] as const) {
      const m = clone(manifest) as unknown as Record<string, unknown>;
      mutate(m);
      const r = evalWith(m, 'M1');
      expect(r.status, name).not.toBe('passed');
      expect(r.status, name).toBe('failed');
    }
    expect(evalWith({}, 'M1').status).toBe('failed');
    expect(evalWith(null, 'M1').status).toBe('failed');
  });

  it('MM-15: wrongly typed, null, empty or duplicated selection lists and unsupported selection fields fail closed', () => {
    for (const [name, mutate] of [
      ['string list', (s: Record<string, unknown>) => { s.requiredCases = 'M1-01'; }],
      ['null list', (s: Record<string, unknown>) => { s.requiredCases = null; }],
      ['object list', (s: Record<string, unknown>) => { s.requiredCases = { 0: 'M1-01' }; }],
      ['non-string item', (s: Record<string, unknown>) => { (s.requiredCases as unknown[]).push(42); }],
      ['empty-string item', (s: Record<string, unknown>) => { (s.requiredCases as unknown[]).push(''); }],
      ['empty list', (s: Record<string, unknown>) => { s.requiredOracleCases = []; }],
      ['duplicate item', (s: Record<string, unknown>) => { (s.requiredCases as unknown[]).push('M1-01'); }],
      ['missing list', (s: Record<string, unknown>) => { delete s.requiredSuites; }],
      ['unsupported field', (s: Record<string, unknown>) => { s.optionalCases = ['M1-01']; }],
      ['unsupported field (typo)', (s: Record<string, unknown>) => { s.requiredCase = s.requiredCases; delete s.requiredCases; }],
      ['every list emptied', (s: Record<string, unknown>) => { for (const l of STATIC_LISTS) s[l] = []; }],
    ] as const) {
      const m = clone(manifest) as unknown as Record<string, Record<string, unknown>>;
      mutate(m.M1);
      const r = evalWith(m, 'M1', passEverything(m.M1));
      expect(r.status, name).toBe('failed');
      expect(r.reason, name).toBe('invalid-selection');
    }
  });

  it('MM-16: M3-dispatch never auto-approves its conditional requirements — all static items passing is still pending', () => {
    const d = manifest['M3-dispatch'] as { requiresGate: string[]; requiredArtifacts: string[] };
    const r = evalWith(manifest, 'M3-dispatch', passEverything(manifest['M3-dispatch']));
    expect(r.status).toBe('pending');
    for (const id of [...d.requiresGate, ...d.requiredArtifacts]) expect(r.items.find((i) => i.id === id), id).toMatchObject({ status: 'passed' });
    const cond = r.items.filter((i) => i.list === 'conditionalCaseRequirements');
    expect(cond).toHaveLength(1);
    expect(cond[0]).toMatchObject({ status: 'pending' });
    expect(cond[0].reason).toMatch(/item-level selection/);
    // A missing static item stays pending; a failed one fails.
    const missing = passEverything(manifest['M3-dispatch']); delete missing['G2-owner-approved'];
    expect(evalWith(manifest, 'M3-dispatch', missing).status).toBe('pending');
    const failed = passEverything(manifest['M3-dispatch']); failed['M1-G6-passed'] = { ...pass, status: 'failed' };
    expect(evalWith(manifest, 'M3-dispatch', failed).status).toBe('failed');
  });

  it('MM-17: shipped M3-G6 (unselected item-level extension) stays pending; raw caller drop-all claims never approve it', () => {
    const everything = passEverything(manifest);
    const r = evalWith(manifest, 'M3-G6', everything);
    expect(r.status).toBe('pending');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.status !== 'passed')).toBe(true);
    // Unauthenticated caller-supplied dispositions (booleans, implementer claims, look-alike evidence) are ignored.
    for (const [name, ev, prov] of [
      ['evidence boolean', { ...everything, ownerDroppedAllM3Items: true }, provenance],
      ['evidence disposition', { ...everything, 'M3-G6': { ...pass, disposition: 'owner-dropped-all-M3-items' } }, provenance],
      ['implementer disposition', { ...everything, 'owner-drop-all': { ...pass, source: 'implementer', disposition: 'owner-dropped-all-M3-items' } }, provenance],
      ['provenance boolean', everything, { ...provenance, ownerDroppedAllM3Items: true }],
      ['provenance disposition', everything, { ...provenance, ownerDisposition: { decision: 'drop-all-M3-items', milestone: 'M3-G6', manifestSha256: manifestSha, head: 'candidate-head', profile: 'profile-hash' } }],
    ] as const) {
      expect(evalWith(manifest, 'M3-G6', ev as Record<string, unknown>, prov).status, name).toBe('pending');
    }
  });

  it('MM-18: malformed M3 descriptors fail closed instead of evaluating to an empty pass', () => {
    for (const [name, ms, mutate] of [
      ['G6 emptySelection passed', 'M3-G6', (s: Record<string, unknown>) => { s.emptySelection = 'passed'; }],
      ['G6 empty object', 'M3-G6', (s: Record<string, unknown>) => { for (const k of Object.keys(s)) delete s[k]; }],
      ['G6 unsupported field', 'M3-G6', (s: Record<string, unknown>) => { s.requiredCases = []; }],
      ['G6 conditional wrong type', 'M3-G6', (s: Record<string, unknown>) => { s.conditionalRequiredCases = ['RTN-01']; }],
      ['dispatch unsupported field', 'M3-dispatch', (s: Record<string, unknown>) => { s.requiredCases = ['RTN-01']; }],
      ['dispatch conditional not array', 'M3-dispatch', (s: Record<string, unknown>) => { s.conditionalCaseRequirements = {}; }],
      ['dispatch conditional empty', 'M3-dispatch', (s: Record<string, unknown>) => { s.conditionalCaseRequirements = []; }],
      ['dispatch conditional missingEvidence passed', 'M3-dispatch', (s: Record<string, unknown>) => { (s.conditionalCaseRequirements as Array<Record<string, unknown>>)[0].missingEvidence = 'passed'; }],
      ['dispatch conditional unsupported field', 'M3-dispatch', (s: Record<string, unknown>) => { (s.conditionalCaseRequirements as Array<Record<string, unknown>>)[0].autoApprove = true; }],
      ['dispatch gates emptied', 'M3-dispatch', (s: Record<string, unknown>) => { s.requiresGate = []; }],
    ] as const) {
      const m = clone(manifest) as unknown as Record<string, Record<string, unknown>>;
      mutate(m[ms]);
      const r = evalWith(m, ms, passEverything(m));
      expect(r.status, name).toBe('failed');
      expect(r.reason, name).toBe('invalid-selection');
    }
  });

  it('MM-19: missing or empty provenance never matches evidence that also omits it', () => {
    const ev = Object.fromEntries(Object.entries(passAll(manifest.M1)).map(([k]) => [k, { status: 'passed', source: 'independent-tester' }]));
    for (const prov of [{}, { manifestSha256: '', head: '', profile: '' }, null]) {
      expect(evalWith(manifest, 'M1', ev, prov).status, JSON.stringify(prov)).not.toBe('passed');
    }
    expect(evalWith(manifest, 'M1', passAll(manifest.M1), {}).status).not.toBe('passed');
  });

  it('MM-20: evidence lookups are own-property only (prototype names are not evidence)', () => {
    const m = clone(manifest);
    m.M1.requiredSuites = [...m.M1.requiredSuites!.filter((s) => s !== 'real-binary-contracts'), 'constructor'];
    const ev = passAll(manifest.M1);
    const r = evalWith(m, 'M1', Object.assign(Object.create({ constructor: { ...pass } }), ev) as Record<string, unknown>);
    expect(r.items.find((i) => i.id === 'constructor')).toMatchObject({ status: 'pending' });
  });
});

describe('milestone manifest: linter covers every declared milestone (B-1)', () => {
  type Report = { issues: Array<{ code: string; id?: string; where?: string }>; placeholders: Array<{ milestone: string; where: string; id: string; readiness: string }> };
  const report = (m: unknown, c: unknown = catalog): Report => {
    expect(typeof (lintModule as Record<string, unknown>).lintManifestReport, 'lintManifestReport export').toBe('function');
    return (lintModule as unknown as { lintManifestReport: (m: unknown, c: unknown) => Report }).lintManifestReport(m, c);
  };
  const lintCodes = (m: unknown) => codes(lintManifest(m, catalog));

  it('MM-21: the shipped manifest lints clean and reports M3 normative placeholders as not ready (never ready)', () => {
    const r = report(manifest);
    expect(r.issues).toEqual([]);
    expect(lintManifest(manifest, catalog)).toEqual([]);
    const ids = r.placeholders.map((p) => `${p.milestone}:${p.id}`);
    for (const id of ['OD-01-selected-items-recorded', 'item-level-selected-tier-case-manifest-reviewed', 'TST-03-exact-cases-and-evidence-bindings',
      'SP-T1-reviewed-branch-for-DEV14', 'SO-11-consumer-before-DEV12', 'SO-12/13-target-cases-before-DEV13/16',
      'reviewed-NormV1-schema-concrete-mixed-fixture-hashes-and-UTF16-assertions', 'case-catalog-RTN01..08-and-negative-control-specs',
      'candidate-head-server-normalized-readback-and-request-message-capture', 'web-mobile-mention-image-correlation-evidence']) {
      expect(ids, id).toContain(`M3-dispatch:${id}`);
    }
    expect(ids).toContain('M3-G6:selection');
    expect(r.placeholders.every((p) => p.readiness === 'not-ready')).toBe(true);
    // Placeholders are never for M1/M2 (those must bind to the catalog).
    expect(r.placeholders.some((p) => p.milestone === 'M1' || p.milestone === 'M2')).toBe(false);
  });

  it('MM-22: missing, null and wrongly typed milestones are lint issues for all four declared milestones', () => {
    for (const ms of ['M1', 'M2', 'M3-dispatch', 'M3-G6']) {
      const missing = clone(manifest) as unknown as Record<string, unknown>; delete missing[ms];
      expect(lintCodes(missing), ms).toContain(`missing-milestone:${ms}`);
      const nul = clone(manifest) as unknown as Record<string, unknown>; nul[ms] = null;
      expect(lintCodes(nul), ms).toContain(`wrong-type:${ms}`);
      const arr = clone(manifest) as unknown as Record<string, unknown>; arr[ms] = [];
      expect(lintCodes(arr), ms).toContain(`wrong-type:${ms}`);
    }
    const extra = clone(manifest) as unknown as Record<string, unknown>; extra.M4 = { requiredCases: ['M1-01'] };
    expect(lintCodes(extra)).toContain('unknown-milestone:M4');
    const empty = clone(manifest) as unknown as Record<string, unknown>; empty[''] = {};
    expect(lintCodes(empty)).toContain('unknown-milestone:');
  });

  it('MM-23: unsupported fields, wrong list types, empty lists and non-string items fail for static milestones', () => {
    const m = clone(manifest) as unknown as Record<string, Record<string, unknown>>;
    m.M1.optionalCases = ['M1-01'];
    m.M1.requiredSuites = 'unit-baseline-55-1178';
    m.M2.requiredSpikes = [];
    m.M2.requiresGate = [...(m.M2.requiresGate as string[]), 7];
    delete m.M2.dependencyBuilds;
    const got = lintCodes(m);
    expect(got).toContain('unsupported-field:optionalCases');
    expect(got).toContain('wrong-type:requiredSuites');
    expect(got).toContain('empty-list:requiredSpikes');
    expect(got).toContain('wrong-type:7');
    expect(got).toContain('missing-list:dependencyBuilds');
  });

  it('MM-24: M3-dispatch structure — gates/artifacts, conditional cases bound to the catalog, pending-only missing evidence', () => {
    const mut = (f: (d: Record<string, unknown>, c: Record<string, unknown>) => void) => {
      const m = clone(manifest) as unknown as Record<string, Record<string, unknown>>;
      const d = m['M3-dispatch'];
      f(d, (d.conditionalCaseRequirements as Array<Record<string, unknown>>)[0]);
      return lintCodes(m);
    };
    expect(mut((d) => { d.requiredCases = ['RTN-01']; })).toContain('unsupported-field:requiredCases');
    expect(mut((d) => { d.requiresGate = []; })).toContain('empty-list:requiresGate');
    expect(mut((d) => { (d.requiresGate as string[]).push('G2-owner-approved'); })).toContain('duplicate-id:G2-owner-approved');
    expect(mut((d) => { d.requiredArtifacts = null; })).toContain('wrong-type:requiredArtifacts');
    expect(mut((d) => { d.conditionalCaseRequirements = []; })).toContain('empty-list:conditionalCaseRequirements');
    expect(mut((d) => { d.conditionalCaseRequirements = {}; })).toContain('wrong-type:conditionalCaseRequirements');
    expect(mut((_d, c) => { (c.requiredCases as string[]).push('RTN-09'); })).toContain('unknown-id:RTN-09');
    expect(mut((_d, c) => { (c.requiredCases as string[])[0] = 'RTN-1'; })).toContain('non-canonical-id:RTN-1');
    expect(mut((_d, c) => { (c.requiredCases as string[]).push('XX-01'); })).toContain('unknown-family:XX-01');
    expect(mut((_d, c) => { c.requiredCases = (c.requiredCases as string[]).filter((x) => x !== 'RTN-08'); })).toContain('omitted-mandatory-case:RTN-08');
    expect(mut((_d, c) => { c.missingEvidence = 'passed'; })).toContain('unsupported-missing-evidence-policy:passed');
    expect(mut((_d, c) => { c.autoApprove = true; })).toContain('unsupported-field:autoApprove');
    expect(mut((_d, c) => { c.whenAnySelected = []; })).toContain('empty-list:whenAnySelected');
    expect(mut((_d, c) => { c.profile = ''; })).toContain('wrong-type:profile');
    expect(mut((_d, c) => { delete c.requiredCases; })).toContain('missing-list:requiredCases');

    const cat = clone(catalog);
    cat.entries.find((e) => e.id === 'RTN-03')!.procedure = '';
    expect(codes(lintManifest(manifest, cat))).toContain('missing-oracle:RTN-03');
    const cat2 = clone(catalog);
    cat2.entries = cat2.entries.filter((e) => e.id !== 'RTN-05');
    expect(codes(lintManifest(manifest, cat2))).toContain('unbound-case:RTN-05');
    // Gates that the catalog does bind keep their oracle requirement.
    const cat3 = clone(catalog);
    cat3.entries.find((e) => e.id === 'M1-G6-passed')!.evidenceOracle = '';
    expect(codes(lintManifest(manifest, cat3))).toContain('missing-oracle:M1-G6-passed');
  });

  it('MM-25: M3-G6 structure — selection descriptor, pending-only empty selection, conditional cases consistent with M3-dispatch', () => {
    const mut = (f: (g: Record<string, unknown>) => void) => {
      const m = clone(manifest) as unknown as Record<string, Record<string, unknown>>;
      f(m['M3-G6']);
      return lintCodes(m);
    };
    expect(mut((g) => { g.emptySelection = 'passed'; })).toContain('unsupported-empty-selection-policy:passed');
    expect(mut((g) => { delete g.emptySelection; })).toContain('missing-field:emptySelection');
    expect(mut((g) => { g.selection = ''; })).toContain('wrong-type:selection');
    expect(mut((g) => { g.selection = ['RTN-01']; })).toContain('wrong-type:selection');
    expect(mut((g) => { g.requiredCases = ['RTN-01']; })).toContain('unsupported-field:requiredCases');
    expect(mut((g) => { g.conditionalRequiredCases = ['RTN-01']; })).toContain('wrong-type:conditionalRequiredCases');
    expect(mut((g) => { g.conditionalRequiredCases = {}; })).toContain('empty-list:conditionalRequiredCases');
    expect(mut((g) => { (g.conditionalRequiredCases as Record<string, string[]>)['EP-05/O13.RichText'].push('RTN-09'); })).toContain('unknown-id:RTN-09');
    expect(mut((g) => { (g.conditionalRequiredCases as Record<string, string[]>)['EP-05/O13.RichText'].pop(); })).toContain('conditional-mismatch:EP-05/O13.RichText');
    expect(mut((g) => { (g.conditionalRequiredCases as Record<string, string[]>)['EP-99'] = ['RTN-01']; })).toContain('conditional-mismatch:EP-99');
  });
});
