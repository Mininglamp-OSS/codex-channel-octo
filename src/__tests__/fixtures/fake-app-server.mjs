#!/usr/bin/env node
// Scripted stand-in for `codex app-server --listen stdio://` (runner tests only).
// argv[2] selects the scenario; every received frame is appended to argv[3].
import { appendFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'ok';
const log = process.argv[3];
const THREAD = 'thr-1';
const TURN = 'turn-1';
let buffer = '';
// While batching, frames are joined into one write so the client reads them in one chunk.
let batch = null;
const send = (o) => { const line = JSON.stringify(o) + '\n'; if (batch !== null) batch += line; else process.stdout.write(line); };
const coalesced = (fn) => { if (batch !== null) { fn(); return; } batch = ''; try { fn(); } finally { const out = batch; batch = null; process.stdout.write(out); } };
const later = (fn) => setTimeout(fn, 30);
const note = (method, params) => send({ method, params });
const turn = (id, status = 'inProgress', error = null) => ({ id, rootTurnId: id, items: [], itemsView: 'notLoaded', status, error, startedAt: null, completedAt: null, durationMs: null });
const item = (it) => ({ item: it, threadId: THREAD, turnId: TURN, startedAtMs: 0 });

function finish(status = 'completed', error = null, turnId = TURN) {
  note('thread/tokenUsage/updated', { threadId: THREAD, turnId, tokenUsage: { last: { inputTokens: 3, cachedInputTokens: 1, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } } });
  note('turn/completed', { threadId: THREAD, turn: turn(turnId, status, error) });
}

// A previous turn on our thread, still streaming when the thread opens (TB-3(d)).
function oldTurn() {
  note('turn/started', { threadId: THREAD, turn: turn('turn-old') });
  note('item/completed', { item: { type: 'agentMessage', id: 'old1', text: 'OLD TURN OUTPUT', phase: 'final_answer' }, threadId: THREAD, turnId: 'turn-old', completedAtMs: 0 });
  finish('completed', null, 'turn-old');
}

// Our turn runs to its terminal before the turn/start response (TB-3(a)/(b)).
function terminalFirst() {
  note('turn/started', { threadId: THREAD, turn: turn(TURN) });
  body(); finish();
}

// Another turn starting on our thread (TB-3(c) conflict while our binding is open).
const conflict = (threadId = THREAD, id = 'turn-2') => note('turn/started', { threadId, turn: turn(id) });

function body() {
  note('item/started', item({ type: 'commandExecution', id: 'cmd1', command: 'ls', cwd: '/', processId: null, source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }));
  note('item/completed', item({ type: 'commandExecution', id: 'cmd1', command: 'ls', cwd: '/', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: 'a', exitCode: 0, durationMs: 1 }));
  note('item/completed', item({ type: 'agentMessage', id: 'msg1', text: 'hello', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }));
}

function onTurnStart(id) {
  switch (scenario) {
    case 'late-call':
    case 'late-failed-call':
    case 'late-interrupted-call':
    case 'before-terminal':
    case 'foreign-terminal':
    case 'foreign-thread-terminal':
    case 'terminal-before-response-call':
    case 'terminal-before-error-call':
    case 'terminal-before-mismatch-call':
    case 'response-terminal-call':
    case 'held-terminal-call': {
      const tool = () => send({ id: 'late-tool', method: 'item/tool/call', params: { threadId: THREAD, turnId: TURN, callId: 'late-1', namespace: null, tool: 'display', arguments: { blocks: [{ kind: 'text', text: 'offline control' }] } } });
      const provisional = scenario.startsWith('terminal-before-');
      const emit = () => coalesced(() => {
        if (scenario === 'before-terminal' || scenario === 'held-terminal-call') tool();
        const status = scenario === 'late-failed-call' ? 'failed' : scenario === 'late-interrupted-call' ? 'interrupted' : 'completed';
        if (scenario === 'foreign-thread-terminal') note('turn/completed', { threadId: 'thr-other', turn: turn(TURN, status) });
        else finish(status, null, scenario === 'foreign-terminal' ? 'other-turn' : TURN);
        if (scenario !== 'before-terminal') tool();
      });
      if (scenario !== 'response-terminal-call' && scenario !== 'held-terminal-call') note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      if (provisional) {
        emit();
        later(() => {
          if (scenario === 'terminal-before-error-call') send({ id, error: { code: -32600, message: 'not submitted' } });
          else send({ id, result: { turn: turn(scenario === 'terminal-before-mismatch-call' ? 'turn-other' : TURN) } });
        });
      } else if (scenario === 'response-terminal-call' || scenario === 'held-terminal-call') {
        coalesced(() => { send({ id, result: { turn: turn(TURN) } }); emit(); });
      } else {
        send({ id, result: { turn: turn(TURN) } });
        later(emit);
        if (scenario === 'foreign-terminal' || scenario === 'foreign-thread-terminal') setTimeout(() => finish(), 150);
      }
      return;
    }

    case 'coalesced-prestart':
    case 'coalesced-prestart-call':
      send({ id, result: { turn: turn(TURN) } });
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      body(); finish(); return;
    case 'terminal-error':
      coalesced(() => { terminalFirst(); send({ id, error: { code: -32600, message: 'not submitted' } }); }); return;
    case 'terminal-error-split':
      terminalFirst(); later(() => send({ id, error: { code: -32600, message: 'not submitted' } })); return;
    case 'terminal-mismatch':
      coalesced(() => { terminalFirst(); send({ id, result: { turn: turn('turn-other') } }); }); return;
    case 'terminal-mismatch-split':
      terminalFirst(); later(() => send({ id, result: { turn: turn('turn-other') } })); return;
    // Our terminal, then a different turn/started on our thread while the terminal settles.
    case 'terminal-conflict-split':
      terminalFirst(); later(() => conflict()); setTimeout(() => send({ id, result: { turn: turn(TURN) } }), 120); return;
    case 'terminal-conflict':
      coalesced(() => { terminalFirst(); conflict(); send({ id, result: { turn: turn(TURN) } }); }); return;
    case 'terminal-conflict-error-split':
      terminalFirst(); later(() => conflict()); setTimeout(() => send({ id, error: { code: -32600, message: 'not submitted' } }), 120); return;
    case 'terminal-conflict-mismatch-split':
      terminalFirst(); later(() => conflict()); setTimeout(() => send({ id, result: { turn: turn('turn-other') } }), 120); return;
    case 'terminal-conflict-no-response':
      terminalFirst(); later(() => conflict()); return;
    // The conflict precedes the response, before our terminal, all in one chunk.
    case 'conflict-response':
      coalesced(() => { note('turn/started', { threadId: THREAD, turn: turn(TURN) }); conflict(); send({ id, result: { turn: turn(TURN) } }); body(); finish(); }); return;
    // Controls: the other turn follows the response (TB-4 foreign), runs on another thread, or is our own id again.
    case 'terminal-response-conflict':
      coalesced(() => { terminalFirst(); send({ id, result: { turn: turn(TURN) } }); conflict(); }); return;
    case 'terminal-other-thread-split':
      terminalFirst(); later(() => conflict('thr-other')); setTimeout(() => send({ id, result: { turn: turn(TURN) } }), 120); return;
    case 'terminal-same-turn-split':
      terminalFirst(); later(() => conflict(THREAD, TURN)); setTimeout(() => send({ id, result: { turn: turn(TURN) } }), 120); return;
    case 'terminal-no-response':
      terminalFirst(); return;
    case 'terminal-ok':
      coalesced(() => { terminalFirst(); send({ id, result: { turn: turn(TURN) } }); }); return;
    case 'terminal-ok-split':
      terminalFirst(); later(() => send({ id, result: { turn: turn(TURN) } })); return;
    case 'held-call-terminal-error':
      // A call for our turn before any binding is held; the turn then ends before an error response.
      send({ id: 'srv-held', method: 'item/tool/call', params: { threadId: THREAD, turnId: TURN, callId: 'c1', namespace: null, tool: 'display', arguments: {} } });
      terminalFirst(); later(() => send({ id, error: { code: -32600, message: 'not submitted' } })); return;
    case 'response-first':
      send({ id, result: { turn: turn(TURN) } });
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      body(); finish(); return;
    case 'mismatch':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      send({ id, result: { turn: turn('turn-other') } }); return;
    case 'second-turn':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      note('turn/started', { threadId: THREAD, turn: turn('turn-2') }); return;
    case 'turn-error':
      send({ id, error: { code: -32600, message: 'not submitted' } }); return;
    case 'crash':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      setTimeout(() => process.exit(3), 20); return;
    case 'foreign':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      send({ id, result: { turn: turn(TURN) } });
      note('turn/started', { threadId: THREAD, turn: turn('turn-foreign') });
      note('item/completed', { item: { type: 'agentMessage', id: 'x', text: 'foreign', phase: null }, threadId: THREAD, turnId: 'turn-foreign', completedAtMs: 0 });
      note('item/completed', { item: { type: 'agentMessage', id: 'y', text: 'other thread', phase: null }, threadId: 'thr-other', turnId: TURN, completedAtMs: 0 });
      body(); finish(); return;
    case 'retry':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      send({ id, result: { turn: turn(TURN) } });
      note('error', { error: { message: 'Reconnecting... 1/5' }, willRetry: true, threadId: THREAD, turnId: TURN });
      body(); finish(); return;
    case 'failed':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      send({ id, result: { turn: turn(TURN) } });
      note('error', { error: { message: 'stream disconnected before completion' }, willRetry: false, threadId: THREAD, turnId: TURN });
      finish('failed', { message: 'stream disconnected before completion' }); return;
    case 'hang':
    case 'interrupt':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      send({ id, result: { turn: turn(TURN) } }); return;
    case 'tool-call':
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      send({ id, result: { turn: turn(TURN) } });
      send({ id: 'srv-1', method: 'item/tool/call', params: { threadId: THREAD, turnId: TURN, callId: 'c1', namespace: null, tool: 'display', arguments: {} } });
      send({ id: 'srv-2', method: 'item/commandExecution/requestApproval', params: {} });
      return;
    default: // ok: turn/started and items before the response (E2 ordering)
      note('turn/started', { threadId: THREAD, turn: turn(TURN) });
      body();
      send({ id, result: { turn: turn(TURN) } });
      finish();
  }
}

function onFrame(msg) {
  if (log) appendFileSync(log, JSON.stringify(msg) + '\n');
  const { id, method, params } = msg;
  if (method === undefined) {
    if (scenario === 'tool-call' && id === 'srv-2') { body(); finish(); }
    return;
  }
  switch (method) {
    case 'initialize':
      if (scenario === 'hang-ready') return;
      send({ id, result: { userAgent: 'fake/0.163.0', codexHome: '/x', platformFamily: 'unix', platformOs: 'macos' } }); return;
    case 'initialized': return;
    case 'account/login/start':
      if (scenario === 'login-reject') { send({ id, error: { code: -32600, message: 'API key login is disabled' } }); return; }
      send({ id, result: { type: 'apiKey' } }); return;
    case 'account/read':
      send({ id, result: { account: scenario === 'account-mismatch' ? { type: 'chatgpt', email: null, planType: 'plus' } : { type: 'apiKey' }, requiresOpenaiAuth: true, workspaceRouting: null } }); return;
    case 'thread/start':
    case 'thread/resume':
      if (scenario === 'resume-usage-replay') {
        // 0.163.0 cold resume replays the last turn's token usage; it is not turn activity.
        coalesced(() => {
          send({ id, result: { thread: { id: params.threadId ?? THREAD }, approvalPolicy: params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false }, model: 'm', modelProvider: 'openai' } });
          note('thread/tokenUsage/updated', { threadId: THREAD, turnId: 'turn-old', tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 } } });
        });
        return;
      }
      if (scenario === 'coalesced-prestart' || scenario === 'coalesced-prestart-call') {
        // The thread response and the old turn's frames in one write: one chunk on the client.
        coalesced(() => {
          send({ id, result: { thread: { id: params.threadId ?? THREAD }, approvalPolicy: params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false }, model: 'm', modelProvider: 'openai' } });
          if (scenario === 'coalesced-prestart-call') send({ id: 'srv-old', method: 'item/tool/call', params: { threadId: THREAD, turnId: 'turn-old', callId: 'c0', namespace: null, tool: 'display', arguments: {} } });
          else oldTurn();
        });
        return;
      }
      send({ id, result: { thread: { id: params.threadId ?? THREAD }, approvalPolicy: params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false }, model: 'm', modelProvider: 'openai' } });
      if (scenario === 'prestart') note('turn/started', { threadId: params.threadId ?? THREAD, turn: turn('turn-steer') });
      return;
    case 'turn/start': onTurnStart(id); return;
    case 'turn/interrupt':
      send({ id, result: {} });
      note('turn/completed', { threadId: THREAD, turn: turn(TURN, 'interrupted') }); return;
    default:
      send({ id, error: { code: -32601, message: 'unknown' } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\n')) !== -1;) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line.trim()) onFrame(JSON.parse(line));
  }
});
// Single-client stdio mode: exit on EOF.
process.stdin.on('end', () => process.exit(0));
