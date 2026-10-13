/**
 * test/milestone-manifest.json is the sole authoritative selection (R8 §10.8/§10.9).
 * The file must be byte-identical to the R8 §10.9 block, every selected ID must
 * bind to a checked-in procedure + evidence oracle, and omitting a mandatory
 * procedure case (the R8 negative fixture: M2-18 or M2-20) must fail the linter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  it('MM-12: with no evidence at all every milestone is pending, never passed', () => {
    for (const ms of ['M1', 'M2'] as const) expect(evaluateMilestone(manifest, ms, {}, provenance).status).toBe('pending');
  });
});
