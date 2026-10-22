import { fileURLToPath } from 'node:url';
import { TurnFailure, classifyFailure } from '../agent-failure.js';
/**
 * agent-bridge typed-event tests (queryAgentEvents) — mocked @openai/codex-sdk.
 * Covers work identity / first-sight seq, message phase and revisions, attempt
 * markers across recovery and fresh retry, and the canonical options contract.
 */
import { OutputCollector, DEFAULT_OUTPUT_SELECTION_MODE } from '../output-selection.js';
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';

type Ev = Record<string, unknown>;
let scriptedRuns: Array<() => AsyncGenerator<Ev>>;
let runIdx: number;
let constructorError: Error | undefined;

function makeThread() {
  return {
    async runStreamed(_prompt: string) {
      void _prompt;
      const gen = scriptedRuns[runIdx++];
      if (!gen) throw new Error('no scripted run left');
      return { events: gen() };
    },
  };
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor() { if(constructorError) throw constructorError; }
    startThread() {
      return makeThread();
    }
    resumeThread() {
      return makeThread();
    }
  },
}));

vi.mock('../execution-scope.js', async importOriginal => {
  const original = await importOriginal<typeof import('../execution-scope.js')>();
  return {...original, ExecutionScope: class extends original.ExecutionScope {
    constructor() { super(fileURLToPath(new URL('./fixtures/owned-cli.mjs', import.meta.url))); }
  }};
});

import { queryAgent, queryAgentEvents } from '../agent-bridge.js';
import type { AgentOutputEvent, QueryAgentOptions } from '../agent-bridge.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';

function cfg(): Config {
  return {
    botToken: 't',
    apiUrl: 'https://example.com',
    baseDir: '/tmp/cco-test',
    cwd: '/tmp/cco-test/ws',
    cwdBase: '/tmp/cco-test/ws',
    dataDir: '/tmp/cco-test/data',
    sdk: {},
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
    dispatchTimeoutMs: 300000,
  } as Config;
}

async function events(opts?: QueryAgentOptions, onToolUse?: (n: string, i?: unknown) => void): Promise<AgentOutputEvent[]> {
  const out: AgentOutputEvent[] = [];
  for await (const ev of queryAgentEvents('hi', cfg(), undefined, onToolUse, opts)) out.push(ev);
  return out;
}

const started = (id: string): Ev => ({ type: 'thread.started', thread_id: id });
const turnDone: Ev = { type: 'turn.completed', usage: {} };
const msg = (id: string, text: string, extra: Record<string, unknown> = {}, phase: 'completed' | 'updated' = 'completed'): Ev => ({
  type: `item.${phase}`,
  item: { id, type: 'agent_message', text, ...extra },
});
const item = (id: string, type: string, phase: 'started' | 'updated' | 'completed', extra: Record<string, unknown> = {}): Ev => ({
  type: `item.${phase}`,
  item: { id, type, ...extra },
});
const interrupt = 'Codex Exec exited with code 1: Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)';
const staleErr = 'thread not found';

beforeEach(() => {
  runIdx = 0;
  constructorError = undefined;
  scriptedRuns = [];
});

it('retains positive non-execution proof for an earlier spawn retry scope',async()=>{
  scriptedRuns=[async function*(){throw Object.assign(new Error('synthetic'),{code:'EAGAIN',syscall:'spawn proxy'});},async function*(){yield started('thread');yield {type:'turn.failed',error:{message:'synthetic failure'}};}];
  const config=cfg();config.sdk.recovery={enabled:true,baseDelayMs:1,maxDelayMs:1};const scopes:ManagedExecution[]=[];
  try{
    await expect((async()=>{for await(const event of queryAgentEvents('current request',config,undefined,undefined,{onManagedExecution:scope=>{scopes.push(scope);}}))void event;})()).rejects.toMatchObject({report:{first:{stage:'spawn'},attempts:2}});
    expect(scopes).toHaveLength(2);expect(runIdx).toBe(2);
    expect(await scopes[0].waitForStopped(0)).toBe(true);
    expect(await scopes[1].waitForStopped(0)).toBe(false); // Mocked SDK launches no gateway-owned process.
  }finally{scopes.forEach(scope=>scope.dispose());}
});

describe('work events', () => {
  it('T22: item.started X + item.completed X → exactly one work event with the started seq', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield item('item_0', 'command_execution', 'started', { command: 'ls', status: 'in_progress' });
      yield item('item_0', 'command_execution', 'completed', { command: 'ls', aggregated_output: 'SECRET', status: 'completed' });
      yield msg('item_1', 'done');
      yield turnDone;
    }];
    const evs = await events();
    const work = evs.filter((e) => e.kind === 'work');
    expect(work).toEqual([{ kind: 'work', attempt: 0, itemId: 'item_0', seq: 0, itemType: 'command_execution' }]);
    const m = evs.find((e) => e.kind === 'message');
    expect(m).toMatchObject({ itemId: 'item_1', seq: 1 });
    // Work events never carry payloads.
    expect(JSON.stringify(work)).not.toContain('SECRET');
    expect(JSON.stringify(work)).not.toContain('ls');
  });

  it('T23: started X, no completion, reconciled completion at turn end → still one event', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield item('item_0', 'mcp_tool_call', 'started', { server: 's', tool: 't', status: 'in_progress' });
      yield msg('item_1', 'final');
      yield item('item_0', 'mcp_tool_call', 'updated', { server: 's', tool: 't', status: 'in_progress' });
      yield item('item_0', 'mcp_tool_call', 'completed', { server: 's', tool: 't', status: 'failed' });
      yield turnDone;
    }];
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'work')).toEqual([
      { kind: 'work', attempt: 0, itemId: 'item_0', seq: 0, itemType: 'mcp_tool_call' },
    ]);
  });

  it('T24: file_change completed-only → one work event at the completion seq', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'before');
      yield item('item_1', 'file_change', 'completed', { changes: [], status: 'completed' });
      yield turnDone;
    }];
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'work')).toEqual([
      { kind: 'work', attempt: 0, itemId: 'item_1', seq: 1, itemType: 'file_change' },
    ]);
  });

  it('unknown item types are work; reasoning, todo_list and drained notices are not', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield item('item_0', 'reasoning', 'started', { text: 'r' });
      yield item('item_1', 'todo_list', 'started', { items: [] });
      yield item('item_2', 'error', 'completed', { message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' });
      yield item('item_3', 'collab_tool_call', 'started', {});
      yield item('item_4', 'web_search', 'completed', { query: 'q' });
      yield turnDone;
    }];
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'work').map((e) => (e as { itemType: string }).itemType)).toEqual([
      'collab_tool_call',
      'web_search',
    ]);
  });
});

