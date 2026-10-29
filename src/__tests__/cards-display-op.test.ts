/**
 * WP-09 explicit display op handler (`ExplicitOpHandler<"display">`):
 * AC-010.1–.4, AC-007.4 and WP09-PF E-G7 (N1/N2), plus the XIN-2384
 * SC-1a/SC-1b late-ACK rules applied to explicit display requests.
 *
 * Evidence label: [UNIT] for the handler over a recording send port, and
 * [INT-SYNTH] for the real tool host + real SQLite store + real G-d admit
 * fixture with a fake transport and a manual clock. No Octo send, no model,
 * no app-server process, no live profile call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCardProfile, serializeSendAuthored } from '../cards/api.js';
import type { CardToolResult, DisplayCardArgs, JsonValue, Limits, TrustedTurnContext } from '../cards/contracts.js';
import { DISPLAY_ACTIONS, DISPLAY_ELEMENTS } from '../cards/display-builder.js';
import { BASELINE_DISPLAY_CAPABILITIES, EXPLICIT_DISPLAY, createExplicitDisplay, type DisplayExplicitCard } from '../cards/explicit-display.js';
import { normalizeLimits } from '../cards/limits.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { parseProfile } from '../cards/profile-parse.js';
import { canonicalJson } from '../cards/protocol.js';
import { cardSubsystemPaths, openCardSubsystem } from '../cards/recovery.js';
import { openCardRuntime, type CardTurnInput } from '../cards/runtime.js';
import type { CardBinding, CardStore, ExplicitCard } from '../cards/store.js';
import {
  CALL_SETTLE_MS, JOIN_MAX, PRODUCTION_EXPLICIT_OPS, appServerToolset, createToolHost, explicitPlatformCertified, registerGatewayExposure,
  type ExplicitOpHandler, type ExplicitOpTable, type ExplicitSendPort, type ExplicitTransport, type ExplicitTransportOutcome, type ToolHost,
} from '../cards/tool-host.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { liveProfileJson } from './fixtures/card-profile-live.js';
import { json, manualTime, scriptedFetch, type ManualTime } from './fixtures/card-write-harness.js';
import { ADMITTED_CONFIG_TOML, admissibleGateway } from './fixtures/gd-admit.js';

const LIMITS: Limits = normalizeLimits(undefined).limits;
const FULL = Object.freeze({ elements: new Set(DISPLAY_ELEMENTS), actions: new Set<string>(DISPLAY_ACTIONS), limits: LIMITS });
const DISPLAY: DisplayCardArgs = { title: 'Report', blocks: [{ kind: 'text', text: 'hello' }, { kind: 'link', label: 'Run', url: 'https://example.com/r/1' }] };

function context(over: Partial<TrustedTurnContext> = {}): TrustedTurnContext {
  return Object.freeze({
    botRef: Object.freeze({ originKey: 'https://test.invalid', credentialRef: 'c'.repeat(43) }),
    route: Object.freeze({ channelId: 'chan', channelType: 2 }), requesterUid: 'u1', sessionKey: `s-${randomUUID()}`,
    turnGeneration: randomUUID(), resetEpoch: 3, policyIdentity: 'c'.repeat(43), runtimeIncarnation: randomUUID(),
    injectedServerId: `octo_cards_${randomBytes(16).toString('hex')}`,
    routeEligibility: Object.freeze({ kind: 'group' as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: 'user' as const }),
    ...over,
  });
}

const SENT: CardToolResult = Object.freeze({ status: 'sent', message_id: '9000000001', route: Object.freeze({ kind: 'group' as const, ref: 'card' }) });

function recordingPort(result: () => Promise<CardToolResult> = async () => SENT): ExplicitSendPort & { cards: ExplicitCard[] } {
  const p = { cards: [] as ExplicitCard[], reserveAndSend: (card: ExplicitCard) => { p.cards.push(card); return result(); } };
  return p;
}

const handle = (args: DisplayCardArgs, ctx = context(), port = recordingPort(), signal = new AbortController().signal,
  h = createExplicitDisplay({ capabilities: () => FULL })) => h.handle(args, Object.freeze({ ctx, requestId: 'r'.repeat(32) }), port, signal);

describe('handler contract (AC-010.1/.4)', () => {
  it('builds one display card bound to the trusted turn and returns the host result unchanged', async () => {
    const ctx = context();
    const port = recordingPort();
    const out = await handle(DISPLAY, ctx, port);
    expect(out).toBe(SENT);
    expect(port.cards).toHaveLength(1);
    const card = port.cards[0] as DisplayExplicitCard;
    expect(card.opcode).toBe('display');
    expect(card.binding).toEqual({ sessionKey: ctx.sessionKey, channelId: 'chan', channelType: 2, topicScope: null,
      generation: ctx.turnGeneration, resetEpoch: 3 });
    expect(card.profile).toBe('octo/v1');
    expect(JSON.parse(card.pinnedLimitsJson!)).toEqual(LIMITS);
    expect(card.authored.profile).toBe('octo/v1');
    expect(card.plain).toBe('Report\n\nhello\nRun: https://example.com/r/1');
    const digest = createHash('sha256').update(canonicalJson({ profile: card.authored.profile, card: card.authored.card, plain: card.plain } as unknown as JsonValue), 'utf8').digest('hex');
    expect(card.bodyDigest).toBe(digest);
    expect(Object.isFrozen(card)).toBe(true);
    // The exact body the transport will serialize is wire-valid.
    expect(serializeSendAuthored({ ...card.authored, route: { channelId: 'chan', channelType: 2 }, clientMsgNo: randomUUID(), plain: card.plain }).bytes).toBeGreaterThan(0);
  });

  it('binds topic routes with their topic scope', async () => {
    const ctx = context({ route: Object.freeze({ channelId: 't1', channelType: 5, topicScope: 't1' }),
      routeEligibility: Object.freeze({ kind: 'topic' as const, obo: false, docTask: false, cron: false }) });
    const port = recordingPort();
    await handle(DISPLAY, ctx, port);
    expect(port.cards[0].binding).toMatchObject({ channelId: 't1', channelType: 5, topicScope: 't1' });
  });

  it('a host failure is returned as is and never retried by the handler', async () => {
    const unconfirmed: CardToolResult = { status: 'error', error: { code: 'send_unconfirmed' } };
    const port = recordingPort(async () => unconfirmed);
    expect(await handle(DISPLAY, context(), port)).toBe(unconfirmed);
    expect(port.cards).toHaveLength(1);
    const throwing = recordingPort(async () => { throw new Error('transport unavailable'); });
    await expect(handle(DISPLAY, context(), throwing)).rejects.toThrow();
    expect(throwing.cards).toHaveLength(1);
  });

  it('invalid authored content fails before any reservation', async () => {
    const port = recordingPort();
    expect(await handle({ blocks: [{ kind: 'link', label: 'x', url: 'javascript:alert(1)' }] }, context(), port))
      .toEqual({ status: 'error', error: { code: 'validation_failed', diagnostics: [{ path: '$.blocks[0].url', rule: 'link_scheme' }] } });
    expect(await handle({ blocks: [] }, context(), port)).toMatchObject({ status: 'error', error: { code: 'validation_failed' } });
    expect(port.cards).toHaveLength(0);
  });

  it('a card that cannot fit fails limit_exceeded with no reservation (AC-007.4)', async () => {
    const port = recordingPort();
    const tiny = createExplicitDisplay({ capabilities: () => ({ ...FULL, limits: { ...LIMITS, maxPayloadBytes: 256 } }) });
    expect(await handle({ title: 'x'.repeat(150), blocks: [{ kind: 'text', text: 'y' }] }, context(), port, undefined, tiny))
      .toEqual({ status: 'error', error: { code: 'limit_exceeded', diagnostics: [{ path: '$', rule: 'card_too_large' }] } });
    expect(port.cards).toHaveLength(0);
  });

  it('an aborted request reserves nothing', async () => {
    const port = recordingPort();
    const ac = new AbortController();
    ac.abort();
    expect(await handle(DISPLAY, context(), port, ac.signal)).toMatchObject({ status: 'error', error: { code: 'unavailable' } });
    expect(port.cards).toHaveLength(0);
  });

  it('no display capability means unavailable and no reservation', async () => {
    const port = recordingPort();
    for (const caps of [undefined, { elements: new Set(['Container']), actions: new Set<string>(DISPLAY_ACTIONS), limits: LIMITS },
      { elements: new Set(DISPLAY_ELEMENTS), limits: LIMITS }]) {
      const h = createExplicitDisplay({ capabilities: () => caps });
      expect(await handle(DISPLAY, context(), port, undefined, h)).toEqual({ status: 'error',
        error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'display_capability' }] } });
    }
    const throwing = createExplicitDisplay({ capabilities: () => { throw new Error('boom'); } });
    expect(await handle(DISPLAY, context(), port, undefined, throwing)).toMatchObject({ status: 'error', error: { code: 'unavailable' } });
    expect(port.cards).toHaveLength(0);
  });
});

describe('route guards (WP09-PF N2 / E-G7)', () => {
  it.each([
    ['obo', { obo: true }],
    ['docTask', { docTask: true }],
    ['cron', { cron: true }],
  ])('a %s route is invalid_route with no reservation', async (_name, flags) => {
    const port = recordingPort();
    const ctx = context({ routeEligibility: Object.freeze({ kind: 'group' as const, obo: false, docTask: false, cron: false, ...flags }) });
    expect(await handle(DISPLAY, ctx, port)).toEqual({ status: 'error', error: { code: 'invalid_route', diagnostics: [{ path: '$', rule: 'route_ineligible' }] } });
    expect(port.cards).toHaveLength(0);
  });

  it.each([
    ['a non-boolean eligibility flag', { routeEligibility: Object.freeze({ kind: 'group', obo: 'no', docTask: false, cron: false }) }],
    ['a route kind that disagrees with the channel type', { routeEligibility: Object.freeze({ kind: 'dm', obo: false, docTask: false, cron: false }) }],
    ['a topic route without its scope', { route: Object.freeze({ channelId: 't1', channelType: 5 }),
      routeEligibility: Object.freeze({ kind: 'topic', obo: false, docTask: false, cron: false }) }],
    ['an unknown channel type', { route: Object.freeze({ channelId: 'c', channelType: 3 }) }],
    ['an empty channel', { route: Object.freeze({ channelId: '', channelType: 2 }) }],
  ])('%s fails closed as invalid_route', async (_name, over) => {
    const port = recordingPort();
    expect(await handle(DISPLAY, context(over as unknown as Partial<TrustedTurnContext>), port)).toMatchObject({ status: 'error', error: { code: 'invalid_route' } });
    expect(port.cards).toHaveLength(0);
  });
});

describe('production registration (B5) and fail-closed live profile', () => {
  it('the production op table holds exactly display and interactive handlers', () => {
    expect([...PRODUCTION_EXPLICIT_OPS.keys()]).toEqual(['display', 'interactive']);
    expect(PRODUCTION_EXPLICIT_OPS.get('display')).toBe(EXPLICIT_DISPLAY);
    expect(EXPLICIT_DISPLAY.op).toBe('display');
    expect(Object.isFrozen(PRODUCTION_EXPLICIT_OPS)).toBe(true);
    expect(PRODUCTION_EXPLICIT_OPS.get('interactive')?.op).toBe('interactive');
  });

  it('the production handler uses only the elements every enabled display profile guarantees', () => {
    expect([...BASELINE_DISPLAY_CAPABILITIES.elements]).toEqual(['TextBlock']);
    expect(BASELINE_DISPLAY_CAPABILITIES.actions.size).toBe(0);
    expect(BASELINE_DISPLAY_CAPABILITIES.limits).toEqual(LIMITS);
  });

  it('the live profile negotiates display over its known elements only (D-W2 Option A); interaction stays disabled', () => {
    const p = parseProfile(projectCardProfile(liveProfileJson() as unknown as JsonValue));
    expect(p.display.state).toBe('enabled');
    expect(p.display.elements.has('Image')).toBe(false);
    expect(p.display.elements.has('ImageSet')).toBe(false);
    expect(p.interaction.state).toBe('disabled');
  });
});

// ─── real host, store and admit (INT-SYNTH) ─────────────────────────────────

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const THREAD = 'thr-1';
const TURN = 'turn-1';
const TOOLSET = appServerToolset();

interface Reply { readonly id: number | string; readonly result: { contentItems: { text: string }[]; success: boolean }; readonly uncharged: boolean }
interface Rig { readonly store: CardStore; readonly adapter: DbAdapter; readonly host: ToolHost; readonly time: ManualTime; readonly incarnation: string; readonly admit: () => boolean }

let messageSeq = 8_100_000_000;
function transport(outcome: () => Promise<ExplicitTransportOutcome> = async () => ({ kind: 'acked', messageId: String(messageSeq++) })): ExplicitTransport & { sends: number; cards: ExplicitCard[] } {
  const t = { sends: 0, cards: [] as ExplicitCard[], async send(input: { card: ExplicitCard }) { t.sends++; t.cards.push(input.card); return outcome(); } };
  return t;
}

async function rig(t: ExplicitTransport | undefined,
  ops: ExplicitOpTable = new Map([['display', createExplicitDisplay({ capabilities: () => FULL }) as ExplicitOpHandler]])): Promise<Rig> {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wp09-disp-')), 'data');
  roots.push(dataDir);
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, 'install-a\n', { mode: 0o600, flag: 'wx' });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, 'install-a', Date.UTC(2026, 9, 24));
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== 'ready') throw new Error(`subsystem ${sub.state}`);
  const host = createToolHost({
    store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir,
    ops, excludedRoots: [],
    clock: time.clock, wall: time.wall, timers: time.timers,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname }, transport: t,
  });
  if (host === undefined) throw new Error('no host');
  cleanups.push(() => { host.close({ reason: 'shutdown', deadlineMono: time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  return { store: sub.store, adapter, host, time, incarnation, admit: gateway.admit };
}

function bindingOf(ctx: TrustedTurnContext): CardBinding {
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: ctx.route.channelId, channelType: 1, topicScope: null, generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}

function bound(r: Rig) {
  const ctx = context({ route: Object.freeze({ channelId: 'chan', channelType: 1 }), resetEpoch: 0, runtimeIncarnation: r.incarnation,
    routeEligibility: Object.freeze({ kind: 'dm' as const, obo: false, docTask: false, cron: false }) });
  const gen = r.host.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: r.time.now() + 300_000, currentResetEpoch: () => 0, ops: ['display'], admit: r.admit });
  if (gen === undefined) throw new Error('no generation');
  const replies: Reply[] = [];
  const cards = gen.launch.prepareAppServerAttempt({ respond: (id, result, o) => { replies.push({ id, result: result as Reply['result'], uncharged: o?.uncharged === true }); return true; } });
  if (cards === undefined) throw new Error('no attempt');
  cards.setThread(THREAD, TOOLSET.digest);
  cards.turnStartEnqueued();
  cards.bindTurn(TURN);
  return { ctx, cards, replies };
}

const call = (callId: string, args: unknown = DISPLAY) => ({ threadId: THREAD, turnId: TURN, callId, namespace: null, tool: 'display', arguments: args });
const result = (rep: Reply | undefined): CardToolResult => JSON.parse(rep!.result.contentItems[0].text) as CardToolResult;
const counters = (r: Rig, generation: string) => r.adapter.prepare('SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?').get(generation) as { inv: number; sends: number };
const rows = (r: Rig, generation: string) => r.adapter.prepare('SELECT request_id, state, settled_by FROM card_explicit_requests WHERE generation = ?').all(generation) as Array<{ request_id: string; state: string; settled_by: string | null }>;

describe('sent only after the ACK (AC-010.4) through the real host', () => {
  it('an acked display is answered sent with the server message id; the transport saw the built card once', async () => {
    const t = transport(async () => ({ kind: 'acked', messageId: '9100000001' }));
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies[0])).toMatchObject({ status: 'sent', message_id: '9100000001', route: { kind: 'dm' } });
    expect(t.sends).toBe(1);
    const card = t.cards[0] as DisplayExplicitCard;
    expect(card.authored.card.body[0]).toMatchObject({ type: 'TextBlock', text: 'Report' });
    expect(rows(r, a.ctx.turnGeneration)).toEqual([expect.objectContaining({ state: 'acked', settled_by: 'app_server' })]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('an identical replay joins the acked row and never sends again', async () => {
    const t = transport();
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    for (let i = 0; i < JOIN_MAX; i++) a.cards.onToolCall(10 + i, call('c1'));
    await r.time.advance(0);
    expect(a.replies.map((x) => result(x).status)).toEqual(Array(JOIN_MAX + 1).fill('sent'));
    expect(t.sends).toBe(1);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('invalid authored content is charged and failed with zero sends', async () => {
    const t = transport();
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1', { blocks: [{ kind: 'link', label: 'x', url: 'http://example.com' }] }));
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'validation_failed', diagnostics: [{ path: '$.blocks[0].url', rule: 'link_scheme' }] } });
    expect(t.sends).toBe(0);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 0 });
  });
});

describe('production inertness at this head', () => {
  it('the production table without a transport (as the runtime builds it) charges, fails and sends nothing', async () => {
    const r = await rig(undefined, PRODUCTION_EXPLICIT_OPS);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'unavailable', diagnostics: [{ path: '$.op', rule: 'explicit_op_unavailable' }] } });
    expect(rows(r, a.ctx.turnGeneration)).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 0 });
    expect(r.adapter.prepare('SELECT COUNT(*) AS n FROM card_messages').get()).toEqual({ n: 0 });
  });
});

describe('reserved-transport ambiguity is never resolved by a resend (N1 / E-G7)', () => {
  it('an ambiguous transport outcome is send_unconfirmed; a replay joins without a second send', async () => {
    const t = transport(async () => ({ kind: 'ambiguous' }));
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    a.cards.onToolCall(2, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies[1])).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    expect(t.sends).toBe(1);
    expect(rows(r, a.ctx.turnGeneration)).toEqual([expect.objectContaining({ state: 'ambiguous' })]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('a transport that throws after the reservation is treated as ambiguous, not failed', async () => {
    const t = transport(async () => { throw new Error('socket reset'); });
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    expect(rows(r, a.ctx.turnGeneration)).toEqual([expect.objectContaining({ state: 'ambiguous' })]);
    expect(t.sends).toBe(1);
  });

  it('only a proven non-delivery is failed; the slot stays consumed (no refund)', async () => {
    const t = transport(async () => ({ kind: 'failed' }));
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'explicit_send_failed' }] } });
    expect(rows(r, a.ctx.turnGeneration)).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
    expect(t.sends).toBe(1);
  });
});

describe('late ACK binding on explicit display requests (XIN-2384 SC-1a/SC-1b)', () => {
  it('a hung send is ambiguous at the reply timer; the late ack is audit only and nothing is resent', async () => {
    let resolveSend!: (o: ExplicitTransportOutcome) => void;
    const t = transport(() => new Promise((res) => { resolveSend = res; }));
    const r = await rig(t);
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(CALL_SETTLE_MS);
    expect(result(a.replies[0])).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    const [row] = rows(r, a.ctx.turnGeneration);
    expect(row).toMatchObject({ state: 'ambiguous', settled_by: 'app_server' });
    const before = r.adapter.prepare('SELECT state, safe_result_json FROM card_explicit_requests WHERE request_id = ?').get(row.request_id);
    resolveSend({ kind: 'acked', messageId: '9100000077' });
    await r.time.advance(0);
    expect(r.adapter.prepare('SELECT state, safe_result_json FROM card_explicit_requests WHERE request_id = ?').get(row.request_id)).toEqual(before);
    expect(r.store.getExplicitRequest(a.ctx.turnGeneration, row.request_id)).toMatchObject({ lateOutcome: 'acked', lateMessageId: '9100000077' });
    a.cards.onToolCall(2, call('c1'));
    await r.time.advance(0);
    expect(result(a.replies.at(-1))).toEqual({ status: 'error', error: { code: 'send_unconfirmed' } });
    expect(t.sends).toBe(1);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });
});

// ─── N2: the real production table through the real runtime ────────────────

async function productionRuntime(profileBody: unknown) {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wp09-prod-')), 'data');
  roots.push(dataDir);
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, 'install-a\n', { mode: 0o600, flag: 'wx' });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, 'install-a', Date.UTC(2026, 9, 24));
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const time = manualTime();
  const net = scriptedFetch(time);
  let profileReads = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith('/v1/bot/card/profile')) { profileReads++; return json(200, profileBody); }
    return net.fetchImpl(input, init);
  }) as typeof fetch;
  // An admissible G-d exposure, so G-a (the profile) is the only gate left to refuse.
  const codexHome = mkdtempSync(join(tmpdir(), 'wp09-home-'));
  roots.push(codexHome);
  writeFileSync(join(codexHome, 'config.toml'), ADMITTED_CONFIG_TOML);
  cleanups.push(registerGatewayExposure({ sandboxMode: 'read-only', codexHome, apiKeyConfigured: true, sdkEnvAuthMarkers: false }));
  // No explicitOpsForTest: the runtime uses PRODUCTION_EXPLICIT_OPS.
  const runtime = (await openCardRuntime({ adapter, dataDir, apiUrl: 'https://test.invalid', botToken: 'token-a',
    clock: time.clock, wall: time.wall, timers: time.timers, fetchImpl, bootstrapExcludedRoots: [] }))!;
  await runtime.idle();
  cleanups.push(async () => { await runtime.close('shutdown'); adapter.close(); });
  const cwd = mkdtempSync(join('/tmp', 'wp09-cwd-'));
  roots.push(cwd);
  const input = (over: Partial<CardTurnInput> = {}): CardTurnInput => ({ dispatchId: `d-${randomUUID()}`, sessionKey: `s-${randomUUID()}`, channelId: 'c', channelType: 1,
    requesterUid: 'u', resetEpoch: 0, cron: false, obo: undefined, docTask: undefined, deadlineMono: time.now() + 300_000, sessionCwd: () => cwd,
    currentResetEpoch: () => 0, ...over });
  const ledger = () => ({
    generations: (adapter.prepare('SELECT COUNT(*) AS n FROM card_handler_generations').get() as { n: number }).n,
    requests: (adapter.prepare('SELECT COUNT(*) AS n FROM card_explicit_requests').get() as { n: number }).n,
    messages: (adapter.prepare("SELECT COUNT(*) AS n FROM card_messages WHERE kind = 'display'").get() as { n: number }).n,
  });
  return { runtime, input, ledger, profileReads: () => profileReads };
}

describe('runtime-level production path with the live profile (WP09-PF N2 replacement)', () => {
  it('the real production table offers no op, opens no attempt and writes no ledger row while the route facts are unknown (D-W1(b))', async () => {
    const r = await productionRuntime(liveProfileJson());
    expect(r.profileReads()).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      const begun = r.runtime.beginTurn(r.input())!;
      expect(begun.coordinator).toBeDefined();
      expect(begun.injection).toBeUndefined();
      expect(begun.coordinator.context.injectedServerId).toBeUndefined();
    }
    expect(r.ledger()).toEqual({ generations: 0, requests: 0, messages: 0 });
  });

  it.runIf(explicitPlatformCertified())('control: the same rig with both route facts proven false does offer display, so the refusal above is the route gate', async () => {
    const r = await productionRuntime(liveProfileJson());
    const begun = r.runtime.beginTurn(r.input({ obo: false, docTask: false }))!;
    expect(begun.injection).toBeDefined();
    expect(r.ledger()).toMatchObject({ generations: 1, requests: 0, messages: 0 });
  });
});
