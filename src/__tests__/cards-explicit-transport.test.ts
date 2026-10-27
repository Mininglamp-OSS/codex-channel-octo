/**
 * WP-09 wiring: the explicit display transport over the existing
 * `CardApi.sendAuthored`, per-Bot policy snapshot and origin pacer, and the
 * runtime offer gate that needs a real transport and proven route facts.
 *
 * Evidence label: [UNIT] for the transport over stub ports, [INT-SYNTH] for
 * the real tool host + real SQLite store + real Card API client over a fake
 * fetch and a manual clock, and the real runtime (certified platform only).
 * No Octo send, no model, no app-server process, no live profile call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardApi, CardRequestError, OctoApiError, type CardApi } from '../cards/api.js';
import type { BotRef, CardProfileWire, CardToolResult, DisplayCardArgs, PolicySnapshot, TrustedTurnContext } from '../cards/contracts.js';
import { createExplicitDisplay, type DisplayExplicitCard } from '../cards/explicit-display.js';
import { createExplicitTransport, type ExplicitPacerPort } from '../cards/explicit-transport.js';
import { normalizeLimits } from '../cards/limits.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { createPolicy, type CardPolicy } from '../cards/policy.js';
import { cardSubsystemPaths, openCardSubsystem } from '../cards/recovery.js';
import { openCardRuntime, type CardTurnInput } from '../cards/runtime.js';
import type { CardBinding, CardStore, ExplicitCard } from '../cards/store.js';
import {
  appServerToolset, createToolHost, explicitPlatformCertified, registerGatewayExposure,
  type ExplicitOpHandler, type ExplicitSendPort, type ExplicitTransport, type ToolHost,
} from '../cards/tool-host.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { profile } from './fixtures/card-profile.js';
import { liveProfileJson } from './fixtures/card-profile-live.js';
import { json, manualTime, type ManualTime } from './fixtures/card-write-harness.js';
import { ADMITTED_CONFIG_TOML, admissibleGateway } from './fixtures/gd-admit.js';

const DISPLAY: DisplayCardArgs = { title: 'Report', blocks: [{ kind: 'text', text: 'hello' }, { kind: 'link', label: 'Run', url: 'https://example.com/r/1' }] };
const CLIENT_MSG_NO = '11111111-2222-4333-8444-555555555555';

const roots: string[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ─── fake network ───────────────────────────────────────────────────────────

interface Sent { readonly body: Record<string, unknown> }
type SendReply = () => Response | Promise<Response>;

/** Serves the profile and records every POST to sendMessage; the send reply is scripted. */
function fakeNet(prof: () => unknown) {
  const sent: Sent[] = [];
  let reply: SendReply = () => json(200, { message_id: '9300000001' });
  let profileReads = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/v1/bot/card/profile')) { profileReads++; return json(200, prof()); }
    if (path.endsWith('/v1/bot/sendMessage')) { sent.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return reply(); }
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch;
  return {
    fetchImpl, sent, profileReads: () => profileReads,
    /** Authored (explicit) sends only; automatic registry frames carry a template_ref. */
    authored: () => sent.filter((s) => (s.body.payload as Record<string, unknown>).card !== undefined),
    reply: (r: SendReply) => { reply = r; },
  };
}

function recordingPacer(eligible = true): ExplicitPacerPort & { calls: string[]; eligible: boolean } {
  const p = {
    calls: [] as string[], eligible,
    gate() { p.calls.push('gate'); return p.eligible ? { eligible: true } as const : { eligible: false, eligibleAtMono: 1e9 } as const; },
    observe429(_o: unknown, retryAfterMs: number | undefined) { p.calls.push(`429:${retryAfterMs ?? 'none'}`); },
    observeSuccess() { p.calls.push('success'); },
  };
  return p;
}

// ─── one Bot: real Card API client, real policy ─────────────────────────────

interface Bot {
  readonly api: CardApi; readonly policy: CardPolicy; readonly botRef: BotRef; readonly time: ManualTime;
  readonly net: ReturnType<typeof fakeNet>; readonly pacer: ReturnType<typeof recordingPacer>; readonly transport: ExplicitTransport;
  setProfile(p: unknown): void;
}

