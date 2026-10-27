/**
 * S02-A protocol rows at unit/integration level (WP-08; AC-011.2/.3/.4/.11, 013.3).
 *
 * Evidence labels: [UNIT] and [INT-SYNTH-OP] only. Synthetic test ops through
 * `explicitOpsForTest`, a mocked SDK for the bridge identity rows and the real
 * SDK against a recording stand-in executable for the argv/env row. None of
 * this is a candidate, live or isolation pass; the production-op AC-011.4/.9
 * controls run at the WP-09 candidate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk = vi.hoisted(() => ({
  constructed: [] as Record<string, unknown>[],
  runs: [] as (() => AsyncGenerator<Record<string, unknown>>)[],
}));
vi.mock("@openai/codex-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openai/codex-sdk")>();
  const thread = () => ({ async runStreamed() { const run = sdk.runs.shift(); if (!run) throw new Error("no run"); return { events: run() }; } });
  return {
    ...actual,
    Codex: class { constructor(options: Record<string, unknown>) { sdk.constructed.push(options); } startThread() { return thread(); } resumeThread() { return thread(); } },
    RealCodex: actual.Codex,
  };
});

import { queryAgentEvents, type AgentOutputEvent } from "../agent-bridge.js";
import type { Config } from "../config.js";
import type { CardToolResult } from "../cards/contracts.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { cardSubsystemPaths } from "../cards/recovery.js";
import { openCardRuntime, type CardRuntime, type CardTurnInput } from "../cards/runtime.js";
import {
  EXPLICIT_OP_UNAVAILABLE,
  explicitPlatformCertified,
  registerGatewayExposure,
  type AttemptHandle,
  type CardInjectionLaunch,
  type ExplicitOpHandler,
} from "../cards/tool-host.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { profile } from "./fixtures/card-profile.js";
import { json, manualTime, scriptedFetch, type ManualTime } from "./fixtures/card-write-harness.js";
import { ADMITTED_CONFIG_TOML, admissibleGateway } from "./fixtures/gd-admit.js";

const roots: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  sdk.constructed.length = 0;
  sdk.runs.length = 0;
});

function tempDir(prefix: string, base = tmpdir()): string {
  const root = mkdtempSync(join(base, prefix));
  roots.push(root);
  return root;
}

const CERTIFIED = explicitPlatformCertified();
const unavailableOp: ExplicitOpHandler = { op: "display", async handle() { return EXPLICIT_OP_UNAVAILABLE as CardToolResult; } };
const TEST_OPS = new Map([["display", unavailableOp]] as const);

// ─── runtime gates G-a…G-g ─────────────────────────────────────────────────

async function runtimeRig(over: { ops?: boolean; prof?: () => unknown; exposure?: "clean" | "danger" | "none" } = {}): Promise<{
  runtime: CardRuntime; adapter: DbAdapter; time: ManualTime; dataDir: string; input: (o?: Partial<CardTurnInput>) => CardTurnInput;
}> {
  const dataDir = join(tempDir("wp08-s02a-"), "data");
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const net = scriptedFetch(time);
  const prof = over.prof ?? (() => profile());
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith("/v1/bot/card/profile") ? json(200, prof()) : net.fetchImpl(input, init)) as typeof fetch;
  const exposure = over.exposure ?? "clean";
  if (exposure !== "none") {
    const codexHome = tempDir("wp08-home-");
    writeFileSync(join(codexHome, "config.toml"), ADMITTED_CONFIG_TOML);
    cleanups.push(registerGatewayExposure({ sandboxMode: exposure === "danger" ? "danger-full-access" : "read-only", codexHome,
      apiKeyConfigured: true, sdkEnvAuthMarkers: false }));
  }
  const runtime = (await openCardRuntime({ adapter, dataDir, apiUrl: "https://test.invalid", botToken: "token-a",
    clock: time.clock, wall: time.wall, timers: time.timers, fetchImpl, bootstrapExcludedRoots: [],
    explicitOpsForTest: over.ops === false ? new Map() : TEST_OPS }))!;
  await runtime.idle();
  cleanups.push(async () => { await runtime.close("shutdown"); adapter.close(); });
  const cwd = tempDir("wp08-cwd-", "/tmp");
  let n = 0;
  const input = (o: Partial<CardTurnInput> = {}): CardTurnInput => ({
    dispatchId: `d-${++n}`, sessionKey: `s-${n}`, channelId: "c", channelType: 1, requesterUid: "u", resetEpoch: 0, cron: false, obo: false, docTask: false,
    deadlineMono: time.now() + 300_000, sessionCwd: () => cwd, currentResetEpoch: () => 0, ...o,
  });
  return { runtime, adapter, time, dataDir, input };
}

function handlers(adapter: DbAdapter) {
  return adapter.prepare("SELECT generation, state FROM card_handler_generations").all() as { generation: string; state: string }[];
}

describe("injection gate G-a…G-g at beginTurn (AM-08 v4 §7.2; AC-011.3/.11)", () => {
  it("an empty op table (G-b) never injects: no host, no bootstrap directory, no ledger rows", async () => {
    const r = await runtimeRig({ ops: false });
    const begun = r.runtime.beginTurn(r.input())!;
    expect(begun.coordinator).toBeDefined();
    expect(begun.injection).toBeUndefined();
    expect(begun.coordinator.context.injectedServerId).toBeUndefined();
    expect(existsSync(join(cardSubsystemPaths(r.dataDir).cardsDir, "bootstrap"))).toBe(false);
    expect(handlers(r.adapter)).toEqual([]);
  });

  it.runIf(CERTIFIED)("with a test op on darwin-arm64 every gate holds: the launch matches the frozen context and a live handler exists", async () => {
    const r = await runtimeRig();
    const begun = r.runtime.beginTurn(r.input())!;
    expect(begun.injection).toBeDefined();
    expect(begun.injection!.serverId).toMatch(/^octo_cards_[0-9a-f]{32}$/);
    expect(begun.coordinator.context.injectedServerId).toBe(begun.injection!.serverId);
    expect(begun.injection!.generation).toBe(begun.coordinator.generation);
    // The app-server dispatcher hook is the only addition; neither entry point carries an authority.
    expect(Object.keys(begun.injection!).sort()).toEqual(["generation", "prepareAppServerAttempt", "prepareAttempt", "serverId"]);
    expect(handlers(r.adapter)).toEqual([{ generation: begun.coordinator.generation, state: "live" }]);
  });

  it.skipIf(CERTIFIED)("G-c: an uncertified platform never injects, even with a test op", async () => {
    const r = await runtimeRig();
    expect(r.runtime.beginTurn(r.input())!.injection).toBeUndefined();
    expect(handlers(r.adapter)).toEqual([]);
  });

  it("G-e/G-a/G-d and missing trusted inputs fail closed", async () => {
    const r = await runtimeRig();
    for (const bad of [{ cron: true }, { obo: undefined }, { docTask: undefined }, { obo: true }, { docTask: true }, { deadlineMono: undefined }, { deadlineMono: r.time.now() - 1 }, { sessionCwd: undefined },
      { currentResetEpoch: undefined }, { sessionCwd: () => { throw new Error("cwd"); } }] as Partial<CardTurnInput>[]) {
      expect(r.runtime.beginTurn(r.input(bad))!.injection).toBeUndefined();
    }
    const denied = await runtimeRig({ prof: () => profile({ config: { card_enabled: true, reasoning_enabled: true,
      reasoning_template_ref: { id: "ai.reasoning-process", version: "0.4.0" }, display_enabled: false, interaction_enabled: false } }) });
    expect(denied.runtime.beginTurn(denied.input())!.injection).toBeUndefined();
    const danger = await runtimeRig({ exposure: "danger" });
    expect(danger.runtime.beginTurn(danger.input())!.injection).toBeUndefined();
    expect(handlers(r.adapter)).toEqual([]);
    expect(handlers(denied.adapter)).toEqual([]);
  });

  it.runIf(CERTIFIED)("G-d: a Bot whose CODEX_HOME leaves the 0.163 default features on turns injection off gateway-wide", async () => {
    const r = await runtimeRig();
    expect(r.runtime.beginTurn(r.input())!.injection).toBeDefined();
    cleanups.push(registerGatewayExposure({ sandboxMode: "read-only", codexHome: tempDir("wp08-home-default-"),
      apiKeyConfigured: true, sdkEnvAuthMarkers: false }));
    expect(r.runtime.beginTurn(r.input())!.injection).toBeUndefined();
  });

  it.runIf(CERTIFIED)("settle, dispatch timeout, supersede and shutdown each close the generation's handler", async () => {
    const r = await runtimeRig();
    const settle = r.runtime.beginTurn(r.input())!;
    settle.coordinator.settle();
    const timeout = r.runtime.beginTurn(r.input({ dispatchId: "d-timeout" }))!;
    r.runtime.onTimeout("d-timeout");
    const older = r.runtime.beginTurn(r.input({ sessionKey: "same" }))!;
    const newer = r.runtime.beginTurn(r.input({ sessionKey: "same" }))!;
    newer.coordinator.signal({ t: "shutdown" });
    const state = (g: string) => handlers(r.adapter).find((h) => h.generation === g)?.state;
    expect(state(settle.coordinator.generation)).toBe("closed");
    expect(state(timeout.coordinator.generation)).toBe("closed");
    expect(state(older.coordinator.generation)).toBe("closed");
    expect(state(newer.coordinator.generation)).toBe("closed");
    expect(await settle.injection!.prepareAttempt()).toBeUndefined();
  });

  it.runIf(CERTIFIED)("runtime close fences every generation before the store lease retires (G-g)", async () => {
    const r = await runtimeRig();
    const begun = r.runtime.beginTurn(r.input())!;
    await r.runtime.close("bot_removed");
    expect(handlers(r.adapter)).toEqual([{ generation: begun.coordinator.generation, state: "closed" }]);
    expect(r.runtime.beginTurn(r.input())).toBeUndefined();
  });
});

// ─── trusted identity in the automatic card (AC-011.4) ──────────────────────

describe("trusted mcp_tool_call match (AC-011.4)", () => {
  const item = (mcpServerId?: string) => ({ kind: "item_state", attempt: 0, itemId: `i-${randomBytes(4).toString("hex")}`, seq: 0,
    itemType: "mcp_tool_call", phase: "started", safe: { category: "tool", ...(mcpServerId !== undefined ? { mcpServerId } : {}) } }) as const;

  it.runIf(CERTIFIED)("only this generation's injected server is excluded; a same-name foreign id stays a generic Tool row", async () => {
    const r = await runtimeRig();
    const trusted = r.runtime.beginTurn(r.input())!;
    trusted.coordinator.observe({ kind: "attempt_start", attempt: 0, reason: "initial", continues: null });
    trusted.coordinator.observe(item(trusted.injection!.serverId));
    expect(trusted.coordinator.inspect().opened).toBe(false);
    const foreign = r.runtime.beginTurn(r.input())!;
    foreign.coordinator.observe({ kind: "attempt_start", attempt: 0, reason: "initial", continues: null });
    foreign.coordinator.observe(item(trusted.injection!.serverId));
    expect(foreign.coordinator.inspect().opened).toBe(true);
  });

  it("an automatic-only turn treats any claimed server id as a generic Tool row", async () => {
    const r = await runtimeRig({ ops: false });
    const t = r.runtime.beginTurn(r.input())!;
    t.coordinator.observe({ kind: "attempt_start", attempt: 0, reason: "initial", continues: null });
    t.coordinator.observe(item(`octo_cards_${"a".repeat(32)}`));
    expect(t.coordinator.inspect().opened).toBe(true);
  });
});

// ─── bridge (AC-011.4, AM-08 v4 §4 item 7) ──────────────────────────────────

function cfg(): Config {
  const base = tempDir("wp08-bridge-");
  return { botToken: "t", apiUrl: "https://example.com", baseDir: base, cwd: join(base, "ws"), cwdBase: join(base, "ws"),
    dataDir: join(base, "data"), sdk: {}, rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288, dispatchTimeoutMs: 300000 } as Config;
}

function fakeLaunch(entry: Record<string, unknown> | undefined) {
  const serverId = `octo_cards_${randomBytes(16).toString("hex")}`;
  const state = { prepared: 0, closed: 0, open: false };
  const launch: CardInjectionLaunch = {
    serverId, generation: "g-1",
    async prepareAttempt(): Promise<AttemptHandle | undefined> {
      state.prepared++;
      if (entry === undefined) return undefined;
      state.open = true;
      return { mcpEntry: entry, close() { state.open = false; state.closed++; }, isTrustedServer: (s) => s === serverId && state.open };
    },
  };
  return { launch, serverId, state };
}

const mcpItem = (id: string, server: string) => ({ type: "item.started", item: { id, type: "mcp_tool_call", server, tool: "display", status: "in_progress", arguments: {} } });

describe("bridge merge and trusted classification", () => {
  it("each attempt gets a fresh Codex with only the entry merged; mcpServerId is set only on the trusted match", async () => {
    const entry = { command: "/abs/node", args: ["/abs/mcp-server.js", "--bootstrap", "/abs/t", "--port", "4242"], required: true };
    const { launch, serverId, state } = fakeLaunch(entry);
    sdk.runs.push(async function* () {
      yield { type: "thread.started", thread_id: "t1" };
      yield mcpItem("a", serverId);
      yield mcpItem("b", "octo_cards_other");
      yield mcpItem("c", "display");
      yield { type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
    });
    const out: AgentOutputEvent[] = [];
    for await (const ev of queryAgentEvents("hi", cfg(), undefined, undefined, { itemStates: true, cardInjection: launch })) out.push(ev);
    const merged = sdk.constructed.filter((o) => o.config !== undefined);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.config).toEqual({ mcp_servers: { [serverId]: entry } });
    const states = out.filter((e): e is Extract<AgentOutputEvent, { kind: "item_state" }> => e.kind === "item_state");
    expect(states.map((s) => s.safe.mcpServerId)).toEqual([serverId, undefined, undefined]);
    expect(state).toMatchObject({ prepared: 1, closed: 1, open: false });
  });

  it("no attempt handle means the ordinary construction with no config at all", async () => {
    const { launch, state } = fakeLaunch(undefined);
    sdk.runs.push(async function* () {
      yield { type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
    });
    for await (const ev of queryAgentEvents("hi", cfg(), undefined, undefined, { cardInjection: launch })) void ev;
    expect(sdk.constructed.every((o) => o.config === undefined)).toBe(true);
    expect(state.prepared).toBe(1);
  });

  it("a failed attempt still closes its registration", async () => {
    const { launch, state } = fakeLaunch({ command: "/abs/node", args: [] });
    sdk.runs.push(async function* () { yield { type: "turn.failed", error: { message: "boom" } }; });
    await expect((async () => { for await (const ev of queryAgentEvents("hi", cfg(), undefined, undefined, { cardInjection: launch })) void ev; })())
      .rejects.toBeDefined();
    expect(state.closed).toBe(state.prepared);
    expect(state.open).toBe(false);
  });
});

/** One live registration on a real host; returns its merged entry plus the redeemed authority and ticket value. */
async function realRegistration() {
  const { openCardSubsystem } = await import("../cards/recovery.js");
  const { createToolHost } = await import("../cards/tool-host.js");
  const { encodeBootstrapFrame, parseBootstrapReply, readFrame } = await import("../cards/protocol.js");
  const { connect } = await import("node:net");
  const { randomUUID } = await import("node:crypto");
  const dataDir = join(tempDir("wp08-real-"), "data");
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== "ready") throw new Error(sub.state);
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir, ops: TEST_OPS,
    excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } })!;
  cleanups.push(() => { host.close({ reason: "shutdown", deadlineMono: 0, signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const serverId = `octo_cards_${randomBytes(16).toString("hex")}`;
  const generation = randomUUID();
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  const gen = host.openGeneration({ ctx: Object.freeze({ botRef: { originKey: "https://test.invalid", credentialRef: "c".repeat(43) },
    route: { channelId: "c", channelType: 1 }, requesterUid: "u", sessionKey: "s", turnGeneration: generation, resetEpoch: 0,
    policyIdentity: "c".repeat(43), runtimeIncarnation: incarnation, injectedServerId: serverId,
    routeEligibility: { kind: "dm" as const, obo: false, docTask: false, cron: false }, origin: { kind: "user" as const } }),
  binding: { sessionKey: "s", channelId: "c", channelType: 1, topicScope: null, generation, resetEpoch: 0 },
  expiresAtMono: time.now() + 60_000, currentResetEpoch: () => 0, ops: ["display"], admit: gateway.admit })!;
  const h = (await gen.launch.prepareAttempt())!;
  const args = h.mcpEntry.args as string[];
  const ticket = readFileSync(args[2] as string, "utf8");
  const authority = await new Promise<string>((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port: Number(args[4]) });
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => { buf = Buffer.concat([buf, c]); const f = readFrame(buf); if (f.kind === "frame") { const r = parseBootstrapReply(f.body); if (r) resolve(r.authority); else reject(new Error("redeem")); } });
    sock.on("error", reject);
    sock.on("connect", () => sock.write(Buffer.from(encodeBootstrapFrame({ v: 1, bootstrap: ticket }))));
    cleanups.push(() => { sock.destroy(); });
  });
  return { entry: h.mcpEntry as Record<string, unknown>, serverId, authority, ticket };
}

