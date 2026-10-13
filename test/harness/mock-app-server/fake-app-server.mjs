#!/usr/bin/env node
/**
 * Scripted fake App Server over stdio JSONL (R8 §3.3.4 rule 7, §10.1 layer 2).
 * Implements the turn-protocol subset of codex 0.142.3 used by DEV-03/04 with
 * the same notification shape as the pinned binary
 * (test/fixtures/app-server/0.142.3/basic-turn.normalized.json), plus:
 *  - runtime.* fault points (FAKE_AS_FAULTS=[{point, times}]);
 *  - steering detection: a turn/start on a thread with an active turn is
 *    recorded as a violation (the runtime must never steer);
 *  - server-request accounting: requests left unanswered at shutdown are
 *    recorded as violations;
 *  - commandApproval: the pinned binary's uninterrupted exec-parity rejection
 *    path (A-R8-SB07-01): requestApproval → host reply → serverRequest/resolved
 *    → item/completed (failed, never executed) → turn/completed. A reply that is
 *    not the byte-level exec parity error is recorded as a violation.
 * Env: FAKE_AS_SCENARIO (JSON {turns:[{text?, delayMs?, hang?, serverRequest?, commandApproval?}]}),
 *      FAKE_AS_FAULTS, FAKE_AS_LOG (JSONL report path).
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// The runtime.* subset of src/seams/fault-plan.ts FAULT_POINT_NAMES this fake implements.
const RUNTIME_POINTS = ['runtime.dropInterruptResponse', 'runtime.dropTurnCompleted', 'runtime.failUnsubscribe', 'runtime.killChild'];

const scenario = JSON.parse(process.env.FAKE_AS_SCENARIO ?? '{"turns":[]}');
const faultsIn = JSON.parse(process.env.FAKE_AS_FAULTS ?? '[]');
const logPath = process.env.FAKE_AS_LOG;
const report = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); };

const faults = new Map();
for (const f of faultsIn) {
  if (!RUNTIME_POINTS.includes(f.point)) { report({ kind: 'config-error', message: `unknown fault point: ${f.point}` }); process.exit(2); }
  faults.set(f.point, f.times ?? 1);
}
const fault = (point) => {
  const n = faults.get(point) ?? 0;
  if (n <= 0) return false;
  faults.set(point, n - 1);
  report({ kind: 'fault', point });
  return true;
};

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let initialized = false;
const threads = new Map(); // threadId → { active: turn | null }
const turns = [...(scenario.turns ?? [])];
let nextServerRequestId = 0;
const pendingServerRequests = new Map(); // id → { resolve, method, parity? }
const parityMessage = (threadId) => `command execution approval is not supported in exec mode for thread \`${threadId}\``;

const turnObj = (id, status) => ({ id, items: [], itemsView: 'notLoaded', status, error: null, startedAt: null, completedAt: null, durationMs: null });
const threadObj = (id) => ({ id, sessionId: id, preview: '', ephemeral: false, modelProvider: 'openai', status: { type: 'idle' }, turns: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function complete(threadId, turn, status) {
  const t = threads.get(threadId);
  if (!t || t.active !== turn || turn.done) return;
  turn.done = true;
  t.active = null;
  if (status === 'interrupted' && fault('runtime.dropTurnCompleted')) return;
  send({ method: 'turn/completed', params: { threadId, turn: turnObj(turn.id, status) } });
}

async function runTurn(threadId, turn, script, input) {
  send({ method: 'turn/started', params: { threadId, turn: turnObj(turn.id, 'inProgress') } });
  const userItem = { type: 'userMessage', id: randomUUID(), clientId: null, content: input };
  send({ method: 'item/started', params: { item: userItem, threadId, turnId: turn.id } });
  send({ method: 'item/completed', params: { item: userItem, threadId, turnId: turn.id } });
  if (fault('runtime.killChild')) { report({ kind: 'exit', reason: 'runtime.killChild' }); process.exit(9); }
  if (script.serverRequest) {
    const id = nextServerRequestId++;
    const answered = new Promise((resolve) => pendingServerRequests.set(id, { resolve, method: script.serverRequest.method }));
    send({ id, method: script.serverRequest.method, params: { threadId, turnId: turn.id, ...script.serverRequest.params } });
    await answered;
    send({ method: 'serverRequest/resolved', params: { threadId, requestId: id } });
  }
  if (script.commandApproval) await rejectedCommand(threadId, turn, script.commandApproval);
  if (script.hang) return; // only an interrupt ends this turn
  if (script.delayMs) await sleep(script.delayMs);
  if (turn.done) return;
  const msg = { type: 'agentMessage', id: `msg_${turn.id}`, text: script.text ?? '', phase: null, memoryCitation: null };
  send({ method: 'item/started', params: { item: msg, threadId, turnId: turn.id } });
  send({ method: 'item/completed', params: { item: msg, threadId, turnId: turn.id } });
  complete(threadId, turn, 'completed');
}

async function rejectedCommand(threadId, turn, spec) {
  const itemId = spec.itemId ?? `call_${randomUUID()}`;
  const command = spec.command ?? 'true';
  const item = (status) => ({ type: 'commandExecution', id: itemId, command, cwd: '/fake', processId: null, source: 'agent', status, commandActions: [{ type: 'unknown', command }], aggregatedOutput: null, exitCode: null, durationMs: null });
  send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  send({ method: 'item/started', params: { item: item('inProgress'), threadId, turnId: turn.id } });
  const id = nextServerRequestId++;
  const answered = new Promise((resolve) => pendingServerRequests.set(id, { resolve, method: 'item/commandExecution/requestApproval', parity: { threadId } }));
  send({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: turn.id, itemId, reason: spec.reason ?? null, command, cwd: '/fake' } });
  await answered;
  send({ method: 'serverRequest/resolved', params: { threadId, requestId: id } });
  send({ method: 'item/completed', params: { item: item('failed'), threadId, turnId: turn.id } });
  send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } });
}

function handle(m, line) {
  if (m.method === undefined && m.id !== undefined) { // response to a server request
    const p = pendingServerRequests.get(m.id);
    if (p) {
      pendingServerRequests.delete(m.id);
      const parity = p.parity ? line === JSON.stringify({ id: m.id, error: { code: -32000, message: parityMessage(p.parity.threadId) } }) : undefined;
      report({ kind: 'server-request-answered', id: m.id, method: p.method, error: m.error ?? null, ...(p.parity ? { parity } : {}) });
      if (parity === false) report({ kind: 'violation', code: 'non-parity-reply', id: m.id, line });
      p.resolve();
    }
    return;
  }
  report({ kind: 'request', method: m.method, params: m.params });
  if (m.id === undefined) return; // client notification (initialized)
  const err = (code, message) => send({ id: m.id, error: { code, message } });
  if (m.method === 'initialize') {
    if (initialized) return err(-32600, 'Already initialized');
    initialized = true;
    return send({ id: m.id, result: { userAgent: 'fake-app-server/0.142.3', codexHome: '/fake', platformFamily: 'unix', platformOs: process.platform } });
  }
  if (!initialized) return err(-32600, 'Not initialized');
  const p = m.params ?? {};
  switch (m.method) {
    case 'thread/start': {
      const id = randomUUID();
      threads.set(id, { active: null });
      send({ id: m.id, result: { thread: threadObj(id) } });
      return send({ method: 'thread/started', params: { thread: threadObj(id) } });
    }
    case 'thread/resume': {
      if (!threads.has(p.threadId)) threads.set(p.threadId, { active: null });
      return send({ id: m.id, result: { thread: threadObj(p.threadId) } });
    }
    case 'turn/start': {
      const t = threads.get(p.threadId);
      if (!t) return err(-32600, `thread not found: ${p.threadId}`);
      if (t.active) {
        report({ kind: 'violation', code: 'steering', threadId: p.threadId, activeTurn: t.active.id });
        return send({ id: m.id, result: { turn: turnObj(randomUUID(), 'inProgress') } });
      }
      const turn = { id: randomUUID(), done: false };
      t.active = turn;
      send({ id: m.id, result: { turn: turnObj(turn.id, 'inProgress') } });
      void runTurn(p.threadId, turn, turns.shift() ?? { text: '' }, p.input ?? []);
      return;
    }
    case 'turn/interrupt': {
      const t = threads.get(p.threadId);
      const turn = t?.active;
      if (!fault('runtime.dropInterruptResponse')) send({ id: m.id, result: {} });
      if (turn && turn.id === p.turnId) setTimeout(() => complete(p.threadId, turn, 'interrupted'), 5);
      return;
    }
    case 'thread/unsubscribe':
      if (fault('runtime.failUnsubscribe')) return err(-32603, 'unsubscribe failed (fault: runtime.failUnsubscribe)');
      return send({ id: m.id, result: { status: 'unsubscribed' } });
    case 'thread/loaded/list':
      return send({ id: m.id, result: { data: [...threads.keys()] } });
    default:
      return err(-32601, `method not supported by the fake: ${m.method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line), line); } catch (e) { report({ kind: 'parse-error', message: String(e) }); }
  }
});
process.stdin.on('end', () => {
  for (const [id, p] of pendingServerRequests) report({ kind: 'violation', code: 'unanswered-server-request', id, method: p.method });
  report({ kind: 'exit', reason: 'stdin-eof' });
  process.exit(0);
});