async function bot(initial: unknown, time = manualTime(), token = `token-${randomUUID()}`): Promise<Bot> {
  let current = initial;
  const net = fakeNet(() => current);
  const api = createCardApi({ apiUrl: 'https://test.invalid', credential: token, fetchImpl: net.fetchImpl });
  const botRef: BotRef = Object.freeze({ originKey: api.origin.key, credentialRef: token.replace(/[^A-Za-z0-9_-]/g, '') });
  const policy = createPolicy({ botRef, api, clock: time.clock });
  await policy.snapshot();
  const pacer = recordingPacer();
  const transport = createExplicitTransport({ api, policy, pacer, clock: time.clock });
  return { api, policy, botRef, time, net, pacer, transport, setProfile: (p) => { current = p; } };
}

/** The per-Bot display handler exactly as the runtime derives it. */
function perBotDisplay(b: Pick<Bot, 'policy' | 'botRef'>): ExplicitOpHandler {
  return createExplicitDisplay({ capabilities: () => {
    const auth = b.policy.authorize('display', { botRef: b.botRef });
    return auth.allowed ? { elements: auth.snapshot.display.elements, limits: auth.limits, snapshot: auth.snapshot } : undefined;
  } }) as ExplicitOpHandler;
}

function ctxOf(b: Pick<Bot, 'botRef'>, over: Partial<TrustedTurnContext> = {}): TrustedTurnContext {
  return Object.freeze({
    botRef: b.botRef, route: Object.freeze({ channelId: 'chan', channelType: 1 }), requesterUid: 'u1', sessionKey: `s-${randomUUID()}`,
    turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: b.botRef.credentialRef, runtimeIncarnation: randomUUID(),
    routeEligibility: Object.freeze({ kind: 'dm' as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: 'user' as const }), ...over,
  });
}

/** Build one display card through the per-Bot handler without sending it. */
async function built(b: Bot, ctx = ctxOf(b), args: DisplayCardArgs = DISPLAY): Promise<DisplayExplicitCard> {
  const cards: ExplicitCard[] = [];
  const port: ExplicitSendPort = { reserveAndSend: async (card) => { cards.push(card); return { status: 'error', error: { code: 'send_unconfirmed' } } as CardToolResult; } };
  await perBotDisplay(b).handle(args as never, { ctx, requestId: 'r'.repeat(32) }, port, new AbortController().signal);
  expect(cards).toHaveLength(1);
  return cards[0] as DisplayExplicitCard;
}

const sendInput = (ctx: TrustedTurnContext, card: ExplicitCard, signal = new AbortController().signal) =>
  ({ ctx, card, cardId: 'card-1', clientMsgNo: CLIENT_MSG_NO, signal });

// ─── [UNIT] outcomes of the single request ──────────────────────────────────

