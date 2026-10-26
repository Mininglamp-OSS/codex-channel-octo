/**
 * Card startup runs under the per-Bot gateway lock (S1).
 *
 * The card store migrates the Bot database, writes a pre-migration backup and
 * recovers the explicit ledger of earlier incarnations. Each of those is a
 * durable effect, so it may only happen while this process holds the Bot's
 * exclusive `gateway.lock`:
 * - a lock held by a live competing process fails startup with zero card
 *   migration, backup, ledger recovery or card transport;
 * - a registration failure after the lock was taken never opens the subsystem;
 * - a startup error after the card runtime opened closes it before the lock is
 *   released, and releases the lock;
 * - a normal shutdown removes the lock exactly once, after the card runtime closed.
 *
 * Registration and the socket are synthetic; the SQLite database, marker,
 * installation reference and lock file are real files in a temporary dataDir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registerSpy = vi.hoisted(() => ({ fail: false }));
vi.mock("../octo/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../octo/api.js")>(),
  registerBot: vi.fn(async () => {
    if (registerSpy.fail) throw new Error("synthetic registration failure");
    return { robot_id: "test_bot", im_token: "im", ws_url: "ws://localhost", api_url: "https://test.invalid",
      owner_uid: "human", owner_channel_id: "owner-channel" };
  }),
  getUploadCredentials: vi.fn(async () => ({})),
  sendHeartbeat: vi.fn(async () => undefined),
}));
vi.mock("../octo/socket.js", () => ({
  WKSocket: vi.fn().mockImplementation(() => ({ connect: vi.fn(), disconnectAndWait: vi.fn().mockResolvedValue(undefined) })),
}));

const events = vi.hoisted(() => ({ order: [] as string[], opens: 0 }));
vi.mock("../cards/resource-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/resource-registry.js")>();
  return {
    ...actual,
    createResourceRegistry: vi.fn((options: Parameters<typeof actual.createResourceRegistry>[0]) => {
      const real = actual.createResourceRegistry(options);
      return Object.freeze({
        get closing() { return real.closing; },
        register: real.register,
        closeAll: (reason: Parameters<typeof real.closeAll>[0]) => { events.order.push("cards.close"); return real.closeAll(reason); },
      });
    }),
  };
});
vi.mock("../cards/recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/recovery.js")>();
  return { ...actual, openCardSubsystem: vi.fn((o: Parameters<typeof actual.openCardSubsystem>[0]) => {
    events.opens++; events.order.push("cards.open"); return actual.openCardSubsystem(o);
  }) };
});

import { registerBot } from "../octo/api.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import { createAdapter } from "../db-adapter.js";
import { OctoGateway } from "../gateway.js";
import { startBot } from "../index.js";
import { SessionStore } from "../session-store.js";
import { profile } from "./fixtures/card-profile.js";
import { json } from "./fixtures/card-write-harness.js";
import { unjammer } from "./fixtures/fifo-unjammer.js";

const API = "https://test.invalid";
const EARLIER = "earlier-incarnation";
const GENERATION = "gen-earlier";

let root: string;
let dataDir: string;
let lockPath: string;
let cardFetches: number;
const children: ChildProcess[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  events.order = []; events.opens = 0; registerSpy.fail = false; cardFetches = 0;
  root = mkdtempSync(join(tmpdir(), "s1-lock-"));
  dataDir = join(root, "data");
  lockPath = join(dataDir, "gateway.lock");
  mkdirSync(dataDir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    if (new URL(String(url)).pathname.startsWith("/v1/bot/card")) cardFetches++;
    return new URL(String(url)).pathname.endsWith("/v1/bot/card/profile") ? json(200, profile()) : new Response("{}");
  }));
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const config = (): Parameters<typeof startBot>[0] => ({
  botId: "test", apiUrl: API, botToken: "test-token", baseDir: root,
  cards: { disable: false, eventTransport: "off", reasoningSummary: "off" },
  cwd: join(root, "workspace"), dataDir, sdk: { toolProgress: true },
  rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
  maxResponseChars: 524288, dispatchTimeoutMs: 300000,
} as Parameters<typeof startBot>[0]);

function provision(ref = "install-a"): void {
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, `${ref}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, ref, Date.UTC(2026, 9, 22));
}

/** A real, live competing process that owns this Bot's lock with its own nonce. */
async function competingLockHolder(): Promise<string> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const content = `${child.pid} competing-nonce`;
  writeFileSync(lockPath, content, { mode: 0o600, flag: "wx" });
  return content;
}

function cardTables(): string[] {
  const db = createAdapter(join(dataDir, "cc-octo.db"));
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'card_%' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
  } finally { db.close(); }
}

/** A migrated card store whose earlier incarnation left one live handler generation. */
async function earlierIncarnationWithLiveGeneration(): Promise<void> {
  provision();
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const sub = await openCardSubsystem({ adapter, dataDir, runtimeIncarnation: EARLIER, clock: { nowUtcMs: () => Date.now() } });
  expect(sub.state).toBe("ready");
  if (sub.state !== "ready") throw new Error("unreachable");
  expect(sub.store.registerHandler({ generation: GENERATION, installationRef: "install-a", sessionKey: "s", runtimeIncarnation: EARLIER,
    resetEpoch: 0, expiresAt: Date.now() + 3_600_000, contextDigest: "d", policyIdentity: "p" })).toEqual({ kind: "registered" });
  sub.store.retire();
  adapter.close();
  events.order = []; events.opens = 0;
}

