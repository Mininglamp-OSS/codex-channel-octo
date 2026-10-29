/**
 * Packaged MCP entry and test-seam isolation (WP-08, AM-08 v4 §7.5, TD v3 E.5).
 *
 * Evidence label: [UNIT]/[INT-SYNTH-OP]. Compiles the project with the
 * repository tsconfig into a private output directory, then:
 * - checks the exact runtime pin, the build step and the `files` entry;
 * - checks the emitted tree: the proxy exists, imports only the protocol
 *   module and Node built-ins, no test handler or `__fixtures__` asset is
 *   emitted, and only `runtime` knows the test seam (`index` never does);
 * - launches the compiled proxy as a real child over stdio against a real
 *   tool-host listener: redemption before `initialize`, a forwarded call,
 *   protocol-only stdout, empty stderr, and the inert child.
 * The clean installed-tarball smoke is a separate packaging step.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import { createToolHost, type ExplicitOpHandler } from "../cards/tool-host.js";
import { createAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime } from "./fixtures/card-write-harness.js";
import { admissibleGateway } from "./fixtures/gd-admit.js";
import { liveProfileJson } from "./fixtures/card-profile-live.js";

const repo = process.cwd();
// Inside the repository so emitted modules resolve the installed dependencies.
const out = join(repo, "node_modules", ".cache", `wp08-dist-${randomUUID()}`);
const roots: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", join(repo, "tsconfig.json"), "--outDir", out],
    { cwd: repo, stdio: "pipe", timeout: 120_000 });
}, 150_000);
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("package contract", () => {
  it("pins @openai/codex-sdk exactly to 0.163.0 in the manifest and the lock", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { dependencies: Record<string, string>; files: string[]; scripts: Record<string, string> };
    const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    expect(pkg.dependencies["@openai/codex-sdk"]).toBe("0.163.0");
    expect(lock.packages[""]?.dependencies?.["@openai/codex-sdk"]).toBe("0.163.0");
    expect(lock.packages["node_modules/@openai/codex-sdk"]?.version).toBe("0.163.0");
    expect(pkg.files).toContain("dist/cards/mcp-server.js");
    expect(pkg.scripts.build).toContain("dist/cards/mcp-server.js");
  });

  it("emits the proxy, which imports only the protocol module and Node built-ins", () => {
    const proxy = join(out, "cards", "mcp-server.js");
    expect(statSync(proxy).isFile()).toBe(true);
    const imports = [...readFileSync(proxy, "utf8").matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    expect(imports.filter((i) => !i!.startsWith("node:"))).toEqual(["./protocol.js"]);
    const protocolImports = [...readFileSync(join(out, "cards", "protocol.js"), "utf8").matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)];
    expect(protocolImports).toEqual([]);
  });

  it("emits no test handler, fixture or harness module, and only the runtime knows the test seam", () => {
    const emitted = files(out).map((f) => relative(out, f).split("\\").join("/"));
    expect(emitted.filter((f) => /__tests__|__fixtures__|privacy-corpus|harness/.test(f))).toEqual([]);
    const seam = emitted.filter((f) => f.endsWith(".js") && readFileSync(join(out, f), "utf8").includes("explicitOpsForTest"));
    expect(seam).toEqual(["cards/runtime.js"]);
    expect(readFileSync(join(repo, "src", "index.ts"), "utf8")).not.toContain("explicitOpsForTest");
    // Test handlers live only under src/__tests__ (excluded from emission); no production source sets the seam.
    const sources = files(join(repo, "src")).filter((f) => !relative(join(repo, "src"), f).startsWith("__tests__"))
      .filter((f) => /\.(?:ts|mts|js|mjs)$/.test(f) && readFileSync(f, "utf8").includes("explicitOpsForTest"));
    expect(sources.map((f) => relative(join(repo, "src"), f).split("\\").join("/"))).toEqual(["cards/runtime.ts"]);
  });

  it("the compiled host's default packaged entry is the emitted proxy beside it", async () => {
    const mod = await import(join(out, "cards", "tool-host.js")) as typeof import("../cards/tool-host.js");
    const entry = mod.defaultPackagedEntry();
    expect(entry.nodePath).toBe(process.execPath);
    expect(entry.serverPath).toBe(join(out, "cards", "mcp-server.js"));
    expect([...mod.PRODUCTION_EXPLICIT_OPS.keys()]).toEqual(["display", "interactive"]);
  });
});

// ─── compiled child over real stdio ─────────────────────────────────────────

const displayOp: ExplicitOpHandler = {
  op: "display",
  async handle(_args, c, send) {
    return send.reserveAndSend({ opcode: "display", bodyDigest: "d".repeat(64), binding: { sessionKey: c.ctx.sessionKey,
      channelId: c.ctx.route.channelId, channelType: 1, topicScope: null, generation: c.ctx.turnGeneration, resetEpoch: c.ctx.resetEpoch } });
  },
};

async function liveHost() {
  const root = mkdtempSync(join(tmpdir(), "wp08-pkg-"));
  roots.push(root);
  const dataDir = join(root, "data");
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
  let seq = 6_000_000_000;
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir,
    ops: new Map([["display", displayOp]]), excludedRoots: [], clock: time.clock, wall: time.wall, timers: time.timers,
    transport: { async send() { return { kind: "acked", messageId: String(seq++) }; } },
    entry: { nodePath: process.execPath, serverPath: join(out, "cards", "mcp-server.js") } })!;
  const generation = randomUUID();
  const gateway = admissibleGateway();
  const gen = host.openGeneration({ ctx: Object.freeze({ botRef: { originKey: "https://test.invalid", credentialRef: "c".repeat(43) },
    route: { channelId: "c", channelType: 1 }, requesterUid: "u", sessionKey: "s", turnGeneration: generation, resetEpoch: 0,
    policyIdentity: "c".repeat(43), runtimeIncarnation: incarnation, injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}`,
    routeEligibility: { kind: "dm" as const, obo: false, docTask: false, cron: false }, origin: { kind: "user" as const } }),
  binding: { sessionKey: "s", channelId: "c", channelType: 1, topicScope: null, generation, resetEpoch: 0 },
  expiresAtMono: time.now() + 60_000, currentResetEpoch: () => 0, ops: ["display"], admit: gateway.admit })!;
  const h = (await gen.launch.prepareAttempt())!;
  const close = () => { host.close({ reason: "shutdown", deadlineMono: 0, signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); gateway.release(); };
  return { h, host, adapter, generation, close, root };
}

/** Drive the compiled child exactly as Codex does: the entry's command and args, JSON-RPC lines on stdio. */
function child(command: string, args: readonly string[]) {
  const proc = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  let stdout = "";
  let stderr = "";
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => {
    stdout += c;
    for (const line of c.split("\n").filter((l) => l.trim() !== "")) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id === "number") waiters.get(msg.id)?.(msg);
    }
  });
  proc.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  let id = 0;
  const request = (method: string, params: unknown = {}) => {
    const n = ++id;
    const p = new Promise<Record<string, unknown>>((resolve) => waiters.set(n, resolve));
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    return p;
  };
  return { request, end: () => proc.stdin.end(), exited, out: () => stdout, err: () => stderr, kill: () => proc.kill("SIGKILL") };
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0.163.0" } };