describe('explicit transport: one sendAuthored, host-owned classification', () => {
  it('a valid ACK is acked with the server id after exactly one request carrying the reserved clientMsgNo', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    expect(await b.transport.send(sendInput(ctx, card))).toEqual({ kind: 'acked', messageId: '9300000001' });
    expect(b.net.authored()).toHaveLength(1);
    const body = b.net.authored()[0].body;
    expect(body).toMatchObject({ channel_id: 'chan', channel_type: 1, client_msg_no: CLIENT_MSG_NO,
      payload: { type: 17, profile: 'octo/v1', card_version: '1.5', plain: card.plain } });
    expect((body.payload as { card: unknown }).card).toEqual(card.authored.card);
    expect(b.pacer.calls).toEqual(['gate', 'success']);
  });

  it.each([400, 404, 422, 401, 403])('HTTP %i is a definite failure (contract/policy), never retried', async (status) => {
    const b = await bot(profile());
    b.net.reply(() => json(status, { error: 'x' }));
    const ctx = ctxOf(b);
    expect(await b.transport.send(sendInput(ctx, await built(b, ctx)))).toEqual({ kind: 'failed' });
    expect(b.net.authored()).toHaveLength(1);
    expect(b.pacer.calls).toEqual(['gate']);
  });

  it.each([
    ['429', () => json(429, {}, { 'retry-after': '7' })],
    ['500', () => json(500, {})],
    ['503', () => json(503, {})],
    ['409 (unlisted 4xx)', () => json(409, {})],
    ['2xx without identity', () => json(200, {})],
    ['2xx malformed body', () => new Response('not json', { status: 200 })],
    ['network error', () => { throw new TypeError('fetch failed'); }],
  ] as const)('%s after dispatch is ambiguous with no resend', async (_label, reply) => {
    const b = await bot(profile());
    b.net.reply(reply as SendReply);
    const ctx = ctxOf(b);
    expect(await b.transport.send(sendInput(ctx, await built(b, ctx)))).toEqual({ kind: 'ambiguous' });
    expect(b.net.authored()).toHaveLength(1);
  });

  it('a 429 is reported to the pacer with its Retry-After and stays ambiguous; only an ACK observes success', async () => {
    const b = await bot(profile());
    b.net.reply(() => json(429, {}, { 'retry-after': '7' }));
    const ctx = ctxOf(b);
    expect(await b.transport.send(sendInput(ctx, await built(b, ctx)))).toEqual({ kind: 'ambiguous' });
    expect(b.pacer.calls).toEqual(['gate', '429:7000']);
  });

  it('an abort during the request is ambiguous, never taken as not dispatched', async () => {
    const b = await bot(profile());
    const ac = new AbortController();
    b.net.reply(() => { ac.abort(); throw new DOMException('aborted', 'AbortError'); });
    const ctx = ctxOf(b);
    expect(await b.transport.send(sendInput(ctx, await built(b, ctx), ac.signal))).toEqual({ kind: 'ambiguous' });
    // An already-aborted signal is passed through to sendAuthored too: still ambiguous, not failed.
    const pre = new AbortController(); pre.abort();
    expect(await b.transport.send(sendInput(ctx, await built(b, ctx), pre.signal))).toEqual({ kind: 'ambiguous' });
  });

  it('any throw inside sendAuthored follows classifySendFailure; a foreign throw is ambiguous', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    const throwing = (err: unknown) => createExplicitTransport({ api: { origin: b.api.origin, sendAuthored: async () => { throw err; } },
      policy: b.policy, pacer: recordingPacer(), clock: b.time.clock });
    expect(await throwing(new CardRequestError('envelope_too_large', 'envelope')).send(sendInput(ctx, card))).toEqual({ kind: 'failed' });
    expect(await throwing(new OctoApiError('send_authored', 'response', 403, 'http_status')).send(sendInput(ctx, card))).toEqual({ kind: 'failed' });
    expect(await throwing(new OctoApiError('send_authored', 'abort', 0, 'aborted')).send(sendInput(ctx, card))).toEqual({ kind: 'ambiguous' });
    expect(await throwing(new OctoApiError('send_authored', 'timeout', 0, 'timeout')).send(sendInput(ctx, card))).toEqual({ kind: 'ambiguous' });
    expect(await throwing(new Error('boom')).send(sendInput(ctx, card))).toEqual({ kind: 'ambiguous' });
  });
});

// ─── [UNIT] prechecks prove pre-request only ────────────────────────────────

