/**
 * test/parity-matrix.json gate (R8 §4 SF-5, TST-01). The expected ID families
 * are written here from R8 independently of the matrix and of the validator so
 * an omitted row, a renamed row or a fake status claim fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateMatrix,
  buildTestIndex,
  CURRENT_STAGE,
} from '../../scripts/parity/validate-matrix.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const matrix = JSON.parse(readFileSync(new URL('../parity-matrix.json', import.meta.url), 'utf8')) as {
  schemaVersion: number; revision: string; rows: Array<Record<string, unknown> & { id: string }>;
};
const ids = matrix.rows.map((r) => r.id);
const range = (p: string, a: number, b: number, pad = 0) =>
  Array.from({ length: b - a + 1 }, (_, i) => `${p}${String(a + i).padStart(pad, '0')}`);

const CAPABILITIES = [
  ...range('T', 1, 26), ...range('R', 1, 8), ...range('EP-', 1, 28, 2), ...range('I', 1, 36),
  ...range('S', 1, 17), ...range('C', 1, 16), ...range('O', 1, 24),
];
const CR_SECTIONS = [7, 9, 7, 9, 7, 8, 7, 5];
const CRON = CR_SECTIONS.flatMap((n, s) => range(`CR-${s + 1}.`, 1, n));
const CONFIG = [...range('K-', 1, 17, 2), ...range('KA-', 1, 7)];
const BX = range('BX-', 1, 12);
const INVARIANTS = [...range('INV-P', 1, 10), ...range('INV-C', 1, 6), ...range('HB-B', 1, 11)];
const REUSE_DASH = ['T11', 'T23', 'R4', 'R5', 'I1', 'I4', 'I9', 'I26', 'I29', 'S7', 'S14', 'O2', 'O10', 'EP-13', 'EP-28'];
const EP_REQUIRED_ACTIONS: Record<string, string[]> = {
  'EP-15': ['GET', 'PUT'], 'EP-16': ['GET', 'PUT'],
  'EP-17': ['info', 'create', 'members.add', 'members.remove'],
  'EP-18': ['create', 'list', 'get', 'delete', 'members', 'join', 'leave'],
  'EP-20': ['space-members', 'resolve-targets'],
  'EP-23': ['GET', 'PUT', 'DELETE'], 'EP-26': ['events', 'ack'],
  'EP-27': ['comments', 'comment-task', 'ppt', 'replies'],
};

describe('parity matrix: complete R8 accounting', () => {
  it('PM-01: exactly the 155 R8 capability rows', () => {
    const got = ids.filter((id) => /^(T|R|I|S|C|O)\d+$|^EP-\d\d$/.test(id));
    expect(got.length).toBe(155);
    expect(new Set(got)).toEqual(new Set(CAPABILITIES));
  });

  it('PM-02: exactly the 59 R8 cron behavior rows CR-1.1..CR-8.5', () => {
    const got = ids.filter((id) => id.startsWith('CR-'));
    expect(got.length).toBe(59);
    expect(new Set(got)).toEqual(new Set(CRON));
  });

  it('PM-03: configuration key ledger, BX defects and invariants (P1–P10, INV-C1–C6, hard boundaries B1–B11)', () => {
    for (const id of [...CONFIG, ...BX, ...INVARIANTS]) expect(ids, id).toContain(id);
  });

  it('PM-04: every EP bundle expands to action rows with method and path; bundled EPs carry every R8-named action', () => {
    for (const ep of range('EP-', 1, 28, 2)) {
      const actions = matrix.rows.filter((r) => r.id.startsWith(`${ep}.`));
      expect(actions.length, ep).toBeGreaterThan(0);
      for (const a of actions) {
        expect(a.kind).toBe('endpoint-action');
        expect(String(a.method), a.id).toMatch(/^(GET|POST|PUT|DELETE|WS)$/);
        expect(String(a.path), a.id).toMatch(/^\/|^ws:/);
      }
    }
    for (const [ep, required] of Object.entries(EP_REQUIRED_ACTIONS)) {
      for (const action of required) expect(ids, `${ep}.${action}`).toContain(`${ep}.${action}`);
    }
  });

  // R8 §4 O24/§9 DEV-14 as amended by A-R8-PM05-01 (owner-ratified): the pinned
  // B source (src/agent-tools.ts sha256 bf549838…cbf06) defines 24 octo_management
  // actions; send/read/search are the SEPARATE advertised message surface and
  // handleOctoMessageAction reaches 8 message routes. Full route checks:
  // test/parity/pm05-routes.test.ts.
  it('PM-05: octo_management has exactly the 24 source-backed actions (A-R8-PM05-01; R8 originally stated 27)', () => {
    const golden = JSON.parse(readFileSync(new URL('../goldens/b/management-actions.json', import.meta.url), 'utf8')) as { actions: string[]; messageActions: string[]; messageRoutes?: Array<{ action: string }> };
    expect(golden.actions).toHaveLength(24);
    expect(new Set(golden.actions).size).toBe(24);
    expect(golden.messageActions).toHaveLength(3);
    expect(golden.messageRoutes?.map((r) => r.action)).toHaveLength(8);
  });

  it('PM-05b: management-action rows equal the source-captured octo_management enum; message-tool actions stay separate', () => {
    const golden = JSON.parse(readFileSync(new URL('../goldens/b/management-actions.json', import.meta.url), 'utf8')) as {
      source: { file: string; sha256: string }; actions: string[]; messageActions: string[];
    };
    expect(golden.source.file).toBe('src/agent-tools.ts');
    expect(golden.source.sha256).toBe('bf549838a2995094fcf95514e081317c8b35820979b661a1d3615409e75cbf06');
    expect(golden.messageActions).toEqual(['send', 'read', 'search']);
    for (const a of golden.messageActions) expect(golden.actions).not.toContain(a);
    const rows = matrix.rows.filter((r) => r.kind === 'management-action');
    expect(rows.map((r) => r.id).sort()).toEqual(golden.actions.map((a) => `O24.mgmt.${a}`).sort());
    const msgRows = matrix.rows.filter((r) => r.kind === 'message-action');
    expect(msgRows.map((r) => r.id).sort()).toEqual(golden.messageActions.map((a) => `O24.msg.${a}`).sort());
  });

  it('PM-06: no duplicate IDs', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parity matrix: no fake coverage or status claims', () => {
  const index = buildTestIndex(ROOT);
  const managementGolden = JSON.parse(readFileSync(new URL('../goldens/b/management-actions.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const issues = validateMatrix(matrix, { testIndex: index, root: ROOT, managementGolden });

  it('PM-07: the validator reports zero issues for the checked-in matrix', () => {
    expect(issues).toEqual([]);
  });

  it('PM-08: initial execution status is not-run unless independently evidenced; pending work is never passed', () => {
    for (const r of matrix.rows) {
      expect(['not-run', 'passed', 'failed', 'pending']).toContain(r.executionStatus);
      if (r.implementationStatus === 'pending') expect(r.executionStatus, r.id).not.toBe('passed');
      if (r.executionStatus === 'passed') {
        expect((r.tests as string[]).length, r.id).toBeGreaterThan(0);
        expect(String(r.evidence), r.id).toMatch(/^test\/evidence\//);
      }
    }
  });

  it('PM-09: REUSE "—" rows reference their named DEV-01 locking test', () => {
    for (const id of REUSE_DASH) {
      const row = matrix.rows.find((r) => r.id === id)!;
      const tests = row.tests as string[];
      expect(tests.some((t) => t.startsWith('test/locks/reuse-locks.test.ts#') && t.includes(`${id}:`)), id).toBe(true);
    }
  });

  it('PM-10: every BX row has a regression test in test/locks/bx-locks.test.ts', () => {
    for (const id of BX) {
      const row = matrix.rows.find((r) => r.id === id)!;
      expect((row.tests as string[]).some((t) => t.startsWith('test/locks/bx-locks.test.ts#') && new RegExp(`> ${id}( / [A-Z0-9-]+)?:`).test(t)), id).toBe(true);
    }
  });

  it('PM-11: approved scope exclusions carry their owner decision ID', () => {
    for (const r of matrix.rows) {
      if (['NA-OD', 'GAP-OD'].includes(String(r.disposition))) expect(String(r.decision), r.id).toMatch(/^OD-\d+/);
    }
  });

  it('PM-12: every row except approved scope exclusions has a resolvable test reference; future work references named pending contracts only', () => {
    expect(CURRENT_STAGE).toBe('DEV-01');
    for (const r of matrix.rows) {
      if (['NA', 'NA-OD', 'GAP-OD'].includes(String(r.disposition))) continue;
      expect((r.tests as string[]).length, r.id).toBeGreaterThan(0);
      const allTodo = (r.tests as string[]).every((t) => index.get(t)?.mode === 'todo');
      if (allTodo) {
        expect(r.executionStatus, r.id).not.toBe('passed');
        expect(r.implementationStatus, r.id).not.toBe('implemented');
      }
    }
  });

  it('PM-13: negative controls — the validator rejects omitted tests, unresolvable refs, fake passes and missing decisions', () => {
    const row = (over: Record<string, unknown>) => ({
      id: 'T11', kind: 'capability', title: 'x', acceptance: 'x', disposition: 'REUSE', owner: 'backend-dev', stage: ['—'],
      tests: ['test/locks/reuse-locks.test.ts#T11: does not exist'], layer: 'unit', fixture: '', evidence: '',
      executionStatus: 'not-run', implementationStatus: 'implemented', gap: '', tier: 'A', ...over,
    });
    const check = (r: Record<string, unknown>) =>
      validateMatrix({ schemaVersion: 1, revision: 'R8', rows: [r] }, { testIndex: index, root: ROOT, partial: true }).map((i: { code: string }) => i.code);
    expect(check(row({}))).toContain('unresolved-test-ref');
    expect(check(row({ tests: [] }))).toContain('missing-test-ref');
    expect(check(row({ implementationStatus: 'pending', executionStatus: 'passed', tests: [] }))).toContain('fake-pass');
    expect(check(row({ id: 'K-06', kind: 'config-key', disposition: 'NA-OD', decision: '', tests: [] }))).toContain('missing-decision');
    expect(check(row({ executionStatus: 'green' }))).toContain('bad-execution-status');
    // dropping a Tier A reference, an action-level reference or a lock reference fails
    expect(check(row({ id: 'T13', disposition: 'ADAPT', stage: ['DEV-02'], tier: 'A', implementationStatus: 'pending', tests: [] }))).toContain('missing-test-ref');
    expect(check(row({ id: 'EP-17.create', kind: 'endpoint-action', method: 'POST', path: '/v1/bot/groups', disposition: 'TIER-OD', tier: 'B', implementationStatus: 'pending', tests: [] }))).toContain('missing-test-ref');
    expect(check(row({ id: 'O24.mgmt.create-group', kind: 'management-action', disposition: 'TIER-OD', tier: 'B', implementationStatus: 'pending', tests: [] }))).toContain('missing-test-ref');
    expect(check(row({ id: 'I12', stage: ['lock'], tests: [] }))).toContain('missing-test-ref');
    // a todo-only contract can never back an implemented/passed claim
    const todoRef = [...index.entries()].find(([, v]) => v.mode === 'todo')![0];
    expect(check(row({ tests: [todoRef], executionStatus: 'passed', evidence: 'test/evidence/x.xml' }))).toContain('todo-backed-pass');
    expect(check(row({ tests: [todoRef], implementationStatus: 'implemented' }))).toContain('todo-backed-implemented');
  });
});
