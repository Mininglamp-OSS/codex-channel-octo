import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { ExecutionScope } from '../execution-scope.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../octo/api.js', () => ({ sendMessage: vi.fn().mockResolvedValue({message_id:'1'}),getMentionPreference:vi.fn().mockResolvedValue(false) }));
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import type { TurnContext } from '../turn-context.js';
import type { Config } from '../config.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';

const config={sdk:{},rateLimit:{maxPerMinute:100},context:{maxContextChars:6000,historyLimit:40},dispatchTimeoutMs:1000} as Config;
const message=(content:string):BotMessage=>({message_id:content,message_seq:1,from_uid:'owner',channel_id:'dm',channel_type:ChannelType.DM,timestamp:0,payload:{type:MessageType.Text,content}});
const proof=(value=true)=>({waitForStopped:vi.fn().mockResolvedValue(value),dispose:vi.fn()});
let root:string;let store:SessionStore;let router:SessionRouter;
beforeEach(()=>{vi.clearAllMocks();root=mkdtempSync(join(tmpdir(),'session-continuity-'));store=new SessionStore(createAdapter(join(root,'db')));store.init();router=new SessionRouter(config,'bot','owner',store);});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});

describe('user-authored turns after interrupted work',()=>{
  it.each(['unknown','effects_observed'] as const)('accepts a new request after failed execution stops (%s)',async risk=>{
    const execution=proof();let old!:TurnContext;
    await router.routeAndHandle(message('old task'),async(_r,t)=>{old=t;t.executionRisk=risk;t.stage='inference';t.registerExecution(execution);throw Error('synthetic failure');});
    expect(store.isTurnQuarantined('owner')).toBe(false);
    expect(store.getInterruption('owner')).toEqual({turnId:old.turnId,reason:'failed',executionRisk:risk,stage:'inference'});
    const next=vi.fn(async (r,t)=>{expect(r.interruptedTurn?.turnId).toBe(old.turnId);t.interruptionPresented=true;});
    await router.routeAndHandle(message('unrelated new task'),next);
    expect(next).toHaveBeenCalledOnce();expect(execution.waitForStopped).toHaveBeenCalledOnce();expect(execution.dispose).toHaveBeenCalledOnce();
    expect(store.getInterruption('owner')).toBeUndefined();
  });
  it('runs a user continuation once, preserving the SDK mapping without replaying the old handler',async()=>{
    store.setSdkSessionId('owner','existing-sdk-thread');const failed=vi.fn(async(_r,t:TurnContext)=>{t.executionRisk='effects_observed';t.interruption='failed';t.registerExecution(proof());});
    await router.routeAndHandle(message('original request'),failed);
    const continuation=vi.fn();await router.routeAndHandle(message('继续上个任务'),continuation);
    expect(failed).toHaveBeenCalledOnce();expect(continuation).toHaveBeenCalledOnce();
    expect(continuation.mock.calls[0][0].message.payload.content).toBe('继续上个任务');
    expect(store.getSdkSessionId('owner')).toBe('existing-sdk-thread');
  });
  it('queues a message during timeout teardown and starts it only after exit proof',async()=>{
    const short=new SessionRouter({...config,dispatchTimeoutMs:20},'bot','owner',store);
    let stopped!:(value:boolean)=>void;const cleanup=new Promise<boolean>(resolve=>{stopped=resolve;});let old!:TurnContext;
    const first=short.routeAndHandle(message('old task'),async(_r,t)=>{
      old=t;t.executionRisk='effects_observed';t.stage='inference';t.registerExecution({waitForStopped:()=>cleanup,dispose:vi.fn()});
      await new Promise<void>((_resolve,reject)=>t.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));
    });
    await vi.waitFor(()=>expect(old?.signal.aborted).toBe(true));
    const next=vi.fn();const queued=short.routeAndHandle(message('new task'),next);
    await new Promise(resolve=>setTimeout(resolve,10));expect(next).not.toHaveBeenCalled();
    stopped(true);await Promise.all([first,queued]);expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].interruptedTurn).toMatchObject({turnId:old.turnId,reason:'timed_out'});
    expect(store.isTurnQuarantined('owner')).toBe(false);
  });
  it('a cancelled generation cannot publish after the new task starts',async()=>{
    let old!:TurnContext;const publish=vi.fn();
    const short=new SessionRouter({...config,dispatchTimeoutMs:15},'bot','owner',store);
    await short.routeAndHandle(message('old'),async(_r,t)=>{old=t;t.executionRisk='unknown';t.registerExecution(proof());await new Promise<void>((_resolve,reject)=>t.signal.addEventListener('abort',()=>reject(Error('late failure')),{once:true}));});
    await short.routeAndHandle(message('new'),async()=>{expect(()=>old.guard({publish}).publish()).toThrow();});
    expect(publish).not.toHaveBeenCalled();expect(store.isTurnQuarantined('owner')).toBe(false);
  });
  it.each([false,'missing'] as const)('keeps maintenance protection when runner exit cannot be confirmed (%s)',async value=>{
    await router.routeAndHandle(message('first'),async(_r,t)=>{t.executionRisk='unknown';t.interruption='failed';if(value!== 'missing')t.registerExecution(proof(value));});
    const next=vi.fn();const result=await router.routeAndHandle(message('next'),next);
    expect(result?.rejectionReason).toBe('quarantined');expect(next).not.toHaveBeenCalled();
  });
  it('a preparation failure with positive non-execution evidence does not block the next turn',async()=>{
    await router.routeAndHandle(message('first'),async()=>{throw Error('synthetic preparation failure');});
    const next=vi.fn();await router.routeAndHandle(message('next'),next);expect(next).toHaveBeenCalledOnce();
  });
  it.each([false,true])('fails closed when teardown inspection throws (async=%s)',async asynchronous=>{
    await router.routeAndHandle(message('first'),async(_r,t)=>{
      t.executionRisk='unknown';t.interruption='failed';
      t.registerExecution({waitForStopped:()=>{if(asynchronous)return Promise.reject(Error('synthetic'));throw Error('synthetic');},dispose:vi.fn()});
    });
    expect(store.isTurnQuarantined('owner')).toBe(true);
    const next=vi.fn();await router.routeAndHandle(message('next'),next);expect(next).not.toHaveBeenCalled();
  });
  it('automatically admits a new request when delayed teardown proof becomes available',async()=>{
    const execution=proof(false);
    await router.routeAndHandle(message('first'),async(_r,t)=>{t.executionRisk='unknown';t.interruption='failed';t.registerExecution(execution);});
    expect(store.isTurnQuarantined('owner')).toBe(true);
    execution.waitForStopped.mockResolvedValue(true);
    const next=vi.fn();await router.routeAndHandle(message('next'),next);
    expect(next).toHaveBeenCalledOnce();expect(store.isTurnQuarantined('owner')).toBe(false);
  });
  it('keeps stopped failure metadata and an open session across a database reopen',async()=>{
    await router.routeAndHandle(message('first'),async(_r,t)=>{t.executionRisk='unknown';t.interruption='failed';t.registerExecution(proof());});
    const previous=store.getInterruption('owner');store.close();store=new SessionStore(createAdapter(join(root,'db')));store.init();store.recoverInterruptedTurns();
    expect(store.getInterruption('owner')).toEqual(previous);expect(store.isTurnQuarantined('owner')).toBe(false);
    router=new SessionRouter(config,'bot','owner',store);const next=vi.fn();await router.routeAndHandle(message('next'),next);expect(next).toHaveBeenCalledOnce();
  });
  it('late proof for an older turn cannot release a different active generation',async()=>{
    const execution=proof(false);let previous='';
    await router.routeAndHandle(message('first'),async(_r,t)=>{previous=t.turnId;t.executionRisk='unknown';t.interruption='failed';t.registerExecution(execution);});
    expect(store.reconcileTurn('owner',previous)).toBe(true);store.beginTurn('owner','different-turn');
    execution.waitForStopped.mockResolvedValue(true);const next=vi.fn();
    await router.routeAndHandle(message('next'),next);
    expect(store.getQuarantinedTurnId('owner')).toBe('different-turn');expect(next).not.toHaveBeenCalled();
  });
  it('a new request admitted by delayed proof still pays the latest global model budget',async()=>{
    let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
    try{
      const limited=new SessionRouter({...config,rateLimit:{maxPerMinute:1}},'bot','owner',store);const execution=proof(false);
      await limited.routeAndHandle(message('first'),async(_r,t)=>{t.executionRisk='unknown';t.interruption='failed';t.registerExecution(execution);});
      now+=60000;
      for(let i=0;i<10;i++)await limited.routeAndHandle({...message('fill budget'),from_uid:`other-${i}`},async()=>{});
      execution.waitForStopped.mockResolvedValue(true);const next=vi.fn();
      const result=await limited.routeAndHandle(message('next'),next);
      expect(result?.rejectionReason).toBe('rate_limited');expect(next).not.toHaveBeenCalled();
      expect(store.isTurnQuarantined('owner')).toBe(false);
    }finally{clock.mockRestore();}
  });
  it('does not delete or claim external reconciliation for a consumed interruption record',async()=>{
    let id='';await router.routeAndHandle(message('first'),async(_r,t)=>{id=t.turnId;t.executionRisk='effects_observed';t.interruption='failed';t.registerExecution(proof());});
    await router.routeAndHandle(message('next'),async(_r,t)=>{t.interruptionPresented=true;});store.deleteSession('owner');
    const connection=createAdapter(join(root,'db'));
    try{expect(connection.prepare('SELECT reason,execution_risk,context_pending FROM interrupted_turns WHERE turn_id=?').get(id)).toEqual({reason:'failed',execution_risk:'effects_observed',context_pending:0});}finally{connection.close();}
  });
  it.skipIf(process.platform === 'win32')('disposes a failed-handshake scope on shutdown without clearing durable quarantine', async () => {
    const scope = new ExecutionScope(join(root, 'unused-launcher.mjs'));
    await scope.prepare();
    scope.expectLaunch();
    const directory = scope.environment({}).CODEX_CHANNEL_EXECUTION_DIR;
    const socketPath = join(directory, 'control.sock');
    const dispose = vi.spyOn(scope, 'dispose');
    try {
      await router.routeAndHandle(message('failed handshake'), async (_result, turn) => {
        turn.executionRisk = 'unknown'; turn.registerExecution(scope);
        throw Error('synthetic missing handshake');
      });
      expect(store.getTurnState('owner')).toBe('quarantined');
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      await router.stopTurns();
      expect(dispose).toHaveBeenCalledOnce();
      expect(existsSync(directory)).toBe(false);
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once('error', () => resolve());
        socket.once('connect', () => { socket.destroy(); reject(Error('listener survived shutdown')); });
      });
      expect(store.getTurnState('owner')).toBe('quarantined');
      expect(await scope.waitForStopped(0)).toBe(false);
      await router.stopTurns();
      expect(dispose).toHaveBeenCalledOnce();
      store.close(); store = new SessionStore(createAdapter(join(root, 'db'))); store.init();
      expect(store.getTurnState('owner')).toBe('quarantined');
    } finally { scope.dispose(); }
  }, 6000);
  it.each(['handler', 'cleanup'] as const)('disposes an unconfirmed scope when late %s completion follows shutdown', async phase => {
    let finish!: () => void;
    const deferred = new Promise<void>(resolve => { finish = resolve; });
    const execution = proof(false);
    let started = false;
    if (phase === 'cleanup') execution.waitForStopped.mockImplementation(async () => { await deferred; return false; });
    const dispatch = router.routeAndHandle(message('late failure'), async (_result, turn) => {
      turn.executionRisk = 'unknown'; turn.registerExecution(execution); started = true;
      if (phase === 'handler') await deferred;
      throw Error('synthetic late failure');
    });
    await vi.waitFor(() => expect(started).toBe(true));
    if (phase === 'cleanup') await vi.waitFor(() => expect(execution.waitForStopped).toHaveBeenCalled());
    await router.stopTurns(1);
    await dispatch;
    store.close(); store = new SessionStore(createAdapter(join(root, 'db'))); store.init();
    finish();
    await vi.waitFor(() => expect(execution.dispose).toHaveBeenCalledOnce());
    expect(store.getTurnState('owner')).toBe('quarantined');
  });
  it('a handler finishing after shutdown cannot write through the closed ledger',async()=>{
    let finish!:()=>void;let started=false;const execution=proof();
    const dispatch=router.routeAndHandle(message('first'),async(_r,t)=>{t.executionRisk='unknown';t.registerExecution(execution);started=true;await new Promise<void>(resolve=>{finish=resolve;});});
    await vi.waitFor(()=>expect(started).toBe(true));await router.stopTurns(1);await dispatch;
    store.close();store=new SessionStore(createAdapter(join(root,'db')));store.init();
    finish();await vi.waitFor(()=>expect(execution.dispose).toHaveBeenCalledOnce());
    expect(store.isTurnQuarantined('owner')).toBe(true);
  });
});
