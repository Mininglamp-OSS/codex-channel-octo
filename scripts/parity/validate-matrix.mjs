#!/usr/bin/env node
/**
 * test/parity-matrix.json validator (R8 §4 SF-5, TST-01).
 *
 *   node scripts/parity/validate-matrix.mjs [--junit <file> ...]
 *
 * - Every test reference `file#Full > Title` must resolve to a real it/test
 *   (or a named it.todo pending contract) found by a TypeScript AST scan.
 * - Every row except an approved scope exclusion (NA, NA-OD, GAP-OD) must have
 *   at least one reference (R8 §4: no Tier A or REUSE/lock row without tests;
 *   action-level rows included).
 * - `passed` requires real (non-todo) references and evidence; todo-backed rows
 *   can never be passed or implemented; pending implementation is never passed.
 * - With --junit, every row claimed `passed` must have all its references
 *   passed in the given JUnit files (claims are re-verified per head).
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CURRENT_STAGE = 'DEV-01';
const EXEC = new Set(['not-run', 'passed', 'failed', 'pending']);
const IMPL = new Set(['implemented', 'partial', 'pending', 'not-applicable']);
const EXCLUDED = new Set(['NA', 'NA-OD', 'GAP-OD']);
const KINDS = new Set(['capability', 'endpoint-action', 'management-action', 'message-action', 'config-key', 'bx', 'invariant', 'cron']);

function listTests(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.cache' || e === 'fixtures' || e === 'evidence' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) listTests(p, out);
    else if (/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/** Map `relative/file.test.ts#Describe > Title` → { mode: 'run' | 'todo' | 'skip' }. */
export function buildTestIndex(root) {
  const index = new Map();
  const dirs = ['src', 'test'].map((d) => join(root, d)).filter(existsSync);
  for (const file of dirs.flatMap((d) => listTests(d))) {
    const rel = relative(root, file).split(sep).join('/');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node, stack) => {
      if (ts.isCallExpression(node)) {
        let callee = node.expression;
        let mode = 'run';
        // it.each(...)(title, fn) / it.for(...)(title, fn)
        if (ts.isCallExpression(callee)) callee = callee.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          const m = callee.name.text;
          if (m === 'todo') mode = 'todo';
          else if (m === 'skip') mode = 'skip';
          callee = callee.expression;
        }
        const name = ts.isIdentifier(callee) ? callee.text : undefined;
        const titleNode = node.arguments[0];
        if ((name === 'describe' || name === 'it' || name === 'test') && titleNode && ts.isStringLiteralLike(titleNode)) {
          const title = titleNode.text;
          if (name === 'describe') {
            node.arguments.slice(1).forEach((a) => ts.forEachChild(a, (c) => visit(c, [...stack, title])));
            return;
          }
          index.set(`${rel}#${[...stack, title].join(' > ')}`, { mode });
          return;
        }
      }
      ts.forEachChild(node, (c) => visit(c, stack));
    };
    visit(sf, []);
  }
  return index;
}

/**
 * @param {{ rows: Array<Record<string, any>>, [key: string]: any }} matrix
 * @param {{ testIndex: Map<string, { mode: string }>, partial?: boolean, root?: string }} opts
 * @returns {Array<{ code: string, id: string, detail?: string }>}
 */
export function validateMatrix(matrix, { testIndex, partial = false }) {
  const issues = [];
  const add = (code, id, detail) => issues.push({ code, id, ...(detail ? { detail } : {}) });
  const seen = new Set();
  for (const r of matrix.rows) {
    if (seen.has(r.id)) add('duplicate-id', r.id);
    seen.add(r.id);
    if (!KINDS.has(r.kind)) add('bad-kind', r.id);
    if (!EXEC.has(r.executionStatus)) add('bad-execution-status', r.id);
    if (!IMPL.has(r.implementationStatus)) add('bad-implementation-status', r.id);
    const tests = Array.isArray(r.tests) ? r.tests : [];
    const excluded = EXCLUDED.has(r.disposition);
    if (excluded && !/^OD-\d+/.test(String(r.decision ?? '')) && r.disposition !== 'NA') add('missing-decision', r.id);
    if (!excluded && tests.length === 0) add('missing-test-ref', r.id);
    const resolved = tests.map((t) => [t, testIndex.get(t)]);
    for (const [t, hit] of resolved) if (!hit) add('unresolved-test-ref', r.id, t);
    const allTodo = resolved.length > 0 && resolved.every(([, hit]) => hit?.mode === 'todo');
    const anyTodo = resolved.some(([, hit]) => hit?.mode === 'todo');
    if (r.executionStatus === 'passed') {
      if (r.implementationStatus === 'pending' || tests.length === 0) add('fake-pass', r.id);
      if (anyTodo) add('todo-backed-pass', r.id);
      if (!/^test\/evidence\//.test(String(r.evidence ?? ''))) add('pass-without-evidence', r.id);
    }
    if (allTodo && r.implementationStatus === 'implemented') add('todo-backed-implemented', r.id);
    if (!partial && !r.gap && r.implementationStatus !== 'implemented' && !excluded) add('missing-gap', r.id);
  }
  return issues;
}

/** Re-verify `passed` claims against JUnit files (testcase classname=file, name=full title). */
export function verifyAgainstJUnit(matrix, junitTexts) {
  const results = new Map();
  for (const xml of junitTexts) {
    for (const m of xml.matchAll(/<testcase classname="([^"]*)" name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const body = m[4] ?? '';
      const status = /<failure/.test(body) ? 'failed' : /<skipped/.test(body) ? 'skipped' : 'passed';
      results.set(`${unesc(m[1])}#${unesc(m[2])}`, status);
    }
  }
  const issues = [];
  for (const r of matrix.rows.filter((x) => x.executionStatus === 'passed')) {
    for (const t of r.tests) {
      const s = results.get(t);
      if (s !== 'passed') issues.push({ code: 'claimed-pass-not-observed', id: r.id, detail: `${t} → ${s ?? 'absent'}` });
    }
  }
  return { issues, observed: results.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const matrix = JSON.parse(readFileSync(join(root, 'test', 'parity-matrix.json'), 'utf8'));
  const issues = validateMatrix(matrix, { testIndex: buildTestIndex(root) });
  const junits = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--junit' ? [readFileSync(a, 'utf8')] : []));
  const j = junits.length ? verifyAgainstJUnit(matrix, junits) : { issues: [], observed: 0 };
  const byStatus = {};
  for (const r of matrix.rows) byStatus[`${r.implementationStatus}/${r.executionStatus}`] = (byStatus[`${r.implementationStatus}/${r.executionStatus}`] ?? 0) + 1;
  console.log(JSON.stringify({ rows: matrix.rows.length, byStatus, issues, junitIssues: j.issues, junitCasesObserved: j.observed }, null, 2));
  process.exit(issues.length || j.issues.length ? 1 : 0);
}
