/**
 * WP-09 production wiring: the explicit transport, per-Bot display
 * capabilities, the transport and route-fact offer gates (D-W1(b)).
 *
 * Evidence label: [UNIT] for `createExplicitTransport` over the real Card API
 * client, policy and pacer with a scripted fetch; [INT-SYNTH] for the real
 * runtime (production op table, real transport, real SQLite store, real G-d
 * admit) driven through the app-server dispatch with a scripted fetch and a
 * manual clock. No Octo send, no model, no app-server process, no live
 * profile call. Route facts are injected as test inputs: this is harness
 * evidence of the transport and ACK behaviour, not production delivery.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardRequestError, createCardApi, type CardApi } from '../cards/api.js';
import type { CardToolResult, DisplayCardArgs, PolicySnapshot, TrustedTurnContext } from '../cards/contracts.js';
import { createExplicitDisplay, type DisplayExplicitCard } from '../cards/explicit-display.js';
import { createExplicitTransport } from '../cards/explicit-transport.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { createPacer } from '../cards/pacer.js';
import { createPolicy } from '../cards/policy.js';
import { cardSubsystemPaths } from '../cards/recovery.js';
import { openCardRuntime, type CardTurnInput, type OpenCardRuntimeOptions } from '../cards/runtime.js';
import type { ExplicitCard } from '../cards/store.js';
import { appServerToolset, explicitPlatformCertified, registerGatewayExposure, type ExplicitTransport } from '../cards/tool-host.js';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { profile } from './fixtures/card-profile.js';
import { liveProfileJson } from './fixtures/card-profile-live.js';
import { json, manualTime, scriptedFetch, type ManualTime, type ScriptedReply } from './fixtures/card-write-harness.js';
import { ADMITTED_CONFIG_TOML } from './fixtures/gd-admit.js';

const CERTIFIED = explicitPlatformCertified();
const DISPLAY: DisplayCardArgs = { title: 'Report', blocks: [{ kind: 'text', text: 'hello' }, { kind: 'facts', items: [{ label: 'k', value: 'v' }] }] };
const SEND_FAILED = { status: 'error', error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'explicit_send_failed' }] } };
const SEND_UNCONFIRMED = { status: 'error', error: { code: 'send_unconfirmed' } };

const roots: string[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ─── [UNIT] the transport over the real API client, policy and pacer ────────

function unitRig(initial: () => unknown = () => profile()) {
  const time = manualTime();
  const net = scriptedFetch(time);
  let body = initial;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith('/v1/bot/card/profile') ? json(200, body()) : net.fetchImpl(input, init)) as typeof fetch;
  const api = createCardApi({ apiUrl: 'https://test.invalid', credential: 'token-a', fetchImpl, nowUtcMs: () => time.wall.nowUtcMs() });
  const botRef = Object.freeze({ originKey: api.origin.key, credentialRef: 'c'.repeat(43) });
  const policy = createPolicy({ botRef, api, clock: time.clock });
  const real = createPacer({ clock: time.clock, timers: time.timers });
  const pacer = { gate: vi.fn(real.gate), observe429: vi.fn(real.observe429), observeSuccess: vi.fn(real.observeSuccess) };
  const transport = createExplicitTransport({ api, pacer, policy, clock: time.clock });
  const ctx: TrustedTurnContext = Object.freeze({
    botRef, route: Object.freeze({ channelId: 'chan', channelType: 1 }), requesterUid: 'u1', sessionKey: 's-1',
    turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: botRef.credentialRef, runtimeIncarnation: randomUUID(),
    injectedServerId: `octo_cards_${randomBytes(16).toString('hex')}`,
    routeEligibility: Object.freeze({ kind: 'dm' as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: 'user' as const }),
  });
  /** A display card built the way the runtime builds it: from the current authorization, snapshot carried. */
  const build = async (args: DisplayCardArgs = DISPLAY): Promise<DisplayExplicitCard> => {
    await policy.snapshot();
    let card: ExplicitCard | undefined;
    const handler = createExplicitDisplay({ capabilities: () => {
      const auth = policy.authorize('display', { botRef });
      return auth.allowed ? { elements: auth.snapshot.display.elements, limits: auth.limits, snapshot: auth.snapshot } : undefined;
    } });
    await handler.handle(args, { ctx, requestId: 'r'.repeat(32) },
      { reserveAndSend: async (c) => { card = c; return { status: 'error', error: { code: 'send_unconfirmed' } }; } }, new AbortController().signal);
    if (card === undefined) throw new Error('not built');
    return card as DisplayExplicitCard;
  };
  const send = (card: ExplicitCard, signal = new AbortController().signal, clientMsgNo = randomUUID()) =>
    transport.send({ ctx, card, cardId: 'card-1', clientMsgNo, signal });
  return { time, net, api, botRef, policy, pacer, transport, ctx, build, send, setProfile: (b: () => unknown) => { body = b; } };
}