describe.skipIf(process.platform === "win32")("real SDK serialization of the merged entry (P-G2-1 at unit level)", () => {
  it("argv carries only paths, ticket path and port; neither argv nor environment carries the authority", async () => {
    const { RealCodex } = await import("@openai/codex-sdk") as unknown as { RealCodex: typeof import("@openai/codex-sdk").Codex };
    const dir = tempDir("wp08-argv-");
    const record = join(dir, "record.json");
    const exe = join(dir, "codex");
    writeFileSync(exe, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));\n`
      + "process.stdin.resume();process.stdin.on('end',()=>{});const e=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');"
      + "e({type:'thread.started',thread_id:'t'});e({type:'turn.completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}});process.exit(0);\n");
    chmodSync(exe, 0o755);
    // A real host registration: the authority is minted in parent memory and obtained only by redemption.
    const { entry, serverId, authority, ticket } = await realRegistration();
    const codex = new RealCodex({ codexPathOverride: exe, env: { PATH: "/usr/bin:/bin" }, config: { mcp_servers: { [serverId]: entry } } as NonNullable<ConstructorParameters<typeof RealCodex>[0]>["config"] });
    const { events } = await codex.startThread({ skipGitRepoCheck: true }).runStreamed("hi");
    for await (const ev of events) void ev;
    const { argv, env } = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string> };
    const overrides = argv.filter((_, i) => argv[i - 1] === "--config").filter((o) => o.startsWith(`mcp_servers.${serverId}.`));
    expect(overrides.map((o) => o.split("=")[0]).sort()).toEqual([
      "args", "command", "enabled_tools", "required", "startup_readiness", "startup_timeout_sec", "tools.display.approval_mode",
    ].map((k) => `mcp_servers.${serverId}.${k}`).sort());
    expect(overrides.some((o) => /\.env(_vars)?[.=]/.test(o))).toBe(false);
    expect(JSON.stringify(argv)).not.toContain(authority);
    expect(JSON.stringify(env)).not.toContain(authority);
    expect(JSON.stringify(argv)).not.toContain(ticket);
    expect(JSON.stringify(env)).not.toContain(ticket);
    expect(Object.keys(env).some((k) => /AUTHORITY|OCTO_CARD/i.test(k))).toBe(false);
  });
});