describe.skipIf(process.platform === "win32")("compiled proxy as a real child", () => {
  it.runIf(process.platform === "darwin")("production runtime offers only display on app-server and packaged MCP while interaction stays denied", async () => {
    const hostMod = await import(join(out, "cards", "tool-host.js")) as typeof import("../cards/tool-host.js");
    const runtimeMod = await import(join(out, "cards", "runtime.js")) as typeof import("../cards/runtime.js");
    const root = mkdtempSync(join(tmpdir(), "wp10-pkg-runtime-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const paths = cardSubsystemPaths(dataDir);
    mkdirSync(paths.cardsDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.installationRefPath, "install-runtime\n", { mode: 0o600 });
    provisionFirstInstallMarker(paths.markerPath, "install-runtime", Date.UTC(2026, 9, 22));
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const time = manualTime();
    const gateway = admissibleGateway();
    const unregister = hostMod.registerGatewayExposure({ sandboxMode: "read-only", codexHome: gateway.codexHome,
      apiKeyConfigured: true, sdkEnvAuthMarkers: false });
    const runtime = await runtimeMod.openCardRuntime({ adapter, dataDir, apiUrl: "https://test.invalid", botToken: "offline-only",
      clock: time.clock, wall: time.wall, timers: time.timers, bootstrapExcludedRoots: [],
      fetchImpl: (async (url, init) => new URL(String(url)).pathname.endsWith("/v1/bot/card/profile")
        ? new Response(JSON.stringify(liveProfileJson()))
        : new Response(JSON.stringify({ message_id: "901234", client_msg_no: JSON.parse(init!.body as string).client_msg_no }))) as typeof fetch });
    let proc: ReturnType<typeof child> | undefined;
    try {
      expect(runtime).toBeDefined();
      await runtime!.idle();
      const turn = () => runtime!.beginTurn({ dispatchId: randomUUID(), sessionKey: randomUUID(), channelId: "c", channelType: 1,
        requesterUid: "u", resetEpoch: 0, cron: false, obo: false, docTask: false, deadlineMono: time.now() + 300_000,
        sessionCwd: () => gateway.cwd, currentResetEpoch: () => 0 })!;
      const app = turn().injection!.prepareAppServerAttempt({ respond: () => true })!;
      expect(app.dynamicTools.map((t) => t.name)).toEqual(["display"]);
      const mcp = await turn().injection!.prepareAttempt();
      expect(mcp?.mcpEntry.enabled_tools).toEqual(["display"]);
      expect(Object.keys(mcp!.mcpEntry.tools as object)).toEqual(["display"]);
      proc = child(mcp!.mcpEntry.command as string, mcp!.mcpEntry.args as string[]);
      await proc.request("initialize", INIT);
      expect((await proc.request("tools/list")).result).toMatchObject({ tools: [{ name: "display" }] });
      const denied = await proc.request("tools/call", { name: "interactive", arguments: {} });
      expect(denied.result).toMatchObject({ isError: true, structuredContent: { status: "error", error: { code: "unavailable" } } });
      expect(adapter.prepare("SELECT COUNT(*) AS n FROM card_explicit_requests").get()).toEqual({ n: 0 });
      const sent = await proc.request("tools/call", { name: "display", arguments: { blocks: [{ kind: "text", text: "Control" }] } });
      expect(sent.result).toMatchObject({ isError: false, structuredContent: { status: "sent", message_id: "901234" } });
      expect(adapter.prepare("SELECT invocation_count AS inv, logical_send_count AS sends FROM card_handler_generations ORDER BY invocation_count").all())
        .toEqual([{ inv: 0, sends: 0 }, { inv: 1, sends: 1 }]);
      proc.end();
      expect(await proc.exited).toBe(0);
      expect(proc.err()).toBe("");
    } finally {
      proc?.kill();
      if (proc) await proc.exited;
      await runtime?.close();
      adapter.close();
      unregister();
      gateway.release();
    }
  }, 20_000);

  it("redeems before initialize, forwards a call, writes protocol-only stdout and nothing to stderr", async () => {
    const r = await liveHost();
    try {
      const args = r.h.mcpEntry.args as string[];
      const ticket = readFileSync(args[2] as string, "utf8");
      const c = child(r.h.mcpEntry.command as string, args);
      const init = await c.request("initialize", INIT);
      expect(init.result).toMatchObject({ capabilities: { tools: {} } });
      expect(r.host.stats().bootstrapRedeemed).toBe(1);
      expect(existsSync(args[2] as string)).toBe(false);
      const tools = await c.request("tools/list");
      expect((tools.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["display"]);
      const denied = await c.request("tools/call", { name: "interactive", arguments: { buttons: [{ id: "ok", label: "Continue" }] } });
      expect(denied.result).toMatchObject({ isError: true, structuredContent: { status: "error", error: { code: "unavailable" } } });
      expect(r.adapter.prepare("SELECT COUNT(*) AS n FROM card_explicit_requests").get()).toEqual({ n: 0 });
      const call = await c.request("tools/call", { name: "display", arguments: { blocks: [{ kind: "text", text: "hi" }] } });
      expect(call.result).toMatchObject({ isError: false, structuredContent: { status: "sent" } });
      c.end();
      expect(await c.exited).toBe(0);
      expect(c.err()).toBe("");
      const lines = c.out().split("\n").filter((l) => l !== "");
      expect(lines.every((l) => (JSON.parse(l) as { jsonrpc?: string }).jsonrpc === "2.0")).toBe(true);
      expect(c.out()).not.toContain(ticket);
      expect(c.out()).not.toMatch(/[0-9a-f]{64}/);
      expect(r.adapter.prepare("SELECT state, send_slot FROM card_explicit_requests WHERE generation = ?").all(r.generation))
        .toEqual([{ state: "acked", send_slot: 1 }]);
    } finally {
      r.close();
    }
  }, 20_000);

  it("a missing ticket gives an inert child that still answers initialize and exits cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp08-pkg-inert-"));
    roots.push(dir);
    const c = child(process.execPath, [join(out, "cards", "mcp-server.js"), "--bootstrap", join(dir, "missing"), "--port", "9"]);
    const init = await c.request("initialize", INIT);
    expect(init.result).toMatchObject({ capabilities: { tools: {} } });
    expect((await c.request("tools/list")).result).toEqual({ tools: [] });
    c.end();
    expect(await c.exited).toBe(0);
    expect(c.err()).toBe("");
  }, 20_000);
});