describe('message events', () => {
  it('phase is read defensively; 0.142.3 items have none', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'a');
      yield msg('item_1', 'b', { phase: 'commentary' });
      yield msg('item_2', 'c', { phase: 'final_answer' });
      yield msg('item_3', 'd', { phase: 'something_else' });
      yield msg('item_4', 'e', { phase: 'partial_answer' });
      yield turnDone;
    }];
    const phases = (await events()).filter((e) => e.kind === 'message').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['unknown', 'commentary', 'final_answer', 'unknown', 'partial_answer']);
  });

  it('T2: a snapshot of the same item keeps its first-sight seq', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'v1', {}, 'updated');
      yield msg('item_1', 'other');
      yield msg('item_0', 'v2');
      yield turnDone;
    }];
    const ms = (await events()).filter((e) => e.kind === 'message');
    expect(ms.map((e) => [(e as { itemId: string }).itemId, (e as { seq: number }).seq, (e as { text: string }).text])).toEqual([
      ['item_0', 0, 'v1'],
      ['item_1', 1, 'other'],
      ['item_0', 0, 'v2'],
    ]);
  });
});

describe('attempt markers', () => {
  it('T5: EOF without turn.completed fails without an attempt_end', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'partial');
      yield item('item_1', 'command_execution', 'started', { command: 'sleep 60' });
    }];
    const evs: AgentOutputEvent[] = [];
    await expect((async () => {
      for await (const event of queryAgentEvents('hi', cfg())) evs.push(event);
    })()).rejects.toMatchObject({ report: {
      attempts: 1, executionRisk: 'effects_observed',
      final: { category: 'stream_interrupted', source: 'local' },
    } });
    expect(evs[0]).toEqual({ kind: 'attempt_start', attempt: 0, reason: 'initial', continues: null });
    expect(evs.some(event => event.kind === 'attempt_end')).toBe(false);
  });

  it.each([{message:interrupt,resume:undefined,partial:false},{message:staleErr,resume:'old',partial:false},{message:interrupt,resume:'old',partial:true},{message:staleErr,resume:'old',partial:true}])('has no recovery attempt/end after $message (partial=$partial)',async({message,resume,partial})=>{
 scriptedRuns=[async function*(){yield started('t');if(partial)yield msg('before','partial');throw new Error(message);}];const seen:AgentOutputEvent[]=[];
 await expect((async()=>{for await(const e of queryAgentEvents('hi',cfg(),undefined,undefined,{resume}))seen.push(e);})()).rejects.toMatchObject({report:{attempts:1,decision:'blocked_uncertain'}});
 expect(seen.map(e=>e.kind)).toEqual(partial?['attempt_start','message']:['attempt_start']);expect(runIdx).toBe(1);
 });





  it('T6: an error after partial output propagates (no attempt_end)', async () => {
    scriptedRuns = [async function* () {
      yield started('t1');
      yield msg('item_0', 'partial');
      yield { type: 'turn.failed', error: { message: 'boom' } };
    }];
    const seen: AgentOutputEvent[] = [];
    await expect((async () => {
      for await (const ev of queryAgentEvents('hi', cfg())) seen.push(ev);
    })()).rejects.toBeInstanceOf(TurnFailure);
    expect(seen.some((e) => e.kind === 'attempt_end')).toBe(false);
  });


});

