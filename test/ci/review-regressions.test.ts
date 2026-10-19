import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beginVectors, assertPureVectors } from '../../scripts/goldens/stub-purity.mjs';
import { mutationKilled, selectMutations } from '../../scripts/ci/mutation-check.mjs';
import { runParityGate } from '../../scripts/ci/parity-matrix-gate.mjs';
import { buildTestIndex, validateMatrix, verifyAgainstJUnit } from '../../scripts/parity/validate-matrix.mjs';
import { checkSrcDiff } from '../../scripts/ci/check-src-diff.mjs';
import { semanticInventory } from '../../scripts/downgrade/harness.mjs';
import { evaluateMilestone } from '../../scripts/manifest/evaluate.mjs';
import { evaluateDelivery } from '../oracle/oracle.mjs';
import { JsonlRpcClient } from '../harness/jsonl-client.js';
import CaseReporter from '../harness/report/case-reporter.js';
import { parseTestHookEnv } from '../hooks/test-hooks.js';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'dev01-review-')); roots.push(p); return p; };
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HEAD = 'a'.repeat(40);
const row = { id: 'T1', kind: 'capability', executionStatus: 'passed', implementationStatus: 'implemented', tests: ['test/x.test.ts#suite > check'], evidence: 'receipt.json', profile: 'p' };
const index = new Map([[row.tests[0], { mode: 'run' }]]);
const xml = (body: string, name = 'suite &gt; check') => `<testcase classname="test/x.test.ts" name="${name}">${body}</testcase>`;

