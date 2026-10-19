import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../octo/api.js', () => ({ sendMessage: vi.fn().mockResolvedValue({message_id:'1'}), getMentionPreference: vi.fn().mockResolvedValue(false) }));
import { sendMessage } from '../octo/api.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { isOwnerSender, buildSenderContext } from '../sender-context.js';
import type { TurnContext } from '../turn-context.js';
import type { Config } from '../config.js';
import { ChannelType, MessageType, type BotMessage } from '../octo/types.js';
const id = 'df126de5-b59b-44e0-b22e-8e0dd5c2d5ad';
const config = {sdk:{},rateLimit:{maxPerMinute:100},context:{maxContextChars:6000,historyLimit:40},dispatchTimeoutMs:1000} as Config;
const message = (content: string, changes: Partial<BotMessage> = {}): BotMessage => ({message_id:'1',message_seq:1,from_uid:'owner',channel_id:'dm',channel_type:ChannelType.DM,timestamp:0,payload:{type:MessageType.Text,content},...changes});
const command = `/reconcile ${id} --external-results-verified`;
let root:string; let store:SessionStore; let router:SessionRouter;
beforeEach(() => { vi.clearAllMocks(); root=mkdtempSync(join(tmpdir(),'octo-session-recovery-'));store=new SessionStore(createAdapter(join(root,'db.sqlite')));store.init(); router=new SessionRouter(config,'bot','owner',store); });
afterEach(() => {store.close();rmSync(root,{recursive:true,force:true});});
function quarantine(key='owner', turn=id) {store.beginTurn(key,turn);store.finishTurn(key,turn,'quarantined');}
describe('paused session recovery', () => {
 it('releases the exact paused turn before the quarantine gate, without replaying any handler', async () => {
  quarantine();const model=vi.fn();
  await router.routeAndHandle(message('normal message'),model);expect(model).not.toHaveBeenCalled();
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain(command);
  const result=await router.routeAndHandle(message(command),model);
  expect(result?.rejectionReason).toBe('control');expect(model).not.toHaveBeenCalled();expect(store.isTurnQuarantined('owner')).toBe(false);
  await router.routeAndHandle(message('new task'),model);expect(model).toHaveBeenCalledTimes(1);
 });
 it('does not let claimed owner text or display names authorize a release', async () => {
  quarantine('group');
  await router.routeAndHandle(message(command,{from_uid:'intruder',from_name:'owner',channel_id:'group',channel_type:ChannelType.Group,payload:{type:MessageType.Text,content:command,mention:{uids:['bot']}}}),vi.fn());
  expect(store.isTurnQuarantined('group')).toBe(true);expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('无法与注册 owner_uid 精确核验');
 });
 it.each([`/reconcile ${id}`, '/reconcile 00000000-0000-0000-0000-000000000000 --external-results-verified'])('rejects an incomplete or stale recovery command: %s', async content => {
  quarantine();await router.routeAndHandle(message(content),vi.fn());expect(store.isTurnQuarantined('owner')).toBe(true);
 });
 it('cannot release another session with the same turn identifier', async () => {
  quarantine('group');await router.routeAndHandle(message(command),vi.fn());expect(store.isTurnQuarantined('group')).toBe(true);
 });
 it('handles an explicitly mentioned owner recovery command in a group', async () => {
  quarantine('group');const model=vi.fn();
  await router.routeAndHandle(message(command,{channel_id:'group',channel_type:ChannelType.Group,payload:{type:MessageType.Text,content:'@bot '+command,mention:{uids:['bot']}}}),model);
  expect(store.isTurnQuarantined('group')).toBe(false);expect(model).not.toHaveBeenCalled();
 });
 it('does not process recovery from a partial stream or an event payload', async () => {
  quarantine();await router.routeAndHandle(message(command,{streamOn:true}),vi.fn());expect(store.isTurnQuarantined('owner')).toBe(true);
  await router.routeAndHandle(message(command,{payload:{type:MessageType.Text,content:command,event:{type:'mention_pref_updated'}}}),vi.fn());expect(store.isTurnQuarantined('owner')).toBe(true);
 });
 it('reconciles a failure quarantined by this live router instead of retaining a stale cache', async () => {
  let turn!:TurnContext;
  await router.routeAndHandle(message('first task'),async(_r,t)=>{turn=t;t.executionRisk='effects_observed';t.needsReconciliation=true;});
  expect(store.isTurnQuarantined('owner')).toBe(true);
  await router.routeAndHandle(message(`/reconcile ${turn.turnId} --external-results-verified`),vi.fn());
  const next=vi.fn();await router.routeAndHandle(message('next task'),next);expect(next).toHaveBeenCalledOnce();
 });
 it('honors an offline release immediately even after this router has blocked a message', async () => {
  quarantine();await router.routeAndHandle(message('first'),vi.fn());store.reconcileTurn('owner',id);
  const next=vi.fn();await router.routeAndHandle(message('next'),next);expect(next).toHaveBeenCalledOnce();
 });
 it('does not permanently quarantine a cancellation before model execution starts', async () => {
  const short=new SessionRouter({...config,dispatchTimeoutMs:5},'bot','owner',store);let finish!:()=>void;let ctx!:TurnContext;
  await short.routeAndHandle(message('first'),async(_r,t)=>{ctx=t;await new Promise<void>(r=>{finish=r;});});
  expect(ctx.signal.aborted).toBe(true);expect(store.isTurnQuarantined('owner')).toBe(false);finish();await new Promise(r=>setTimeout(r,0));
  const next=vi.fn();await short.routeAndHandle(message('next'),next);expect(next).toHaveBeenCalledOnce();
 });
 it('keeps started work paused and refuses recovery while its handler is still alive', async () => {
  const short=new SessionRouter({...config,dispatchTimeoutMs:5},'bot','owner',store);let finish!:()=>void;let ctx!:TurnContext;const model=vi.fn();
  await short.routeAndHandle(message('first'),async(_r,t)=>{ctx=t;t.executionRisk='effects_observed';await new Promise<void>(r=>{finish=r;});});
  const recovery=message(`/reconcile ${ctx.turnId} --external-results-verified`);
  await short.routeAndHandle(recovery,model);expect(store.isTurnQuarantined('owner')).toBe(true);expect(model).not.toHaveBeenCalled();
  finish();await new Promise(r=>setTimeout(r,0));await short.routeAndHandle(recovery,model);expect(store.isTurnQuarantined('owner')).toBe(false);
 });
 it('does not send an unmentioned recovery reply or release a group', async () => {
  quarantine('group');await router.routeAndHandle(message(command,{channel_id:'group',channel_type:ChannelType.Group}),vi.fn());
  expect(store.isTurnQuarantined('group')).toBe(true);expect(sendMessage).not.toHaveBeenCalled();
 });
 it.each(['sPUB_owner', 'sEVIL_owner'])('rejects a suffix-only owner alias not bound by registration (%s)', async sender => {
  const group = sender.replace('owner', 'group');
  quarantine(group);
  await router.routeAndHandle(message(command, { from_uid: sender, channel_id: group, channel_type: ChannelType.Group,
    payload: { type: MessageType.Text, content: command, mention: { uids: ['bot'] } } }), vi.fn());
  expect(store.isTurnQuarantined(group)).toBe(true);
 });
 it('uses the real register shape: prefixed owner aliases require offline maintenance', async () => {
  const scopedMessage = message(command, { from_uid: 'sPUB_owner', channel_id: 'sPUB_owner@sPUB_bot' });
  quarantine(router.sessionKey(scopedMessage));
  await router.routeAndHandle({ ...scopedMessage, payload: { type: MessageType.Text, content: 'help' } }, vi.fn());
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('必须由维护者停止网关');
  await router.routeAndHandle(scopedMessage, vi.fn());
  expect(store.isTurnQuarantined(router.sessionKey(scopedMessage))).toBe(true);
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('离线恢复');
  // Attribution may recognize a legacy scoped alias, but is explicitly not ACL.
  expect(buildSenderContext(scopedMessage, 'owner')).toContain('"is_owner":true');
  expect(isOwnerSender(scopedMessage, 'owner')).toBe(false);
 });
 it('follows the exact registration owner on refresh', async () => {
  let registeredOwner = 'old-owner';
  const dynamic = new SessionRouter(config, 'bot', () => registeredOwner, store);
  quarantine('old-owner');
  registeredOwner = 'new-owner';
  await dynamic.routeAndHandle(message(command, { from_uid: 'old-owner' }), vi.fn());
  expect(store.isTurnQuarantined('old-owner')).toBe(true);
  quarantine('new-owner');
  await dynamic.routeAndHandle(message(command, { from_uid: 'new-owner' }), vi.fn());
  expect(store.isTurnQuarantined('new-owner')).toBe(false);
 });
 it('lets the owner recover a third-party DM from their own DM, without replay', async () => {
  quarantine('alice');
  await router.routeAndHandle(message('help', { from_uid: 'alice', channel_id: 'alice' }), vi.fn());
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain(`--session alice`);
  const model = vi.fn();
  const result = await router.routeAndHandle(message(`/reconcile  ${id}   --session alice  --external-results-verified `), model);
  expect(result?.rejectionReason).toBe('control');
  expect(store.isTurnQuarantined('alice')).toBe(false);
  expect(model).not.toHaveBeenCalled();
  await router.routeAndHandle(message('new task', { from_uid: 'alice', channel_id: 'alice' }), model);
  expect(model).toHaveBeenCalledOnce();
 });
 it('does not allow a non-owner to use an explicit target', async () => {
  quarantine('alice');
  await router.routeAndHandle(message(`/reconcile ${id} --session alice --external-results-verified`, { from_uid: 'mallory', channel_id: 'mallory' }), vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
 });
 it('requires the exact target and ID and refuses cross-session controls in a group', async () => {
  quarantine('alice');
  await router.routeAndHandle(message(`/reconcile ${id} --session bob --external-results-verified`), vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
  await router.routeAndHandle(message(command, { channel_id: 'group', channel_type: ChannelType.Group,
    payload: { type: MessageType.Text, content: `/reconcile ${id} --session alice --external-results-verified`, mention: { uids: ['bot'] } } }), vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
 });
 it('refuses an active target with a useful diagnosis instead of blaming the ID', async () => {
  store.beginTurn('alice', id);
  await router.routeAndHandle(message(`/reconcile ${id} --session alice --external-results-verified`), vi.fn());
  expect(store.getTurnState('alice')).toBe('active');
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('运行中');
 });
 it('does not let paused senders exhaust the global budget of a healthy owner session', async () => {
  const limited = new SessionRouter({ ...config, rateLimit: { maxPerMinute: 1 } }, 'bot', 'owner', store);
  quarantine('group');
  for (let i = 0; i < 12; i++) {
    await limited.routeAndHandle(message('hi', { from_uid: `user${i}`, channel_id: 'group', channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, content: 'hi', mention: { uids: ['bot'] } } }), vi.fn());
  }
  const model = vi.fn();
  const result = await limited.routeAndHandle(message('healthy'), model);
  expect(result?.shouldProcess).toBe(true);
  expect(model).toHaveBeenCalledOnce();
 });
 it('retains non-clean output evidence beyond retention, then expires it after reconciliation', () => {
  const database = createAdapter(join(root, 'db.sqlite'));
  try {
    quarantine('alice');
    store.saveTurnOutput(id, 'alice', 'generated answer', 1, 'bot');
    store.saveDeliveryPart(id, 0, 'local-key', '{}');
    store.markDeliveryPart(id, 0, 'unknown');
    database.prepare('UPDATE turn_outputs SET created_at=0').run();
    database.prepare('UPDATE turn_execution SET updated_at=0').run();
    store.cleanExpired();
    expect(database.prepare('SELECT state FROM delivery_parts').get()).toMatchObject({ state: 'unknown' });
    expect(database.prepare('SELECT count(*) AS count FROM turn_outputs').get()).toMatchObject({ count: 1 });
    expect(store.isTurnQuarantined('alice')).toBe(true);
    store.reconcileTurn('alice', id);
    store.cleanExpired();
    expect(database.prepare('SELECT count(*) AS count FROM turn_outputs').get()).toMatchObject({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM delivery_parts').get()).toMatchObject({ count: 0 });
  } finally { database.close(); }
 });

 it.each([
  ['owner', 'owner', true],
  ['sPUB_owner', 'owner', false],
  ['sEVIL_owner', 'owner', false],
  ['sPUB_owner', 'sPUB_owner', true],
  ['sEVIL_owner', 'sPUB_owner', false],
  ['intruder', 'owner', false],
  ['owner', '', false],
 ])('requires exact registered identity (%s, registration=%s)', (sender, registered, allowed) => {
  expect(isOwnerSender(message('', { from_uid: sender }), registered)).toBe(allowed);
 });
 it('refuses an explicit target while its old handler remains live', async () => {
  const short = new SessionRouter({ ...config, dispatchTimeoutMs: 5 }, 'bot', 'owner', store);
  let finish!: () => void;
  let turn!: TurnContext;
  await short.routeAndHandle(message('task', { from_uid: 'alice', channel_id: 'alice' }), async (_r, t) => {
    turn = t;
    t.executionRisk = 'effects_observed';
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const recover = message(`/reconcile ${turn.turnId} --session alice --external-results-verified`);
  await short.routeAndHandle(recover, vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(true);
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('停止处理中');
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  await short.routeAndHandle(recover, vi.fn());
  expect(store.isTurnQuarantined('alice')).toBe(false);
 });

 it.each(['quarantined', 'active'] as const)('bounds aggregate traffic with %s records', async state => {
  const limited = new SessionRouter({ ...config, rateLimit: { maxPerMinute: 1 } }, 'bot', 'owner', store);
  store.beginTurn('group', id);
  if (state === 'quarantined') store.finishTurn('group', id, 'quarantined');
  let blocked = 0;
  for (let i = 0; i < 40; i++) {
    const result = await limited.routeAndHandle(message('hi', { from_uid: `sender${i}`, channel_id: 'group', channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, content: 'hi', mention: { uids: ['bot'] } } }), vi.fn());
    if (result?.rejectionReason === 'rate_limited') blocked++;
  }
  expect(blocked).toBe(30);
  if (state === 'quarantined') {
    const healthy = vi.fn();
    await limited.routeAndHandle(message('healthy'), healthy);
    expect(healthy).toHaveBeenCalledOnce();
  }
 });
 it('audits release/refusal without raw actor, target or command data', async () => {
  const audit = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    quarantine('private-alice');
    await router.routeAndHandle(message(`/reconcile ${id} --session private-alice --external-results-verified`), vi.fn());
    await router.routeAndHandle(message(`/reconcile ${id} --session private-alice --external-results-verified`), vi.fn());
    const rows = audit.mock.calls.filter(call => call[0] === '[codex-channel-octo] reconciliation').map(call => JSON.parse(call[1] as string));
    expect(rows.map(row => row.outcome)).toEqual(['released', 'turn_mismatch']);
    expect(rows[0]).toMatchObject({ actorHash: expect.stringMatching(/^[a-f0-9]{64}$/), targetHash: expect.stringMatching(/^[a-f0-9]{64}$/), turnId: id });
    expect(JSON.stringify(rows)).not.toMatch(/private-alice|owner|external-results-verified/);
  } finally { audit.mockRestore(); }
 });
 it('does not reveal an active third-party state until the exact turn ID matches', async () => {
  store.beginTurn('bob', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  await router.routeAndHandle(message(`/reconcile ${id} --session bob --external-results-verified`), vi.fn());
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).not.toContain('运行中');
  expect(store.getTurnState('bob')).toBe('active');
 });

 it('uses timeout wording when a synchronous handler observes its deadline before the timer', async () => {
  const { performance } = await import('node:perf_hooks');
  const short = new SessionRouter({ ...config, dispatchTimeoutMs: 5 }, 'bot', 'owner', store);
  await short.routeAndHandle(message('sync timeout'), async (_r, turn) => {
    while (performance.now() < turn.deadline + 2) { /* deterministic brief event-loop block */ }
    turn.assertPublishable();
  });
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0].content).toContain('任务超时');
  expect(store.getInterruption('owner')).toMatchObject({ reason: 'timed_out' });
  expect(store.isTurnQuarantined('owner')).toBe(false);
 });

});