describe('explicit transport prechecks: refused before any request', () => {
  it('an ineligible origin gate is failed with zero requests (synchronous gate)', async () => {
    const b = await bot(profile());
    b.pacer.eligible = false;
    const ctx = ctxOf(b);
    expect(await b.transport.send(sendInput(ctx, await built(b, ctx)))).toEqual({ kind: 'failed' });
    expect(b.net.sent).toHaveLength(0);
    expect(b.pacer.calls).toEqual(['gate']);
  });

  it('a card without the built body, plain text or snapshot is failed with zero requests', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    const noSnapshot = { ...card, snapshot: undefined };
    for (const bad of [noSnapshot, { ...card, plain: undefined }, { ...card, authored: undefined }, { ...card, opcode: 'interactive' }, null]) {
      expect(await b.transport.send(sendInput(ctx, bad as unknown as ExplicitCard))).toEqual({ kind: 'failed' });
    }
    expect(b.net.sent).toHaveLength(0);
  });

  it('a pinned snapshot revoked after the build (new policy generation) is failed with zero requests', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    b.policy.invalidate('bot_setting');
    await b.policy.snapshot();
    expect(await b.transport.send(sendInput(ctx, card))).toEqual({ kind: 'failed' });
    expect(b.net.sent).toHaveLength(0);
  });

  it('display disabled by a refreshed profile after the build is failed with zero requests', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    b.setProfile(profile({ config: { ...profile().config!, display_enabled: false } }));
    await b.time.advance(61_000);
    await b.policy.snapshot();
    expect(await b.transport.send(sendInput(ctx, card))).toEqual({ kind: 'failed' });
    expect(b.net.sent).toHaveLength(0);
  });

  it('refit: lower effective limits from a refreshed snapshot refuse a card built under the pinned one', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    b.setProfile(profile({ limits: { max_nodes: 2, max_depth: 12, max_payload_bytes: 16384, max_input_text_bytes: 4096, max_inputs_bytes: 16384 } }));
    await b.time.advance(61_000);
    await b.policy.snapshot();
    expect(await b.transport.send(sendInput(ctx, card))).toEqual({ kind: 'failed' });
    expect(b.net.sent).toHaveLength(0);
    // A card rebuilt under the lower limits fits them.
    const small = await built(b, ctx, { blocks: [{ kind: 'text', text: 'hi' }] });
    expect(await b.transport.send(sendInput(ctx, small))).toMatchObject({ kind: 'acked' });
  });

  it('refit: an element dropped by the refreshed snapshot refuses the card', async () => {
    const b = await bot(profile());
    const ctx = ctxOf(b);
    const card = await built(b, ctx);
    expect(card.authored.card.body.some((e) => e.type === 'ActionSet')).toBe(true);
    b.setProfile(profile({ elements: ['TextBlock', 'RichTextBlock', 'FactSet', 'Container', 'ColumnSet', 'Table'] }));
    await b.time.advance(61_000);
    await b.policy.snapshot();
    expect(await b.transport.send(sendInput(ctx, card))).toEqual({ kind: 'failed' });
    expect(b.net.sent).toHaveLength(0);
  });

  it('two Bots stay isolated: each builds against its own snapshot, and no snapshot authorizes another Bot', async () => {
    const time = manualTime();
    const wide = await bot(profile(), time);
    const narrow = await bot(profile({ elements: ['TextBlock'],
      limits: { max_nodes: 50, max_depth: 4, max_payload_bytes: 4096, max_input_text_bytes: 4096, max_inputs_bytes: 16384 } }), time);
    const wideCard = await built(wide, ctxOf(wide));
    const narrowCard = await built(narrow, ctxOf(narrow));
    expect(wideCard.authored.card.body.map((e) => e.type)).toContain('ActionSet');
    expect(narrowCard.authored.card.body.every((e) => e.type === 'TextBlock')).toBe(true);
    expect(JSON.parse(narrowCard.pinnedLimitsJson!)).toMatchObject({ maxNodes: 50, maxDepth: 4, maxPayloadBytes: 4096 });
    expect(JSON.parse(wideCard.pinnedLimitsJson!)).toEqual(normalizeLimits(undefined).limits);
    // Wide's card carried to the narrow Bot's transport is refused before any request.
    expect(await narrow.transport.send(sendInput(ctxOf(narrow), wideCard))).toEqual({ kind: 'failed' });
    expect(await narrow.transport.send(sendInput(ctxOf(narrow), { ...wideCard, snapshot: narrowCard.snapshot as PolicySnapshot } as DisplayExplicitCard))).toEqual({ kind: 'failed' });
    expect(narrow.net.sent).toHaveLength(0);
    expect(await wide.transport.send(sendInput(ctxOf(wide), wideCard))).toMatchObject({ kind: 'acked' });
    expect(await narrow.transport.send(sendInput(ctxOf(narrow), narrowCard))).toMatchObject({ kind: 'acked' });
  });
});

// ─── [INT-SYNTH] real host + store + transport ──────────────────────────────

const THREAD = 'thr-1';
const TURN = 'turn-1';
const TOOLSET = appServerToolset();
interface Reply { readonly result: { contentItems: { text: string }[]; success: boolean } }
const call = (callId: string, args: unknown = DISPLAY) => ({ threadId: THREAD, turnId: TURN, callId, namespace: null, tool: 'display', arguments: args });
const result = (rep: Reply | undefined): CardToolResult => JSON.parse(rep!.result.contentItems[0].text) as CardToolResult;

function freshDataDir(prefix: string): string {
  const dataDir = join(mkdtempSync(join(tmpdir(), prefix)), 'data');
  roots.push(dataDir);
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, 'install-a\n', { mode: 0o600, flag: 'wx' });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, 'install-a', Date.UTC(2026, 9, 27));
  return dataDir;
}