describe('review gate integrity', () => {
  it('RC-G1: vector reset preserves the array aliased by generated stubs; a later call fails purity', () => {
    const calls = ['module-init'];
    const state = { __ocStubCalls: calls };
    const stub = new Proxy(() => undefined, { apply: () => { calls.push('stub-called'); } });
    expect(beginVectors(state)).toEqual(['module-init']);
    expect(assertPureVectors(state)).toBe(0);
    stub();
    expect(() => assertPureVectors(state)).toThrow(/stubbed host package invoked/);
  });
  it('RC-G2: unknown mutations fail before running, and environment failures cannot kill a mutant', () => {
    expect(() => selectMutations(['M99-typo'])).toThrow(/unknown mutation/);
    expect(selectMutations([])).toHaveLength(12);
    const run = { exit: 1, signal: null, loadErrors: [], cases: [{ status: 'failed', failure: 'Error: ENOENT: missing file' }] };
    expect(mutationKilled(run)).toBe(false);
    expect(mutationKilled({ ...run, cases: [{ status: 'failed', failure: 'AssertionError: expected true to be false' }] })).toBe(true);
  });
  it.each([null, 1])('RC-G3: stale JUnit is removed and unsuccessful child status %s cannot approve', status => {
    const out = temp();
    writeFileSync(join(out, 'parity-matrix.junit.xml'), '<stale/>');
    const result = runParityGate({ root: ROOT, reportDir: out, sourceState: { head: HEAD } as never, spawn: (() => ({ status, signal: status === null ? 'SIGKILL' : null })) as never });
    expect(result.exitStatus).toBe(1);
    expect(result.passedClaimsAgainstFreshJUnit.issues.some(x => x.code === 'fresh-junit-missing')).toBe(true);
    expect(existsSync(join(out, 'parity-matrix.junit.xml'))).toBe(false);
  });
  it('RC-G4: a signal after partial JUnit flush still fails', () => {
    const out = temp();
    const result = runParityGate({ root: ROOT, reportDir: out, sourceState: { head: HEAD } as never,
      spawn: (() => { writeFileSync(join(out, 'parity-matrix.junit.xml'), '<testsuites/>'); return { status: null, signal: 'SIGKILL' }; }) as never });
    expect(result.unitRun.exitStatus).toBe(1);
    expect(result.exitStatus).toBe(1);
  });
  it('RC-G5: duplicate JUnit names aggregate failure/skip regardless of ordering or input file', () => {
    for (const bodies of [['<failure/>', ''], ['', '<failure/>'], ['<skipped/>', '']]) {
      expect(verifyAgainstJUnit({ rows: [row] }, bodies.map(b => xml(b))).issues).toHaveLength(1);
    }
    expect(verifyAgainstJUnit({ rows: [row] }, [xml('')]).issues).toEqual([]);
  });
  it('RC-G6: parameterized references require observed expansions and every expansion passing', () => {
    const m = { rows: [{ ...row, tests: ['test/x.test.ts#suite > GOC-01 $id'] }] };
    expect(verifyAgainstJUnit(m, [xml('', 'suite &gt; GOC-01 london'), xml('', 'suite &gt; GOC-01 ny')]).issues).toEqual([]);
    expect(verifyAgainstJUnit(m, [xml('<failure/>', 'suite &gt; GOC-01 ny')]).issues).toHaveLength(1);
    expect(verifyAgainstJUnit(m, []).issues).toHaveLength(1);
  });
  it('RC-G7: JUnit claims must match a clean verified head', () => {
    const good = xml(`<property name="head" value="${HEAD}"/>`);
    expect(verifyAgainstJUnit({ rows: [row] }, [good], { head: HEAD }).issues).toEqual([]);
    expect(verifyAgainstJUnit({ rows: [row] }, [good], { head: HEAD+'+dirty' }).issues).toHaveLength(1);
    expect(verifyAgainstJUnit({ rows: [row] }, [xml('')], { head: HEAD }).issues).toHaveLength(1);
  });
  it('RC-G8: skip, inherited skip and conditional skip aliases never count as executable pass evidence', () => {
    const root = temp(); mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/x.test.ts'), `describe.skip('suite', () => { it('check', () => {}); }); const itPosix = flag ? it.skip : it; itPosix('conditional', () => {});`);
    const hits = buildTestIndex(root);
    expect(hits.get(row.tests[0])?.mode).toBe('skip');
    expect(hits.get('test/x.test.ts#conditional')?.mode).toBe('skip');
    expect(validateMatrix({ rows: [row] }, { testIndex: hits, root, partial: true, head: HEAD }).map(x => x.code)).toContain('nonrun-backed-pass');
  });
  it('RC-G9: missing, stale or wrong-profile evidence cannot back a persisted pass', () => {
    const root = temp();
    const check = () => validateMatrix({ rows: [row] }, { testIndex: index, root, head: HEAD, partial: true }).map(x => x.code);
    expect(check()).toContain('pass-without-evidence');
    writeFileSync(join(root, 'receipt.json'), JSON.stringify({ head: HEAD+'+dirty', profile: 'p' }));
    expect(check()).toContain('stale-evidence-head');
    writeFileSync(join(root, 'receipt.json'), JSON.stringify({ head: HEAD, profile: 'other' }));
    expect(check()).toContain('evidence-profile-mismatch');
    writeFileSync(join(root, 'receipt.json'), JSON.stringify({ head: HEAD, profile: 'p' }));
    expect(check()).toEqual([]);
  });
  it('RC-G10: milestone matching dirty provenance is still pending', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'test/milestone-manifest.json'), 'utf8'));
    const provenance = { head: HEAD+'+dirty', manifestSha256: 'hash', profile: 'p' };
    const evidence = Object.values(manifest.M1).flat().reduce<Record<string, unknown>>((out, id) => { out[String(id)] = { ...provenance, status: 'passed', source: 'independent-review' }; return out; }, {});
    expect(evaluateMilestone(manifest, 'M1', evidence, provenance).status).toBe('pending');
  });
  it.each(['confimed', null, undefined])('RC-G11: invalid expected outcome %s cannot suppress missing delivery', outcome => {
    const trace = JSON.parse(readFileSync(join(ROOT, 'test/oracle/fixtures/ORACLE-01.json'), 'utf8'));
    const t = trace.trace ?? trace;
    for (const e of t.expected) e.outcome = outcome;
    for (const page of t.inventory.pages) page.records = [];
    expect(evaluateDelivery(t, {}).violations.map(x => x.code)).toContain('malformed-expected-outcome');
  });
  it('RC-G12: inventory rejects hostile source/database identifiers', () => {
    const path = join(temp(), 'db.sqlite');
    const db = new Database(path); db.exec('CREATE TABLE sessions ("bad-column" TEXT)'); db.close();
    expect(() => semanticInventory(path, { tables: ['sessions; DROP TABLE sessions'] })).toThrow(/invalid inventory table/);
    expect(() => semanticInventory(path, { tables: ['sessions'] })).toThrow(/invalid inventory column/);
  });
  it('RC-G13: ignored source files are still included in the scope proof', () => {
    const root = temp(); const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q'); writeFileSync(join(root, '.gitignore'), 'artifacts/\n'); git('add', '.');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    mkdirSync(join(root, 'src/artifacts'), { recursive: true }); writeFileSync(join(root, 'src/artifacts/leak.ts'), 'export const leak = 1;');
    expect(checkSrcDiff({ root, base: git('rev-parse', 'HEAD').trim() }).violations.map(x => x.path)).toContain('src/artifacts/leak.ts');
  });
  it('RC-G14: disabled hooks agree, and malformed argument/JSON/unsafe offsets fail', () => {
    expect(parseTestHookEnv({ CODEX_OCTO_TEST_CLOCK: '', CODEX_OCTO_TEST_FAULTS: '' })).toEqual({ faults: [], clockOffsetMs: 0 });
    for (const point of ['egress.afterSegment(abc)', 'api.forceStatus(../../x)', 'runtime.killChild(extra)']) expect(() => parseTestHookEnv({ CODEX_OCTO_TEST_FAULTS: JSON.stringify([{ point }]) })).toThrow(/parameter/);
    expect(() => parseTestHookEnv({ CODEX_OCTO_TEST_FAULTS: '{bad' })).toThrow(/valid JSON/);
    expect(() => parseTestHookEnv({ CODEX_OCTO_TEST_CLOCK: '999999999999999999999' })).toThrow(/safe integer/);
  });
  it('RC-G15: dead-client writes reject immediately and do not invent transcript entries', async () => {
    const client = JsonlRpcClient.spawn(process.execPath, ['-e', 'process.exit(0)']);
    await client.exited;
    const before = client.transcript.length;
    await expect(client.request('late', {}, { timeoutMs: 1000 })).rejects.toThrow(/not writable/);
    expect(client.transcript.length).toBe(before);
  });
  it('RC-G16: collection and unhandled errors are failed records in JSON and JUnit', () => {
    const out = temp();
    const previous = process.env.DEV01_REPORT_DIR;
    process.env.DEV01_REPORT_DIR = out;
    try {
      new CaseReporter().onFinished([{ type: 'file', name: 'broken.test.ts', tasks: [], result: { state: 'fail', errors: [{ message: 'collection failed' }] } }], [{ message: 'unhandled runner failure' }]);
      const report = JSON.parse(readFileSync(join(out, `${process.env.DEV01_RUNNER ?? 'adhoc'}.results.json`), 'utf8'));
      expect(report.records).toHaveLength(2);
      expect(report.records.every((r: { status: string }) => r.status === 'failed')).toBe(true);
      expect(readFileSync(join(out, `${process.env.DEV01_RUNNER ?? 'adhoc'}.junit.xml`), 'utf8')).toContain('failures="2"');
    } finally { if (previous === undefined) delete process.env.DEV01_REPORT_DIR; else process.env.DEV01_REPORT_DIR = previous; }
  });

});
