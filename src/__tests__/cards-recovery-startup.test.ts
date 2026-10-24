/**
 * Card subsystem startup (WP-13A-1): `openCardSubsystem` consumes the
 * existing provenance file, activation marker, backup and
 * `initializeCardStore` contracts, recovers the explicit ledger before any
 * queue exists, and leaves the Bot card-inert on every failure.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { BotRef, Limits, PolicySnapshot, RegistryData } from "../cards/contracts.js";
import { FileActivationMarker, provisionFirstInstallMarker, serializeActivationMarker } from "../cards/migrations.js";
import { createCardApi } from "../cards/api.js";
import { normalizeOrigin } from "../cards/origin.js";
import { createPacer } from "../cards/pacer.js";
import { cardSubsystemPaths, openCardSubsystem, type CardSubsystemOptions } from "../cards/recovery.js";
import { CardStore, initializeCardStore, type CardStoreDisabledReason, type CardStoreInit } from "../cards/store.js";
import type { CardFrame } from "../cards/write-queue.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime, scriptedFetch, type ManualTime } from "./fixtures/card-write-harness.js";

const forced = vi.hoisted(() => ({ init: undefined as undefined | ((options: unknown) => unknown) }));
vi.mock("../cards/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/store.js")>();
  return {
    ...actual,
    initializeCardStore: vi.fn((options: Parameters<typeof actual.initializeCardStore>[0]) =>
      forced.init ? forced.init(options) : actual.initializeCardStore(options)),
  };
});

const roots: string[] = [];
const adapters: DbAdapter[] = [];
afterEach(() => {
  forced.init = undefined;
  vi.mocked(initializeCardStore).mockClear();
  vi.restoreAllMocks();
  for (const a of adapters.splice(0)) { try { a.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ─── fixtures ───────────────────────────────────────────────────────────────

interface Bot {
  readonly dataDir: string;
  readonly adapter: DbAdapter;
  /** Every DbAdapter call made through `adapter`. */
  readonly calls: string[];
  readonly raw: DbAdapter;
}

/** A per-Bot data directory whose ordinary store is already initialized, as at `index.ts` startup. */
function bot(name = "a", file = "cc-octo.db"): Bot {
  const root = mkdtempSync(join(tmpdir(), `cards-open-${name}-`));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  return attach(dataDir, file);
}

function attach(dataDir: string, file = "cc-octo.db", opts: { failDdl?: string } = {}): Bot {
  const raw = createAdapter(join(dataDir, file));
  adapters.push(raw);
  const sessions = new SessionStore(raw);
  sessions.init();
  sessions.getOrCreate("dm:u1", "u1", 1);
  sessions.appendUser("dm:u1", "hello", 1);
  const calls: string[] = [];
  const adapter: DbAdapter = {
    exec(sql) {
      calls.push("exec");
      if (opts.failDdl !== undefined && sql.includes(opts.failDdl)) throw new Error("injected DDL failure");
      raw.exec(sql);
    },
    prepare(sql) { calls.push("prepare"); return raw.prepare(sql); },
    close() { calls.push("close"); raw.close(); },
    get inTransaction() { return raw.inTransaction; },
    transaction(fn) { calls.push("transaction"); return raw.transaction(fn); },
    backup(dest) { calls.push("backup"); return raw.backup(dest); },
  };
  return { dataDir, adapter, calls, raw };
}