describe('intermediate CLI notifications', () => {
  const notification = (kind: 'stream' | 'item'): Ev => kind === 'stream'
    ? { type: 'error', message: 'Reconnecting... 2/5 (synthetic transport interruption)' }
    : item('warning', 'error', 'completed', {
      message: 'Falling back from WebSockets to HTTPS transport. Synthetic interruption',
    });

  it.each(['stream', 'item'].flatMap(kind =>
    ['absent', 'empty', 'spaces', 'formatting', 'erased', 'mixed-phases'].map(output => ({ kind, output })),
  ))('rejects a silent completed turn ($kind, $output) without an attempt_end', async ({ kind, output }) => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield item('work', 'file_change', 'completed', { changes: [] });
      if (kind === 'stream') yield { type: 'error', message: 'authentication failed' };
      else yield item('error', 'error', 'completed', { message: 'authentication failed' });
      if (output === 'erased') yield msg('answer', 'discarded snapshot', {}, 'updated');
      if (output === 'mixed-phases') yield msg('commentary', 'still working', { phase: 'commentary' });
      if (output !== 'absent') yield msg('answer', (output === 'spaces' || output === 'mixed-phases') ? '  \n' : output === 'formatting' ? '\u200b\u2060' : '');
      yield turnDone;
    }];
    const seen: AgentOutputEvent[] = [];
    await expect((async () => {
      for await (const event of queryAgentEvents('hi', cfg())) seen.push(event);
    })()).rejects.toMatchObject({ report: { attempts: 1, decision: 'blocked_uncertain',
      executionRisk: 'effects_observed', final: { category: 'auth' } } });
    expect(seen.some(event => event.kind === 'attempt_end')).toBe(false);
    expect(runIdx).toBe(1);
  });

  it.each(['stream', 'item'].flatMap(kind => [
    ['authentication failed', 'auth'], ['quota exhausted', 'quota_exhausted'],
    ['context window exceeded', 'context_limit'], ['invalid encrypted content', 'invalid_encrypted_content'],
    ['permission denied', 'permission'], ['unrecognized synthetic error', 'unknown'],
  ].map(([message, category]) => ({ kind, message, category }))))('retains $category on silent $kind completion', async ({ kind, message, category }) => {
    scriptedRuns = [async function* () {
      if (kind === 'stream') yield { type: 'error', message };
      else yield item('error', 'error', 'completed', { message });
      yield turnDone;
    }];
    await expect(events()).rejects.toMatchObject({ report: { attempts: 1, decision: 'blocked_uncertain', final: { category } } });
    expect(runIdx).toBe(1);
  });

  it('keeps an earlier genuine failure when a later reconnect notice precedes silent completion', async () => {
    scriptedRuns = [async function* () {
      yield item('error', 'error', 'completed', { message: 'authentication failed' });
      yield notification('stream'); yield turnDone;
    }];
    await expect(events()).rejects.toMatchObject({ report: { final: { category: 'auth' }, attempts: 1 } });
  });

  it('uses the configured output selection rules for compatibility whitespace replies', async () => {
    scriptedRuns = [async function* () { yield notification('stream'); yield msg('answer', '  '); yield turnDone; }];
    const config = cfg(); config.sdk.outputSelection = 'legacy';
    const seen: AgentOutputEvent[] = [];
    for await (const event of queryAgentEvents('hi', config)) seen.push(event);
    expect(seen.at(-1)).toMatchObject({ kind: 'attempt_end', terminal: 'completed' });
  });

  it('logs one fixed deferred marker and a bounded recovery count without SDK text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scriptedRuns = [async function* () {
        yield { type: 'error', message: 'SYNTHETIC_PRIVATE_ERROR' };
        yield { type: 'error', message: 'SYNTHETIC_PRIVATE_ERROR_AGAIN' };
        yield msg('answer', 'answer'); yield turnDone;
      }];
      await events();
      expect(warn.mock.calls).toEqual([
        ['[codex-channel-octo] CLI notification deferred'],
        ['[codex-channel-octo] CLI notifications recovered', JSON.stringify({ count: 2 })],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SYNTHETIC_PRIVATE');
    } finally { warn.mockRestore(); }
  });

  it.each(['stream', 'item'] as const)('continues the same execution after a %s notification and snapshot revision', async kind => {
    let drained = false;
    scriptedRuns = [async function* () {
      yield started('thread');
      yield msg('answer', 'early text', {}, 'updated');
      yield item('work', 'command_execution', 'started', { command: 'synthetic' });
      yield notification(kind);
      yield notification(kind);
      yield msg('answer', 'completed answer');
      yield turnDone;
      drained = true;
    }];
    const text = [];
    for await (const part of queryAgent('hi', cfg(), undefined, undefined, { resume: 'existing-thread' })) text.push(part);
    expect(text).toEqual(['completed answer']);
    expect(drained).toBe(true);
    expect(runIdx).toBe(1);
  });

  it.each(['stream', 'item'] as const)('uses a later turn.failed instead of the earlier %s notification', async kind => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield notification(kind);
      yield msg('answer', 'must not be published');
      yield item('work', 'file_change', 'completed', { changes: [] });
      yield { type: 'turn.failed', error: { message: 'authentication failed' } };
    }];
    const seen: AgentOutputEvent[] = [];
    await expect((async () => {
      for await (const event of queryAgentEvents('hi', cfg(), undefined, undefined)) seen.push(event);
    })()).rejects.toMatchObject({ report: {
      attempts: 1, decision: 'blocked_uncertain', executionRisk: 'effects_observed',
      final: { source: 'sdk_event', category: 'auth' },
    } });
    expect(seen.some(event => event.kind === 'attempt_end')).toBe(false);
    expect(runIdx).toBe(1);
  });

  it.each(['stream', 'item', 'none'] as const)('rejects partial output followed by EOF (%s notification)', async kind => {
    scriptedRuns = [async function* () {
      yield started('thread');
      if (kind !== 'none') yield notification(kind);
      yield msg('answer', 'must not be published');
    }];
    const published: string[] = [];
    await expect((async () => {
      for await (const text of queryAgent('hi', cfg())) published.push(text);
    })()).rejects.toBeInstanceOf(TurnFailure);
    expect(published).toEqual([]);
    expect(runIdx).toBe(1);
  });

  it.each(['stream', 'item'] as const)('preserves a process exception after a %s notification', async kind => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield notification(kind);
      yield turnDone;
      throw new Error('Codex Exec exited with code 1: SYNTHETIC_PRIVATE_STDERR');
    }];
    await expect(events()).rejects.toMatchObject({ report: {
      attempts: 1, final: { stage: 'process_exit', category: 'process_exit' },
    } });
    expect(runIdx).toBe(1);
  });

  it.each(['stream', 'item'] as const)('does not hide a %s error arriving after turn.completed', async kind => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield msg('answer', 'must not be published');
      yield turnDone;
      yield notification(kind);
    }];
    await expect(events()).rejects.toBeInstanceOf(TurnFailure);
    expect(runIdx).toBe(1);
  });

  it('still rejects a terminal failure following turn.completed', async () => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield turnDone;
      yield { type: 'turn.failed', error: { message: 'permission denied' } };
    }];
    await expect(events()).rejects.toMatchObject({ report: { final: { category: 'permission' } } });
  });

  it('retains cancellation and closes the iterator while a notification is pending', async () => {
    const controller = new AbortController();
    let closed = false;
    scriptedRuns = [async function* () {
      try {
        yield started('thread');
        yield notification('stream');
        controller.abort();
        controller.signal.throwIfAborted();
      } finally { closed = true; }
    }];
    await expect(events({ signal: controller.signal })).rejects.toMatchObject({ report: { decision: 'cancelled' } });
    expect(closed).toBe(true);
    expect(runIdx).toBe(1);
  });
});

