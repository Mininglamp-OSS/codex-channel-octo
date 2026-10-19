/**
 * PM05-F1 (R8 amendment A-R8-PM05-01): the pinned B source exposes three
 * public Octo tool surfaces — 24 `octo_management` actions and 3 advertised
 * message actions, with all 8 reachable message dispatcher routes. The normative
 * sets below are written from the ratified amendment, independently of the
 * golden, the matrix and the validator, so an omission, a duplicate, a wrong
 * surface, missing provenance, an unauthorized route, a wrong reference or a
 * falsely passed pending route contract fails.
 *
 * Source provenance assertions passing here are NOT behavioral contract
 * passes: every route stays pending until its DEV-14 route contracts execute.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as validator from '../../scripts/parity/validate-matrix.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
type Row = Record<string, unknown> & { id: string; kind: string; tests: string[] };
type Matrix = { rows: Row[]; [k: string]: unknown };
type Issue = { code: string; id: string; detail?: string };
type RouteValidator = (m: Matrix, g: unknown, o: { testIndex: Map<string, { mode: string }> }) => Issue[];

const loadMatrix = () => JSON.parse(readFileSync(new URL('../parity-matrix.json', import.meta.url), 'utf8')) as Matrix;
const loadGolden = () => JSON.parse(readFileSync(new URL('../goldens/b/management-actions.json', import.meta.url), 'utf8')) as Golden;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
// Resolved at run time so an absent validator fails the assertions below
// instead of failing module load.
const validateMessageRoutes: RouteValidator = (validator as Record<string, unknown>).validateMessageRoutes as RouteValidator
  ?? (() => [{ code: 'validator-absent', id: '*' }]);

interface Provenance { file: string; symbol: string; startLine: number; endLine: number; sha256: string }
interface Golden {
  source: { file: string; sha256: string };
  messageSource: { file: string; sha256: string };
  actions: string[];
  messageActions: string[];
  amendment?: { id: string; ratification: string; doc: string };
  sources?: Record<string, string>;
  ownership?: Record<string, Provenance & Record<string, unknown>>;
  messageRoutes?: Array<{ action: string; file: string; symbol: string; caseLine: number; returnLine: number; handler: string; handlerArgs: string[]; advertised: boolean }>;
}

// ── normative sets (A-R8-PM05-01, source pin B 2e710e90…) ──────────────────
const PIN_B = '2e710e903fa43ac9440723746f7395d2f7b4347e';
const SHA = {
  'src/agent-tools.ts': 'bf549838a2995094fcf95514e081317c8b35820979b661a1d3615409e75cbf06',
  'src/channel.ts': 'c18771187069feda3ee4212978b6da4ebb2c39da8a704ec548e97cbfd85bca4c',
  'src/actions.ts': '928312349952a5f3697ee46ef51742aae5d7d528dd08add595fc7d3f6d5d7002',
};
const MGMT_24 = [
  'list-groups', 'group-info', 'group-members', 'group-md-read', 'group-md-update', 'search-members', 'resolve',
  'create-group', 'update-group', 'add-members', 'remove-members', 'create-thread', 'list-threads', 'get-thread',
  'delete-thread', 'list-thread-members', 'join-thread', 'leave-thread', 'thread-md-read', 'thread-md-update',
  'voice-context-read', 'voice-context-update', 'voice-context-delete', 'write-secret',
];
const ADVERTISED_3 = ['send', 'read', 'search'];
/** handleOctoMessageAction switch in B src/actions.ts: [action, case line, handler]. */
const REACHABLE_8: Array<[string, number, string]> = [
  ['send', 189, 'handleSend'], ['read', 191, 'handleRead'], ['search', 193, 'handleSearch'],
  ['member-info', 195, 'handleMemberInfo'], ['channel-list', 197, 'handleChannelList'], ['channel-info', 199, 'handleChannelInfo'],
  ['group-md-read', 201, 'handleGroupMdRead'], ['group-md-update', 203, 'handleGroupMdUpdate'],
];
/** Reachable-only routes: the five rows the amendment adds, with their endpoint/management references. */
const ROUTE_ROWS: Record<string, { endpoint: string; management: string }> = {
  'O24.msg-route.member-info': { endpoint: 'EP-13', management: 'O24.mgmt.group-members' },
  'O24.msg-route.channel-list': { endpoint: 'EP-12', management: 'O24.mgmt.list-groups' },
  'O24.msg-route.channel-info': { endpoint: 'EP-12', management: 'O24.mgmt.group-info' },
  'O24.msg-route.group-md-read': { endpoint: 'EP-15', management: 'O24.mgmt.group-md-read' },
  'O24.msg-route.group-md-update': { endpoint: 'EP-15', management: 'O24.mgmt.group-md-update' },
};
const ADVERTISED_ROWS = ['O24.msg.send', 'O24.msg.read', 'O24.msg.search'];
const CONTRACT_KINDS = ['authorization', 'target resolution', 'result envelope', 'cache'];
const CONTRACT_FILE = 'test/contracts/dev-14.message-routes.contract.test.ts';
const routeRowId = (action: string) => (ADVERTISED_3.includes(action) ? `O24.msg.${action}` : `O24.msg-route.${action}`);