function writeRef(dataDir: string, content: string, mode = 0o600): string {
  const { cardsDir, installationRefPath } = cardSubsystemPaths(dataDir);
  mkdirSync(cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(installationRefPath, content, { mode, flag: "wx" });
  chmodSync(installationRefPath, mode);
  return installationRefPath;
}

/** Deployment-side provisioning through the existing marker contract. */
function provision(b: Bot, ref = "install-a", nowMs = Date.UTC(2026, 9, 22)): void {
  writeRef(b.dataDir, `${ref}\n`);
  provisionFirstInstallMarker(cardSubsystemPaths(b.dataDir).markerPath, ref, nowMs);
}

function options(b: Bot, time: ManualTime, over: Partial<CardSubsystemOptions> = {}): CardSubsystemOptions {
  let id = 0;
  return { adapter: b.adapter, dataDir: b.dataDir, clock: time.wall, runtimeIncarnation: "inc-1",
    newId: () => `id-${++id}-${randomUUID()}`, ...over };
}

/** Content hash of every file under the data directory except the live database. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out[`${relative(dir, p)}/`] = (statSync(p).mode & 0o777).toString(8); walk(p); continue; }
      if (/^cc-octo\.db/.test(e.name) || /^other\.db/.test(e.name)) continue;
      out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** Schema and every row of the ordinary database. */
function db(b: Bot): unknown {
  const objects = b.raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as
    Array<{ type: string; name: string }>;
  const rows = objects.filter((o) => o.type === "table").map((o) => [o.name, b.raw.prepare(`SELECT * FROM "${o.name}"`).all()]);
  return { objects, rows };
}

const cardTables = (b: Bot): string[] =>
  (b.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'card_%'").all() as Array<{ name: string }>)
    .map((r) => r.name);

const LIMITS: Limits = { maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384, maxInputTextBytes: 4096, maxInputsBytes: 16384 };
const DATA: RegistryData = {
  reasoningId: "octo-progress", state: "reasoning", title: "Reasoning", statusLabel: "Working", statusTone: "Accent",
  timerText: "Reasoning", traceExpanded: true, traceCollapsed: false, collapsedSummary: "Reasoning in progress",
  phases: [{ thought: "Working", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
};
const frame = (label: string): CardFrame =>
  ({ k: "registry", ref: { id: "ai.reasoning-process", version: "0.4.0" }, state: "reasoning", data: { ...DATA, progressText: label } });

function queueDeps(time: ManualTime) {
  const net = scriptedFetch(time);
  const api = createCardApi({ apiUrl: "https://api.example.com", credential: "t", fetchImpl: net.fetchImpl, nowUtcMs: time.wall.nowUtcMs });
  const policy = { authorize: () => ({ allowed: true as const, snapshot: {} as PolicySnapshot, limits: LIMITS }) };
  const pacer = createPacer({ clock: time.clock, timers: time.timers, rng: () => 0 });
  const ref: BotRef = { originKey: normalizeOrigin("https://api.example.com").key, credentialRef: "opaque-a" };
  const binding = { sessionKey: "group:g1", channelId: "g1", channelType: 2 as const, topicScope: null, generation: "turn-1", resetEpoch: 0 };
  let n = 0;
  const spec = (capability: "automatic" | "display" = "automatic") =>
    ({ cardId: `c${++n}`, kind: capability, capability, ctx: { botRef: ref }, binding, clientMsgNo: randomUUID() });
  return { net, deps: { api, policy, pacer, clock: time.clock, timers: time.timers }, spec, binding };
}

// ─── paths ──────────────────────────────────────────────────────────────────

describe("cardSubsystemPaths", () => {
  it("places marker, installation reference and backups under <dataDir>/cards", () => {
    expect(cardSubsystemPaths("/srv/bot")).toEqual({
      cardsDir: join("/srv/bot", "cards"),
      markerPath: join("/srv/bot", "cards", "activation.json"),
      installationRefPath: join("/srv/bot", "cards", "installation-ref"),
      backupDir: join("/srv/bot", "cards", "backups"),
    });
  });
});

// ─── provenance file ────────────────────────────────────────────────────────

describe("installation reference", () => {
  it("missing -> disabled provenance_missing with no DB access and no file written", async () => {
    const time = manualTime();
    const b = bot();
    const before = tree(b.dataDir);
    expect(await openCardSubsystem(options(b, time))).toEqual({ state: "disabled", reason: "provenance_missing" });
    expect(b.calls).toEqual([]);
    expect(tree(b.dataDir)).toEqual(before);
    expect(existsSync(cardSubsystemPaths(b.dataDir).cardsDir)).toBe(false);
    expect(initializeCardStore).not.toHaveBeenCalled();
  });

  it("missing while a marker exists -> disabled provenance_missing; the marker is untouched", async () => {
    const time = manualTime();
    const b = bot();
    provisionFirstInstallMarker(cardSubsystemPaths(b.dataDir).markerPath, "install-a", 1);
    const before = tree(b.dataDir);
    expect(await openCardSubsystem(options(b, time))).toEqual({ state: "disabled", reason: "provenance_missing" });
    expect(b.calls).toEqual([]);
    expect(tree(b.dataDir)).toEqual(before);
  });

  it.each([
    ["unsafe characters", "install a/../b\n", 0o600],
    ["empty", "", 0o600],
    ["only a newline", "\n", 0o600],
    ["two lines", "install-a\ninstall-b\n", 0o600],
    ["trailing CRLF", "install-a\r\n", 0o600],
    ["oversized", `${"a".repeat(4096)}\n`, 0o600],
    ["group-readable", "install-a\n", 0o640],
    ["world-readable", "install-a\n", 0o604],
  ])("%s -> disabled provenance_invalid with no DB access", async (_name, content, mode) => {
    const time = manualTime();
    const b = bot();
    writeRef(b.dataDir, content, mode);
    provisionFirstInstallMarker(cardSubsystemPaths(b.dataDir).markerPath, "install-a", 1);
    const before = tree(b.dataDir);
    expect(await openCardSubsystem(options(b, time))).toEqual({ state: "disabled", reason: "provenance_invalid" });
    expect(b.calls).toEqual([]);
    expect(tree(b.dataDir)).toEqual(before);
    expect(initializeCardStore).not.toHaveBeenCalled();
  });

  it("a symlink or a directory -> disabled provenance_invalid with no DB access", async () => {
    const time = manualTime();
    const b = bot();
    const { cardsDir, installationRefPath } = cardSubsystemPaths(b.dataDir);
    mkdirSync(cardsDir, { mode: 0o700 });
    const target = join(cardsDir, "elsewhere");
    writeFileSync(target, "install-a\n", { mode: 0o600 });
    symlinkSync(target, installationRefPath);
    expect(await openCardSubsystem(options(b, time))).toEqual({ state: "disabled", reason: "provenance_invalid" });
    rmSync(installationRefPath);
    mkdirSync(installationRefPath);
    expect(await openCardSubsystem(options(b, time))).toEqual({ state: "disabled", reason: "provenance_invalid" });
    expect(b.calls).toEqual([]);
  });

  it("accepts the reference with or without a single trailing newline", async () => {
    for (const content of ["install-a", "install-a\n"]) {
      const time = manualTime();
      const b = bot();
      writeRef(b.dataDir, content);
      provisionFirstInstallMarker(cardSubsystemPaths(b.dataDir).markerPath, "install-a", 1);
      expect(await openCardSubsystem(options(b, time))).toMatchObject({ state: "ready", provenance: "first_install" });
    }
  });
});

// ─── consumption of initializeCardStore ─────────────────────────────────────

describe("initializeCardStore is consumed exactly", () => {
  it("is called once with the same adapter, the file marker, the reference, the backup directory and the runtime options", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const newLineageId = () => "lineage-x";
    const opts = options(b, time, { newLineageId, sessionCapacity: 7 });
    const result = await openCardSubsystem(opts);
    expect(result.state).toBe("ready");
    const init = vi.mocked(initializeCardStore);
    expect(init).toHaveBeenCalledTimes(1);
    const arg = init.mock.calls[0][0];
    expect(arg.adapter).toBe(b.adapter);
    expect(arg.marker).toBeInstanceOf(FileActivationMarker);
    expect(arg.marker.read()).toEqual(new FileActivationMarker(cardSubsystemPaths(b.dataDir).markerPath).read());
    expect(arg.installationRef).toBe("install-a");
    expect(arg.backupDir).toBe(cardSubsystemPaths(b.dataDir).backupDir);
    expect(arg.clock).toBe(opts.clock);
    expect(arg.newId).toBe(opts.newId);
    expect(arg.sessionCapacity).toBe(7);
    expect(arg.newLineageId).toBe(newLineageId);
  });

  it("first install: ready, pre-migration backup 0600 in a 0700 directory, marker activated", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const result = await openCardSubsystem(options(b, time));
    if (result.state !== "ready") throw new Error(`unexpected ${result.reason}`);
    expect(result.provenance).toBe("first_install");
    const { backupDir, markerPath } = cardSubsystemPaths(b.dataDir);
    expect(result.backup?.path).toBe(join(backupDir, result.backup?.fileName as string));
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(result.backup?.path as string).mode & 0o777).toBe(0o600);
    const marker = new FileActivationMarker(markerPath).read();
    expect(marker).toMatchObject({ state: "present", marker: { installationRef: "install-a", everActivated: true, schemaFamily: "card_v1" } });
    expect(cardTables(b).length).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("restart: reopened with no second backup", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    expect(await openCardSubsystem(options(b, time))).toMatchObject({ state: "ready", provenance: "first_install" });
    const backups = readdirSync(cardSubsystemPaths(b.dataDir).backupDir);
    const again = await openCardSubsystem(options(b, time, { runtimeIncarnation: "inc-2" }));
    expect(again).toMatchObject({ state: "ready", provenance: "reopened" });
    expect(again.state === "ready" && again.backup).toBeFalsy();
    expect(readdirSync(cardSubsystemPaths(b.dataDir).backupDir)).toEqual(backups);
  });

  const reasons: CardStoreDisabledReason[] = [
    "provenance_missing", "provenance_invalid", "installation_mismatch", "prior_active_store_missing", "provenance_conflict",
    "lineage_mismatch", "partial_schema", "unknown_schema", "newer_schema", "integrity_failed", "invariant_failed",
    "backup_failed", "migration_failed", "marker_write_failed", "invalid_options",
  ];

  it.each(reasons.map((r) => [r]))("passes %s through without throwing, recovering nothing and writing no card state", async (reason) => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const before = { db: db(b), files: tree(b.dataDir) };
    const disabled: CardStoreInit = reason === "invariant_failed"
      ? { state: "disabled", reason, violations: ["foreign_key"] }
      : { state: "disabled", reason };
    forced.init = () => Promise.resolve(disabled);
    const recover = vi.spyOn(CardStore.prototype, "recoverExplicitLedger");
    const result = await openCardSubsystem(options(b, time));
    expect(result).toEqual(disabled);
    expect(result).not.toHaveProperty("store");
    expect(result).not.toHaveProperty("queueFactory");
    expect(recover).not.toHaveBeenCalled();
    expect({ db: db(b), files: tree(b.dataDir) }).toEqual(before);
  });

  it("an initializer that breaks its never-throws contract still resolves disabled", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    forced.init = () => { throw new Error("boom"); };
    await expect(openCardSubsystem(options(b, time))).resolves.toEqual({ state: "disabled", reason: "startup_failed" });
    forced.init = () => Promise.reject(new Error("boom"));
    await expect(openCardSubsystem(options(b, time))).resolves.toEqual({ state: "disabled", reason: "startup_failed" });
  });
});