describe('T14: queryAgent wrapper keeps baseline string output', () => {
  it('yields only the completed run, first-seen order, non-empty, snapshot-overwritten', async () => {
    scriptedRuns = [
      async function* () {
        yield started('t1');
        yield msg('item_0', 'a1', {}, 'updated');
        yield msg('item_1', '');
        yield msg('item_2', 'b');
        yield msg('item_0', 'a2');
        yield turnDone;
      },
    ];
    const out: string[] = [];
    for await (const t of queryAgent('hi', cfg())) out.push(t);
    expect(out).toEqual(['a2', 'b']);
  });
});

describe('T25: one canonical options contract', () => {
  it('queryAgent and queryAgentEvents both take QueryAgentOptions', () => {
    expectTypeOf<NonNullable<Parameters<typeof queryAgent>[4]>>().toEqualTypeOf<QueryAgentOptions>();
    expectTypeOf<NonNullable<Parameters<typeof queryAgentEvents>[4]>>().toEqualTypeOf<QueryAgentOptions>();
    expectTypeOf<Parameters<typeof queryAgent>>().toEqualTypeOf<Parameters<typeof queryAgentEvents>>();
  });

  it('exposes only supported query options', () => {
    expectTypeOf<Extract<keyof QueryAgentOptions, 'onResumeFailed' | 'fallbackRetryPrompt'>>().toEqualTypeOf<never>();
    expectTypeOf<QueryAgentOptions>().toEqualTypeOf<{
      resume?: string;
      onSessionId?: (id: string, prompt: string) => void;
      groupInstructions?: string;
      senderContext?: import('../prompt-safety.js').SafeText;
      signal?: AbortSignal;
      deadline?: number;
      diagnosticId?: string;
      assertPublishable?: () => void;
      onExecutionRisk?: (risk: import('../agent-failure.js').ExecutionRisk) => void;
      privateMemoryContext?: import('../prompt-safety.js').SafeText;
      onManagedExecution?: (execution: import('../execution-scope.js').ManagedExecution) => void;
      interruptedTurn?: import('../turn-context.js').InterruptedTurn;
      itemStates?: boolean;
    }>();
  });

  it('onSessionId observes the current attempt without a replay callback',async()=>{
 const session=vi.fn();scriptedRuns=[async function*(){yield started('t');yield turnDone;}];
 await events({resume:'t',onSessionId:session});expect(session).toHaveBeenCalledWith('t',expect.stringContaining('hi'));
 });
});

// The real bridge sees SDK-style id/type/text items with no phase property.
describe('unlabeled SDK events through default output selection', () => {
  it.each([false, true])('excludes progress (tool boundary=%s)', async withTool => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield msg('progress', 'I will inspect the code. '.repeat(500));
      if (withTool) yield item('tool', 'command_execution', 'completed', { command: 'true' });
      yield msg('answer', 'The fix is complete.');
      yield turnDone;
    }];
    const collector = new OutputCollector();
    const observed = await events();
    for (const event of observed) collector.push(event);
    expect(observed.filter(e => e.kind === 'message').map(e => e.phase)).toEqual(['unknown', 'unknown']);
    expect(collector.select({ mode: DEFAULT_OUTPUT_SELECTION_MODE, maxChars: 1000 }))
      .toMatchObject({ text: 'The fix is complete.', source: 'last_message', droppedMessageCount: 1 });
  });

  it('normalizes an agent_message started without text at the real bridge boundary', async () => {
    scriptedRuns = [async function* () {
      yield started('thread');
      yield msg('answer', 'Useful answer');
      yield { type: 'item.started', item: { id: 'unfinished', type: 'agent_message' } };
      yield turnDone;
    }];
    const observed = await events();
    expect(observed.find(e => e.kind === 'message' && e.itemId === 'unfinished'))
      .toMatchObject({ text: '' });
    const collector = new OutputCollector();
    observed.forEach(event => collector.push(event));
    expect(collector.select({ mode: DEFAULT_OUTPUT_SELECTION_MODE, maxChars: 1000 }).text).toBe('Useful answer');
  });
});