async function hostRig(b: Bot): Promise<{ host: ToolHost; store: CardStore; adapter: DbAdapter; incarnation: string; admit: () => boolean }> {
  const dataDir = freshDataDir('wp09-tx-');
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: b.time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== 'ready') throw new Error(`subsystem ${sub.state}`);
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: cardSubsystemPaths(dataDir).cardsDir,
    ops: new Map([['display', perBotDisplay(b)]]), excludedRoots: [], clock: b.time.clock, wall: b.time.wall, timers: b.time.timers,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname }, transport: b.transport, policy: b.policy });
  if (host === undefined) throw new Error('no host');
  cleanups.push(() => { host.close({ reason: 'shutdown', deadlineMono: b.time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  return { host, store: sub.store, adapter, incarnation, admit: gateway.admit };
}

function attempt(b: Bot, r: Awaited<ReturnType<typeof hostRig>>) {
  const ctx = ctxOf(b, { runtimeIncarnation: r.incarnation, injectedServerId: `octo_cards_${randomBytes(16).toString('hex')}` });
  const binding: CardBinding = Object.freeze({ sessionKey: ctx.sessionKey, channelId: 'chan', channelType: 1, topicScope: null, generation: ctx.turnGeneration, resetEpoch: 0 });
  const gen = r.host.openGeneration({ ctx, binding, expiresAtMono: b.time.now() + 300_000, currentResetEpoch: () => 0, ops: ['display'], admit: r.admit });
  if (gen === undefined) throw new Error('no generation');
  const replies: Reply[] = [];
  const cards = gen.launch.prepareAppServerAttempt({ respond: (_id, res) => { replies.push({ result: res as Reply['result'] }); return true; } });
  if (cards === undefined) throw new Error('no attempt');
  cards.setThread(THREAD, TOOLSET.digest);
  cards.turnStartEnqueued();
  cards.bindTurn(TURN);
  const counters = () => r.adapter.prepare('SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?')
    .get(ctx.turnGeneration) as { inv: number; sends: number };
  const reservedNo = () => (r.adapter.prepare("SELECT client_msg_no AS n FROM card_messages WHERE kind = 'display'").all() as { n: string }[]).map((x) => x.n);
  return { ctx, cards, replies, counters, reservedNo };
}

describe('real host + store + Card API transport (INT-SYNTH)', () => {
  it('one display call is one real send with the store-reserved clientMsgNo, answered sent after the ACK', async () => {
    const b = await bot(profile());
    const r = await hostRig(b);
    const a = attempt(b, r);
    a.cards.onToolCall(1, call('c1'));
    await b.time.advance(0);
    expect(result(a.replies[0])).toMatchObject({ status: 'sent', message_id: '9300000001', route: { kind: 'dm' } });
    expect(b.net.authored()).toHaveLength(1);
    expect(a.reservedNo()).toEqual([b.net.authored()[0].body.client_msg_no]);
    expect(a.counters()).toEqual({ inv: 1, sends: 1 });
  });

  it('a post-dispatch unknown outcome is send_unconfirmed; the replay joins and nothing is resent; the slot stays consumed', async () => {
    const b = await bot(profile());
    b.net.reply(() => json(503, {}));
    const r = await hostRig(b);
    const a = attempt(b, r);
    a.cards.onToolCall(1, call('c1'));
    await b.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    a.cards.onToolCall(2, call('c1'));
    await b.time.advance(0);
    expect(result(a.replies[1])).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    expect(b.net.authored()).toHaveLength(1);
    expect(a.counters()).toEqual({ inv: 1, sends: 1 });
  });

  it('a definite contract failure is the host explicit_send_failed with one request and no refund', async () => {
    const b = await bot(profile());
    b.net.reply(() => json(422, {}));
    const r = await hostRig(b);
    const a = attempt(b, r);
    a.cards.onToolCall(1, call('c1'));
    await b.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'explicit_send_failed' }] } });
    expect(b.net.authored()).toHaveLength(1);
    expect(a.counters()).toEqual({ inv: 1, sends: 1 });
  });

  it('a pacer-refused send is failed before any request and still consumes its slot', async () => {
    const b = await bot(profile());
    b.pacer.eligible = false;
    const r = await hostRig(b);
    const a = attempt(b, r);
    a.cards.onToolCall(1, call('c1'));
    await b.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'explicit_send_failed' }] } });
    expect(b.net.sent).toHaveLength(0);
    expect(a.counters()).toEqual({ inv: 1, sends: 1 });
  });

  it('policy denied at call time is no send and no reservation', async () => {
    const b = await bot(profile());
    const r = await hostRig(b);
    const a = attempt(b, r);
    b.setProfile(profile({ config: { ...profile().config!, display_enabled: false } }));
    await b.time.advance(61_000);
    await b.policy.snapshot();
    a.cards.onToolCall(1, call('c1'));
    await b.time.advance(0);
    expect(result(a.replies[0]).status).toBe('error');
    expect(b.net.sent).toHaveLength(0);
    expect(a.counters().sends).toBe(0);
  });
});