// ─── failures stay inert ────────────────────────────────────────────────────

describe("migration and provenance failures leave the Bot card-inert with zero card writes", () => {
  async function expectInert(b: Bot, time: ManualTime, reason: string, opts: Partial<CardSubsystemOptions> = {}) {
    const result = await openCardSubsystem(options(b, time, opts));
    expect(result).toMatchObject({ state: "disabled", reason });
    expect(result).not.toHaveProperty("queueFactory");
    return result;
  }

  it("marker absent -> provenance_missing; no card table, no backup", async () => {
    const time = manualTime();
    const b = bot();
    writeRef(b.dataDir, "install-a\n");
    const before = db(b);
    await expectInert(b, time, "provenance_missing");
    expect(cardTables(b)).toEqual([]);
    expect(db(b)).toEqual(before);
    expect(existsSync(cardSubsystemPaths(b.dataDir).backupDir)).toBe(false);
  });

  it("reference differs from the marker -> installation_mismatch; nothing written", async () => {
    const time = manualTime();
    const b = bot();
    writeRef(b.dataDir, "install-b\n");
    provisionFirstInstallMarker(cardSubsystemPaths(b.dataDir).markerPath, "install-a", 1);
    const before = { db: db(b), files: tree(b.dataDir) };
    await expectInert(b, time, "installation_mismatch");
    expect({ db: db(b), files: tree(b.dataDir) }).toEqual(before);
  });

  it("activated marker over a database without card tables -> prior_active_store_missing; nothing written", async () => {
    const time = manualTime();
    const first = bot();
    provision(first, "install-a");
    expect(await openCardSubsystem(options(first, time))).toMatchObject({ state: "ready" });
    const other = attach(first.dataDir, "other.db");
    const before = { db: db(other), files: tree(first.dataDir) };
    await expectInert(other, time, "prior_active_store_missing");
    expect({ db: db(other), files: tree(first.dataDir) }).toEqual(before);
    expect(cardTables(other)).toEqual([]);
  });

  it("newer schema family in the marker -> newer_schema; nothing written", async () => {
    const time = manualTime();
    const b = bot();
    writeRef(b.dataDir, "install-a\n");
    writeFileSync(cardSubsystemPaths(b.dataDir).markerPath, serializeActivationMarker({ installationRef: "install-a",
      everActivated: true, schemaFamily: "card_v2", lineageId: "l", backupRef: null, recoveryClearanceRef: null, updatedAt: 1 }),
    { mode: 0o600 });
    const before = { db: db(b), files: tree(b.dataDir) };
    await expectInert(b, time, "newer_schema");
    expect({ db: db(b), files: tree(b.dataDir) }).toEqual(before);
  });

  it("backup directory unusable -> backup_failed; no card table and the marker is not activated", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    writeFileSync(cardSubsystemPaths(b.dataDir).backupDir, "not a directory");
    const before = { db: db(b), files: tree(b.dataDir) };
    await expectInert(b, time, "backup_failed");
    expect({ db: db(b), files: tree(b.dataDir) }).toEqual(before);
    expect(cardTables(b)).toEqual([]);
  });

  it("DDL failure -> migration_failed; the migration rolls back and the marker is not activated", async () => {
    const time = manualTime();
    const root = bot();
    const b = attach(root.dataDir, "cc-octo.db", { failDdl: "card_sessions" });
    provision(b, "install-a");
    const dbBefore = db(b);
    const markerBefore = readFileSync(cardSubsystemPaths(b.dataDir).markerPath);
    await expectInert(b, time, "migration_failed");
    expect(db(b)).toEqual(dbBefore);
    expect(cardTables(b)).toEqual([]);
    expect(readFileSync(cardSubsystemPaths(b.dataDir).markerPath)).toEqual(markerBefore);
  });

  it("the ordinary session store keeps working after a disabled open", async () => {
    const time = manualTime();
    const b = bot();
    await expectInert(b, time, "provenance_missing");
    const sessions = new SessionStore(b.raw);
    sessions.init();
    sessions.appendAssistant("dm:u1", "reply", 2);
    expect(sessions.buildHistoryPrefix("dm:u1", 10)).toContain("reply");
  });
});

