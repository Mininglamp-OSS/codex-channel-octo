/**
 * Runner output contract (R8 §10.1): every runner emits JSON and JUnit records
 * {caseId,pin,head,environment,preconditions,steps,expected,actual,start,end,
 * status,evidencePaths}. Skipped and todo cases are pending, never passed.
 */
import { describe, it, expect } from 'vitest';
import { buildCaseRecords, toJUnit, CASE_RECORD_FIELDS } from './report/case-records.js';

const task = (name: string, state: string | undefined, mode = 'run', meta: Record<string, unknown> = {}) => ({
  type: 'test', name, mode, meta, file: { name: 'test/x.test.ts' },
  suite: { name: 'suite', suite: undefined },
  result: state === undefined ? undefined : { state, startTime: 1_000, duration: 25, errors: state === 'fail' ? [{ message: 'boom <&>' }] : [] },
});

describe('case records', () => {
  const ctx = {
    runner: 'unit', pins: { A: 'a', B: 'b', OC: 'oc', codex: '0.142.3', croner: '10.0.1' }, head: 'h1+dirty',
    environment: { node: 'v24', platform: 'darwin', arch: 'arm64' },
    catalog: { 'SB-08': { preconditions: ['hung mock turn'], steps: ['turn/interrupt'], expected: '{} within 2 s, interrupted within 5 s' } },
  };
  const records = buildCaseRecords([
    task('SB-08: interrupt', 'pass', 'run', { actual: { responseMs: 12 }, evidencePaths: ['test/evidence/x.jsonl'] }),
    task('plain title', 'fail'),
    task('SB-02b: runtime lane', undefined, 'todo'),
    task('skipped one', 'skip', 'skip'),
  ] as never, ctx);

  it('CR-01: every record carries every R8 §10.1 field', () => {
    expect(CASE_RECORD_FIELDS).toEqual(['caseId', 'pin', 'head', 'environment', 'preconditions', 'steps', 'expected', 'actual', 'start', 'end', 'status', 'evidencePaths']);
    for (const r of records) for (const f of CASE_RECORD_FIELDS) expect(r, f).toHaveProperty(f);
  });

  it('CR-02: case IDs come from the title prefix, else file#full-title; catalog metadata and test meta are merged', () => {
    expect(records[0]).toMatchObject({
      caseId: 'SB-08', status: 'passed', head: 'h1+dirty', pin: ctx.pins,
      preconditions: ['hung mock turn'], steps: ['turn/interrupt'], actual: { responseMs: 12 }, evidencePaths: ['test/evidence/x.jsonl'],
    });
    expect(records[0].start).toBe(new Date(1_000).toISOString());
    expect(records[0].end).toBe(new Date(1_025).toISOString());
    expect(records[1].caseId).toBe('test/x.test.ts#suite > plain title');
  });

  it('CR-03: failures are failed; todo and skipped are pending — never passed', () => {
    expect(records.map((r) => r.status)).toEqual(['passed', 'failed', 'pending', 'pending']);
    expect(records[1].actual).toMatchObject({ errors: ['boom <&>'] });
  });

  it('CR-04: JUnit output escapes XML, marks failures and skipped, and embeds the record as properties', () => {
    const xml = toJUnit(records, 'unit');
    expect(xml).toContain('<testsuite name="unit" tests="4" failures="1" skipped="2"');
    expect(xml).toContain('boom &lt;&amp;&gt;');
    expect(xml).toContain('<property name="caseId" value="SB-08"/>');
    expect((xml.match(/<skipped/g) ?? []).length).toBe(2);
  });
});