// Provenance is local only and must not acquire execution/retry authority.
import { createHash } from 'node:crypto';
import { privateDiagnosticRow } from '../private-diagnostics.js';
import { failureReply } from '../agent-failure.js';
describe('detailed SDK diagnostics through the bridge',()=>{
 const id='3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2';
 async function failed(config:Config,resume?:string) {
  try {for await(const ev of queryAgentEvents('PRIVATE_PROMPT',config,undefined,undefined,{resume,diagnosticId:id}))void ev;}
  catch(error){expect(error).toBeInstanceOf(TurnFailure);return error as TurnFailure;}
  throw Error('expected failure');
 }
 it.each(['item.started','item.updated','item.completed','turn.failed','error','exception'])('captures %s before classification and preserves the failure',async type=>{
  const fields={message:'PRIVATE_SDK_FAILURE',code:'invalid_encrypted_content',status:400,exitCode:9,signal:'SIGTERM',stderr:'PRIVATE_STDERR'};
  scriptedRuns=[async function*(){yield started('PRIVATE_THREAD');yield {type:'turn.started',turn_id:'PRIVATE_TURN'};
   if(type==='exception')throw Object.assign(new Error(fields.message),fields);
   if(type.startsWith('item.'))yield {type,item:{...fields,id:'error',type:'error'}};
   else if(type==='turn.failed')yield {type,error:fields};else yield {type,...fields};
  }];
  const config=cfg();config.sdk={privateDiagnostics:true,privateDiagnosticsDetails:true,recovery:{enabled:true}};
  const error=await failed(config,'PRIVATE_RESUME');
  expect(error.report).toMatchObject({diagnosticId:id,attempts:1,decision:'blocked_uncertain',final:{category:'unknown'}});
  const row=privateDiagnosticRow(error.report,error);
  expect(row).toMatchObject({diagnosticId:id,sdk:{event:type.startsWith('item.')?'item.error':type,detail:{code:fields.code,status:400,
   exitCode:9,signal:'SIGTERM',exitSource:'own_field',eventSubtype:type,mode:'resume',attempt:0,
   resumeFingerprint:createHash('sha256').update('PRIVATE_RESUME').digest('hex'),
   threadFingerprint:createHash('sha256').update('PRIVATE_THREAD').digest('hex'),turnFingerprint:createHash('sha256').update('PRIVATE_TURN').digest('hex')}}});
  expect(JSON.stringify(row)).not.toMatch(/PRIVATE_|stderr/);expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|"sdk":|Fingerprint|exitCode/);
  expect(failureReply(error.report)).not.toMatch(/PRIVATE_|"sdk":|Fingerprint|exitCode/);expect(runIdx).toBe(1);
 });
 it.each([[undefined,undefined],[true,undefined],[false,true],[undefined,true],[true,true]])('requires both flags (private=%s, detailed=%s)',async(enabled,detailed)=>{
  scriptedRuns=[async function*(){yield started('PRIVATE_THREAD');yield {type:'turn.failed',error:{message:'rate limit exceeded',status:429}};}];
  const config=cfg();config.sdk={privateDiagnostics:enabled,privateDiagnosticsDetails:detailed};const error=await failed(config);
  const row=privateDiagnosticRow(error.report,error);
  if(enabled)expect(row).toHaveProperty('sdk');else expect(row).not.toHaveProperty('sdk');
  if(enabled&&detailed){expect(row).toMatchObject({sdk:{detail:{mode:'start',attempt:0,templateId:'rate_limit',status:429}}});expect(row).not.toHaveProperty('sdk.detail.resumeFingerprint');}
  else expect(row).not.toHaveProperty('sdk.detail');
  expect(error.report).toMatchObject({diagnosticId:id,attempts:1,final:{category:'rate_limited',httpStatus:429}});expect(runIdx).toBe(1);
 });
 it('keeps the final retry attempt correlation distinct',async()=>{
  scriptedRuns=[async function*(){throw Object.assign(new Error('spawn synthetic'),{code:'EAGAIN',syscall:'spawn proxy'});},
   async function*(){yield started('new-thread');yield {type:'error',message:'PRIVATE_FINAL'};}];
  const config=cfg();config.sdk={privateDiagnostics:true,privateDiagnosticsDetails:true,recovery:{enabled:true,baseDelayMs:1,maxDelayMs:1}};
  const error=await failed(config);
  expect(error.report).toMatchObject({attempts:2,final:{category:'unknown'}});
  expect(privateDiagnosticRow(error.report,error)).toMatchObject({sdk:{event:'error',detail:{mode:'start',attempt:1,threadFingerprint:createHash('sha256').update('new-thread').digest('hex')}}});
  expect(runIdx).toBe(2);
 });
});

describe('notice correlation without broader suppression',()=>{
 it('records only a fixed notice ID then still throws the real failure',async()=>{
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const config=cfg();config.sdk={privateDiagnostics:true,privateDiagnosticsDetails:true};
  scriptedRuns=[async function*(){yield {type:'item.completed',item:{id:'notice',type:'error',message:'Model metadata for `PRIVATE_MODEL` not found. Defaulting to fallback metadata.'}};
   yield {type:'turn.failed',error:{message:'PRIVATE_REAL_FAILURE with notice keywords model metadata'}};}];
  let caught:unknown;
  try{for await(const event of queryAgentEvents('request',config))void event;}catch(error){caught=error;}finally{warning.mockRestore();}
  expect(caught).toBeInstanceOf(TurnFailure);const failure=caught as TurnFailure;
  expect(privateDiagnosticRow(failure.report,failure)).toMatchObject({sdk:{event:'turn.failed',detail:{noticeTemplateId:'model_metadata_notice'}}});
  expect(JSON.stringify(privateDiagnosticRow(failure.report,failure))).not.toMatch(/PRIVATE_/);expect(runIdx).toBe(1);
 });
});

describe('proxy correlation review regression',()=>{
 it.each(['thread.started','turn.started'])('never executes a diagnostic descriptor trap on %s',async type=>{
  let traps=0;
  const event=new Proxy({type,thread_id:'PRIVATE_THREAD',turn_id:'PRIVATE_TURN'}, {
   getOwnPropertyDescriptor(target,key){traps++;return Reflect.getOwnPropertyDescriptor(target,key);},
  });
  scriptedRuns=[async function*(){yield event;yield {type:'error',message:'PRIVATE_FAILURE'};}];
  const config=cfg();config.sdk={privateDiagnostics:true,privateDiagnosticsDetails:true};let caught:unknown;
  try{for await(const value of queryAgentEvents('request',config))void value;}catch(error){caught=error;}
  expect(traps).toBe(0);expect(caught).toBeInstanceOf(TurnFailure);const failure=caught as TurnFailure;
  const row=privateDiagnosticRow(failure.report,failure);
  expect(row).toMatchObject({sdk:{event:'error',detail:{mode:'start'}}});
  expect(row).not.toHaveProperty('sdk.detail.threadFingerprint');expect(row).not.toHaveProperty('sdk.detail.turnFingerprint');
 });
});