// ─── explicit ledger before any queue ───────────────────────────────────────

describe("recoverExplicitLedger runs before the first queue construction", () => {
  it("is called once with the runtime incarnation before the queue factory reads the store", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const recover = vi.spyOn(CardStore.prototype, "recoverExplicitLedger");
    const unresolved = vi.spyOn(CardStore.prototype, "unresolvedSendKinds");
    const result = await openCardSubsystem(options(b, time, { runtimeIncarnation: "inc-7" }));
    if (result.state !== "ready") throw new Error(`unexpected ${result.reason}`);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith("inc-7");
    expect(unresolved).not.toHaveBeenCalled();
    const { deps } = queueDeps(time);
    result.queueFactory(deps);
    expect(unresolved).toHaveBeenCalledTimes(1);
    expect(recover.mock.invocationCallOrder[0]).toBeLessThan(unresolved.mock.invocationCallOrder[0]);
  });

  it("closes live handler generations of an earlier incarnation", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const first = await openCardSubsystem(options(b, time, { runtimeIncarnation: "inc-1" }));
    if (first.state !== "ready") throw new Error(`unexpected ${first.reason}`);
    first.store.registerHandler({ generation: "g1", installationRef: "install-a", sessionKey: "dm:u1", runtimeIncarnation: "inc-1",
      resetEpoch: 0, expiresAt: time.wall.nowUtcMs() + 60_000, contextDigest: "c", policyIdentity: "p" });
    const second = await openCardSubsystem(options(b, time, { runtimeIncarnation: "inc-2" }));
    if (second.state !== "ready") throw new Error(`unexpected ${second.reason}`);
    expect(second.ledger.closedGenerations).toBe(1);
    expect(second.store.getHandler("g1")?.state).toBe("closed");
  });

  it("a ledger recovery failure disables the Bot and retires the store", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const retire = vi.spyOn(CardStore.prototype, "retire");
    const result = await openCardSubsystem(options(b, time, { runtimeIncarnation: "" }));
    expect(result).toEqual({ state: "disabled", reason: "ledger_recovery_failed" });
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("ledger invariant violations disable the Bot and retire the store", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    vi.spyOn(CardStore.prototype, "recoverExplicitLedger").mockReturnValue({ closedGenerations: 0, unresolved: [], violations: ["foreign_key"] });
    const retire = vi.spyOn(CardStore.prototype, "retire");
    expect(await openCardSubsystem(options(b, time))).toEqual({ state: "disabled", reason: "invariant_failed", violations: ["foreign_key"] });
    expect(retire).toHaveBeenCalledTimes(1);
  });
});

