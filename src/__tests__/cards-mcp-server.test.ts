/**
 * Packaged stdio MCP proxy (WP-08, AM-08 v4 §4 item 4).
 *
 * Evidence label: [UNIT]/[INT-SYNTH-OP]. The proxy runs in-process over
 * in-memory stdio against a real tool-host listener and a synthetic test op.
 * Covers redemption before `initialize`, the inert fallbacks (missing,
 * symlinked, wrong-mode, multi-link or wrong-size ticket, bad arguments, a
 * silent or malformed parent, the 3 s redemption timeout), protocol-only
 * stdout with no ticket or authority, and the forwarded tool call.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { TrustedTurnContext } from "../cards/contracts.js";
import { REDEMPTION_TIMEOUT_MS, runMcpProxy } from "../cards/mcp-server.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import type { CardBinding } from "../cards/store.js";
import { createToolHost, type ExplicitOpHandler, type ToolHost } from "../cards/tool-host.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, type ManualTime } from "./fixtures/card-write-harness.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const displayOp: ExplicitOpHandler = {
  op: "display",
  async handle(_args, c, send) {
    const binding: CardBinding = { sessionKey: c.ctx.sessionKey, channelId: c.ctx.route.channelId, channelType: 1, topicScope: null,
      generation: c.ctx.turnGeneration, resetEpoch: c.ctx.resetEpoch };
    return send.reserveAndSend({ opcode: "display", binding, bodyDigest: "d".repeat(64) });
  },
};

async function hostRig(): Promise<{ host: ToolHost; adapter: DbAdapter; time: ManualTime; incarnation: string }> {
  const dataDir = join(tempDir("wp08-mcp-"), "data");
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== "ready") throw new Error(sub.state);
  let seq = 8_000_000_000;
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir,
    ops: new Map([["display", displayOp]]), excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers,
    transport: { async send() { return { kind: "acked", messageId: String(seq++) }; } },
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } })!;
  cleanups.push(() => { host.close({ reason: "shutdown", deadlineMono: time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  return { host, adapter, time, incarnation };
}

async function liveArgs(r: Awaited<ReturnType<typeof hostRig>>): Promise<{ argv: string[]; ticket: string; generation: string }> {
  const ctx: TrustedTurnContext = Object.freeze({
    botRef: { originKey: "https://test.invalid", credentialRef: "c".repeat(43) }, route: { channelId: "chan", channelType: 1 },
    requesterUid: "u1", sessionKey: "s1", turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: "c".repeat(43),
    runtimeIncarnation: r.incarnation, injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}`,
    routeEligibility: { kind: "dm" as const, obo: false, docTask: false, cron: false }, origin: { kind: "user" as const },
  });
  const gen = r.host.openGeneration({ ctx, binding: { sessionKey: "s1", channelId: "chan", channelType: 1, topicScope: null,
    generation: ctx.turnGeneration, resetEpoch: 0 }, expiresAtMono: r.time.now() + 600_000, currentResetEpoch: () => 0,
  ops: ["display"], admit: () => true })!;
  const h = (await gen.launch.prepareAttempt())!;
  const args = h.mcpEntry.args as string[];
  return { argv: args.slice(1), ticket: readFileSync(args[2] as string, "utf8"), generation: ctx.turnGeneration };
}

/** In-memory stdio session with the proxy. */
function session(argv: readonly string[]) {
  const stdin = new PassThrough();
  const lines: string[] = [];
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const done = runMcpProxy({ argv, stdin, write: (line) => {
    lines.push(line);
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === "number") waiters.get(msg.id)?.(msg);
  }, ...(uid !== undefined ? { uid } : {}) });
  let id = 0;
  const request = (method: string, params: unknown = {}) => {
    const n = ++id;
    const p = new Promise<Record<string, unknown>>((resolve) => waiters.set(n, resolve));
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    return p;
  };
  const notify = (method: string) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const end = async () => { stdin.end(); await done; };
  cleanups.push(() => stdin.destroy());
  return { request, notify, end, lines };
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0.163.0" } };

