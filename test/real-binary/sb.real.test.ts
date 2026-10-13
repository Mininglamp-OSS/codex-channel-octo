/**
 * Real-binary contract cases SB-01..SB-14 and protocol spike SP-T1 (R8 §6.3/§6.4),
 * executed against the pinned codex 0.142.3 binary from the installed SDK
 * vendor package. The model provider is the local mock Responses server;
 * every run uses an isolated temporary CODEX_HOME/HOME, NO_PROXY for loopback
 * and a fake API key. Raw JSONL transcripts and mock request logs are written
 * under $DEV01_EVIDENCE_DIR/real-binary/ (default artifacts/evidence/real-binary/)
 * for each case; test/evidence/dev01/real-binary/ is a committed snapshot.
 *
 * Expectations are R8's normative statements. If the binary contradicts one,
 * the case fails with the raw evidence retained — expectations are not relaxed.
 */
import { describe, it, expect, beforeAll, afterEach, type TestContext } from 'vitest';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveCodexBinary, RealEnv, spawnAppServer, runExec, readRolloutTurnContexts, waitForPidExit, spawnHostedAppServer, generateProtocolSchema,
  type AppServerHandle,
} from './harness.js';
import { startMockResponses } from '../harness/mock-responses/server.mjs';
import { recordCase } from '../harness/report/case-meta.js';
import { normalizeTranscript } from '../harness/app-server-normalize.js';
import { classifySpT1, callable } from './sp-t1-classify.js';
import { checkSb07RejectionPath } from '../harness/sb07/oracle.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const owned: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const f of owned.splice(0).reverse()) await f(); });

let bin: { path: string; version: string };
beforeAll(() => { bin = resolveCodexBinary(); });

async function setup(caseId: string, script: Array<Record<string, unknown>> = []) {
  const env = RealEnv.create(caseId);
  const mock = await startMockResponses({ script, logPath: join(env.evidenceDir, 'mock-requests.jsonl') });
  owned.push(() => env.finish());
  owned.push(() => mock.close());
  return { env, mock };
}
function track<T extends AppServerHandle>(h: T): T { owned.push(() => h.close()); return h; }
const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pinned binary', () => {
  it('SB-00: the binary under test is exactly codex-cli 0.142.3 from the installed vendor package', () => {
    expect(bin.version).toBe('codex-cli 0.142.3');
    expect(bin.path).toMatch(/node_modules\/@openai\/codex-[a-z0-9-]+\/vendor\//);
  });
});

