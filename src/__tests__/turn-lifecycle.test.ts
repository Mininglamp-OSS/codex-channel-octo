import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../octo/api.js',()=>({sendMessage:vi.fn().mockResolvedValue({message_id:'1'}),sendTyping:vi.fn().mockResolvedValue(undefined),getMentionPreference:vi.fn().mockResolvedValue(false)}));
import { sendMessage } from '../octo/api.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { StreamRelay } from '../stream-relay.js';
import { AgentFailure } from '../agent-failure.js';
import { TurnContext } from '../turn-context.js';
import type { Config } from '../config.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
let adapter:DbAdapter;let store:SessionStore;let root:string;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(sendMessage).mockReset().mockResolvedValue({message_id:'1',message_seq:1});root=mkdtempSync(join(tmpdir(),'turn-lifecycle-'));adapter=createAdapter(join(root,'sessions.db'));store=new SessionStore(adapter);store.init();});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
const config={sdk:{},rateLimit:{maxPerMinute:100},context:{maxContextChars:6000,historyLimit:40},dispatchTimeoutMs:15} as Config;
const message:BotMessage={message_id:'1',message_seq:1,from_uid:'user',channel_id:'dm',channel_type:ChannelType.DM,timestamp:0,payload:{type:MessageType.Text,content:'do work'}};
describe('durable lifecycle quarantine',()=>{
 it('cancels a timed-out handler and blocks the next message before routing or publication',async()=>{
  const router=new SessionRouter(config,'bot','',store);let release!:()=>void;let turn!:TurnContext;const late=vi.fn();
  await router.routeAndHandle(message,async(_result,ctx)=>{turn=ctx;ctx.executionRisk='unknown';await new Promise<void>(r=>{release=r;});ctx.guard({publish:late}).publish();});
  expect(turn.signal.aborted).toBe(true);expect(store.isTurnQuarantined('user')).toBe(true);
  const next=vi.fn();const result=await router.routeAndHandle({...message,message_id:'2'},next);expect(next).not.toHaveBeenCalled();expect(result?.rejectionReason).toBe('quarantined');
  release();await new Promise(r=>setTimeout(r,0));expect(late).not.toHaveBeenCalled();expect(store.isTurnQuarantined('user')).toBe(true);
 });
 it('startup quarantines an interrupted turn only via the explicit singleton-owner operation',()=>{
  store.beginTurn('session','old');const second=new SessionStore(adapter);second.init();
  expect(adapter.prepare('SELECT state FROM turn_execution').get()).toMatchObject({state:'active'});
  second.recoverInterruptedTurns();expect(adapter.prepare('SELECT state FROM turn_execution').get()).toMatchObject({state:'quarantined'});
  store.deleteSession('session');expect(store.isTurnQuarantined('session')).toBe(true);
  expect(store.reconcileTurn('session','wrong-id')).toBe(false);expect(store.reconcileTurn('session','old')).toBe(true);expect(store.beginTurn('session','new')).toBe(2);
 });
 it('normal completion revokes retained callbacks',async()=>{
  const router=new SessionRouter(config,'bot','',store);let turn!:TurnContext;
  await router.routeAndHandle(message,async(_r,t)=>{turn=t;});
  expect(()=>turn.assertPublishable()).toThrow();expect(store.isTurnQuarantined('user')).toBe(false);
 });
 it('shutdown settles the dispatch gate even when a handler ignores abort and timeouts are disabled',async()=>{
  const router=new SessionRouter({...config,dispatchTimeoutMs:0},'bot','',store);let started=false;
  const dispatch=router.routeAndHandle(message,async(_r,t)=>{started=true;t.executionRisk='unknown';await new Promise<void>(()=>{});});
  await vi.waitFor(()=>expect(started).toBe(true));await router.stopTurns(1);await dispatch;expect(store.isTurnQuarantined('user')).toBe(true);
 });
 it('an older completion cannot overwrite the next generation',()=>{
  store.beginTurn('s','old');store.finishTurn('s','old','clean');store.beginTurn('s','new');store.finishTurn('s','old','clean');expect(store.isTurnQuarantined('s')).toBe(true);
 });
 it('shutdown revokes callbacks and quarantines even if the handler ignores cancellation',async()=>{
  const router=new SessionRouter({...config,dispatchTimeoutMs:1000},'bot','',store);let release!:()=>void;let turn!:TurnContext;
  const task=router.routeAndHandle(message,async(_r,t)=>{turn=t;t.executionRisk='unknown';await new Promise<void>(r=>{release=r;});});
  await vi.waitFor(()=>expect(turn).toBeDefined());await router.stopTurns(1);expect(turn.signal.aborted).toBe(true);expect(store.isTurnQuarantined('user')).toBe(true);
  release();await task;expect(store.isTurnQuarantined('user')).toBe(true);
 });
});
async function deliver(text:string, turn=new TurnContext(1000)){
 store.getOrCreate('s','dm',1);store.saveTurnOutput(turn.turnId,'s',text,10,'bot');
 return {turn,report:await new StreamRelay().deliver('dm',1,(async function*(){yield text;})(),'https://example.com','PRIVATE_TOKEN',524288,undefined,undefined,{turn,store})};
}
describe('delivery outcome and outbox',()=>{
 it('persists fixed message keys without credentials and commits history once',async()=>{
  const {turn,report}=await deliver('answer');expect(report.parts).toMatchObject([{state:'confirmed',messageId:'1'}]);
  const part=adapter.prepare('SELECT * FROM delivery_parts').get() as {payload:string;client_msg_no:string};expect(part.payload).not.toContain('PRIVATE_TOKEN');expect(part.client_msg_no).toBe(vi.mocked(sendMessage).mock.calls[0][0].clientMsgNo);
  store.commitTurnOutput(turn.turnId);store.commitTurnOutput(turn.turnId);expect(store.buildHistoryPrefix('s',10).match(/answer/g)).toHaveLength(1);
 });
 it.each([undefined,{message_id:'invalid'},{message_id:0},{message_id:9007199254740992},{message_id:'9223372036854775808'}])('does not mark an unverified acknowledgement as delivered: %j',async result=>{
  vi.mocked(sendMessage).mockResolvedValue(result as never);await expect(deliver('answer')).rejects.toMatchObject({snapshot:{stage:'delivery'}});
  expect(adapter.prepare('SELECT state FROM delivery_parts').get()).toMatchObject({state:'unknown'});expect(store.buildHistoryPrefix('s',10)).toBe('');
 });
 it('confirms a valid response even when the server rewrites the client message key',async()=>{
  vi.mocked(sendMessage).mockResolvedValue({message_id:'123',message_seq:1,client_msg_no:'server-generated-key'});
  const {turn,report}=await deliver('answer');
  expect(report.parts).toMatchObject([{state:'confirmed',messageId:'123'}]);
  expect(vi.mocked(sendMessage).mock.calls[0][0].clientMsgNo).not.toBe('server-generated-key');
  store.commitTurnOutput(turn.turnId);
  expect(store.buildHistoryPrefix('s',10).match(/answer/g)).toHaveLength(1);
 });
 it('preserves safe API status and endpoint through the relay boundary', async () => {
  const error = new AgentFailure({ stage: 'delivery', category: 'auth', source: 'octo_api', evidence: 'structured', httpStatus: 401, endpoint: '/v1/bot/sendMessage' });
  vi.mocked(sendMessage).mockRejectedValueOnce(error);
  await expect(deliver('answer')).rejects.toBe(error);
  expect(adapter.prepare('SELECT state FROM delivery_parts').get()).toMatchObject({ state: 'unknown' });
 });
 it('stops subsequent segments after one ambiguous send; never loses generated output',async()=>{
  vi.mocked(sendMessage).mockResolvedValueOnce({message_id:'1',message_seq:1}).mockRejectedValueOnce(new Error('PRIVATE_RESPONSE'));
  await expect(deliver('x'.repeat(8000))).rejects.toMatchObject({snapshot:{category:'delivery_failed'}});expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(adapter.prepare('SELECT state FROM delivery_parts ORDER BY part_index').all()).toEqual([{state:'confirmed'},{state:'unknown'},{state:'pending'}]);
  expect(adapter.prepare('SELECT state FROM turn_outputs').get()).toMatchObject({state:'generated'});expect(store.buildHistoryPrefix('s',10)).toBe('');
 });
 it('a local outbox failure prevents any external send',async()=>{
  vi.spyOn(store,'saveDeliveryParts').mockImplementation(()=>{throw new Error('disk full');});await expect(deliver('answer')).rejects.toMatchObject({snapshot:{stage:'history_commit',category:'history_failed'}});expect(sendMessage).not.toHaveBeenCalled();
 });
 it('cancellation after network submission preserves unknown outcome and does not commit history',async()=>{
  const turn=new TurnContext(1000);vi.mocked(sendMessage).mockImplementation(async()=>{turn.cancel();return {message_id:'1',message_seq:1};});await expect(deliver('answer',turn)).rejects.toThrow();expect(adapter.prepare('SELECT state FROM delivery_parts').get()).toMatchObject({state:'unknown'});expect(store.buildHistoryPrefix('s',10)).toBe('');
 });
 it('reset removes output contents while keeping an execution quarantine',async()=>{
  const {turn}=await deliver('private answer');store.beginTurn('s',turn.turnId);store.finishTurn('s',turn.turnId,'quarantined');store.deleteSession('s');expect(adapter.prepare('SELECT * FROM turn_outputs').all()).toEqual([]);expect(adapter.prepare('SELECT * FROM delivery_parts').all()).toEqual([]);expect(store.isTurnQuarantined('s')).toBe(true);
 });
});

 describe('execution evidence retention', () => {
  it('prunes only completed old tombstones and reports unresolved inventory', () => {
    store.beginTurn('done','done-id');store.finishTurn('done','done-id','clean');
    store.beginTurn('paused','paused-id');store.finishTurn('paused','paused-id','quarantined');
    store.beginTurn('active','active-id');
    adapter.prepare('UPDATE turn_execution SET updated_at=0').run();
    expect(store.quarantinedTurnCount()).toBe(1);store.cleanExpired();
    expect(store.getQuarantinedTurnId('done')).toBeUndefined();
    expect(adapter.prepare("SELECT state FROM turn_execution WHERE session_key='done'").get()).toBeUndefined();
    expect(store.getQuarantinedTurnId('paused')).toBe('paused-id');expect(store.getQuarantinedTurnId('active')).toBe('active-id');
  });
 });