describe('explicit transport outcome mapping (C1/C2)', () => {
  it('a valid ACK is acked: exactly one send of the built card with the reserved client_msg_no and route', async () => {
    const r = unitRig();
    const card = await r.build();
    const clientMsgNo = randomUUID();
    const out = await r.send(card, undefined, clientMsgNo);
    expect(out).toEqual({ kind: 'acked', messageId: expect.stringMatching(/^9\d+$/) });
    expect(r.net.sends()).toHaveLength(1);
    const wire = JSON.parse(r.net.sends()[0].body) as Record<string, unknown> & { payload: Record<string, unknown> };
    expect(wire).toMatchObject({ channel_id: 'chan', channel_type: 1, client_msg_no: clientMsgNo });
    expect(wire.payload).toMatchObject({ type: 17, profile: 'octo/v1', card_version: '1.5', plain: card.plain });
    expect(r.net.sends()[0].authorization).toBe('Bearer token-a');
    expect(r.pacer.observeSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 422, 401, 403])('a definite %i rejection is failed, sent once and never retried', async (status) => {
    const r = unitRig();
    const card = await r.build();
    r.net.reply({ status });
    expect(await r.send(card)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(1);
    expect(r.pacer.observeSuccess).not.toHaveBeenCalled();
  });

  it.each<[string, ScriptedReply]>([
    ['a 5xx', { status: 503 }],
    ['a 429', { status: 429 }],
    ['an unlisted 4xx', { status: 409 }],
    ['a 2xx without identity', { status: 200, body: {} }],
    ['a network fault', { network: true }],
  ])('%s after dispatch is ambiguous, sent once and never retried', async (_name, reply) => {
    const r = unitRig();
    const card = await r.build();
    r.net.reply(reply);
    expect(await r.send(card)).toEqual({ kind: 'ambiguous' });
    expect(r.net.sends()).toHaveLength(1);
  });

  it('an abort while the request is in flight is ambiguous, never inferred as not dispatched', async () => {
    const r = unitRig();
    const card = await r.build();
    r.net.reply({ hold: true });
    const ac = new AbortController();
    const pending = r.send(card, ac.signal);
    await r.time.advance(0);
    expect(r.net.heldCount()).toBe(1);
    ac.abort();
    expect(await pending).toEqual({ kind: 'ambiguous' });
    expect(r.net.sends()).toHaveLength(1);
  });

  it('a throw that is neither an API nor a request error is ambiguous', async () => {
    const r = unitRig();
    const card = await r.build();
    const api: Pick<CardApi, 'origin' | 'sendAuthored'> = { origin: r.api.origin, sendAuthored: async () => { throw new TypeError('boom'); } };
    const t = createExplicitTransport({ api, pacer: r.pacer, policy: r.policy, clock: r.time.clock });
    expect(await t.send({ ctx: r.ctx, card, cardId: 'card-1', clientMsgNo: randomUUID(), signal: new AbortController().signal })).toEqual({ kind: 'ambiguous' });
  });

  it('a request error raised inside sendAuthored is a contract failure', async () => {
    const r = unitRig();
    const card = await r.build();
    const api: Pick<CardApi, 'origin' | 'sendAuthored'> = { origin: r.api.origin,
      sendAuthored: () => { throw new CardRequestError('envelope_too_large', 'envelope'); } };
    const t = createExplicitTransport({ api, pacer: r.pacer, policy: r.policy, clock: r.time.clock });
    expect(await t.send({ ctx: r.ctx, card, cardId: 'card-1', clientMsgNo: randomUUID(), signal: new AbortController().signal })).toEqual({ kind: 'failed' });
  });
});

describe('pacer semantics (C3)', () => {
  it('a 429 with Retry-After is ambiguous and cools the origin', async () => {
    const r = unitRig();
    const card = await r.build();
    r.net.reply({ status: 429, headers: { 'retry-after': '5' } });
    expect(await r.send(card)).toEqual({ kind: 'ambiguous' });
    expect(r.pacer.observe429).toHaveBeenCalledWith(r.api.origin, 5000, r.time.now());
    expect(r.pacer.gate(r.api.origin).eligible).toBe(false);
  });

  it('an ineligible origin gate is failed before the request, with zero fetches', async () => {
    const r = unitRig();
    const card = await r.build();
    r.pacer.observe429(r.api.origin, 10_000, r.time.now());
    expect(await r.send(card)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
  });

  it('an already aborted signal is failed before the request', async () => {
    const r = unitRig();
    const card = await r.build();
    const ac = new AbortController();
    ac.abort();
    expect(await r.send(card, ac.signal)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
  });
});

describe('the built snapshot is re-authorized, pinned, just before the send (C4)', () => {
  it('the built card carries the exact snapshot it was fitted under', async () => {
    const r = unitRig();
    const card = await r.build();
    const auth = r.policy.authorize('display', { botRef: r.botRef });
    expect(auth.allowed).toBe(true);
    expect(card.snapshot).toBe((auth as { snapshot: PolicySnapshot }).snapshot);
  });

  it('a display revocation between build and send fails closed with zero fetches', async () => {
    const r = unitRig();
    const card = await r.build();
    r.setProfile(() => profile({ config: { ...profile().config!, display_enabled: false } }));
    await r.time.advance(60_001);
    await r.policy.snapshot();
    expect(await r.send(card)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
  });

  it('a bot setting invalidation or an expired policy fails closed with zero fetches', async () => {
    const r = unitRig();
    const card = await r.build();
    r.policy.invalidate('bot_setting');
    expect(await r.send(card)).toEqual({ kind: 'failed' });
    const s = unitRig();
    const other = await s.build();
    await s.time.advance(60_001);
    expect(await s.send(other)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
    expect(s.net.sends()).toHaveLength(0);
  });

  it('a server limit that shrinks after the handler ran never results in an oversize send', async () => {
    const r = unitRig();
    const card = await r.build({ blocks: [{ kind: 'text', text: 'x'.repeat(3000) }] });
    r.setProfile(() => profile({ limits: { max_payload_bytes: 1024 } }));
    await r.time.advance(60_001);
    await r.policy.snapshot();
    expect(r.policy.authorize('display', { botRef: r.botRef }, card.snapshot).allowed).toBe(true);
    expect(await r.send(card)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
  });

  it('shrunk layout limits fail closed rather than send a card fitted under larger ones', async () => {
    const r = unitRig();
    const card = await r.build();
    r.setProfile(() => profile({ limits: { max_nodes: 1 } }));
    await r.time.advance(60_001);
    await r.policy.snapshot();
    expect(await r.send(card)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
  });

  it('a card without its snapshot, or an interactive card, is never sent', async () => {
    const r = unitRig();
    const card = await r.build();
    const bare: Record<string, unknown> = { ...card };
    delete bare.snapshot;
    expect(await r.send(Object.freeze(bare) as unknown as ExplicitCard)).toEqual({ kind: 'failed' });
    expect(await r.send({ ...card, opcode: 'interactive' } as unknown as ExplicitCard)).toEqual({ kind: 'failed' });
    expect(r.net.sends()).toHaveLength(0);
  });
});

// ─── [INT-SYNTH] the real runtime with the production table ─────────────────

const THREAD = 'thr-1';
const TURN = 'turn-1';
const TOOLSET = appServerToolset();
const ROUTE_OK = { obo: false, docTask: false } as const;

interface Reply { readonly id: number | string; readonly result: { contentItems: { text: string }[]; success: boolean } }

async function runtimeRig(profileBody: () => unknown, over: { token?: string; time?: ManualTime; transport?: ExplicitTransport | null } = {}) {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wp09-wire-')), 'data');
  roots.push(dataDir);
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, 'install-a\n', { mode: 0o600, flag: 'wx' });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, 'install-a', Date.UTC(2026, 9, 24));
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const time = over.time ?? manualTime();
  const net = scriptedFetch(time);
  let body = profileBody;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith('/v1/bot/card/profile') ? json(200, body()) : net.fetchImpl(input, init)) as typeof fetch;
  const codexHome = mkdtempSync(join(tmpdir(), 'wp09-home-'));
  roots.push(codexHome);
  writeFileSync(join(codexHome, 'config.toml'), ADMITTED_CONFIG_TOML);
  cleanups.push(registerGatewayExposure({ sandboxMode: 'read-only', codexHome, apiKeyConfigured: true, sdkEnvAuthMarkers: false }));
  const options: OpenCardRuntimeOptions = {
    adapter, dataDir, apiUrl: 'https://test.invalid', botToken: over.token ?? 'token-a',
    clock: time.clock, wall: time.wall, timers: time.timers, fetchImpl, bootstrapExcludedRoots: [],
    ...(over.transport !== undefined ? { explicitTransportForTest: over.transport } : {}),
  };
  // No explicitOpsForTest: the runtime derives its table from PRODUCTION_EXPLICIT_OPS.
  const runtime = (await openCardRuntime(options))!;
  await runtime.idle();
  cleanups.push(async () => { await runtime.close('shutdown'); adapter.close(); });
  const cwd = mkdtempSync(join('/tmp', 'wp09-cwd-'));
  roots.push(cwd);
  const input = (o: Partial<CardTurnInput> = {}): CardTurnInput => ({ dispatchId: `d-${randomUUID()}`, sessionKey: `s-${randomUUID()}`,
    channelId: 'c', channelType: 1, requesterUid: 'u', resetEpoch: 0, cron: false, obo: undefined, docTask: undefined,
    deadlineMono: time.now() + 300_000, sessionCwd: () => cwd, currentResetEpoch: () => 0, ...o });
  /** One app-server attempt of a turn whose route facts are both proven false. */
  const attempt = () => {
    const begun = runtime.beginTurn(input(ROUTE_OK));
    if (begun?.injection === undefined) throw new Error('not offered');
    const replies: Reply[] = [];
    const cards = begun.injection.prepareAppServerAttempt({ respond: (id, result) => { replies.push({ id, result: result as Reply['result'] }); return true; } });
    if (cards === undefined) throw new Error('no attempt');
    cards.setThread(THREAD, TOOLSET.digest);
    cards.turnStartEnqueued();
    cards.bindTurn(TURN);
    const call = (id: number, callId: string, args: unknown = DISPLAY) =>
      cards.onToolCall(id, { threadId: THREAD, turnId: TURN, callId, namespace: null, tool: 'display', arguments: args });
    return { generation: begun.coordinator.generation, replies, call };
  };
  const displaySends = () => net.sends().filter((s) => 'card' in (JSON.parse(s.body) as { payload: object }).payload);
  const rows = (generation: string) => adapter.prepare('SELECT state, client_msg_no FROM card_explicit_requests WHERE generation = ?').all(generation) as
    Array<{ state: string; client_msg_no: string | null }>;
  return { runtime, adapter, time, net, input, attempt, displaySends, rows, setProfile: (b: () => unknown) => { body = b; } };
}

const result = (rep: Reply | undefined): CardToolResult => JSON.parse(rep!.result.contentItems[0].text) as CardToolResult;

describe.runIf(CERTIFIED)('runtime wiring: one real send through the production table (C1/C2)', () => {
  it('an acked display reaches sendAuthored exactly once with the reserved client_msg_no and is answered sent', async () => {
    const r = await runtimeRig(() => liveProfileJson());
    const a = r.attempt();
    a.call(1, 'c1');
    await r.time.advance(0);
    expect(result(a.replies[0])).toMatchObject({ status: 'sent', message_id: expect.stringMatching(/^9\d+$/), route: { kind: 'dm' } });
    expect(r.displaySends()).toHaveLength(1);
    const [row] = r.rows(a.generation);
    expect(row.state).toBe('acked');
    expect(JSON.parse(r.displaySends()[0].body)).toMatchObject({ channel_id: 'c', channel_type: 1, client_msg_no: row.client_msg_no });
    // A replay joins the acked row.
    a.call(2, 'c1');
    await r.time.advance(0);
    expect(result(a.replies[1]).status).toBe('sent');
    expect(r.displaySends()).toHaveLength(1);
  });

  it.each<[string, ScriptedReply]>([['a 5xx', { status: 503 }], ['a network fault', { network: true }], ['a 2xx without identity', { status: 200, body: {} }]])(
    '%s is send_unconfirmed; a replay never sends again', async (_name, reply) => {
      const r = await runtimeRig(() => liveProfileJson());
      const a = r.attempt();
      r.net.reply(reply);
      a.call(1, 'c1');
      await r.time.advance(0);
      expect(result(a.replies[0])).toEqual(SEND_UNCONFIRMED);
      a.call(2, 'c1');
      await r.time.advance(0);
      expect(result(a.replies[1])).toEqual(SEND_UNCONFIRMED);
      expect(r.displaySends()).toHaveLength(1);
      expect(r.rows(a.generation)).toEqual([expect.objectContaining({ state: 'ambiguous' })]);
    });

  it('a definite 400 is unavailable / explicit_send_failed; the slot stays consumed and nothing is resent', async () => {
    const r = await runtimeRig(() => liveProfileJson());
    const a = r.attempt();
    r.net.reply({ status: 400 });
    a.call(1, 'c1');
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual(SEND_FAILED);
    a.call(2, 'c1');
    await r.time.advance(0);
    expect(result(a.replies[1])).toEqual(SEND_FAILED);
    expect(r.displaySends()).toHaveLength(1);
    expect(r.rows(a.generation)).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(r.adapter.prepare('SELECT logical_send_count AS n FROM card_handler_generations WHERE generation = ?').get(a.generation)).toEqual({ n: 1 });
  });

  it('a display policy that is no longer current at call time is unavailable / display_capability with zero sends', async () => {
    const r = await runtimeRig(() => liveProfileJson());
    const a = r.attempt();
    await r.time.advance(60_001);
    a.call(1, 'c1');
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'display_capability' }] } });
    expect(r.displaySends()).toHaveLength(0);
  });
});