describe('review regressions: SDK accessors and hash-only provenance',()=>{
 it.each([{}, {privateDiagnostics:true}, {privateDiagnostics:true,privateDiagnosticsDetails:true}])('reads SDK accessors once regardless of diagnostic flags %j',async sdk=>{
  for (const type of ['item.started','item.updated','item.completed','turn.failed','error']) {
   let typeReads=0,errorReads=0,messageReads=0;
   const fields={get message(){if(++messageReads>1)throw Error('PRIVATE_SECOND_MESSAGE_READ');return 'rate limit exceeded';}};
   const event={get type(){if(++typeReads>1)throw Error('PRIVATE_SECOND_TYPE_READ');return type;},
    get error(){if(++errorReads>1)throw Error('PRIVATE_SECOND_ERROR_READ');return fields;},
    get message(){return fields.message;},item:{id:'error',type:'error',get message(){return fields.message;}}};
   runIdx=0;scriptedRuns=[async function*(){yield event;}];const config=cfg();config.sdk=sdk;let caught:unknown;
   try{for await(const value of queryAgentEvents('request',config))void value;}catch(error){caught=error;}
   expect(caught).toBeInstanceOf(TurnFailure);const failure=caught as TurnFailure;
   expect(failure.report).toMatchObject({attempts:1,final:{category:'rate_limited',httpStatus:429}});
   expect(typeReads).toBe(1);expect(messageReads).toBe(1);expect(errorReads).toBe(type==='turn.failed'?1:0);
   if(sdk.privateDiagnostics)expect(privateDiagnosticRow(failure.report,failure)).toMatchObject({sdk:{event:type.startsWith('item.')?'item.error':type,
    fingerprint:createHash('sha256').update('rate limit exceeded').digest('hex'),messageBytes:19}});
  }
 });
 it('preserves original hash-only event and fingerprint when optional detail fields are a proxy',async()=>{
  let traps=0;const message='stream closed before response.completed';
  const fields=new Proxy({message},{getOwnPropertyDescriptor(target,key){traps++;return Reflect.getOwnPropertyDescriptor(target,key);}});
  scriptedRuns=[async function*(){yield {type:'turn.failed',error:fields};}];const config=cfg();config.sdk={privateDiagnostics:true};let caught:unknown;
  try{for await(const value of queryAgentEvents('request',config))void value;}catch(error){caught=error;}
  const failure=caught as TurnFailure;expect(failure).toBeInstanceOf(TurnFailure);expect(traps).toBe(0);
  expect(failure.report.final.category).toBe('stream_interrupted');
  const row=privateDiagnosticRow(failure.report,failure);
  expect(row).toMatchObject({sdk:{event:'turn.failed',fingerprint:createHash('sha256').update(message).digest('hex'),messageBytes:39,fingerprintTruncated:false}});
  expect(row).not.toHaveProperty('sdk.detail');
 });
});


describe('SDK construction diagnostic coverage',()=>{
 it.each([{}, {privateDiagnostics:true}, {privateDiagnosticsDetails:true}, {privateDiagnostics:true,privateDiagnosticsDetails:true}])('preserves construction failure behavior %j',async sdk=>{
  constructorError=Object.assign(new Error('PRIVATE_CONSTRUCTION_FAILURE'),{code:'ENOENT'});
  const config=cfg();config.sdk={...sdk,recovery:{enabled:true}};let caught:unknown;
  try{for await(const value of queryAgentEvents('request',config,undefined,undefined,{resume:'PRIVATE_RESUME'}))void value;}catch(error){caught=error;}
  expect(caught).toBe(constructorError);expect(caught).not.toBeInstanceOf(TurnFailure);expect(runIdx).toBe(0);
  const report={diagnosticId:'3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2',attempts:1,decision:'not_attempted' as const,executionRisk:'unknown' as const,
   first:{stage:'inference' as const,category:'unknown' as const,source:'sdk_exception' as const,evidence:'unknown' as const},
   final:{stage:'inference' as const,category:'unknown' as const,source:'sdk_exception' as const,evidence:'unknown' as const}};
  const row=privateDiagnosticRow(report,caught);
  if(sdk.privateDiagnostics && sdk.privateDiagnosticsDetails){
   expect(row).toMatchObject({sdk:{event:'exception',code:'ENOENT',detail:{code:'ENOENT',mode:'resume',attempt:0,eventSubtype:'exception',
    resumeFingerprint:createHash('sha256').update('PRIVATE_RESUME').digest('hex')}}});
  }else expect(row).not.toHaveProperty('sdk');
  expect(JSON.stringify(row)).not.toMatch(/PRIVATE_/);
 });
});


describe('constructor prototype-proxy review regressions',()=>{
 it.each(['throw','mutate'])('never traverses an error prototype during constructor diagnostics: %s',async behavior=>{
  for(const sdk of [{}, {privateDiagnostics:true}, {privateDiagnostics:true,privateDiagnosticsDetails:true}]){
   let traps=0;const original=new Error('PRIVATE_ORIGINAL');const replacement=new Error('PRIVATE_REPLACEMENT');
   Object.setPrototypeOf(original,new Proxy(Error.prototype,{getPrototypeOf(){traps++;if(behavior==='throw')throw replacement;original.message='PRIVATE_MUTATED';return Error.prototype;}}));
   constructorError=original;const config=cfg();config.sdk=sdk;let caught:unknown;
   try{for await(const value of queryAgentEvents('request',config))void value;}catch(error){caught=error;}
   expect(caught).toBe(original);expect(traps).toBe(0);expect(original.message).toBe('PRIVATE_ORIGINAL');expect(runIdx).toBe(0);
  }
 });
});


