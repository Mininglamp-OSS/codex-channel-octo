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
 * - Octo tool surfaces (R8 amendment A-R8-PM05-01) are checked against the
 *   source-captured golden test/goldens/b/management-actions.json: see
 *   validateMessageRoutes.
 */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CURRENT_STAGE = 'DEV-01';
const EXEC = new Set(['not-run', 'passed', 'failed', 'pending']);
const IMPL = new Set(['implemented', 'partial', 'pending', 'not-applicable']);
const EXCLUDED = new Set(['NA', 'NA-OD', 'GAP-OD']);
const KINDS = new Set(['capability', 'endpoint-action', 'management-action', 'message-action', 'message-route', 'config-key', 'bx', 'invariant', 'cron']);

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
    const aliases = new Map();
    const collectAlias = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const text = node.initializer.getText(sf);
        if (/\b(?:it|test|describe)(?:\.|\b)/.test(text)) aliases.set(node.name.text, /\bskip(?:If)?\b/.test(text) ? 'skip' : /\btodo\b/.test(text) ? 'todo' : 'run');
      }
      ts.forEachChild(node, collectAlias);
    };
    collectAlias(sf);
    const visit = (node, stack, inherited = 'run') => {
      if (ts.isCallExpression(node)) {
        let callee = node.expression;
        let mode = inherited;
        // it.each(...)(title, fn) / it.for(...)(title, fn)
        if (ts.isCallExpression(callee)) callee = callee.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          const m = callee.name.text;
          if (m === 'todo') mode = 'todo';
          else if (['skip', 'skipIf', 'runIf'].includes(m)) mode = 'skip';
          callee = callee.expression;
        }
        let name = ts.isIdentifier(callee) ? callee.text : undefined;
        if (aliases.has(name)) { mode = aliases.get(name); name = 'it'; }
        const titleNode = node.arguments[0];
        if ((name === 'describe' || name === 'it' || name === 'test') && titleNode && ts.isStringLiteralLike(titleNode)) {
          const title = titleNode.text;
          if (name === 'describe') {
            node.arguments.slice(1).forEach((a) => ts.forEachChild(a, (c) => visit(c, [...stack, title], mode)));
            return;
          }
          const key = `${rel}#${[...stack, title].join(' > ')}`;
          const previous = index.get(key);
          index.set(key, { mode: previous && previous.mode !== 'run' ? previous.mode : mode });
          return;
        }
      }
      ts.forEachChild(node, (c) => visit(c, stack, inherited));
    };
    visit(sf, []);
  }
  return index;
}

/**
 * @param {{ rows: Array<Record<string, any>>, [key: string]: any }} matrix
 * @param {{ testIndex: Map<string, { mode: string }>, partial?: boolean, root?: string, head?: string, managementGolden?: Record<string, any> }} opts
 * @returns {Array<{ code: string, id: string, detail?: string }>}
 */
export function validateMatrix(matrix, { testIndex, partial = false, managementGolden, root, head }) {
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
    if (excluded && (r.disposition === 'NA' ? !String(r.decision ?? '').trim() : !/^OD-\d+/.test(String(r.decision ?? '')))) add('missing-decision', r.id);
    if (!excluded && tests.length === 0) add('missing-test-ref', r.id);
    const resolved = tests.map((t) => [t, testIndex.get(t)]);
    for (const [t, hit] of resolved) if (!hit) add('unresolved-test-ref', r.id, t);
    const allTodo = resolved.length > 0 && resolved.every(([, hit]) => hit?.mode === 'todo');
    const anyTodo = resolved.some(([, hit]) => hit?.mode === 'todo');
    if (r.executionStatus === 'passed') {
      if (r.implementationStatus === 'pending' || tests.length === 0) add('fake-pass', r.id);
      if (anyTodo) add('todo-backed-pass', r.id);
      if (resolved.some(([, hit]) => hit?.mode !== 'run')) add('nonrun-backed-pass', r.id);
      if (!root || typeof r.evidence !== 'string' || !r.evidence || !existsSync(resolve(root, r.evidence))) add('pass-without-evidence', r.id);
      else {
        try {
          const snapshot = JSON.parse(readFileSync(resolve(root, r.evidence), 'utf8'));
          const expectedHead = head ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
          if (!/^[0-9a-f]{40}$/.test(expectedHead) || snapshot.head !== expectedHead) add('stale-evidence-head', r.id);
          if (!r.profile || snapshot.profile !== r.profile) add('evidence-profile-mismatch', r.id);
        } catch { add('invalid-evidence', r.id); }
      }
    }
    if (allTodo && r.implementationStatus === 'implemented') add('todo-backed-implemented', r.id);
    if (!partial && !r.gap && r.implementationStatus !== 'implemented' && !excluded) add('missing-gap', r.id);
  }
  if (managementGolden) issues.push(...validateMessageRoutes(matrix, managementGolden, { testIndex }));
  return issues;
}