describe('PM05-F1: source-backed Octo tool surfaces (A-R8-PM05-01)', () => {
  const golden = loadGolden();
  const matrix = loadMatrix();

  it('PM05-F1-01: octo_management is exactly the 24 normative actions, write-secret exactly once', () => {
    expect(golden.source).toEqual({ repo: 'Mininglamp-OSS/openclaw-channel-octo', commit: PIN_B, file: 'src/agent-tools.ts', sha256: SHA['src/agent-tools.ts'] });
    expect(golden.actions).toEqual(MGMT_24);
    expect(new Set(golden.actions).size).toBe(24);
    expect(golden.actions.filter((a) => a === 'write-secret')).toHaveLength(1);
  });

  it('PM05-F1-02: the advertised message surface is exactly send/read/search, disjoint from octo_management', () => {
    expect(golden.messageSource).toEqual({ file: 'src/channel.ts', sha256: SHA['src/channel.ts'] });
    expect(golden.messageActions).toEqual(ADVERTISED_3);
    for (const a of ADVERTISED_3) expect(MGMT_24, a).not.toContain(a);
    const adv = golden.ownership?.messageAdvertisement;
    expect(adv).toMatchObject({ file: 'src/channel.ts', symbol: 'getAvailableActions', startLine: 484, returnLine: 495, actions: ADVERTISED_3 });
  });

  it('PM05-F1-03: handleOctoMessageAction reaches exactly 8 routes, AST-captured with case line, handler and provenance', () => {
    const routes = golden.messageRoutes ?? [];
    expect(routes.map((r) => [r.action, r.caseLine, r.handler])).toEqual(REACHABLE_8);
    expect(new Set(routes.map((r) => r.action)).size).toBe(8);
    for (const r of routes) {
      expect(r, r.action).toMatchObject({ file: 'src/actions.ts', symbol: 'handleOctoMessageAction', returnLine: r.caseLine + 1, advertised: ADVERTISED_3.includes(r.action) });
      expect(r.handlerArgs.length, r.action).toBeGreaterThan(0);
    }
    expect(routes.filter((r) => r.advertised).map((r) => r.action)).toEqual(ADVERTISED_3);
    expect(routes.filter((r) => !r.advertised)).toHaveLength(5);
  });

  it('PM05-F1-04: factory, registration and dispatcher ownership carry source file, symbol, lines and hashes', () => {
    expect(golden.sources).toMatchObject(SHA);
    expect(golden.sources?.['index.ts']).toMatch(/^[0-9a-f]{64}$/);
    const own = golden.ownership ?? {};
    const expected: Record<string, [string, string, number]> = {
      managementFactory: ['src/agent-tools.ts', 'createOctoManagementTools', 557],
      managementEnum: ['src/agent-tools.ts', 'createOctoManagementTools > parameters.properties.action.enum', 613],
      managementRegistration: ['index.ts', 'registerFull > api.registerTool(octo_management)', 231],
      messageAdvertisement: ['src/channel.ts', 'getAvailableActions', 484],
      messageRegistration: ['src/channel.ts', 'octoPlugin.actions', 804],
      messageDispatcher: ['src/actions.ts', 'handleOctoMessageAction', 114],
    };
    expect(Object.keys(own).sort()).toEqual(Object.keys(expected).sort());
    for (const [k, [file, symbol, startLine]] of Object.entries(expected)) {
      const p = own[k];
      expect(p, k).toMatchObject({ file, symbol, startLine });
      expect(p.endLine, k).toBeGreaterThan(p.startLine);
      expect(p.sha256, k).toMatch(/^[0-9a-f]{64}$/);
      expect(p.fileSha256, k).toBe(golden.sources?.[file]);
    }
    expect(own.managementRegistration).toMatchObject({ names: ['octo_management'] });
    expect(own.messageRegistration).toMatchObject({ dispatchCall: 'handleOctoMessageAction', dispatchCallLine: 860 });
    expect(own.messageRegistration?.members).toMatchObject({ listActions: 805, describeMessageTool: 809, handleAction: 823 });
    expect(own.messageDispatcher).toMatchObject({ endLine: 210, defaultRejectsUnknown: true });
  });

  it('PM05-F1-05: inventory has 32 surface/action pairs and 30 distinct names with no double count', () => {
    const routes = (golden.messageRoutes ?? []).map((r) => r.action);
    const pairs = [...golden.actions.map((a) => `octo_management:${a}`), ...routes.map((a) => `message:${a}`)];
    expect(pairs).toHaveLength(32);
    expect(new Set(pairs).size).toBe(32);
    expect(new Set([...golden.actions, ...routes]).size).toBe(30);
    // advertised is a subset of reachable, never a third independent count
    for (const a of golden.messageActions) expect(routes, a).toContain(a);
  });

  it('PM05-F1-06: matrix keeps 24 management + 3 advertised rows and adds exactly the 5 reachable-only route rows with their references', () => {
    const byKind = (k: string) => matrix.rows.filter((r) => r.kind === k).map((r) => r.id).sort();
    expect(byKind('management-action')).toEqual(MGMT_24.map((a) => `O24.mgmt.${a}`).sort());
    expect(byKind('message-action')).toEqual([...ADVERTISED_ROWS].sort());
    expect(byKind('message-route')).toEqual(Object.keys(ROUTE_ROWS).sort());
    const ids = matrix.rows.map((r) => r.id);
    for (const [id, ref] of Object.entries(ROUTE_ROWS)) {
      const row = matrix.rows.find((r) => r.id === id)!;
      expect(row.references, id).toEqual(ref);
      expect(ids, `${id} → ${ref.endpoint}`).toContain(ref.endpoint);
      expect(ids, `${id} → ${ref.management}`).toContain(ref.management);
      expect(row.surface, id).toBe('reachable-only');
    }
    for (const id of ADVERTISED_ROWS) {
      const row = matrix.rows.find((r) => r.id === id)!;
      expect(row.surface, id).toBe('advertised');
      expect(row.references ?? null, id).toBeNull();
    }
  });

  it('PM05-F1-07: all 8 routes carry DEV-14 Tier B ownership and four named pending route contracts; none is passed or implemented', () => {
    const index = validator.buildTestIndex(ROOT);
    const o24 = matrix.rows.find((r) => r.id === 'O24')!;
    for (const [action, caseLine] of REACHABLE_8) {
      const id = routeRowId(action);
      const row = matrix.rows.find((r) => r.id === id);
      expect(row, id).toBeDefined();
      expect(row!.route, id).toEqual({ file: 'src/actions.ts', symbol: 'handleOctoMessageAction', caseLine, sha256: SHA['src/actions.ts'] });
      const ref = ROUTE_ROWS[id]?.management;
      const owner = ref ? matrix.rows.find((r) => r.id === ref)! : o24;
      expect([row!.stage, row!.tier], id).toEqual([owner.stage, owner.tier]);
      expect([row!.stage, row!.tier], id).toEqual([['DEV-14'], 'B']);
      for (const kind of CONTRACT_KINDS) {
        const prefix = `${CONTRACT_FILE}#DEV-14 pending message route contracts > ${id} (DEV-14): ${kind} — `;
        const refs = row!.tests.filter((t) => t.startsWith(prefix));
        expect(refs, `${id} ${kind}`).toHaveLength(1);
        expect(index.get(refs[0])?.mode, `${id} ${kind}`).toBe('todo');
      }
      expect(row!.executionStatus, id).not.toBe('passed');
      expect(row!.implementationStatus, id).toBe('pending');
    }
  });

  it('PM05-F1-08: the route validator reports zero issues for the checked-in matrix and golden', () => {
    expect(validateMessageRoutes(matrix, golden, { testIndex: validator.buildTestIndex(ROOT) })).toEqual([]);
  });

  it('PM05-F1-09: negative controls — omissions, duplicates, wrong surface, missing provenance, unauthorized routes, wrong references and false passes fail', () => {
    const testIndex = validator.buildTestIndex(ROOT);
    const codes = (m: Matrix, g: unknown = golden) => validateMessageRoutes(m, g, { testIndex }).map((i) => `${i.code}:${i.id}`);
    const edit = (f: (m: Matrix) => void) => { const m = clone(matrix); f(m); return m; };
    const row = (m: Matrix, id: string) => m.rows.find((r) => r.id === id)!;

    expect(codes(edit((m) => { m.rows = m.rows.filter((r) => r.id !== 'O24.msg-route.channel-list'); }))).toContain('route-missing-row:channel-list');
    expect(codes(edit((m) => { m.rows.push({ ...clone(row(m, 'O24.msg.send')), id: 'O24.msg-route.send', kind: 'message-route', surface: 'reachable-only' }); }))).toContain('route-duplicate-row:send');
    expect(codes(edit((m) => { m.rows.push(clone(row(m, 'O24.msg-route.member-info'))); }))).toContain('route-duplicate-row:member-info');
    // a reachable-only route promoted to the advertised surface is a fabricated capability
    expect(codes(edit((m) => { Object.assign(row(m, 'O24.msg-route.member-info'), { id: 'O24.msg.member-info', kind: 'message-action', surface: 'advertised' }); }))).toContain('route-wrong-surface:O24.msg.member-info');
    expect(codes(edit((m) => { row(m, 'O24.msg-route.channel-info').surface = 'advertised'; }))).toContain('route-wrong-surface:O24.msg-route.channel-info');
    expect(codes(edit((m) => { row(m, 'O24.msg.read').surface = 'reachable-only'; }))).toContain('route-wrong-surface:O24.msg.read');
    expect(codes(edit((m) => { delete row(m, 'O24.msg-route.group-md-read').route; }))).toContain('route-missing-provenance:O24.msg-route.group-md-read');
    expect(codes(edit((m) => { (row(m, 'O24.msg.search').route as { caseLine: number }).caseLine = 194; }))).toContain('route-missing-provenance:O24.msg.search');
    expect(codes(edit((m) => { (row(m, 'O24.msg.send').route as { sha256: string }).sha256 = SHA['src/channel.ts']; }))).toContain('route-missing-provenance:O24.msg.send');
    expect(codes(edit((m) => { m.rows.push({ ...clone(row(m, 'O24.msg-route.member-info')), id: 'O24.msg-route.create-group' }); }))).toContain('route-unauthorized:O24.msg-route.create-group');
    expect(codes(edit((m) => { m.rows.push({ ...clone(row(m, 'O24.msg.send')), id: 'O24.msg.write-secret' }); }))).toContain('route-unauthorized:O24.msg.write-secret');
    expect(codes(edit((m) => { row(m, 'O24.msg-route.member-info').references = { endpoint: 'EP-12', management: 'O24.mgmt.group-members' }; }))).toContain('route-wrong-reference:O24.msg-route.member-info');
    expect(codes(edit((m) => { row(m, 'O24.msg-route.group-md-update').references = { endpoint: 'EP-15', management: 'O24.mgmt.group-md-read' }; }))).toContain('route-wrong-reference:O24.msg-route.group-md-update');
    expect(codes(edit((m) => { delete row(m, 'O24.msg-route.channel-list').references; }))).toContain('route-wrong-reference:O24.msg-route.channel-list');
    expect(codes(edit((m) => { row(m, 'O24.msg.read').references = { endpoint: 'EP-12', management: 'O24.mgmt.list-groups' }; }))).toContain('route-wrong-reference:O24.msg.read');
    expect(codes(edit((m) => { row(m, 'O24.msg-route.channel-info').stage = ['DEV-17']; }))).toContain('route-stage-tier:O24.msg-route.channel-info');
    expect(codes(edit((m) => { row(m, 'O24.msg.send').tier = 'C'; }))).toContain('route-stage-tier:O24.msg.send');
    // pending route contracts can never back a pass, and a provenance pass is not a contract pass
    expect(codes(edit((m) => { Object.assign(row(m, 'O24.msg-route.member-info'), { executionStatus: 'passed', evidence: 'test/evidence/x.xml' }); }))).toContain('route-contract-false-pass:O24.msg-route.member-info');
    expect(codes(edit((m) => { row(m, 'O24.msg.send').implementationStatus = 'implemented'; }))).toContain('route-contract-false-pass:O24.msg.send');
    expect(codes(edit((m) => {
      const r = row(m, 'O24.msg-route.channel-list');
      r.tests = r.tests.filter((t) => !t.startsWith(CONTRACT_FILE));
      Object.assign(r, { executionStatus: 'passed', evidence: 'test/evidence/x.xml' });
    }))).toContain('route-contract-missing:O24.msg-route.channel-list');
    expect(codes(edit((m) => { const r = row(m, 'O24.msg.search'); r.tests = r.tests.filter((t) => !t.includes(': cache — ')); }))).toContain('route-contract-missing:O24.msg.search');
    // a route contract borrowed from another route does not count
    expect(codes(edit((m) => {
      const r = row(m, 'O24.msg-route.group-md-read');
      r.tests = r.tests.map((t) => t.replace('O24.msg-route.group-md-read (DEV-14)', 'O24.msg-route.group-md-update (DEV-14)'));
    }))).toContain('route-contract-missing:O24.msg-route.group-md-read');

    // golden-side controls
    const g = (f: (x: Golden) => void) => { const x = clone(golden); f(x); return x; };
    expect(codes(matrix, g((x) => { x.actions = x.actions.filter((a) => a !== 'write-secret'); }))).toContain('golden-management-set:octo_management');
    expect(codes(matrix, g((x) => { x.actions.push('write-secret'); }))).toContain('golden-management-duplicate:write-secret');
    expect(codes(matrix, g((x) => { x.messageRoutes = x.messageRoutes!.filter((r) => r.action !== 'channel-info'); }))).toContain('golden-route-set:handleOctoMessageAction');
    expect(codes(matrix, g((x) => { x.messageRoutes!.push(clone(x.messageRoutes![0])); }))).toContain('golden-route-duplicate:send');
    expect(codes(matrix, g((x) => { x.messageActions = [...x.messageActions, 'member-info']; }))).toContain('golden-advertised-set:getAvailableActions');
    expect(codes(matrix, g((x) => { x.messageRoutes!.find((r) => r.action === 'member-info')!.advertised = true; }))).toContain('golden-advertised-set:getAvailableActions');
    expect(codes(matrix, g((x) => { delete x.ownership!.messageDispatcher; }))).toContain('golden-missing-provenance:messageDispatcher');
    expect(codes(matrix, g((x) => { x.sources!['src/actions.ts'] = '0'.repeat(64); }))).toContain('golden-missing-provenance:src/actions.ts');
  });

  it('PM05-F1-10: unchanged scope — 155 capability rows, 59 cron rows, Tier C management actions stay DEV-17 parity-later', () => {
    expect(matrix.rows.filter((r) => r.kind === 'capability')).toHaveLength(155);
    expect(matrix.rows.filter((r) => r.kind === 'cron')).toHaveLength(59);
    for (const a of ['voice-context-read', 'voice-context-update', 'voice-context-delete', 'write-secret']) {
      const r = matrix.rows.find((x) => x.id === `O24.mgmt.${a}`)!;
      expect([r.stage, r.tier, r.implementationStatus], a).toEqual([['DEV-17'], 'C', 'pending']);
    }
  });

  it('PM05-F1-11: the amendment is referenced by version from the golden and the matrix and its document records the counts', () => {
    const ref = { id: 'A-R8-PM05-01', ratification: 'owner-ratified-R8-AMD-01', doc: 'docs/amendments/R8-AMD-01.md' };
    expect(golden.amendment).toEqual(ref);
    expect((matrix.amendments as unknown[] | undefined) ?? []).toContainEqual(expect.objectContaining({ ...ref, version: 'R8-AMD-01' }));
    const docPath = new URL(`../../${ref.doc}`, import.meta.url);
    expect(existsSync(docPath)).toBe(true);
    const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
    for (const s of ['A-R8-PM05-01', 'A-R8-SB07-01', 'owner-ratified-R8-AMD-01', '24', '32', '30', '155', '59', SHA['src/actions.ts']]) expect(doc, s).toContain(s);
  });
});