describe.runIf(CERTIFIED)('per-Bot capabilities: elements and limits come from each Bot\'s own policy (C4/C5)', () => {
  it('a TextBlock-only Bot with a smaller payload limit and a full Bot in one process each use their own snapshot', async () => {
    const time = manualTime();
    const narrow = await runtimeRig(() => profile({ elements: ['TextBlock'], limits: { max_payload_bytes: 2048 } }), { token: 'token-a', time });
    const full = await runtimeRig(() => profile(), { token: 'token-b', time });
    const many: DisplayCardArgs = { title: 'Report', blocks: [{ kind: 'facts', items: [{ label: 'k', value: 'v' }] },
      ...Array.from({ length: 40 }, (_, i) => ({ kind: 'text' as const, text: `line ${i} ${'y'.repeat(60)}` }))] };
    const a = narrow.attempt();
    const b = full.attempt();
    a.call(1, 'c1', many);
    b.call(1, 'c1', many);
    await time.advance(0);
    expect(result(a.replies[0]).status).toBe('sent');
    expect(result(b.replies[0]).status).toBe('sent');
    const [na] = narrow.displaySends();
    const [fu] = full.displaySends();
    expect(Buffer.byteLength(na.body, 'utf8')).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(fu.body, 'utf8')).toBeGreaterThan(2048);
    const types = (body: string) => JSON.stringify((JSON.parse(body) as { payload: { card: unknown } }).payload.card);
    expect(types(na.body)).not.toContain('FactSet');
    expect(types(fu.body)).toContain('FactSet');
    expect(na.authorization).toBe('Bearer token-a');
    expect(fu.authorization).toBe('Bearer token-b');
  });
});