// ── Octo tool surfaces (A-R8-PM05-01) ─────────────────────────────────────
export const AMENDMENT_PM05 = 'A-R8-PM05-01';
const MGMT_COUNT = 24;
const ADVERTISED_COUNT = 3;
const REACHABLE_COUNT = 8;
const ROUTE_FILE = 'src/actions.ts';
const ROUTE_SYMBOL = 'handleOctoMessageAction';
/** Ratified endpoint/management references for the reachable-only routes; advertised routes carry none. */
export const ROUTE_REFERENCES = {
  'member-info': { endpoint: 'EP-13', management: 'O24.mgmt.group-members' },
  'channel-list': { endpoint: 'EP-12', management: 'O24.mgmt.list-groups' },
  'channel-info': { endpoint: 'EP-12', management: 'O24.mgmt.group-info' },
  'group-md-read': { endpoint: 'EP-15', management: 'O24.mgmt.group-md-read' },
  'group-md-update': { endpoint: 'EP-15', management: 'O24.mgmt.group-md-update' },
};
export const ROUTE_CONTRACT_KINDS = ['authorization', 'target resolution', 'result envelope', 'cache'];
const ROUTE_CONTRACT_FILE = 'test/contracts/dev-14.message-routes.contract.test.ts';
const OWNERSHIP_KEYS = ['managementFactory', 'managementEnum', 'managementRegistration', 'messageAdvertisement', 'messageRegistration', 'messageDispatcher'];
const HEX64 = /^[0-9a-f]{64}$/;
/** Source files backing the amendment at pin B 2e710e90… (A-R8-PM05-01). */
const AMENDMENT_SOURCES = {
  'src/agent-tools.ts': 'bf549838a2995094fcf95514e081317c8b35820979b661a1d3615409e75cbf06',
  'src/channel.ts': 'c18771187069feda3ee4212978b6da4ebb2c39da8a704ec548e97cbfd85bca4c',
  'src/actions.ts': '928312349952a5f3697ee46ef51742aae5d7d528dd08add595fc7d3f6d5d7002',
};

/** Matrix row id for a dispatcher route: advertised → O24.msg.<a>, reachable-only → O24.msg-route.<a>. */
export const routeRowId = (action, advertised) => (advertised ? `O24.msg.${action}` : `O24.msg-route.${action}`);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check the two public Octo tool surfaces (24 octo_management actions and
 * 3 advertised message actions) plus all 8 reachable routes in the golden
 * and their matrix rows: omissions, duplicates/double counts, wrong surface,
 * missing or wrong source provenance, unauthorized routes, wrong references,
 * stage/tier ownership and pending route contracts claimed as passed.
 * @param {{ rows: Array<Record<string, any>> }} matrix
 * @param {Record<string, any>} golden test/goldens/b/management-actions.json
 * @param {{ testIndex: Map<string, { mode: string }> }} opts
 */
