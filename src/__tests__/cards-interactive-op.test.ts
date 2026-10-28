import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardApi } from '../cards/api.js';
import type { CardToolResult, TrustedTurnContext } from '../cards/contracts.js';
import { createExplicitDisplay } from '../cards/explicit-display.js';
import { createExplicitInteractive, interactionDegradation, type InteractiveCapability } from '../cards/explicit-interactive.js';
import { createExplicitTransport } from '../cards/explicit-transport.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { createPacer } from '../cards/pacer.js';
import { createPolicy } from '../cards/policy.js';
import { cardSubsystemPaths, openCardSubsystem } from '../cards/recovery.js';
import { PRODUCTION_EXPLICIT_OPS, appServerToolset, createToolHost, type ExplicitOpHandler, type ExplicitTransport } from '../cards/tool-host.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { profile } from './fixtures/card-profile.js';
import { json, manualTime, scriptedFetch } from './fixtures/card-write-harness.js';
import { admissibleGateway } from './fixtures/gd-admit.js';
it('registers exactly the two closed explicit operations', () => {
  expect([...PRODUCTION_EXPLICIT_OPS.keys()]).toEqual(['display', 'interactive']);
});

// Real host + SQLite + policy + REST serializer, entirely over offline fetch doubles.
const roots: string[] = [], cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const args = { title: 'Decide', inputs: [{ id: 'ok', kind: 'toggle' as const, label: 'Approve', required: true }], buttons: [{ id: 'submit', label: 'Continue', data: { decision: 'proceed' } }] };
async function rig(profileBody: () => unknown = () => profile(), transportOverride?: ExplicitTransport) {
  const root = mkdtempSync(join(tmpdir(), 'wp10-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const paths = cardSubsystemPaths(dataDir);
  mkdirSync(paths.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.installationRefPath, 'install-wp10\n', { mode: 0o600 });
  chmodSync(paths.installationRefPath, 0o600);
  const time = manualTime();
  provisionFirstInstallMarker(paths.markerPath, 'install-wp10', time.wall.nowUtcMs());
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== 'ready') throw new Error(`subsystem ${sub.state}`);
  const net = scriptedFetch(time);
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith('/v1/bot/card/profile') ? json(200, profileBody()) : net.fetchImpl(url, init)) as typeof fetch;
  const api = createCardApi({ apiUrl: 'https://test.invalid', credential: 'test-only', fetchImpl });
  const botRef = { originKey: api.origin.key, credentialRef: 'c'.repeat(43) };
  const policy = createPolicy({ botRef, api, clock: time.clock });
  await policy.snapshot();
  const caps = async (): Promise<InteractiveCapability> => {
    const snapshot = await policy.snapshot(), auth = policy.authorize('interaction', { botRef });
    if (auth.allowed) return { kind: 'enabled', caps: { inputs: snapshot.interaction.inputs, limits: auth.limits }, snapshot };
    const reason = interactionDegradation(snapshot);
    return reason ? { kind: 'degrade', reason } : { kind: 'denied' };
  };
  const ops = new Map([
    ['interactive', createExplicitInteractive({ capabilities: caps }) as ExplicitOpHandler],
    ['display', createExplicitDisplay({ capabilities: () => {
      const a = policy.authorize('display', { botRef });
      return a.allowed ? { ...a.snapshot.display, limits: a.limits, snapshot: a.snapshot } : undefined;
    } }) as ExplicitOpHandler],
  ] as const);
  const transport = transportOverride ?? createExplicitTransport({ api, policy, pacer: createPacer({ clock: time.clock, timers: time.timers }), clock: time.clock });
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: paths.cardsDir, ops,
    excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers, policy, transport,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } });
  if (!host) throw new Error('host');
  const gateway = admissibleGateway();
  cleanup.push(() => { host.close({ reason: 'shutdown', deadlineMono: time.now(), signal: AbortSignal.abort() }); gateway.release(); sub.store.retire(); adapter.close(); });
  const ctx: TrustedTurnContext = { botRef, route: { channelId: 'chan', channelType: 2 }, requesterUid: 'requester', sessionKey: 's', turnGeneration: randomUUID(), resetEpoch: 0,
    policyIdentity: 'p', runtimeIncarnation: incarnation, injectedServerId: `octo_cards_${randomBytes(16).toString('hex')}`,
    routeEligibility: { kind: 'group', obo: false, docTask: false, cron: false }, origin: { kind: 'user' } };
  const binding = { sessionKey: ctx.sessionKey, channelId: 'chan', channelType: 2 as const, topicScope: null, generation: ctx.turnGeneration, resetEpoch: 0 };
  const gen = host.openGeneration({ ctx, binding, expiresAtMono: time.now() + 300_000, currentResetEpoch: () => 0, ops: ['interactive', 'display'], admit: gateway.admit });
  if (!gen) throw new Error('generation');
  const replies: CardToolResult[] = [], refusals: string[] = [];
  const responses: { success: boolean; contentItems: { text: string }[] }[] = [];
  const cards = gen.launch.prepareAppServerAttempt({ respond: (_id, result) => {
    const response = result as { success: boolean; contentItems: { text: string }[] };
    responses.push(response);
    const text = response.contentItems[0].text;
    try { replies.push(JSON.parse(text)); } catch { refusals.push(text); }
    return true;
  } });
  if (!cards) throw new Error('attempt');
  cards.setThread('thread', appServerToolset().digest);
  cards.turnStartEnqueued(); cards.bindTurn('turn');
  const call = (id: number, tool = 'interactive', input: unknown = args) => cards.onToolCall(id, { threadId: 'thread', turnId: 'turn', callId: `c${id}`, namespace: null, tool, arguments: input });
  const counters = () => adapter.prepare('SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?').get(ctx.turnGeneration);
  const reopen = async () => {
    const second = createAdapter(join(dataDir, 'cc-octo.db'));
    cleanup.push(() => second.close());
    const reopened = await openCardSubsystem({ adapter: second, dataDir, clock: time.wall, runtimeIncarnation: randomUUID() });
    if (reopened.state === 'ready') cleanup.push(() => reopened.store.retire());
    return { reopened, second };
  };
  return { adapter, store: sub.store, net, time, host, cards, call, replies, responses, refusals, ctx, binding, policy, counters, reopen };
}