describe('stream catch diagnostic reflection regressions', () => {
 it.each([false, true])('does not traverse a proxy prototype (details=%s)', async detailed => {
  let traps = 0;
  const original = new Error('PRIVATE_ORIGINAL');
  Object.setPrototypeOf(original, new Proxy(Error.prototype, {
   getPrototypeOf() { traps++; throw new Error('PRIVATE_REPLACEMENT'); },
  }));
  scriptedRuns = [async function* () { throw original; }];
  const config = cfg(); config.sdk = {privateDiagnostics:true, privateDiagnosticsDetails:detailed};
  let caught: unknown;
  try { for await (const value of queryAgentEvents('request', config)) void value; } catch (error) { caught=error; }
  expect(traps).toBe(0); expect(runIdx).toBe(1);
  expect(caught).toBeInstanceOf(TurnFailure);
  expect((caught as TurnFailure).report.final.category).toBe('unknown');
 });
 it('never executes a caught error message getter', async () => {
  let reads = 0; const original = new Error();
  Object.defineProperty(original, 'message', {get() { reads++; throw new Error('PRIVATE_GETTER'); }});
  scriptedRuns = [async function* () { throw original; }];
  const config=cfg(); config.sdk={privateDiagnostics:true,privateDiagnosticsDetails:true};
  let caught:unknown;
  try { for await(const value of queryAgentEvents('request',config))void value; } catch(error) {caught=error;}
  expect(reads).toBe(0);expect(caught).toBeInstanceOf(TurnFailure);expect(runIdx).toBe(1);
 });
});


describe('DOMException private diagnostic compatibility', () => {
 it.each(['AbortError','TimeoutError'])('preserves %s classification and exception fingerprints', async name => {
  for(const sdk of [{}, {privateDiagnostics:true}, {privateDiagnostics:true,privateDiagnosticsDetails:true}]) {
   const message='PRIVATE_DOM_MESSAGE';scriptedRuns=[async function*(){throw new DOMException(message,name);}];runIdx=0;
   const config=cfg();config.sdk=sdk;let caught:unknown;
   try {for await(const value of queryAgentEvents('request',config))void value;}catch(error){caught=error;}
   expect(caught).toBeInstanceOf(TurnFailure);const failure=caught as TurnFailure;
   expect(failure.report.final).toMatchObject({category:name==='AbortError'?'cancelled':'timeout',evidence:'structured'});
   const row=privateDiagnosticRow(failure.report,failure);
   if(sdk.privateDiagnostics) expect(row).toMatchObject({sdk:{event:'exception',fingerprint:createHash('sha256').update(message).digest('hex')}});
   else expect(row).not.toHaveProperty('sdk');
   expect(JSON.stringify(row)).not.toContain(message);expect(runIdx).toBe(1);
  }
 });
 it.each(['AbortError','TimeoutError'])('captures a native %s constructor error only with detailed opt-in', async name=>{
  const error=new DOMException('PRIVATE_CONSTRUCTOR_DOM',name);constructorError=error;
  const config=cfg();config.sdk={privateDiagnostics:true,privateDiagnosticsDetails:true};let caught:unknown;
  try{for await(const value of queryAgentEvents('request',config))void value;}catch(e){caught=e;}
  expect(caught).toBe(error);expect(runIdx).toBe(0);
  const snapshot=classifyFailure(error);
  expect(privateDiagnosticRow({diagnosticId:'3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2',attempts:0,decision:'not_attempted',executionRisk:'proven_not_started',first:snapshot,final:snapshot},error))
   .toHaveProperty('sdk.fingerprint');
 });
});

describe('single-read event types across progress paths',()=>{
 it.each(['command_execution','web_search','reasoning','todo_list'])(
  'reads the %s event discriminant once',async itemType=>{
   for(const type of ['item.started','item.completed']) {
    let reads=0;const event={get type(){if(++reads>1)throw Error('PRIVATE_SECOND_READ');return type;},
     item:{id:'progress',type:itemType,command:'synthetic',query:'synthetic'}};
    runIdx=0;scriptedRuns=[async function*(){yield event;yield {type:'item.completed',item:{id:'final',type:'agent_message',text:'done'}};yield {type:'turn.completed',usage:{}};}];
    const output=[];for await(const value of queryAgentEvents('request',cfg(),undefined,()=>{})) output.push(value);
    expect(reads).toBe(1);expect(output).toContainEqual(expect.objectContaining({kind:'message',text:'done'}));
   }
  });
});