export function validateMessageRoutes(matrix, golden, { testIndex }) {
  const issues = [];
  const add = (code, id, detail) => issues.push({ code, id, ...(detail ? { detail } : {}) });
  const mgmt = Array.isArray(golden?.actions) ? golden.actions : [];
  const advertised = Array.isArray(golden?.messageActions) ? golden.messageActions : [];
  const routes = Array.isArray(golden?.messageRoutes) ? golden.messageRoutes : [];
  const sources = golden?.sources ?? {};
  const own = golden?.ownership ?? {};

  // golden: exact counts, uniqueness, disjointness, provenance
  if (mgmt.length !== MGMT_COUNT || new Set(mgmt).size !== mgmt.length || !mgmt.includes('write-secret')) add('golden-management-set', 'octo_management', `${mgmt.length} entries`);
  for (const a of new Set(mgmt)) if (mgmt.filter((x) => x === a).length > 1) add('golden-management-duplicate', a);
  const routeActions = routes.map((r) => r.action);
  if (routes.length !== REACHABLE_COUNT || new Set(routeActions).size !== routeActions.length) add('golden-route-set', ROUTE_SYMBOL, `${routes.length} routes`);
  for (const a of new Set(routeActions)) if (routeActions.filter((x) => x === a).length > 1) add('golden-route-duplicate', a);
  const flagged = routes.filter((r) => r.advertised === true).map((r) => r.action);
  if (advertised.length !== ADVERTISED_COUNT || new Set(advertised).size !== advertised.length || !sameJson([...flagged].sort(), [...advertised].sort())
    || advertised.some((a) => !routeActions.includes(a)) || !sameJson(own.messageAdvertisement?.actions, advertised)) add('golden-advertised-set', 'getAvailableActions');
  for (const a of advertised) if (mgmt.includes(a)) add('surface-overlap', a);
  for (const f of ['index.ts', 'src/actions.ts', 'src/agent-tools.ts', 'src/channel.ts']) {
    if (!HEX64.test(String(sources[f] ?? '')) || (f in AMENDMENT_SOURCES && sources[f] !== AMENDMENT_SOURCES[f])) add('golden-missing-provenance', f);
  }
  if (golden?.source?.sha256 !== sources['src/agent-tools.ts']) add('golden-missing-provenance', 'src/agent-tools.ts');
  if (golden?.messageSource?.sha256 !== sources['src/channel.ts']) add('golden-missing-provenance', 'src/channel.ts');
  for (const k of OWNERSHIP_KEYS) {
    const p = own[k];
    if (!p || !p.file || !p.symbol || !(p.startLine > 0) || !(p.endLine >= p.startLine) || !HEX64.test(String(p.sha256 ?? '')) || p.fileSha256 !== sources[p.file]) add('golden-missing-provenance', k);
  }
  for (const r of routes) {
    if (r.file !== ROUTE_FILE || r.symbol !== ROUTE_SYMBOL || !(r.caseLine > 0) || !r.handler) add('golden-missing-provenance', `route:${r.action}`);
  }

  // matrix: one row per reachable route on the correct surface, no extra routes
  const byId = new Map(matrix.rows.map((r) => [r.id, r]));
  const routeRows = matrix.rows.filter((r) => r.kind === 'message-action' || r.kind === 'message-route' || /^O24\.msg(-route)?\./.test(r.id));
  const counted = new Map();
  for (const row of routeRows) {
    const m = /^O24\.(msg|msg-route)\.(.+)$/.exec(row.id);
    const action = m?.[2];
    const route = routes.find((r) => r.action === action);
    if (!m || !route) { add('route-unauthorized', row.id); continue; }
    counted.set(action, (counted.get(action) ?? 0) + 1);
    const isAdv = advertised.includes(action);
    const wantKind = isAdv ? 'message-action' : 'message-route';
    const wantSurface = isAdv ? 'advertised' : 'reachable-only';
    if (row.id !== routeRowId(action, isAdv) || row.kind !== wantKind || row.surface !== wantSurface) add('route-wrong-surface', row.id);
    const sha = sources[ROUTE_FILE];
    if (!row.route || !sameJson(row.route, { file: ROUTE_FILE, symbol: ROUTE_SYMBOL, caseLine: route.caseLine, sha256: sha })) add('route-missing-provenance', row.id);
    const wantRefs = isAdv ? null : ROUTE_REFERENCES[action] ?? null;
    if (!sameJson(row.references ?? null, wantRefs) || (wantRefs && (!byId.has(wantRefs.endpoint) || !byId.has(wantRefs.management)))) add('route-wrong-reference', row.id);
    // stage/tier ownership follows the referenced management action, else O24 itself
    const owner = byId.get(wantRefs?.management ?? 'O24');
    if (!owner || !sameJson(row.stage, owner.stage) || row.tier !== owner.tier) add('route-stage-tier', row.id);
    // four named route contracts for THIS route; while any is pending the row cannot pass
    const stage = Array.isArray(row.stage) ? row.stage[0] : '';
    const tests = Array.isArray(row.tests) ? row.tests : [];
    const contracts = ROUTE_CONTRACT_KINDS.map((kind) => tests.filter((t) => t.startsWith(`${ROUTE_CONTRACT_FILE}#${stage} pending message route contracts > ${row.id} (${stage}): ${kind} — `) && testIndex.has(t)));
    if (contracts.some((c) => c.length !== 1)) add('route-contract-missing', row.id);
    const pending = contracts.some((c) => c.length !== 1 || testIndex.get(c[0])?.mode !== 'run');
    if (pending && (row.executionStatus === 'passed' || row.implementationStatus === 'implemented')) add('route-contract-false-pass', row.id);
  }
  for (const r of routes) {
    const n = counted.get(r.action) ?? 0;
    if (n === 0) add('route-missing-row', r.action);
    if (n > 1) add('route-duplicate-row', r.action);
  }
  const mgmtRows = matrix.rows.filter((r) => r.kind === 'management-action').map((r) => r.id);
  for (const a of mgmt) if (mgmtRows.filter((id) => id === `O24.mgmt.${a}`).length !== 1) add('management-row', `O24.mgmt.${a}`);
  for (const id of mgmtRows) if (!mgmt.includes(id.replace(/^O24\.mgmt\./, ''))) add('management-row', id);
  return issues;
}