describe('SB contract cases', () => {
  it('SB-01: pre-init request → -32600 Not initialized; second initialize → -32600 Already initialized', async (ctx) => {
    const { env, mock } = await setup('SB-01');
    const as = track(spawnAppServer(env, mock, { login: false }));
    const pre = await as.request('thread/start', {}).catch((e) => e);
    await as.request('initialize', as.initializeParams());
    const again = await as.request('initialize', as.initializeParams()).catch((e) => e);
    const rpc = (e: unknown) => ({ code: (e as { code?: number }).code, message: (e as { message?: string }).message });
    recordCase(ctx, { pre: rpc(pre), again: rpc(again) }, env.evidence(as));
    expect(pre).toMatchObject({ code: -32600, message: 'Not initialized' });
    expect(again).toMatchObject({ code: -32600, message: 'Already initialized' });
  });

  it('SB-02: a second turn/start on an active thread returns a turn id that receives no turn/started or turn/completed within 10 s', async (ctx) => {
    const { env, mock } = await setup('SB-02', [{ delayMs: 14_000, text: 'slow first' }, { text: 'second' }]);
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd() });
    const t1 = await as.request('turn/start', { threadId: tid, input: text('first'), cwd: env.cwd(), approvalPolicy: 'never', effort: 'low' }) as { turn: { id: string } };
    await as.waitForNotification((n) => n.method === 'turn/started');
    const t2 = await as.request('turn/start', { threadId: tid, input: text('second'), cwd: env.cwd(), approvalPolicy: 'never', effort: 'low' }) as { turn: { id: string } };
    const windowStart = as.transcript.length;
    await sleep(10_000);
    const t2Events = as.transcript.slice(windowStart).filter((e) => e.dir === 'in' && ['turn/started', 'turn/completed'].includes(String(e.message.method))
      && (e.message.params as { turn?: { id?: string } })?.turn?.id === t2.turn.id);
    recordCase(ctx, { firstTurnId: t1.turn.id, secondTurnId: t2.turn.id, sameId: t1.turn.id === t2.turn.id, eventsForSecondIdWithin10s: t2Events.length }, env.evidence(as));
    await as.request('turn/interrupt', { threadId: tid, turnId: t1.turn.id }).catch(() => undefined);
    expect(typeof t2.turn.id).toBe('string');
    expect(t2Events).toEqual([]);
  }, 60_000);
  it.todo('SB-02 runtime (DEV-04): a second runTurn on the same lane does not call turn/start until the first is terminal');

  it('SB-03: after a terminal `codex exec resume` turn, thread/resume{config:{}} sees it; an identical resume without config does not', async (ctx) => {
    const { env, mock } = await setup('SB-03');
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd() });
    await as.runTurn(tid, 'alpha-sb03');
    await as.request('thread/unsubscribe', { threadId: tid });
    const exec = await runExec(env, mock, ['exec', 'resume', '--skip-git-repo-check', '--json', tid, 'bravo-terminal-sb03']);
    expect(exec.code).toBe(0);
    await as.request('thread/resume', { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only' });
    await as.runTurn(tid, 'charlie-sb03');
    const withoutConfig = mock.lastModelRequest()!;
    await as.request('thread/unsubscribe', { threadId: tid });
    await as.request('thread/resume', { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only', config: {} });
    await as.runTurn(tid, 'delta-sb03');
    const withConfig = mock.lastModelRequest()!;
    const sawWithout = JSON.stringify(withoutConfig.body.input).includes('bravo-terminal-sb03');
    const sawWith = JSON.stringify(withConfig.body.input).includes('bravo-terminal-sb03');
    recordCase(ctx, { execExit: exec.code, resumeWithoutConfigSeesTerminalTurn: sawWithout, resumeWithConfigSeesTerminalTurn: sawWith }, env.evidence(as));
    expect(sawWith).toBe(true);
    expect(sawWithout).toBe(false);
  }, 120_000);

  it('SB-04: turn/start overrides persist across turns and a config:{} reload', async (ctx) => {
    const { env, mock } = await setup('SB-04');
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd() });
    await as.runTurn(tid, 'one', { effort: 'high' });
    const e1 = mock.lastModelRequest()!.body.reasoning?.effort;
    await as.runTurn(tid, 'two', {});
    const e2 = mock.lastModelRequest()!.body.reasoning?.effort;
    await as.request('thread/unsubscribe', { threadId: tid });
    await as.request('thread/resume', { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only', config: {} });
    await as.runTurn(tid, 'three', {});
    const e3 = mock.lastModelRequest()!.body.reasoning?.effort;
    recordCase(ctx, { efforts: [e1, e2, e3] }, env.evidence(as));
    expect([e1, e2, e3]).toEqual(['high', 'high', 'high']);
  }, 120_000);
  it.todo('SB-04 runtime (DEV-04): turn/start carries only cwd, approvalPolicy and effort (asserted from the runtime request log)');

  it('SB-05: AGENTS.md edited after the first turn leaves the recorded instructions unchanged on later turns', async (ctx) => {
    const { env, mock } = await setup('SB-05');
    const cwd = env.cwd();
    writeFileSync(join(cwd, 'AGENTS.md'), 'INSTR-ALPHA-SB05\n');
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd });
    await as.runTurn(tid, 'first');
    const r1 = JSON.stringify(mock.lastModelRequest()!.body);
    writeFileSync(join(cwd, 'AGENTS.md'), 'INSTR-BRAVO-SB05\n');
    await as.runTurn(tid, 'second');
    const r2 = JSON.stringify(mock.lastModelRequest()!.body);
    recordCase(ctx, { firstHasAlpha: r1.includes('INSTR-ALPHA-SB05'), secondHasAlpha: r2.includes('INSTR-ALPHA-SB05'), secondHasBravo: r2.includes('INSTR-BRAVO-SB05') }, env.evidence(as));
    expect(r1).toContain('INSTR-ALPHA-SB05');
    expect(r2).toContain('INSTR-ALPHA-SB05');
    expect(r2).not.toContain('INSTR-BRAVO-SB05');
  }, 120_000);

  it('SB-06: an exec-created thread resumes in app-server and an app-server thread resumes in `codex exec resume`, both with prior turns', async (ctx) => {
    const { env, mock } = await setup('SB-06');
    const exec1 = await runExec(env, mock, ['exec', '--skip-git-repo-check', '--json', '--cd', env.cwd(), 'exec-made-sb06']);
    expect(exec1.code).toBe(0);
    const execThread = exec1.threadId!;
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const resumed = await as.request('thread/resume', { threadId: execThread, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only' }) as { thread: { turns: Array<{ items: Array<{ type: string; content?: Array<{ text?: string }> }> }> } };
    const execTurnSeen = JSON.stringify(resumed.thread.turns).includes('exec-made-sb06');
    const asThread = await as.startThread({ cwd: env.cwd() });
    await as.runTurn(asThread, 'app-server-made-sb06');
    await as.request('thread/unsubscribe', { threadId: asThread });
    const exec2 = await runExec(env, mock, ['exec', 'resume', '--skip-git-repo-check', '--json', asThread, 'follow-up-sb06']);
    const execSawPrior = JSON.stringify(mock.lastModelRequest()!.body.input).includes('app-server-made-sb06');
    recordCase(ctx, { execThread, priorTurnsListed: resumed.thread.turns.length, execTurnSeen, exec2Exit: exec2.code, execSawPrior }, env.evidence(as));
    expect(resumed.thread.turns.length).toBeGreaterThan(0);
    expect(execTurnSeen).toBe(true);
    expect(exec2.code).toBe(0);
    expect(exec2.threadId).toBe(asThread);
    expect(execSawPrior).toBe(true);
  }, 120_000);

  // A-R8-SB07-01 (R8 amendment, owner-ratified): the pinned binary resolves the
  // request before the item and turn complete. Strict correlated sequence:
  // requestApproval → host error reply → serverRequest/resolved →
  // item/completed:failed → turn/completed:completed (oracle: test/harness/sb07/).
  it('SB-07: never → commandExecution with no server request; on-request escalation in a fresh process → request id 0, byte-exact parity reply ≤ 5 s, serverRequest/resolved, item failed, turn completed (A-R8-SB07-01)', async (ctx) => {
    const { env, mock } = await setup('SB-07', [
      { functionCall: { name: 'exec_command', arguments: { cmd: 'echo sb07-never' } } }, { text: 'done-never' },
      { functionCall: { name: 'exec_command', arguments: { cmd: 'echo sb07-esc', sandbox_permissions: 'require_escalated', justification: 'contract test' } } }, { text: 'done-escalated' },
    ]);
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const t1 = await as.startThread({ cwd: env.cwd() });
    const before = as.serverRequests.length;
    await as.runTurn(t1, 'run a command');
    const neverItems = as.notifications().filter((n) => n.method === 'item/started' && (n.params as { item: { type: string } }).item.type === 'commandExecution');
    const neverRequests = as.serverRequests.length - before;

    // The harness default answer is the exec-parity rejection under test.
    const t2 = await as.startThread({ cwd: env.cwd(), approvalPolicy: 'on-request' });
    await as.runTurn(t2, 'run escalated', { approvalPolicy: 'on-request' });
    const verdict = checkSb07RejectionPath(as.transcript, { threadId: t2, incarnation: as.incarnation });
    const reply = as.transcript.filter((e) => e.dir === 'out' && e.message.method === undefined && e.message.id === 0);
    const evidence = env.evidence(as);
    recordCase(ctx, { neverCommandItems: neverItems.length, neverServerRequests: neverRequests, incarnation: as.incarnation, record: verdict.record, indices: verdict.indices, violations: verdict.violations, replyRaw: reply.map((e) => e.raw) }, evidence);
    expect(neverItems.length).toBeGreaterThan(0);
    expect(neverRequests).toBe(0);
    expect.soft(reply.map((e) => [e.raw, e.incarnation])).toEqual([[
      `{"id":0,"error":{"code":-32000,"message":${JSON.stringify(`command execution approval is not supported in exec mode for thread \`${t2}\``)}}}`,
      as.incarnation,
    ]]);
    expect.soft(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  }, 120_000);

  it('SB-08: turn/interrupt → {} within 2 s, then turn/completed status=interrupted within 5 s', async (ctx) => {
    const { env, mock } = await setup('SB-08', [{ hang: true }]);
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd() });
    const t = await as.request('turn/start', { threadId: tid, input: text('hang'), cwd: env.cwd(), approvalPolicy: 'never', effort: 'low' }) as { turn: { id: string } };
    await as.waitForNotification((n) => n.method === 'turn/started');
    await mock.waitForModelRequests(1);
    const t0 = performance.now();
    const resp = await as.request('turn/interrupt', { threadId: tid, turnId: t.turn.id });
    const respMs = performance.now() - t0;
    const done = await as.waitForNotification((n) => n.method === 'turn/completed', 10_000);
    const doneMs = performance.now() - t0;
    recordCase(ctx, { response: resp, responseMs: Math.round(respMs), completedMs: Math.round(doneMs), status: (done.params as { turn: { status: string } }).turn.status }, env.evidence(as));
    expect(resp).toEqual({});
    expect(respMs).toBeLessThanOrEqual(2_000);
    expect((done.params as { turn: { status: string } }).turn.status).toBe('interrupted');
    expect(doneMs).toBeLessThanOrEqual(5_000);
  }, 60_000);

  it('SB-09: two concurrent 4 s turns on different threads take ≤ 1.3× single-turn wall time (median of 5 runs)', async (ctx) => {
    const { env, mock } = await setup('SB-09');
    mock.setDefault({ delayMs: 4_000, text: 'four seconds' });
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const singles: number[] = [];
    const pairs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await as.startThread({ cwd: env.cwd() });
      let t0 = performance.now();
      await as.runTurn(a, `single-${i}`);
      singles.push(performance.now() - t0);
      const b = await as.startThread({ cwd: env.cwd() });
      const c = await as.startThread({ cwd: env.cwd() });
      t0 = performance.now();
      await Promise.all([as.runTurn(b, `pair-b-${i}`), as.runTurn(c, `pair-c-${i}`)]);
      pairs.push(performance.now() - t0);
    }
    const median = (v: number[]) => [...v].sort((x, y) => x - y)[2];
    const ratio = median(pairs) / median(singles);
    recordCase(ctx, { singlesMs: singles.map(Math.round), pairsMs: pairs.map(Math.round), ratio }, env.evidence(as));
    expect(ratio).toBeLessThanOrEqual(1.3);
  }, 180_000);

  it.for([['SIGKILL', 2_000], ['SIGTERM', 2_000], ['stdin-EOF', 30_000]] as Array<[string, number]>)('SB-10 (%s): mid-turn termination exits within bound and the turn reads back interrupted after respawn', { timeout: 90_000 }, async ([mode, boundMs]: [string, number], ctx: TestContext) => {
    const { env, mock } = await setup(`SB-10-${mode}`, [{ hang: true }]);
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd() });
    await as.request('turn/start', { threadId: tid, input: text('hang'), cwd: env.cwd(), approvalPolicy: 'never', effort: 'low' });
    await as.waitForNotification((n) => n.method === 'turn/started');
    await mock.waitForModelRequests(1);
    const t0 = performance.now();
    if (mode === 'stdin-EOF') as.endStdin(); else as.kill(mode as NodeJS.Signals);
    await as.exited;
    const exitMs = performance.now() - t0;
    const as2 = track(spawnAppServer(env, mock));
    await as2.ready();
    const resumed = await as2.request('thread/resume', { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only' }) as { thread: { turns: Array<{ status: string }> } };
    const last = resumed.thread.turns.at(-1)?.status;
    recordCase(ctx, { mode, exitMs: Math.round(exitMs), lastTurnStatus: last }, [...env.evidence(as), ...env.evidence(as2)]);
    expect(exitMs).toBeLessThanOrEqual(boundMs);
    expect(last).toBe('interrupted');
  });

  it('SB-10 (host SIGKILL): the app-server child exits on stdin EOF within 30 s after its host is killed (measured)', async (ctx) => {
    const { env, mock } = await setup('SB-10-host', [{ hang: true }]);
    const host = await spawnHostedAppServer(env, mock);
    owned.push(() => host.cleanup());
    await mock.waitForModelRequests(1);
    const t0 = performance.now();
    process.kill(host.hostPid, 'SIGKILL');
    const exited = await waitForPidExit(host.childPid, 35_000);
    const ms = performance.now() - t0;
    recordCase(ctx, { childExited: exited, childExitMs: Math.round(ms) }, [host.logPath]);
    expect(exited).toBe(true);
    expect(ms).toBeLessThanOrEqual(30_000);
  }, 60_000);

  it('SB-11: CODEX_API_KEY env alone sends no Authorization; ephemeral store + account/login/start sends Bearer <key> and writes no auth.json', async (ctx) => {
    const { env, mock } = await setup('SB-11');
    const envOnly = track(spawnAppServer(env, mock, { login: false, ephemeral: false, extraEnv: { CODEX_API_KEY: env.fakeKey } }));
    await envOnly.ready();
    const t = await envOnly.startThread({ cwd: env.cwd() });
    await envOnly.runTurn(t, 'env-only', {}, 30_000).catch((e) => e);
    const envOnlyAuth = mock.requests.filter((r) => r.headers.authorization).length;
    const envOnlyRequests = mock.requests.length;
    await envOnly.close();
    const env2 = RealEnv.create('SB-11-login');
    owned.push(() => env2.finish());
    const logged = track(spawnAppServer(env2, mock, { login: true, ephemeral: true }));
    await logged.ready();
    const t2 = await logged.startThread({ cwd: env2.cwd() });
    const mark = mock.requests.length;
    await logged.runTurn(t2, 'logged-in');
    const loggedAuth = mock.requests.slice(mark).map((r) => r.headers.authorization);
    const authJson = existsSync(join(env2.home, 'auth.json'));
    recordCase(ctx, { envOnlyRequests, envOnlyRequestsWithAuthorization: envOnlyAuth, loggedAuthorization: loggedAuth.map((a) => (a === `Bearer ${env2.fakeKey}` ? 'Bearer <fake-key>' : a ? '<other>' : null)), authJsonWritten: authJson }, [...env.evidence(envOnly), ...env2.evidence(logged)]);
    expect(envOnlyAuth).toBe(0);
    expect(loggedAuth.length).toBeGreaterThan(0);
    expect(loggedAuth.every((a) => a === `Bearer ${env2.fakeKey}`)).toBe(true);
    expect(authJson).toBe(false);
  }, 120_000);

  it('SB-12: exec with -c approval_policy="on-request" records turn_context.approval_policy == "never"', async (ctx) => {
    const { env, mock } = await setup('SB-12');
    const r = await runExec(env, mock, ['exec', '--skip-git-repo-check', '--json', '--cd', env.cwd(), '-c', 'approval_policy="on-request"', 'policy probe']);
    const ctxs = readRolloutTurnContexts(env, r.threadId!);
    recordCase(ctx, { exit: r.code, approvalPolicies: ctxs.map((c) => c.approval_policy) }, [r.logPath, env.rolloutEvidencePath(r.threadId!)]);
    expect(r.code).toBe(0);
    expect(ctxs.length).toBeGreaterThan(0);
    expect(ctxs.every((c) => c.approval_policy === 'never')).toBe(true);
  }, 60_000);

  it('SB-13: runtimeWorkspaceRoots:[cwd,X] + network -c gives the same turn_context sandbox as exec --add-dir X', async (ctx) => {
    const { env, mock } = await setup('SB-13');
    const cwd = env.cwd('work');
    const extra = env.cwd('extra');
    const exec = await runExec(env, mock, ['exec', '--skip-git-repo-check', '--json', '--cd', cwd, '--sandbox', 'workspace-write', '--add-dir', extra, '-c', 'sandbox_workspace_write.network_access=true', 'roots probe']);
    const execCtx = readRolloutTurnContexts(env, exec.threadId!).at(-1)!;
    const as = track(spawnAppServer(env, mock, { extraConfig: ['sandbox_workspace_write.network_access=true'] }));
    await as.ready();
    const tid = await as.startThread({ cwd, sandbox: 'workspace-write', runtimeWorkspaceRoots: [cwd, extra] });
    await as.runTurn(tid, 'roots probe', { cwd });
    const asCtx = readRolloutTurnContexts(env, tid).at(-1)!;
    const pick = (c: Record<string, unknown>) => ({ cwd: c.cwd, approval_policy: c.approval_policy, sandbox_policy: c.sandbox_policy, workspace_roots: c.workspace_roots ?? null });
    recordCase(ctx, { exec: pick(execCtx), appServer: pick(asCtx) }, [exec.logPath, ...env.evidence(as)]);
    expect(pick(asCtx)).toEqual(pick(execCtx));
  }, 120_000);

  it('SB-14: `codex app-server --session-source exec` exits non-zero with "unexpected argument"', async (ctx) => {
    const { env, mock } = await setup('SB-14');
    const r = await runExec(env, mock, ['app-server', '--session-source', 'exec'], { stdin: '' });
    recordCase(ctx, { exit: r.code, stderrHead: r.stderr.slice(0, 400) }, [r.logPath]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('unexpected argument');
  }, 30_000);
});

describe('SP-T1 dynamic tools spike', () => {
  it('SP-T1: dynamicTools registered at thread/start — callable on turn 1, after thread/resume{config:{}}, and after respawn + resume (outcome A/B/C recorded)', async (ctx) => {
    const call = (n: number) => ({ functionCall: { name: 'octo_probe', arguments: { q: `call-${n}` } } });
    const { env, mock } = await setup('SP-T1', [call(1), { text: 'after-1' }, call(2), { text: 'after-2' }, call(3), { text: 'after-3' }]);
    const tool = { type: 'function', name: 'octo_probe', description: 'DEV-01 probe tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
    const answer = (r: { method: string; params: unknown }) => r.method === 'item/tool/call'
      ? { result: { contentItems: [{ type: 'inputText', text: `probe-ok:${JSON.stringify((r.params as { arguments: unknown }).arguments)}` }], success: true } }
      : { error: { code: -32000, message: `${r.method} is not supported in exec mode` } };
    const stage = async (as: AppServerHandle, tid: string, label: string) => {
      const mark = mock.requests.length;
      const callsBefore = as.serverRequests.filter((r) => r.method === 'item/tool/call').length;
      await as.runTurn(tid, `use the probe (${label})`, {}, 30_000).catch(() => undefined);
      const reqs = mock.requests.slice(mark).filter((r) => !r.warmup);
      const advertised = reqs.some((r) => JSON.stringify(r.body.tools ?? []).includes('octo_probe'));
      const called = as.serverRequests.filter((r) => r.method === 'item/tool/call').length > callsBefore;
      const toolOutputSeen = reqs.some((r) => JSON.stringify(r.body.input ?? []).includes('probe-ok'));
      return { advertised, called, toolOutputSeen };
    };
    const as = track(spawnAppServer(env, mock));
    as.onServerRequest = answer;
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd(), dynamicTools: [tool] });
    const turn1 = await stage(as, tid, 'turn1');
    await as.request('thread/unsubscribe', { threadId: tid });
    await as.request('thread/resume', { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only', config: {} });
    const afterResume = await stage(as, tid, 'resume');
    await as.close();
    const as2 = track(spawnAppServer(env, mock));
    as2.onServerRequest = answer;
    await as2.ready();
    await as2.request('thread/resume', { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only', config: {} });
    const afterRespawn = await stage(as2, tid, 'respawn');
    const ok = callable;
    // Schema-backed re-registration probe: which non-start requests of the pinned
    // binary accept dynamicTools? (R8 §6.4 outcome B requires such a path.)
    const schema = generateProtocolSchema(env);
    const registrationPaths = Object.entries(schema.methods)
      .filter(([m, ref]) => m !== 'thread/start' && ref && Object.keys(schema.definitions[ref]?.properties ?? {}).includes('dynamicTools'))
      .map(([m]) => m);
    let reRegistration: { method: string; result: unknown; afterReRegistration: typeof turn1 } | null = null;
    if (ok(turn1) && !(ok(afterResume) && ok(afterRespawn)) && registrationPaths.length > 0) {
      const method = registrationPaths[0];
      const result = await as2.request(method, { threadId: tid, cwd: env.cwd(), approvalPolicy: 'never', sandbox: 'read-only', config: {}, dynamicTools: [tool] }).catch((e: unknown) => ({ error: String(e) }));
      mock.push(call(4)); mock.push({ text: 'after-4' });
      reRegistration = { method, result, afterReRegistration: await stage(as2, tid, 're-registration') };
    }
    // Exact R8 §6.4 classification; anything else is unclassified and fails.
    const { outcome, basis } = classifySpT1({ turn1, afterResume, afterRespawn, registrationPaths, reRegistration });
    const evidence = { caseId: 'SP-T1', pin: '0.142.3', turn1, afterResume, afterRespawn, schemaRegistrationPathsBesidesThreadStart: registrationPaths, reRegistration, outcome, basis };
    writeFileSync(join(env.evidenceDir, 'sp-t1-outcome.json'), JSON.stringify(evidence, null, 2) + '\n');
    recordCase(ctx, evidence, [...env.evidence(as), ...env.evidence(as2), relative(REPO_ROOT, join(env.evidenceDir, 'sp-t1-outcome.json'))]);
    expect(['A', 'B', 'C'], `SP-T1 unclassified: ${JSON.stringify(evidence)}`).toContain(outcome);
  }, 180_000);
});

describe('protocol fixture capture', () => {
  it('SB-FIX: the basic-turn normalized notification shape matches the committed 0.142.3 fixture used by the fake App Server', async (ctx) => {
    const { env, mock } = await setup('SB-FIX', [{ text: 'Hello from mock' }]);
    const as = track(spawnAppServer(env, mock));
    await as.ready();
    const tid = await as.startThread({ cwd: env.cwd() });
    await as.runTurn(tid, 'hi');
    await as.request('thread/unsubscribe', { threadId: tid });
    const seq = normalizeTranscript(as.transcript);
    const fixtureUrl = new URL('../fixtures/app-server/0.142.3/basic-turn.normalized.json', import.meta.url);
    if (process.env.DEV01_UPDATE_FIXTURES === '1') writeFileSync(fixtureUrl, JSON.stringify({ pin: '0.142.3', capturedBy: 'test/real-binary/sb.real.test.ts#SB-FIX', sequence: seq }, null, 2) + '\n');
    const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { sequence: string[] };
    recordCase(ctx, { sequence: seq }, env.evidence(as));
    expect(seq).toEqual(fixture.sequence);
  }, 60_000);
});
