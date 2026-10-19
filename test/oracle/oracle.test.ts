/**
 * Independent all-attempt/all-segment delivery oracle (R8 §10.10, IR5-B4).
 * ORACLE-01..08 are frozen synthetic traces; every defect fixture carries a
 * control trace without the injected defect, and the control must pass, so a
 * vacuous oracle cannot satisfy these cases.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { evaluateDelivery, parseMarker, formatMarker } from './oracle.mjs';

interface OracleFixture {
  id: string;
  description: string;
  expectedVerdict: 'pass' | 'fail' | 'unknown' | 'pending';
  expectedViolations: string[];
  expectedCounts?: Record<string, number>;
  trace: unknown;
  ledger?: unknown;
  controlLedger?: unknown;
  controlTrace?: unknown;
  variants?: Array<{ name: string; expectedVerdict: string; expectedViolations: string[]; trace: unknown; ledger?: unknown }>;
}

const ledgers = JSON.parse(readFileSync(new URL('./capture-ledgers-v1.json', import.meta.url), 'utf8')).fixtures;
const dir = new URL('./fixtures/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => /^ORACLE-\d\d\.json$/.test(f)).sort()
  .map((f) => {
    const fixture = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as OracleFixture;
    return { ...fixture, ledger: ledgers[fixture.id].trace, controlLedger: ledgers[fixture.id].controlTrace,
      variants: fixture.variants?.map(v => ({ ...v, ledger: ledgers[fixture.id][v.name] })) };
  });

describe('oracle spec', () => {
  it('ORACLE-SPEC: the frozen spec matches the manifest policy path and fixture set', () => {
    const spec = JSON.parse(readFileSync(new URL('./independent-delivery-v1.json', import.meta.url), 'utf8')) as {
      version: string; captureRecordFields: string[]; inventoryRecordFields: string[]; fixtures: string[];
    };
    expect(spec.version).toBe('independent-delivery-v1');
    expect(spec.captureRecordFields).toEqual([
      'fixture', 'logicalIdentity', 'kind', 'occurrence', 'run', 'ordinal', 'index', 'count', 'senderUid', 'target',
      'requestOrdinal', 'requestAt', 'requestBodyHash', 'serverNormalizedPayloadHash', 'normalizationFixtureVersion',
      'clientMsgNo', 'httpStatus', 'responseMessageId', 'responseAt', 'transportOutcome',
    ]);
    expect(spec.inventoryRecordFields).toEqual([
      'messageId', 'channelId', 'channelType', 'senderUid', 'serverTimestamp', 'fixtureMarker', 'payloadHash',
      'serverNormalizedPayloadHash', 'normalizationFixtureVersion',
    ]);
    expect(fixtures.map((f) => f.id)).toEqual(spec.fixtures);
    expect(spec.fixtures).toEqual(Array.from({ length: 8 }, (_, i) => `ORACLE-0${i + 1}`));
  });

  it('ORACLE-MARKER: fixed-width markers round-trip and reject malformed or non-fixed-width forms', () => {
    const m = formatMarker({ fixture: 'fx7', occurrence: 'oc7', run: 'run7', kind: 'cron.result', ordinal: 0, index: 2, count: 3 });
    expect(m).toBe('[DLY f=fx7 o=oc7 r=run7 k=cron.result m=000000 s=000002/000003]');
    expect(parseMarker(`${m}\nbody`)).toEqual({ fixture: 'fx7', occurrence: 'oc7', run: 'run7', kind: 'cron.result', ordinal: 0, index: 2, count: 3 });
    expect(parseMarker('[DLY f=fx7 o=oc7 r=run7 k=cron.result m=0 s=2/3]')).toBeNull();
    expect(parseMarker('no marker')).toBeNull();
  });
});

describe('ORACLE-01..08 frozen traces', () => {
  it.each(fixtures.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    const report = evaluateDelivery(f.trace, f.ledger);
    expect(report.verdict, f.description).toBe(f.expectedVerdict);
    expect(report.violations.map((v: { code: string }) => v.code).sort()).toEqual([...f.expectedViolations].sort());
    if (f.expectedCounts) expect(report.counts).toMatchObject(f.expectedCounts);
    for (const v of f.variants ?? []) {
      const r = evaluateDelivery(v.trace, v.ledger);
      expect(r.verdict, `${f.id}/${v.name}`).toBe(v.expectedVerdict);
      expect(r.violations.map((x: { code: string }) => x.code).sort(), `${f.id}/${v.name}`).toEqual([...v.expectedViolations].sort());
    }
  });

  it('ORACLE-NEG: every failing or pending fixture has a defect-free control trace that passes', () => {
    const defective = fixtures.filter((f) => f.expectedVerdict === 'fail' || f.expectedVerdict === 'pending');
    expect(defective.map((f) => f.id)).toEqual(['ORACLE-02', 'ORACLE-03', 'ORACLE-05', 'ORACLE-07', 'ORACLE-08']);
    for (const f of defective) {
      expect(f.controlTrace, f.id).toBeDefined();
      const r = evaluateDelivery(f.controlTrace, f.controlLedger);
      expect(r.verdict, `${f.id} control`).toBe('pass');
      expect(r.violations, `${f.id} control`).toEqual([]);
    }
  });

  it('ORACLE-HOST: host receipts never select expectations — a host "delivered" claim cannot hide a missing segment', () => {
    const f = fixtures.find((x) => x.id === 'ORACLE-01')!;
    const trace = JSON.parse(JSON.stringify(f.trace)) as { inventory: { pages: Array<{ records: unknown[] }> }; hostReceipts?: unknown[] };
    trace.inventory.pages[0].records.pop();
    trace.hostReceipts = [{ state: 'delivered', segmentsSent: 3 }];
    const r = evaluateDelivery(trace, f.ledger);
    expect(r.verdict).toBe('fail');
    expect(r.violations.map((v: { code: string }) => v.code)).toContain('missing-confirmed-segment');
  });
  it('ORACLE-RC-CURSOR: repeated cursors and cycles remain incomplete even with distinct complete records', () => {
    const f = fixtures.find(x => x.id === 'ORACLE-01')!;
    const original = structuredClone(f.trace) as {inventory:{pages:Array<{cursor:string;next:string|null;records:unknown[]}>;declaredPageCount:number}};
    expect(evaluateDelivery(original, f.ledger).verdict).toBe('pass');
    const records = original.inventory.pages.flatMap(p => p.records);
    for (const cursors of [['c0','c0'], ['c0','c1','c0']]) {
      const trace = structuredClone(original);
      trace.inventory.pages = cursors.map((cursor,i) => ({cursor,next:cursors[i+1]??null,records:records.filter((_,j)=>j%cursors.length===i)}));
      trace.inventory.declaredPageCount = cursors.length;
      const r = evaluateDelivery(trace, f.ledger);
      expect(r.verdict).toBe('pending');
      expect(r.violations.map(v=>v.code)).toContain('incomplete-inventory');
    }
  });
  it.each(['confirmed', 'suppressed', 'unknown'])('ORACLE-RC-EXPECTED: duplicate identity with outcome %s is malformed', outcome => {
    const f = fixtures.find(x => x.id === 'ORACLE-01')!;
    const trace = structuredClone(f.trace) as {expected:Array<{outcome:string}>};
    trace.expected.push({...trace.expected[0], outcome});
    const r = evaluateDelivery(trace, f.ledger);
    expect(r.verdict).toBe('fail');
    expect(r.violations.map(v=>v.code)).toContain('malformed-duplicate-expected-identity');
  });

});