// ─── N3 / D-B at startup ────────────────────────────────────────────────────

describe("startup never resends or abandons unresolved sends", () => {
  it("a sending row stays sending, abandonUnsent is never called and the factory queue starts suspended", async () => {
    const time = manualTime();
    const b = bot();
    provision(b, "install-a");
    const first = await openCardSubsystem(options(b, time));
    if (first.state !== "ready") throw new Error(`unexpected ${first.reason}`);
    const { binding } = queueDeps(time);
    const reserved = first.store.reserveMessage({ kind: "automatic", binding, bodyDigest: "d".repeat(64), clientMsgNo: randomUUID() });
    if (reserved.kind !== "reserved") throw new Error("fixture");
    const abandon = vi.spyOn(CardStore.prototype, "abandonUnsent");
    const markFailed = vi.spyOn(CardStore.prototype, "markSendFailed");
    const restarted = await openCardSubsystem(options(b, time, { runtimeIncarnation: "inc-2" }));
    if (restarted.state !== "ready") throw new Error(`unexpected ${restarted.reason}`);
    const { net, deps, spec } = queueDeps(time);
    const queue = restarted.queueFactory(deps);
    expect(queue.suspendedCapabilities()).toEqual(["automatic"]);
    const s = spec("automatic");
    expect(queue.open(s)).toBe("suspended");
    await time.advance(5000);
    expect(abandon).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(net.requests).toHaveLength(0);
    expect(restarted.store.getMessage(reserved.cardId)?.state).toBe("sending");
    const d = spec("display");
    expect(queue.open(d)).toBe("opened");
    queue.enqueue(d.cardId, frame("x"));
    await time.advance(800);
    expect(net.sends()).toHaveLength(1);
  });
});