/** Re-verify `passed` claims against JUnit files (testcase classname=file, name=full title). */
export function verifyAgainstJUnit(matrix, junitTexts, { head, profile } = {}) {
  const results = new Map();
  for (const xml of junitTexts) {
    for (const m of xml.matchAll(/<testcase classname="([^"]*)" name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const body = m[4] ?? '';
      let status = /<(?:failure|error)\b/.test(body) ? 'failed' : /<skipped/.test(body) ? 'skipped' : 'passed';
      if (head !== undefined && (!/^[0-9a-f]{40}$/.test(head) || !body.includes(`name="head" value="${head}"`))) status = 'unverified-head';
      if (profile) {
        try {
          const encoded = /name="environment" value="([^"]*)"/.exec(body)?.[1];
          const environment = JSON.parse(unesc(encoded ?? ''));
          if (Object.entries(profile).some(([key, value]) => environment[key] !== value)) status = 'unverified-head';
        } catch { status = 'unverified-head'; }
      }
      const key = `${unesc(m[1])}#${unesc(m[2])}`;
      const previous = results.get(key);
      const rank = { passed: 0, skipped: 1, 'unverified-head': 2, failed: 3 };
      results.set(key, previous && rank[previous] > rank[status] ? previous : status);
    }
  }
  const issues = [];
  for (const r of matrix.rows.filter((x) => x.executionStatus === 'passed' || x.requiredVerification === 'passed-on-fresh-head-and-profile')) {
    for (const t of r.tests) {
      let s = results.get(t);
      // Template references must match at least one expanded test, and every
      // expansion must pass. A template cannot stand in for an empty selection.
      if (!s && /\$[A-Za-z_]|%[sdifjo#]/.test(t)) {
        const pattern = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$[A-Za-z_][A-Za-z_0-9]*|%[sdifjo#]/g, '.+');
        const matches = [...results].filter(([key]) => new RegExp(`^${pattern}$`).test(key));
        s = matches.length ? matches.every(([, status]) => status === 'passed') ? 'passed' : 'failed' : undefined;
      }
      if (s !== 'passed') issues.push({ code: 'claimed-pass-not-observed', id: r.id, detail: `${t} → ${s ?? 'absent'}` });
    }
  }
  return { issues, observed: results.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const matrix = JSON.parse(readFileSync(join(root, 'test', 'parity-matrix.json'), 'utf8'));
  const managementGolden = JSON.parse(readFileSync(join(root, 'test', 'goldens', 'b', 'management-actions.json'), 'utf8'));
  const issues = validateMatrix(matrix, { testIndex: buildTestIndex(root), managementGolden, root });
  const junits = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--junit' ? [readFileSync(a, 'utf8')] : []));
  const j = junits.length ? verifyAgainstJUnit(matrix, junits) : { issues: [], observed: 0 };
  const byStatus = {};
  for (const r of matrix.rows) byStatus[`${r.implementationStatus}/${r.executionStatus}`] = (byStatus[`${r.implementationStatus}/${r.executionStatus}`] ?? 0) + 1;
  console.log(JSON.stringify({ rows: matrix.rows.length, byStatus, issues, junitIssues: j.issues, junitCasesObserved: j.observed }, null, 2));
  process.exit(issues.length || j.issues.length ? 1 : 0);
}