function generationState(): string {
  const db = createAdapter(join(dataDir, "cc-octo.db"));
  try {
    return (db.prepare("SELECT state FROM card_handler_generations WHERE generation = ?").get(GENERATION) as { state: string }).state;
  } finally { db.close(); }
}

function backups(): string[] {
  const dir = cardSubsystemPaths(dataDir).backupDir;
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("a lock held by a live competing process", () => {
  it("fails startup before any card migration, backup or card transport", async () => {
    provision();
    const marker = readFileSync(cardSubsystemPaths(dataDir).markerPath);
    const held = await competingLockHolder();

    await expect(startBot(config(), true)).rejects.toThrow(/Another instance is running/);

    expect(events.opens).toBe(0);
    expect(cardTables()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(readFileSync(cardSubsystemPaths(dataDir).markerPath)).toEqual(marker);
    expect(cardFetches).toBe(0);
    expect(registerBot).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, "utf8")).toBe(held);
  });

  it("never recovers the ledger of an earlier incarnation", async () => {
    await earlierIncarnationWithLiveGeneration();
    const before = backups();
    const held = await competingLockHolder();

    await expect(startBot(config(), true)).rejects.toThrow(/Another instance is running/);

    expect(events.opens).toBe(0);
    expect(generationState()).toBe("live");
    expect(backups()).toEqual(before);
    expect(cardFetches).toBe(0);
    expect(readFileSync(lockPath, "utf8")).toBe(held);
  });

  it("once the holder is gone, the next start recovers that ledger under its own lock", async () => {
    await earlierIncarnationWithLiveGeneration();
    const stack = await startBot(config(), true);
    expect(generationState()).toBe("closed");
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid} `));
    await stack.shutdown();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("startup failure after the lock was acquired", () => {
  it("a registration failure never opens the card subsystem and releases the lock", async () => {
    provision();
    registerSpy.fail = true;
    await expect(startBot(config(), true)).rejects.toThrow(/synthetic registration failure/);
    expect(events.opens).toBe(0);
    expect(cardTables()).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a later error closes the card runtime before the lock is released, then releases it", async () => {
    provision();
    const release = OctoGateway.prototype.releaseLock;
    vi.spyOn(OctoGateway.prototype, "releaseLock").mockImplementation(function (this: OctoGateway) {
      events.order.push(existsSync(lockPath) ? "lock.release(held)" : "lock.release(noop)");
      return release.call(this);
    });
    vi.spyOn(OctoGateway.prototype, "setMessageHandler").mockImplementation(() => { throw new Error("synthetic later failure"); });

    await expect(startBot(config(), true)).rejects.toThrow(/synthetic later failure/);

    expect(events.order.filter((e) => e !== "lock.release(noop)")).toEqual(["cards.open", "cards.close", "lock.release(held)"]);
    expect(existsSync(lockPath)).toBe(false);
    // The Bot can start again: nothing was left behind.
    vi.mocked(OctoGateway.prototype.setMessageHandler).mockRestore();
    const stack = await startBot(config(), true);
    await stack.shutdown();
  });
});

describe("normal shutdown", () => {
  it("removes the lock exactly once, after the card runtime closed", async () => {
    provision();
    const stack = await startBot(config(), true);
    expect(events.order).toEqual(["cards.open"]);
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid} `));
    const release = OctoGateway.prototype.releaseLock;
    let removals = 0;
    vi.spyOn(OctoGateway.prototype, "releaseLock").mockImplementation(function (this: OctoGateway) {
      const held = existsSync(lockPath);
      release.call(this);
      if (held && !existsSync(lockPath)) { removals++; events.order.push("lock.removed"); }
    });

    await stack.shutdown();

    expect(removals).toBe(1);
    expect(events.order).toEqual(["cards.open", "cards.close", "lock.removed"]);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("a writerless FIFO activation marker (S2-b)", () => {
  /** A valid private installation reference with a FIFO where the marker belongs. */
  function provisionFifoMarker(): string {
    const p = cardSubsystemPaths(dataDir);
    mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
    writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
    chmodSync(p.installationRefPath, 0o600);
    execFileSync("mkfifo", ["-m", "600", p.markerPath]);
    return p.markerPath;
  }

  it("leaves startup card-inert under the lock without blocking, and shutdown releases the lock", async () => {
    const guard = unjammer(provisionFifoMarker());
    const stack = await startBot(config(), true);
    expect(await guard.settle()).toBe("never_blocked");
    expect(events.order).toEqual(["cards.open"]);
    expect(cardTables()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(cardFetches).toBe(0);
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid} `));
    await stack.shutdown();
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);

  it("a live competing holder still rejects startup before the marker is opened", async () => {
    provisionFifoMarker();
    const held = await competingLockHolder();
    await expect(startBot(config(), true)).rejects.toThrow(/Another instance is running/);
    expect(events.opens).toBe(0);
    expect(cardTables()).toEqual([]);
    expect(readFileSync(lockPath, "utf8")).toBe(held);
  });
});