describe('atomic interactive sends', () => {
  it.each(['display', 'interactive'])('reports acknowledged %s as outer app-server success', async op => {
    const r = await rig();
    r.net.reply({ status: 200, body: { message_id: '9100' } });
    r.call(1, op, op === 'display' ? { blocks: [{ kind: 'text', text: 'report' }] } : args);
    await r.time.advance(0);
    expect(r.responses).toHaveLength(1);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ status: 'sent', message_id: '9100' });
    expect(r.responses[0].success).toBe(true);
  });
  it('reserves before transport and only binds the acknowledged message and session', async () => {
    let acknowledge!: (value: { kind: 'acked'; messageId: string }) => void;
    const r = await rig(undefined, { send: async () => new Promise(resolve => { acknowledge = resolve; }) });
    r.call(1); await r.time.advance(0);
    expect(r.replies).toEqual([]);
    expect(r.store.activeSessions()).toBe(1);
    expect(r.adapter.prepare('SELECT status FROM card_sessions').get()).toEqual({ status: 'sending' });
    expect(r.adapter.prepare('SELECT message_id FROM card_messages').get()).toEqual({ message_id: null });
    acknowledge({ kind: 'acked', messageId: '9101' }); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'sent', message_id: '9101', session_id: expect.any(String), route: { kind: 'group' } });
    expect(r.responses).toHaveLength(1); expect(r.responses[0].success).toBe(true);
    expect(r.adapter.prepare('SELECT status, requester_uid, authored_contract_json FROM card_sessions').get()).toMatchObject({ status: 'pending', requester_uid: 'requester', authored_contract_json: expect.stringContaining('"kind":"toggle"') });
    expect(r.adapter.prepare('SELECT message_id FROM card_messages').get()).toEqual({ message_id: '9101' });
    r.call(1); await r.time.advance(0);
    expect(r.counters()).toEqual({ inv: 1, sends: 1 });
  });
  it('sends actual v2 through the production transport and returns no success before a valid ACK', async () => {
    const r = await rig(); r.net.reply({ status: 200, body: { message_id: '9102' } });
    r.call(1); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'sent', session_id: expect.any(String) });
    expect(r.responses).toHaveLength(1); expect(r.responses[0].success).toBe(true);
    const wire = JSON.parse(r.net.sends()[0].body);
    expect(wire).toMatchObject({ channel_id: 'chan', payload: { type: 17, profile: 'octo/v2', card: { actions: [{ type: 'Action.Submit', data: { decision: 'proceed' } }] } } });
  });
  it('capacity counts 1000 sending sessions and refuses the next actionable send', async () => {
    const r = await rig();
    const contract = { requesterUid: 'other', contractVersion: 1, authoredContractJson: '{}', authoredDataHash: 'h' };
    for (let i = 0; i < 1000; i++) expect(r.store.reserveSession({ binding: r.binding, bodyDigest: 'd', clientMsgNo: randomUUID(), contract }).kind).toBe('reserved');
    r.call(1); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'error', error: { code: 'capacity_full' } });
    expect(r.store.activeSessions()).toBe(1000);
    expect(r.counters()).toEqual({ inv: 1, sends: 0 });
    expect(r.net.sends()).toHaveLength(0);
  });
  it('rechecks policy at T-bind and never admits a revoked in-flight session', async () => {
    let acknowledge!: (value: { kind: 'acked'; messageId: string }) => void;
    let denied = false;
    const r = await rig(() => denied ? profile({ config: { ...profile().config!, interaction_enabled: false } }) : profile(),
      { send: async () => new Promise(resolve => { acknowledge = resolve; }) });
    r.call(1); await r.time.advance(0);
    denied = true; r.policy.invalidate('bot_setting'); await r.policy.snapshot();
    acknowledge({ kind: 'acked', messageId: '9301' }); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'error', error: { code: 'policy_denied' } });
    expect(r.responses).toHaveLength(1); expect(r.responses[0].success).toBe(false);
    expect(r.adapter.prepare('SELECT status FROM card_sessions').get()).toEqual({ status: 'failed' });
    expect(r.adapter.prepare('SELECT message_id FROM card_messages').get()).toEqual({ message_id: '9301' });
    expect(r.counters()).toEqual({ inv: 1, sends: 1 });
  });
  it('shares 32/10 across 128 concurrent mixed-surface IDs, with no refunds after failures', async () => {
    const r = await rig(undefined, { send: async () => ({ kind: 'failed' }) });
    for (let i = 0; i < 128; i++) r.call(i, i % 2 ? 'display' : 'interactive', i % 2 ? { blocks: [{ kind: 'text', text: 'report' }] } : args);
    await r.time.advance(0);
    expect(r.counters()).toEqual({ inv: 32, sends: 10 });
    expect(r.replies).toHaveLength(32);
    expect(r.refusals).toHaveLength(96);
    r.call(0); await r.time.advance(0);
    expect(r.counters()).toEqual({ inv: 32, sends: 10 });
  });
  it.each(['ambiguous', 'failed'] as const)('keeps %s outcome without fallback or resend', async kind => {
    let sends = 0;
    const r = await rig(undefined, { send: async () => { sends++; return { kind }; } });
    r.call(1); await r.time.advance(0); r.call(1); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'error', error: { code: kind === 'ambiguous' ? 'send_unconfirmed' : 'unavailable' } });
    expect(sends).toBe(1); expect(r.counters()).toEqual({ inv: 1, sends: 1 });
    expect(r.adapter.prepare('SELECT status FROM card_sessions').get()).toMatchObject({ status: kind === 'ambiguous' ? 'ambiguous' : 'failed' });
  });
  it('charges invalid decision and routing calls without reservations', async () => {
    const r = await rig();
    r.call(1, 'interactive', { ...args, channel_id: 'other' });
    r.call(2, 'interactive', { ...args, buttons: [] }); await r.time.advance(0);
    expect(r.replies.map(x => x.status === 'error' && x.error.code)).toEqual(['invalid_route', 'limit_exceeded']);
    expect(r.counters()).toEqual({ inv: 2, sends: 0 }); expect(r.store.activeSessions()).toBe(0);
  });
});