describe("redeem, then initialize (§4 item 4)", () => {
  it("answers initialize only after redemption, lists the offered ops and forwards a call", async () => {
    const r = await hostRig();
    const { argv, ticket } = await liveArgs(r);
    const s = session(argv);
    const init = await s.request("initialize", INIT);
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "octo-cards" } });
    expect(r.host.stats().bootstrapRedeemed).toBe(1);
    expect(existsSync(argv[1] as string)).toBe(false);
    s.notify("notifications/initialized");
    const list = await s.request("tools/list");
    expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["display"]);
    const call = await s.request("tools/call", { name: "display", arguments: { blocks: [{ kind: "text", text: "hi" }] } });
    expect(call.result).toMatchObject({ isError: false, structuredContent: { status: "sent", route: { kind: "dm" } } });
    expect((await s.request("ping")).result).toEqual({});
    expect((await s.request("resources/list")).error).toMatchObject({ code: -32601 });
    await s.end();
    for (const line of s.lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
      expect(line).not.toContain(ticket);
    }
    // The authority never reaches stdout: no 64-hex value appears at all.
    expect(s.lines.join("")).not.toMatch(/[0-9a-f]{64}/);
  });

  it("an unknown tool name or an oversized call is answered locally without charging the parent", async () => {
    const r = await hostRig();
    const { argv, generation } = await liveArgs(r);
    const s = session(argv);
    await s.request("initialize", INIT);
    expect((await s.request("tools/call", { name: "interactive", arguments: {} })).result)
      .toMatchObject({ isError: true, structuredContent: { status: "error", error: { code: "unavailable" } } });
    expect((await s.request("tools/call", { name: "display", arguments: { blocks: [{ kind: "text", text: "x".repeat(40_000) }] } })).result)
      .toMatchObject({ isError: true, structuredContent: { status: "error", error: { code: "limit_exceeded" } } });
    expect(r.adapter.prepare("SELECT count(*) AS n FROM card_explicit_requests WHERE generation = ?").get(generation)).toEqual({ n: 0 });
    await s.end();
  });
});

describe("inert on any redemption failure (zero tools, never silent)", () => {
  async function expectInert(argv: readonly string[], within = 1_000) {
    const s = session(argv);
    const started = Date.now();
    const init = await s.request("initialize", INIT);
    expect(Date.now() - started).toBeLessThan(within + 500);
    expect(init.result).toMatchObject({ capabilities: { tools: {} } });
    expect((await s.request("tools/list")).result).toEqual({ tools: [] });
    expect((await s.request("tools/call", { name: "display", arguments: {} })).result)
      .toMatchObject({ isError: true, structuredContent: { status: "error", error: { code: "unavailable" } } });
    await s.end();
    return s;
  }

  it("missing ticket, bad arguments", async () => {
    const r = await hostRig();
    const { argv } = await liveArgs(r);
    const dir = tempDir("wp08-inert-");
    await expectInert(["--bootstrap", join(dir, "missing"), "--port", argv[3] as string]);
    await expectInert(["--bootstrap", "relative/t", "--port", argv[3] as string]);
    await expectInert(["--bootstrap", argv[1] as string]);
    await expectInert([]);
    expect(r.host.stats().bootstrapRedeemed).toBe(0);
  });

  it("symlinked, group-readable, multi-link and wrong-size tickets are refused", async () => {
    const r = await hostRig();
    const { argv, ticket } = await liveArgs(r);
    const dir = tempDir("wp08-inert-");
    const real = join(dir, "real");
    writeFileSync(real, ticket, { mode: 0o600 });
    const link = join(dir, "link");
    symlinkSync(real, link);
    await expectInert(["--bootstrap", link, "--port", argv[3] as string]);
    const open = join(dir, "open");
    writeFileSync(open, ticket, { mode: 0o644 });
    chmodSync(open, 0o644);
    await expectInert(["--bootstrap", open, "--port", argv[3] as string]);
    const multi = join(dir, "multi");
    writeFileSync(multi, ticket, { mode: 0o600 });
    linkSync(multi, join(dir, "multi2"));
    await expectInert(["--bootstrap", multi, "--port", argv[3] as string]);
    const short = join(dir, "short");
    writeFileSync(short, ticket.slice(0, 63), { mode: 0o600 });
    await expectInert(["--bootstrap", short, "--port", argv[3] as string]);
    expect(r.host.stats().bootstrapRedeemed).toBe(0);
  });

  it("a malformed parent reply leaves the proxy inert", async () => {
    const server: Server = createServer((sock) => { sock.on("data", () => sock.write(Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]))); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const dir = tempDir("wp08-inert-");
    const t = join(dir, "t");
    writeFileSync(t, randomBytes(32).toString("hex"), { mode: 0o600 });
    await expectInert(["--bootstrap", t, "--port", String((server.address() as { port: number }).port)]);
  });

  it("a silent parent hits the 3 s redemption timeout and initialize is still answered", async () => {
    const sockets: import("node:net").Socket[] = [];
    const server: Server = createServer((sock) => { sockets.push(sock); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { for (const s of sockets) s.destroy(); server.close(); });
    const dir = tempDir("wp08-inert-");
    const t = join(dir, "t");
    writeFileSync(t, randomBytes(32).toString("hex"), { mode: 0o600 });
    const started = Date.now();
    await expectInert(["--bootstrap", t, "--port", String((server.address() as { port: number }).port)], REDEMPTION_TIMEOUT_MS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(REDEMPTION_TIMEOUT_MS - 50);
    expect(existsSync(t)).toBe(false);
  }, 10_000);
});