// ─── runtime offer gate: real transport + proven route facts ───────────────

async function runtimeFor(prof: () => unknown) {
  const dataDir = freshDataDir('wp09-rt-');
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const time = manualTime();
  const net = fakeNet(prof);
  const codexHome = mkdtempSync(join(tmpdir(), 'wp09-home-'));
  roots.push(codexHome);
  writeFileSync(join(codexHome, 'config.toml'), ADMITTED_CONFIG_TOML);
  cleanups.push(registerGatewayExposure({ sandboxMode: 'read-only', codexHome, apiKeyConfigured: true, sdkEnvAuthMarkers: false }));
  const runtime = (await openCardRuntime({ adapter, dataDir, apiUrl: 'https://test.invalid', botToken: `token-${randomUUID()}`,
    clock: time.clock, wall: time.wall, timers: time.timers, fetchImpl: net.fetchImpl, bootstrapExcludedRoots: [] }))!;
  await runtime.idle();
  cleanups.push(async () => { await runtime.close('shutdown'); adapter.close(); });
  const cwd = mkdtempSync(join('/tmp', 'wp09-rt-cwd-'));
  roots.push(cwd);
  const input = (routeFacts: unknown): CardTurnInput => ({ dispatchId: `d-${randomUUID()}`, sessionKey: `s-${randomUUID()}`, channelId: 'c', channelType: 1,
    requesterUid: 'u', resetEpoch: 0, cron: false, deadlineMono: time.now() + 300_000, sessionCwd: () => cwd, currentResetEpoch: () => 0,
    routeFacts: routeFacts as CardTurnInput['routeFacts'] });
  return { runtime, time, net, input };
}

describe('runtime offer gate (D-W1b)', () => {
  it('missing, undefined or true route facts offer no tool even with display enabled on the live profile', async () => {
    const r = await runtimeFor(() => liveProfileJson());
    for (const facts of [undefined, {}, { obo: undefined, docTask: undefined }, { obo: false, docTask: undefined },
      { obo: undefined, docTask: false }, { obo: true, docTask: false }, { obo: false, docTask: true }]) {
      expect(r.runtime.beginTurn(r.input(facts))!.injection).toBeUndefined();
    }
    expect(r.net.authored()).toHaveLength(0);
  });

  it.runIf(explicitPlatformCertified())('both facts exactly false offer display over the real transport: one call is one real send', async () => {
    const r = await runtimeFor(() => liveProfileJson());
    const begun = r.runtime.beginTurn(r.input({ obo: false, docTask: false }))!;
    expect(begun.injection).toBeDefined();
    const replies: Reply[] = [];
    const cards = begun.injection!.prepareAppServerAttempt({ respond: (_id, res) => { replies.push({ result: res as Reply['result'] }); return true; } })!;
    cards.setThread(THREAD, TOOLSET.digest);
    cards.turnStartEnqueued();
    cards.bindTurn(TURN);
    cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(result(replies[0])).toMatchObject({ status: 'sent', message_id: '9300000001' });
    expect(r.net.authored()).toHaveLength(1);
    // Built against the live profile's known intersection: no Image anywhere.
    expect(JSON.stringify(r.net.authored()[0].body)).not.toContain('"Image"');
  });

  it('a profile without display enabled offers nothing even with proven route facts', async () => {
    const r = await runtimeFor(() => profile({ config: { ...profile().config!, display_enabled: false } } as Partial<CardProfileWire>));
    expect(r.runtime.beginTurn(r.input({ obo: false, docTask: false }))!.injection).toBeUndefined();
  });
});