describe('budgeted informational degradation', () => {
  it.each(['reserved', 'acked', 'failed', 'ambiguous'] as const)('preserves invariants and reopens a session-free %s degradation', async state => {
    let settle!: (value: { kind: 'ambiguous' }) => void;
    let sends = 0;
    const r = await rig(() => { throw new TypeError('offline'); }, { send: async () => {
      sends++;
      if (state === 'reserved') return new Promise(resolve => { settle = resolve; });
      return state === 'acked' ? { kind: 'acked', messageId: '9202' } : { kind: state };
    } });
    r.call(1); await r.time.advance(0);
    expect(r.adapter.prepare('SELECT state, opcode FROM card_explicit_requests').get()).toEqual({ state, opcode: 'interactive' });
    expect(r.adapter.prepare('SELECT kind FROM card_messages').get()).toEqual({ kind: 'interactive' });
    const invariants = r.store.checkInvariants();
    const { reopened, second } = await r.reopen();
    // Collect the in-flight result even when startup assertions fail.
    if (state === 'reserved') { settle({ kind: 'ambiguous' }); await r.time.advance(0); }
    expect.soft(invariants).toEqual([]);
    expect(reopened).toMatchObject({ state: 'ready', provenance: 'reopened', ledger: { violations: [], closedGenerations: 1 } });
    if (reopened.state !== 'ready') return;
    expect(reopened.store.checkInvariants()).toEqual([]);
    expect(second.prepare('SELECT state, opcode FROM card_explicit_requests').get()).toEqual({ state: state === 'reserved' ? 'ambiguous' : state, opcode: 'interactive' });
    expect(reopened.store.findSessionByMessageId('9202')).toBeNull();
    expect(second.prepare('SELECT count(*) AS n FROM card_sessions').get()).toEqual({ n: 0 });
    expect(second.prepare('SELECT count(*) AS n FROM card_admissions').get()).toEqual({ n: 0 });
    expect(second.prepare('SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations').get()).toEqual({ inv: 1, sends: 1 });
    r.call(1); await r.time.advance(0);
    expect(sends).toBe(1);
  });
  it('still detects a corrupted request/message relationship', async () => {
    const r = await rig(() => profile({ actions: [] }), { send: async () => ({ kind: 'acked', messageId: '9204' }) });
    r.call(1); await r.time.advance(0);
    expect(r.store.checkInvariants()).toEqual([]);
    r.adapter.prepare("UPDATE card_messages SET kind = 'display'").run();
    expect(r.store.checkInvariants()).toEqual(['request_card_mismatch']);
    const { reopened } = await r.reopen();
    expect(reopened).toMatchObject({ state: 'disabled', reason: 'invariant_failed', violations: ['request_card_mismatch'] });
  });
  it('reports acknowledged degraded text as outer app-server success', async () => {
    const r = await rig(() => { throw new TypeError('offline'); });
    r.net.reply({ status: 200, body: { message_id: '9203' } });
    r.call(1); await r.time.advance(0);
    expect(r.responses).toHaveLength(1);
    expect(r.replies).toEqual([{ status: 'degraded', message_id: '9203', interaction_available: false, reason: 'profile_unavailable' }]);
    expect(r.responses[0].success).toBe(true);
  });
  it.each([
    [{ status: 200, body: {} }, 'send_unconfirmed'],
    [{ status: 403 }, 'unavailable'],
    [{ status: 429, headers: { 'retry-after': '1' } }, 'send_unconfirmed'],
    [{ status: 503 }, 'send_unconfirmed'],
    [{ network: true }, 'send_unconfirmed'],
  ] as const)('requires an acknowledged degraded-text identity under %j', async (response, code) => {
    const r = await rig(() => { throw new TypeError('offline'); });
    r.net.reply(response); r.call(1); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'error', error: { code } });
    expect(r.responses).toHaveLength(1); expect(r.responses[0].success).toBe(false);
    expect(r.net.sends()).toHaveLength(1); expect(r.store.activeSessions()).toBe(0);
    expect(r.counters()).toEqual({ inv: 1, sends: 1 });
    r.call(1); await r.time.advance(0); expect(r.net.sends()).toHaveLength(1);
  });
  it.each(['throw', 'incompatible'])('degrades %s once to acknowledged ordinary text, without a session', async mode => {
    const r = await rig(() => { if (mode === 'throw') throw new TypeError('offline'); return profile({ actions: [] }); });
    r.net.reply({ status: 200, body: { message_id: '9201' } });
    r.call(1); await r.time.advance(0);
    expect(r.replies[0]).toEqual({ status: 'degraded', message_id: '9201', interaction_available: false, reason: mode === 'throw' ? 'profile_unavailable' : 'profile_incompatible' });
    expect(r.responses).toHaveLength(1); expect(r.responses[0].success).toBe(true);
    const wire = JSON.parse(r.net.sends()[0].body);
    expect(wire.payload).toMatchObject({ type: 1, content: expect.stringMatching(/^Interaction unavailable\./) });
    expect(wire.payload.card).toBeUndefined();
    expect(r.store.activeSessions()).toBe(0); expect(r.adapter.prepare('SELECT count(*) AS n FROM card_sessions').get()).toEqual({ n: 0 });
    expect(r.counters()).toEqual({ inv: 1, sends: 1 });
    r.call(1); await r.time.advance(0); expect(r.net.sends()).toHaveLength(1);
  });
  it.each(['enabled', 'throw', 'incompatible'])('rejects final visible-label collisions before reservation under %s capability', async mode => {
    const r = await rig(() => { if (mode === 'throw') throw new TypeError('offline'); return mode === 'incompatible' ? profile({ actions: [] }) : profile(); });
    r.call(1, 'interactive', { ...args, inputs: [{ id: 'pick', kind: 'choice', label: 'Pick', required: true, multiple: false, min: 1, max: 1,
      options: [{ id: 'a', label: 'www.example.com' }, { id: 'b', label: 'www[.]example.com' }] }] });
    await r.time.advance(0);
    expect(r.responses).toHaveLength(1); expect(r.responses[0].success).toBe(false);
    expect(r.replies).toEqual([{ status: 'error', error: { code: 'validation_failed', diagnostics: [{ path: '$.inputs[0].options[1].label', rule: 'label_duplicate' }] } }]);
    expect(r.counters()).toEqual({ inv: 1, sends: 0 });
    expect(r.adapter.prepare('SELECT count(*) AS n FROM card_messages').get()).toEqual({ n: 0 });
    expect(r.store.activeSessions()).toBe(0); expect(r.net.sends()).toHaveLength(0);
  });
  it('retains all degraded send slots after ambiguous results and never creates sessions', async () => {
    const r = await rig(() => { throw new TypeError('offline'); }, { send: async () => ({ kind: 'ambiguous' }) });
    for (let i = 0; i < 11; i++) r.call(i);
    await r.time.advance(0);
    expect(r.counters()).toEqual({ inv: 11, sends: 10 }); expect(r.store.activeSessions()).toBe(0);
    expect(r.replies.every(x => x.status === 'error')).toBe(true);
  });
  it.each([
    () => profile({ config: { ...profile().config!, interaction_enabled: false } }),
    () => profile({ config: {} as never }),
    () => profile({ config: { ...profile().config!, interaction_enabled: false }, actions: [] }),
  ])('hard-denies known or malformed policy, including mixed incompatibility', async body => {
    const r = await rig(body); r.call(1); await r.time.advance(0);
    expect(r.replies[0]).toMatchObject({ status: 'error', error: { code: 'policy_denied' } });
    expect(r.counters()).toEqual({ inv: 1, sends: 0 }); expect(r.net.sends()).toHaveLength(0);
  });
});