describe('offer gates: transport and route facts (F4, D-W1(b), C6)', () => {
  it.runIf(CERTIFIED)('a runtime without a transport offers nothing, even with display enabled and both route facts false', async () => {
    const r = await runtimeRig(() => liveProfileJson(), { transport: null });
    expect(r.runtime.beginTurn(r.input(ROUTE_OK))!.injection).toBeUndefined();
    expect(r.adapter.prepare('SELECT COUNT(*) AS n FROM card_handler_generations').get()).toEqual({ n: 0 });
  });

  it('unknown or true route facts offer nothing; the frozen context counts an unknown fact as ineligible', async () => {
    const r = await runtimeRig(() => liveProfileJson());
    for (const facts of [{}, { obo: undefined, docTask: false }, { obo: false, docTask: undefined }, { obo: true, docTask: false },
      { obo: false, docTask: true }, { obo: true, docTask: true }] as Partial<CardTurnInput>[]) {
      const begun = r.runtime.beginTurn(r.input(facts))!;
      expect(begun.coordinator).toBeDefined();
      expect(begun.injection).toBeUndefined();
      const e = begun.coordinator.context.routeEligibility;
      expect([e.obo, e.docTask]).toEqual([facts.obo !== false, facts.docTask !== false]);
    }
    expect(r.adapter.prepare('SELECT COUNT(*) AS n FROM card_handler_generations').get()).toEqual({ n: 0 });
  });

  it.runIf(CERTIFIED)('both route facts exactly false is offered display, with false facts in the frozen context', async () => {
    const r = await runtimeRig(() => liveProfileJson());
    const begun = r.runtime.beginTurn(r.input(ROUTE_OK))!;
    expect(begun.injection).toBeDefined();
    expect(begun.coordinator.context.routeEligibility).toEqual({ kind: 'dm', obo: false, docTask: false, cron: false });
  });

  it('a denied display policy offers nothing', async () => {
    const r = await runtimeRig(() => profile({ config: { ...profile().config!, display_enabled: false, interaction_enabled: false } }));
    expect(r.runtime.beginTurn(r.input(ROUTE_OK))!.injection).toBeUndefined();
  });
});
