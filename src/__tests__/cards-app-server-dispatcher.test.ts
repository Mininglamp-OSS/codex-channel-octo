/**
 * App-server explicit-card dispatcher (`AttemptBinding`, XIN-2384 rev2 §5–§6
 * plus addendum A1–A5): G-A2 off-chain.
 *
 * Evidence label: [UNIT]/[INT-SYNTH-OP]. Real SQLite store and the real G-d
 * admit over an admissible fixture; a synthetic test op table and a fake
 * transport; a manual monotonic clock. No production op, no Octo send, no
 * model, no app-server process (the reply port stands in for the client).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardToolResult, ToolOpcode, TrustedTurnContext } from '../cards/contracts.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { canonicalJson } from '../cards/protocol.js';
import { cardSubsystemPaths, openCardSubsystem } from '../cards/recovery.js';
import type { CardBinding, CardStore, ExplicitCard } from '../cards/store.js';
import {
  CALL_ADMISSION_MS, CALL_SETTLE_MS, HOLD_MAX, JOIN_MAX, PRODUCTION_EXPLICIT_OPS, appServerToolset, createToolHost,
  type AppServerAttemptCards, type ExplicitOpHandler, type ExplicitTransport, type ExplicitTransportOutcome, type ToolHost,
} from '../cards/tool-host.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { manualTime, type ManualTime } from './fixtures/card-write-harness.js';
import { admissibleGateway } from './fixtures/gd-admit.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const DISPLAY = { blocks: [{ kind: 'text', text: 'hello' }] };
const THREAD = 'thr-1';
const TURN = 'turn-1';
const TOOLSET = appServerToolset();

interface Reply { readonly id: number | string; readonly result: { contentItems: { text: string }[]; success: boolean }; readonly uncharged: boolean }

interface Rig {
  readonly store: CardStore; readonly adapter: DbAdapter; readonly host: ToolHost; readonly time: ManualTime;
  readonly incarnation: string; readonly admit: () => boolean;
}

async function rig(opts: { ops?: ReadonlyMap<ToolOpcode, ExplicitOpHandler>; transport?: ExplicitTransport } = {}): Promise<Rig> {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'xin2387-disp-')), 'data');
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
    ops: opts.ops ?? new Map([['display', sendingOp('display')]]), excludedRoots: [],
    clock: time.clock, wall: time.wall, timers: time.timers,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname },
    transport: opts.transport ?? transport(),
  });
  if (host === undefined) throw new Error('no host');
  cleanups.push(() => { host.close({ reason: 'shutdown', deadlineMono: time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  return { store: sub.store, adapter, host, time, incarnation, admit: gateway.admit };
}

let messageSeq = 8_000_000_000;
function transport(outcome: () => Promise<ExplicitTransportOutcome> = async () => ({ kind: 'acked', messageId: String(messageSeq++) })): ExplicitTransport & { sends: number } {
  const t = { sends: 0, async send() { t.sends++; return outcome(); } };
  return t;
}

function sendingOp(op: ToolOpcode, before?: () => Promise<void>): ExplicitOpHandler {
  return {
    op,
    async handle(_args, c, send) {
      await before?.();
      const card: ExplicitCard = { opcode: 'display', binding: bindingOf(c.ctx), bodyDigest: 'd'.repeat(64) };
      return send.reserveAndSend(card);
    },
  };
}

function bindingOf(ctx: TrustedTurnContext): CardBinding {
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: ctx.route.channelId, channelType: 1, topicScope: null, generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}

function attempt(r: Rig, over: { ttl?: number; threadDigest?: string | null; ops?: readonly ToolOpcode[] } = {}) {
  const ctx: TrustedTurnContext = Object.freeze({
    botRef: Object.freeze({ originKey: 'https://test.invalid', credentialRef: 'c'.repeat(43) }),
    route: Object.freeze({ channelId: 'chan', channelType: 1 }), requesterUid: 'u1', sessionKey: `s-${randomUUID()}`,
    turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: 'c'.repeat(43), runtimeIncarnation: r.incarnation,
    injectedServerId: `octo_cards_${randomBytes(16).toString('hex')}`,
    routeEligibility: Object.freeze({ kind: 'dm' as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: 'user' as const }),
  });
  const gen = r.host.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: r.time.now() + (over.ttl ?? 300_000),
    currentResetEpoch: () => 0, ops: over.ops ?? ['display'], admit: r.admit });
  if (gen === undefined) throw new Error('no generation');
  const replies: Reply[] = [];
  const cards = gen.launch.prepareAppServerAttempt({ respond: (id, result, o) => { replies.push({ id, result: result as Reply['result'], uncharged: o?.uncharged === true }); return true; } });
  if (cards === undefined) throw new Error('no attempt');
  cards.setThread(THREAD, over.threadDigest === undefined ? TOOLSET.digest : over.threadDigest);
  return { gen, ctx, cards, replies };
}

const call = (callId: string, over: Record<string, unknown> = {}) => ({ threadId: THREAD, turnId: TURN, callId, namespace: null, tool: 'display', arguments: DISPLAY, ...over });
const result = (rep: Reply | undefined): CardToolResult => JSON.parse(rep!.result.contentItems[0].text) as CardToolResult;
const counters = (r: Rig, generation: string) => r.adapter.prepare('SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?').get(generation) as { inv: number; sends: number };
const rows = (r: Rig, generation: string) => r.adapter.prepare('SELECT request_id, state, settled_by FROM card_explicit_requests WHERE generation = ?').all(generation) as Array<{ request_id: string; state: string; settled_by: string | null }>;

function bound(r: Rig, over: Parameters<typeof attempt>[1] = {}) {
  const a = attempt(r, over);
  a.cards.turnStartEnqueued();
  a.cards.bindTurn(TURN);
  return a;
}

describe('toolset (T0/T2a) and production inertness', () => {
  it('declares the full versioned toolset with a stable digest', () => {
    expect(TOOLSET.tools.map((t) => t.name)).toEqual(['display', 'interactive']);
    expect(TOOLSET.tools.every((t) => t.type === 'function')).toBe(true);
    expect(appServerToolset().digest).toBe(TOOLSET.digest);
    expect(TOOLSET.digest).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('the production op table holds the display handler only', () => {
    expect([...PRODUCTION_EXPLICIT_OPS.keys()]).toEqual(['display']);
  });

  it('no attempt opens when the generation has no ops', async () => {
    const r = await rig();
    const ctx = attempt(r).ctx;
    const gen = r.host.openGeneration({ ctx: { ...ctx, turnGeneration: randomUUID(), sessionKey: 's2' } as TrustedTurnContext,
      binding: { ...bindingOf(ctx), generation: 'x' }, expiresAtMono: r.time.now() + 300_000, currentResetEpoch: () => 0, ops: [], admit: r.admit });
    expect(gen?.launch.prepareAppServerAttempt({ respond: () => true })).toBeUndefined();
  });
});

describe('D1′–D6 round trip and the derived logical key (§5.3)', () => {
  it('a bound call is charged once under a1:<sha256(thread, turn, call)> and answered sent', async () => {
    const r = await rig();
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    expect(a.replies).toHaveLength(1);
    expect(a.replies[0]).toMatchObject({ id: 1, uncharged: false, result: { success: true } });
    expect(result(a.replies[0]).status).toBe('sent');
    const key = `a1:${createHash('sha256').update(canonicalJson([THREAD, TURN, 'c1']), 'utf8').digest('hex')}`;
    expect(rows(r, a.ctx.turnGeneration)).toEqual([{ request_id: key, state: 'acked', settled_by: 'app_server' }]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('an identical replay joins at 0 invocations; a changed body is rejected; joins are capped at JOIN_MAX', async () => {
    const r = await rig();
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    for (let i = 0; i < JOIN_MAX; i++) a.cards.onToolCall(10 + i, call('c1'));
    await r.time.advance(0);
    expect(a.replies.slice(1).map((x) => result(x).status)).toEqual(Array(JOIN_MAX).fill('sent'));
    a.cards.onToolCall(99, call('c1'));
    expect(a.replies.at(-1)).toMatchObject({ id: 99, uncharged: true, result: { success: false } });
    a.cards.onToolCall(100, call('c1', { arguments: { blocks: [{ kind: 'text', text: 'other' }] } }));
    expect(result(a.replies.at(-1))).toMatchObject({ status: 'error', error: { code: 'validation_failed' } });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('a different callId is a new logical call', async () => {
    const r = await rig();
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    a.cards.onToolCall(2, call('c2'));
    await r.time.advance(0);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 2, sends: 2 });
  });

  it('D4: invalid grammar is charged and failed; a non-object payload is refused uncharged', async () => {
    const r = await rig();
    const a = bound(r);
    a.cards.onToolCall(1, call('c1', { arguments: { blocks: [{ kind: 'nope' }] } }));
    a.cards.onToolCall(2, call('c2', { arguments: 'not an object' }));
    await r.time.advance(0);
    expect(result(a.replies.find((x) => x.id === 1))).toMatchObject({ status: 'error', error: { code: 'validation_failed' } });
    expect(a.replies.find((x) => x.id === 2)).toMatchObject({ uncharged: true });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 0 });
  });
});

describe('trusted turn assignment and routing (TB-4, TB-5, A5)', () => {
  it('early calls are held uncharged and released in order once the turn is bound', async () => {
    const r = await rig();
    const a = attempt(r);
    a.cards.turnStartEnqueued();
    a.cards.onToolCall(1, call('c1'));
    a.cards.onToolCall(2, call('c2', { turnId: 'other' }));
    expect(a.replies).toEqual([]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 0, sends: 0 });
    a.cards.bindTurn(TURN);
    await r.time.advance(0);
    expect(result(a.replies.find((x) => x.id === 1)).status).toBe('sent');
    expect(a.replies.find((x) => x.id === 2)).toMatchObject({ uncharged: true, result: { success: false } });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('hold overflow and the held deadline give uncharged refusals', async () => {
    const r = await rig();
    const a = attempt(r);
    a.cards.turnStartEnqueued();
    for (let i = 0; i < HOLD_MAX + 1; i++) a.cards.onToolCall(i, call(`c${i}`));
    expect(a.replies).toEqual([expect.objectContaining({ id: HOLD_MAX, uncharged: true })]);
    await r.time.advance(CALL_SETTLE_MS);
    expect(a.replies).toHaveLength(HOLD_MAX + 1);
    expect(a.replies.every((x) => x.uncharged && x.result.contentItems[0].text === 'turn not yet bound')).toBe(true);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 0, sends: 0 });
  });

  it('A5: a call released late keeps its original timer and is cancelled at 16 s (1 invocation, 0 sends)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const r = await rig({ ops: new Map([['display', sendingOp('display', () => gate)]]) });
    const a = attempt(r);
    a.cards.turnStartEnqueued();
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(CALL_SETTLE_MS - 100);
    a.cards.bindTurn(TURN);
    await r.time.advance(100);
    expect(result(a.replies[0])).toMatchObject({ status: 'error', error: { code: 'unavailable' } });
    expect(rows(r, a.ctx.turnGeneration)[0]).toMatchObject({ state: 'cancelled', settled_by: 'app_server' });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 0 });
    release();
  });

  it('calls on other threads, foreign turns, after turn/completed, or before turn/start are refused uncharged', async () => {
    const r = await rig();
    const a = attempt(r);
    a.cards.onToolCall(1, call('c1')); // before turn/start was enqueued
    a.cards.turnStartEnqueued();
    a.cards.bindTurn(TURN);
    a.cards.onToolCall(2, call('c2', { threadId: 'thr-sub' }));
    a.cards.onToolCall(3, call('c3', { turnId: 'turn-x' }));
    a.cards.turnCompleted();
    a.cards.onToolCall(4, call('c4'));
    expect(a.replies.map((x) => [x.id, x.uncharged])).toEqual([[1, true], [2, true], [3, true], [4, true]]);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 0, sends: 0 });
    expect(r.host.stats()).toMatchObject({ appForeignCalls: 2 });
  });

  it('a binding close answers held calls uncharged', async () => {
    const r = await rig();
    const a = attempt(r);
    a.cards.turnStartEnqueued();
    a.cards.onToolCall(1, call('c1'));
    a.cards.close();
    expect(a.replies).toEqual([expect.objectContaining({ id: 1, uncharged: true })]);
    a.cards.onToolCall(2, call('c2'));
    expect(a.replies.at(-1)).toMatchObject({ id: 2, uncharged: true });
  });
});

describe('admission, toolset boundary and call-time policy', () => {
  it(`refuses uncharged when less than ${CALL_ADMISSION_MS} ms remain`, async () => {
    const r = await rig();
    const a = bound(r, { ttl: CALL_ADMISSION_MS - 1 });
    a.cards.onToolCall(1, call('c1'));
    expect(a.replies[0]).toMatchObject({ uncharged: true });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 0, sends: 0 });
  });

  it('T5/R1: a thread without the current toolset gets no explicit cards', async () => {
    const r = await rig();
    for (const digest of [null, 'v0:old']) {
      const a = bound(r, { threadDigest: digest });
      a.cards.onToolCall(1, call('c1'));
      expect(a.replies[0]).toMatchObject({ uncharged: true, result: { contentItems: [{ text: 'unknown tool' }] } });
      expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 0, sends: 0 });
    }
    expect(r.host.stats()).toMatchObject({ appOldThreadCalls: 2 });
  });

  it('T2a/T3: a declared tool the Bot profile does not allow is charged 1, sends 0', async () => {
    const r = await rig();
    const a = bound(r, { ops: ['display'] });
    a.cards.onToolCall(1, call('c1', { tool: 'interactive', arguments: DISPLAY }));
    await r.time.advance(0);
    expect(a.replies[0].uncharged).toBe(false);
    expect(result(a.replies[0]).status).toBe('error');
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 0 });
  });

  it('a namespaced or unknown tool is refused uncharged', async () => {
    const r = await rig();
    const a = bound(r);
    a.cards.onToolCall(1, call('c1', { namespace: 'x' }));
    a.cards.onToolCall(2, call('c2', { tool: 'shell' }));
    expect(a.replies.every((x) => x.uncharged)).toBe(true);
  });
});

describe('R-2/R-4 whole-call timer outcomes (ST-5 end to end)', () => {
  it('a charged call stuck in its handler is cancelled at 16 s', async () => {
    const r = await rig({ ops: new Map([['display', sendingOp('display', () => new Promise(() => {}))]]) });
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(CALL_SETTLE_MS - 1);
    expect(a.replies).toEqual([]);
    await r.time.advance(1);
    expect(result(a.replies[0])).toMatchObject({ status: 'error', error: { code: 'unavailable' } });
    expect(rows(r, a.ctx.turnGeneration)[0]).toMatchObject({ state: 'cancelled', settled_by: 'app_server' });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 0 });
  });

  it('a call whose send hangs is ambiguous at 16 s; the late ack binds the card but changes nothing else', async () => {
    let resolveSend!: (o: ExplicitTransportOutcome) => void;
    const t = transport(() => new Promise((res) => { resolveSend = res; }));
    const r = await rig({ transport: t });
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(CALL_SETTLE_MS);
    expect(result(a.replies[0])).toMatchObject({ status: 'error', error: { code: 'send_unconfirmed' } });
    const [row] = rows(r, a.ctx.turnGeneration);
    expect(row).toMatchObject({ state: 'ambiguous', settled_by: 'app_server' });
    const before = r.adapter.prepare('SELECT state, safe_result_json FROM card_explicit_requests WHERE request_id = ?').get(row.request_id);
    resolveSend({ kind: 'acked', messageId: '9000000001' });
    await r.time.advance(0);
    expect(r.adapter.prepare('SELECT state, safe_result_json FROM card_explicit_requests WHERE request_id = ?').get(row.request_id)).toEqual(before);
    expect(r.store.getExplicitRequest(a.ctx.turnGeneration, row.request_id)).toMatchObject({ lateOutcome: 'acked', lateMessageId: '9000000001' });
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
    expect(a.replies).toHaveLength(1); // no second reply
    expect(t.sends).toBe(1); // no resend
  });

  it('a binding close mid-send settles the row ambiguous and answers the call', async () => {
    const r = await rig({ transport: transport(() => new Promise(() => {})) });
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    a.cards.close();
    expect(result(a.replies[0])).toMatchObject({ error: { code: 'send_unconfirmed' } });
    expect(rows(r, a.ctx.turnGeneration)[0]).toMatchObject({ state: 'ambiguous', settled_by: 'app_server' });
  });

  it("a joiner's own timer answers without touching the original row", async () => {
    const r = await rig({ transport: transport(() => new Promise(() => {})) });
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(1_000);
    a.cards.onToolCall(2, call('c1'));
    await r.time.advance(CALL_SETTLE_MS - 1_000);
    // The original fired first (ambiguous), the joiner then gets the cached result at its own deadline.
    await r.time.advance(1_000);
    expect(a.replies.map((x) => x.id).sort()).toEqual([1, 2]);
    expect(rows(r, a.ctx.turnGeneration)).toHaveLength(1);
    expect(counters(r, a.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  });

  it('a new attempt closes the previous binding first', async () => {
    const r = await rig({ ops: new Map([['display', sendingOp('display', () => new Promise(() => {}))]]) });
    const a = bound(r);
    a.cards.onToolCall(1, call('c1'));
    await r.time.advance(0);
    const second: AppServerAttemptCards | undefined = a.gen.launch.prepareAppServerAttempt({ respond: () => true });
    expect(second).toBeDefined();
    expect(a.replies[0]).toMatchObject({ id: 1 });
    expect(rows(r, a.ctx.turnGeneration)[0]).toMatchObject({ state: 'cancelled' });
  });
});