// ─── two Bots ───────────────────────────────────────────────────────────────

describe("two-Bot isolation", () => {
  it("provenance, ledger and suspension are per Bot data directory", async () => {
    const time = manualTime();
    const a = bot("a");
    const b = bot("b");
    provision(a, "install-a");
    provision(b, "install-b");
    const ra = await openCardSubsystem(options(a, time));
    if (ra.state !== "ready") throw new Error(`unexpected ${ra.reason}`);
    const { binding } = queueDeps(time);
    const r = ra.store.reserveMessage({ kind: "display", binding, bodyDigest: "d".repeat(64), clientMsgNo: randomUUID() });
    if (r.kind !== "reserved") throw new Error("fixture");
    ra.store.markSendAmbiguous(r.cardId);
    const rb = await openCardSubsystem(options(b, time));
    if (rb.state !== "ready") throw new Error(`unexpected ${rb.reason}`);
    expect(rb.provenance).toBe("first_install");
    expect(ra.queueFactory(queueDeps(time).deps).suspendedCapabilities()).toEqual(["display"]);
    expect(rb.queueFactory(queueDeps(time).deps).suspendedCapabilities()).toEqual([]);
    // Bot B's reference never opens Bot A's store.
    writeFileSync(cardSubsystemPaths(a.dataDir).installationRefPath, "install-b\n");
    expect(await openCardSubsystem(options(a, time))).toMatchObject({ state: "disabled", reason: "installation_mismatch" });
  });
});
