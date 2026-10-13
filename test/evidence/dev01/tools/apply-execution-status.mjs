// Set executionStatus in test/parity-matrix.json from a JUnit run:
// 'passed' only when every reference is a real (non-todo) test that passed;
// 'failed' when any referenced real test failed; otherwise 'not-run'.
//   node test/evidence/dev01/tools/apply-execution-status.mjs test/evidence/dev01/runs/unit.junit.xml
import { readFileSync, writeFileSync } from 'node:fs';
import { buildTestIndex } from '../../../../scripts/parity/validate-matrix.mjs';
const junitPath = process.argv[2];
const xml = readFileSync(junitPath, 'utf8');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const results = new Map();
for (const m of xml.matchAll(/<testcase classname="([^"]*)" name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const body = m[4] ?? '';
  results.set(`${unesc(m[1])}#${unesc(m[2])}`, /<failure/.test(body) ? 'failed' : /<skipped/.test(body) ? 'skipped' : 'passed');
}
const index = buildTestIndex(process.cwd());
const matrix = JSON.parse(readFileSync('test/parity-matrix.json', 'utf8'));
const counts = {};
for (const r of matrix.rows) {
  const real = r.tests.filter((t) => index.get(t)?.mode === 'run');
  const todo = r.tests.some((t) => index.get(t)?.mode === 'todo');
  const statuses = real.map((t) => results.get(t));
  let s = 'not-run';
  if (statuses.some((x) => x === 'failed')) s = 'failed';
  else if (real.length > 0 && !todo && r.implementationStatus === 'implemented' && statuses.every((x) => x === 'passed')) s = 'passed';
  r.executionStatus = s;
  r.evidence = s === 'not-run' ? '' : junitPath;
  counts[s] = (counts[s] ?? 0) + 1;
}
writeFileSync('test/parity-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
console.log(JSON.stringify(counts));
