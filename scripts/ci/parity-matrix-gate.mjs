#!/usr/bin/env node
/**
 * Parity-matrix gate (R8 §4 SF-5): executes a FRESH full default unit run (it
 * contains every test the matrix references), then validates
 *   1. structural inventory + reference resolution (independent of test outcomes), and
 *   2. every `passed` claim against that fresh JUnit,
 * even when the unit run itself fails. Never reads committed JUnit snapshots.
 * Writes <DEV01_REPORT_DIR>/parity-matrix-gate.json; exits non-zero if any step failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestIndex, validateMatrix, verifyAgainstJUnit } from '../parity/validate-matrix.mjs';
import { captureSourceState } from './source-state.mjs';

export function runParityGate({ root = process.cwd(), reportDir = process.env.DEV01_REPORT_DIR ?? join('artifacts', 'runs'), spawn = spawnSync, sourceState = captureSourceState(root) } = {}) {
const runner = 'parity-matrix';
const junitPath = join(reportDir, `${runner}.junit.xml`);
mkdirSync(reportDir, { recursive: true });
rmSync(junitPath, { force: true }); // a stale file can never stand in for this run

const unit = spawn(process.execPath, ['scripts/ci/run-runner.mjs', runner], { cwd: root, stdio: 'inherit', env: { ...process.env, DEV01_REPORT_DIR: reportDir } });
const matrix = JSON.parse(readFileSync(join(root, 'test', 'parity-matrix.json'), 'utf8'));
const managementGolden = JSON.parse(readFileSync(join(root, 'test', 'goldens', 'b', 'management-actions.json'), 'utf8'));
const structural = validateMatrix(matrix, { testIndex: buildTestIndex(root), managementGolden, root });
const fresh = existsSync(junitPath) ? readFileSync(junitPath, 'utf8') : null;
const claims = fresh ? verifyAgainstJUnit(matrix, [fresh], { head: sourceState.head, profile: { node: process.version, platform: process.platform, arch: process.arch } }) : { issues: [{ code: 'fresh-junit-missing', id: '*', detail: junitPath }], observed: 0 };
const failedCases = fresh ? [...fresh.matchAll(/<testcase classname="([^"]*)" name="([^"]*)"[^>]*>(?:(?!<\/testcase>)[\s\S])*<failure/g)].map((m) => `${m[1]}#${m[2]}`.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : [];
const summary = {
  head: sourceState.head, junit: junitPath,
  unitRun: { exitStatus: unit.status ?? 1, signal: unit.signal, error: unit.error?.message, failedCases },
  structural: { exitStatus: structural.length ? 1 : 0, rows: matrix.rows.length, issues: structural },
  passedClaimsAgainstFreshJUnit: { exitStatus: claims.issues.length ? 1 : 0, junitCasesObserved: claims.observed, issues: claims.issues },
};
writeFileSync(join(reportDir, 'parity-matrix-gate.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ unitRun: summary.unitRun, structural: { exitStatus: summary.structural.exitStatus, issues: structural.length }, passedClaims: { exitStatus: summary.passedClaimsAgainstFreshJUnit.exitStatus, observed: claims.observed, issues: claims.issues.length } }, null, 2));
return { ...summary, exitStatus: (unit.status ?? 1) || unit.signal || unit.error || summary.structural.exitStatus || summary.passedClaimsAgainstFreshJUnit.exitStatus ? 1 : 0 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(runParityGate().exitStatus);
