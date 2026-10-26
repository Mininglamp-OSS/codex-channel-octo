/**
 * G-A2/G-A3 on the packaged Codex 0.163.0 binary: explicit card tools as
 * host-dispatched `dynamicTools`, end to end through the bridge.
 *
 * Real: the app-server child, its pipes, the gateway tool host and SQLite
 * ledger, the G-d admit over an admissible fixture. Mocked: the model (a
 * local Responses endpoint with a synthetic key), the card op (a synthetic
 * test-only `display` handler) and the Octo transport (a fake that acks).
 * The production op table stays empty; nothing reaches Octo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_TOOLSET_NOTICE, queryAgentEvents, type AgentOutputEvent } from '../agent-bridge.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';
import type { ToolOpcode, TrustedTurnContext } from '../cards/contracts.js';
import { provisionFirstInstallMarker } from '../cards/migrations.js';
import { cardSubsystemPaths, openCardSubsystem } from '../cards/recovery.js';
import type { CardBinding, CardStore, ExplicitCard } from '../cards/store.js';
import { appServerToolset, createToolHost, type ExplicitOpHandler, type ToolHost } from '../cards/tool-host.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { resolvePinnedCodexBinary } from '../app-server/spawn.js';
import type { AppServerExecution } from '../app-server/runner.js';
import { admissibleGateway, type AdmissibleGateway } from './fixtures/gd-admit.js';
import { startMockResponses, type MockResponses } from './fixtures/mock-responses.js';

const BIN = resolvePinnedCodexBinary();
const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const DISPLAY_CALL = 'TOOL:display:{"blocks":[{"kind":"text","text":"hello card"}]}';

let mock: MockResponses;
beforeAll(async () => { if (BIN !== null) mock = await startMockResponses(); });
afterAll(async () => { if (BIN !== null) await mock.close(); });

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } } });

interface Rig { store: CardStore; adapter: DbAdapter; host: ToolHost; gateway: AdmissibleGateway; incarnation: string; sends: ExplicitCard[] }

async function rig(): Promise<Rig> {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'xin2387-e2e-')), 'data');
  mkdirSync(dataDir);
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, 'install-a\n', { mode: 0o600, flag: 'wx' });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, 'install-a', Date.UTC(2026, 9, 24));
  const adapter = createAdapter(join(dataDir, 'cc-octo.db'));
  new SessionStore(adapter).init();
  const incarnation = randomUUID();
  const clock = { nowMono: () => performance.now() };
  const wall = { nowUtcMs: () => Date.now() };
  const sub = await openCardSubsystem({ adapter, dataDir, clock: wall, runtimeIncarnation: incarnation });
  if (sub.state !== 'ready') throw new Error(`subsystem ${sub.state}`);
  const sends: ExplicitCard[] = [];
  let msg = 9_100_000_000;
  const op: ExplicitOpHandler = {
    op: 'display',
    async handle(_args, c, send) {
      return send.reserveAndSend({ opcode: 'display', binding: bindingOf(c.ctx), bodyDigest: 'd'.repeat(64) });
    },
  };
  const host = createToolHost({
    store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir, ops: new Map<ToolOpcode, ExplicitOpHandler>([['display', op]]),
    excludedRoots: [], clock, wall, timers: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname },
    transport: { async send({ card }) { sends.push(card); return { kind: 'acked', messageId: String(msg++) }; } },
  });
  if (host === undefined) throw new Error('no host');
  const gateway = admissibleGateway();
  cleanups.push(() => { host.close({ reason: 'shutdown', deadlineMono: performance.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); gateway.release(); });
  return { store: sub.store, adapter, host, gateway, incarnation, sends };
}

function bindingOf(ctx: TrustedTurnContext): CardBinding {
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: ctx.route.channelId, channelType: 1, topicScope: null, generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}

function generation(r: Rig, sessionKey: string) {
  const ctx: TrustedTurnContext = Object.freeze({
    botRef: Object.freeze({ originKey: 'https://test.invalid', credentialRef: 'c'.repeat(43) }),
    route: Object.freeze({ channelId: 'chan', channelType: 1 }), requesterUid: 'u1', sessionKey,
    turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: 'c'.repeat(43), runtimeIncarnation: r.incarnation,
    injectedServerId: `octo_cards_${randomBytes(16).toString('hex')}`,
    routeEligibility: Object.freeze({ kind: 'dm' as const, obo: false, docTask: false, cron: false }),
    origin: Object.freeze({ kind: 'user' as const }),
  });
  const gen = r.host.openGeneration({ ctx, binding: bindingOf(ctx), expiresAtMono: performance.now() + 300_000, currentResetEpoch: () => 0, ops: ['display'], admit: r.gateway.admit });
  if (gen === undefined) throw new Error('no generation');
  return { gen, ctx };
}

function config(r: Rig): Config {
  return {
    botToken: 't', apiUrl: 'https://example.com', baseDir: r.gateway.cwd, cwd: r.gateway.cwd, cwdBase: r.gateway.cwd, dataDir: r.gateway.cwd,
    sdk: { runtime: 'app-server', codexHome: r.gateway.codexHome, codexApiKey: 'sk-synthetic-harness', codexBaseUrl: mock.baseUrl, env: NO_PROXY, model: 'gpt-5.1' },
    rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 }, maxResponseChars: 524288, dispatchTimeoutMs: 300000,
  } as Config;
}

async function run(r: Rig, text: string, opts: { cards?: ReturnType<typeof generation>; resume?: string; digest?: string | null } = {}) {
  const events: AgentOutputEvent[] = [];
  const executions: ManagedExecution[] = [];
  let session: { id: string; digest: string | null | undefined } | undefined;
  const before = mock.requests.length;
  for await (const ev of queryAgentEvents(text, config(r), undefined, undefined, {
    onManagedExecution: (e) => executions.push(e),
    onSessionId: (id, _p, digest) => { session = { id, digest }; },
    ...(opts.cards ? { cardInjection: opts.cards.gen.launch } : {}),
    ...(opts.resume ? { resume: opts.resume, threadToolsetDigest: opts.digest ?? null } : {}),
  })) events.push(ev);
  const requests = mock.requests.slice(before);
  const messages = events.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text);
  await (executions[0] as AppServerExecution).waitForStopped(10_000);
  return { events, messages, session, requests };
}

const toolNames = (req: { body: Record<string, unknown> }): string[] =>
  ((req.body.tools as Array<{ name?: string; type?: string }> | undefined) ?? []).map((t) => t.name ?? t.type ?? '');
/** Text items of each user message in a Responses request, oldest first. */
const userMessages = (req: { body: Record<string, unknown> }): string[][] =>
  ((req.body.input as Array<Record<string, unknown>> | undefined) ?? []).filter((i) => i.role === 'user')
    .map((i) => ((i.content as Array<{ text?: unknown }> | undefined) ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')));
const ledger = (r: Rig, generationId: string) =>
  r.adapter.prepare('SELECT state, settled_by FROM card_explicit_requests WHERE generation = ?').all(generationId);
const budget = (r: Rig, generationId: string) =>
  r.adapter.prepare('SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations WHERE generation = ?').get(generationId);

describe.runIf(BIN !== null)('explicit cards over app-server dynamicTools (real 0.163.0 binary; model, op and transport mocked)', () => {
  it('G-A2: a new thread declares the full toolset; a model call is dispatched in-process and answered', async () => {
    const r = await rig();
    const cards = generation(r, 's1');
    const out = await run(r, DISPLAY_CALL, { cards });
    // T2a: both tools declared on thread/start; T0: the digest is reported with the thread id.
    expect(toolNames(out.requests[0])).toEqual(expect.arrayContaining(['display', 'interactive']));
    expect(out.session?.digest).toBe(appServerToolset().digest);
    // developerInstructions on thread/start reaches the model.
    expect(JSON.stringify(out.requests[0].body)).toContain('Explicit card tools (display, interactive) are available');
    expect(r.sends).toHaveLength(1);
    expect(ledger(r, cards.ctx.turnGeneration)).toEqual([{ state: 'acked', settled_by: 'app_server' }]);
    expect(budget(r, cards.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
    // The model saw the bounded card result; the final answer stays on the normal reply path.
    expect(out.messages.at(-1)).toContain('"status":"sent"');
    expect(out.events.some((e) => e.kind === 'work')).toBe(false);
  }, 90_000);

  it('G-A3: a resumed thread keeps its tools (T1) and later turns dispatch again', async () => {
    const r = await rig();
    const first = await run(r, 'hello', { cards: generation(r, 's2') });
    const cards = generation(r, 's2');
    const out = await run(r, DISPLAY_CALL, { cards, resume: first.session!.id, digest: first.session!.digest ?? null });
    expect(out.session?.id).toBe(first.session!.id);
    expect(toolNames(out.requests[0])).toEqual(expect.arrayContaining(['display', 'interactive']));
    expect(budget(r, cards.ctx.turnGeneration)).toEqual({ inv: 1, sends: 1 });
  }, 90_000);

  it('R1: a thread started without cards gets none on resume; the gateway logs it', async () => {
    const warn = vi.spyOn(console, 'warn');
    cleanups.push(() => warn.mockRestore());
    const r = await rig();
    const first = await run(r, 'hello');
    expect(toolNames(first.requests[0])).not.toContain('display');
    expect(first.session?.digest).toBeNull();
    const cards = generation(r, 's3');
    const out = await run(r, DISPLAY_CALL, { cards, resume: first.session!.id, digest: null });
    expect(toolNames(out.requests[0])).not.toContain('display');
    // Finding (G-A3): 0.163.0 does not deliver developerInstructions passed on a cold thread/resume.
    expect(JSON.stringify(out.requests[0].body)).not.toContain('Explicit card tools are not available');
    // D3: the notice reaches the model as turn input, one item ahead of the unchanged user text.
    const turns = userMessages(out.requests[0]);
    expect(turns.at(-1)?.[0]).toBe(LEGACY_TOOLSET_NOTICE);
    expect(turns.at(-1)?.at(-1)?.endsWith(DISPLAY_CALL)).toBe(true);
    expect(turns.flat().filter((t) => t === LEGACY_TOOLSET_NOTICE)).toHaveLength(1);
    expect(turns.flat().filter((t) => t.includes('[Card tools notice'))).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('explicit cards unavailable: thread predates toolset v1'))).toBe(true);
    expect(r.sends).toHaveLength(0);
    expect(budget(r, cards.ctx.turnGeneration)).toEqual({ inv: 0, sends: 0 });

    // Each later turn on the old thread gets one new notice. Codex keeps earlier turn input in the
    // thread, so the previous notice is history; the earlier user text is unchanged.
    const again = await run(r, 'third', { cards: generation(r, 's3'), resume: first.session!.id, digest: null });
    const later = userMessages(again.requests[0]);
    expect(later.at(-1)?.[0]).toBe(LEGACY_TOOLSET_NOTICE);
    expect(later.at(-1)?.filter((t) => t === LEGACY_TOOLSET_NOTICE)).toHaveLength(1);
    expect(later.flat().filter((t) => t === LEGACY_TOOLSET_NOTICE)).toHaveLength(2);
    expect(later.flat().some((t) => t.endsWith('hello') && !t.includes('[Card tools notice'))).toBe(true);
    expect(toolNames(again.requests[0])).not.toContain('display');
  }, 90_000);

  it('D3: a new thread with cards (T2a) and its resumes never carry the legacy notice', async () => {
    const r = await rig();
    const first = await run(r, 'hello', { cards: generation(r, 's4') });
    const out = await run(r, 'again', { cards: generation(r, 's4'), resume: first.session!.id, digest: first.session!.digest ?? null });
    for (const req of [...first.requests, ...out.requests]) expect(JSON.stringify(req.body)).not.toContain('[Card tools notice');
    expect(toolNames(out.requests[0])).toEqual(expect.arrayContaining(['display', 'interactive']));
  }, 90_000);
});