describe('item_state events (WP-06, opt-in)', () => {
  type ItemStateEvent = Extract<AgentOutputEvent, { kind: 'item_state' }>;
  const states = (out: AgentOutputEvent[]): ItemStateEvent[] => out.filter((e): e is ItemStateEvent => e.kind === 'item_state');
  const workRun = () => async function* () {
    yield started('t1');
    yield item('r', 'reasoning', 'started', { text: 'PRIVATE_REASONING' });
    yield item('c', 'command_execution', 'started', { command: 'SECRET_ENV=1 git push https://u:SECRET_PW@h/x', status: 'in_progress' });
    yield item('c', 'command_execution', 'updated', { command: 'SECRET_ENV=1 git push', aggregated_output: 'SECRET_OUT', status: 'in_progress' });
    yield item('c', 'command_execution', 'completed', { command: 'SECRET_ENV=1 git push', aggregated_output: 'SECRET_OUT', exit_code: 0, status: 'completed' });
    yield item('f', 'file_change', 'completed', { changes: [{ path: '/home/u/SECRET_PATH', kind: 'add' }], status: 'failed' });
    yield item('w', 'web_search', 'started', { query: 'SECRET_QUERY' });
    yield item('m', 'mcp_tool_call', 'started', { server: 'SECRET_SERVER', tool: 'SECRET_TOOL', arguments: { a: 'SECRET_ARG' }, status: 'in_progress' });
    yield item('t', 'todo_list', 'started', { items: [{ text: 'PRIVATE_TODO', completed: false }] });
    yield msg('a', 'answer');
    yield turnDone;
  };

  it('without the opt-in the event stream carries no item_state (card-off parity)', async () => {
    scriptedRuns = [workRun()];
    const out = await events();
    expect(states(out)).toEqual([]);
    expect(out.map((e) => e.kind)).toEqual(['attempt_start', 'work', 'work', 'work', 'work', 'message', 'attempt_end']);
  });

  it('with the opt-in every non-item event is unchanged and item_state events are added', async () => {
    scriptedRuns = [workRun()];
    const plain = await events();
    runIdx = 0; scriptedRuns = [workRun()];
    const withStates = await events({ itemStates: true });
    expect(withStates.filter((e) => e.kind !== 'item_state')).toEqual(plain);
  });

  it('reduces items at the bridge: typed phase/status, first-sight seq, reducer facts only', async () => {
    scriptedRuns = [workRun()];
    const out = await events({ itemStates: true });
    const work = new Map(out.filter((e) => e.kind === 'work').map((e) => [(e as { itemId: string }).itemId, (e as { seq: number }).seq]));
    expect(states(out).map((e) => [e.itemId, e.itemType, e.phase, e.status ?? null])).toEqual([
      ['r', 'reasoning', 'started', null],
      ['c', 'command_execution', 'started', 'in_progress'],
      ['c', 'command_execution', 'updated', 'in_progress'],
      ['c', 'command_execution', 'completed', 'completed'],
      ['f', 'file_change', 'completed', 'failed'],
      ['w', 'web_search', 'started', null],
      ['m', 'mcp_tool_call', 'started', 'in_progress'],
      ['t', 'todo_list', 'started', null],
    ]);
    for (const e of states(out)) {
      expect(e.attempt).toBe(0);
      // Work items reuse the bridge's first-sight identity; activity items take no selection position.
      expect(e.seq).toBe(work.get(e.itemId) ?? -1);
    }
    const command = states(out).find((e) => e.itemId === 'c' && e.phase === 'completed')!;
    expect(command.safe).toMatchObject({ category: 'command', program: 'git', exitClass: 'ok' });
    expect(states(out).find((e) => e.itemId === 'f')!.safe).toMatchObject({ category: 'file_change', fileCount: 1 });
    expect(states(out).find((e) => e.itemId === 'm')!.safe).toEqual({ category: 'tool' });
    const text = JSON.stringify(states(out));
    for (const s of ['SECRET', 'PRIVATE', '/home/u']) expect(text).not.toContain(s);
  });

  it('item_state does not change selection: the collector ignores it', async () => {
    scriptedRuns = [workRun()];
    const out = await events({ itemStates: true });
    const withStates = new OutputCollector();
    const without = new OutputCollector();
    for (const e of out) { withStates.push(e); if (e.kind !== 'item_state') without.push(e); }
    const opts = { mode: DEFAULT_OUTPUT_SELECTION_MODE, maxChars: 524288 } as const;
    expect(withStates.select(opts)).toEqual(without.select(opts));
    expect(withStates.select(opts).text).toBe('answer');
  });

  it('a retry attempt carries its own attempt number', async () => {
    scriptedRuns = [
      async function* () { throw Object.assign(new Error('synthetic'), { code: 'EAGAIN', syscall: 'spawn proxy' }); },
      async function* () { yield started('t2'); yield item('c', 'command_execution', 'started', { command: 'ls', status: 'in_progress' }); yield msg('a', 'ok'); yield turnDone; },
    ];
    const config = cfg(); config.sdk.recovery = { enabled: true, baseDelayMs: 1, maxDelayMs: 1 };
    const out: AgentOutputEvent[] = [];
    for await (const e of queryAgentEvents('hi', config, undefined, undefined, { itemStates: true })) out.push(e);
    expect(states(out).map((e) => [e.attempt, e.itemId])).toEqual([[1, 'c']]);
  });

  it('keeps the single-read event discriminant with the opt-in', async () => {
    for (const type of ['item.started', 'item.updated', 'item.completed']) {
      let reads = 0;
      const event = { get type() { if (++reads > 1) throw Error('PRIVATE_SECOND_READ'); return type; },
        item: { id: 'progress', type: 'command_execution', command: 'synthetic', status: 'in_progress' } };
      runIdx = 0; scriptedRuns = [async function* () { yield event; yield msg('final', 'done'); yield turnDone; }];
      const out = await events({ itemStates: true });
      expect(reads).toBe(1);
      expect(states(out).map((e) => e.phase)).toEqual([type.slice('item.'.length)]);
    }
  });

  it('agent messages and error items never produce item_state', async () => {
    scriptedRuns = [async function* () {
      yield started('t'); yield msg('a', 'PRIVATE_ANSWER');
      yield item('e', 'error', 'completed', { message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' });
      yield turnDone;
    }];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await events({ itemStates: true });
    expect(states(out)).toEqual([]);
  });
});
