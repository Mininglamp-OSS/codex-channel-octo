/**
 * WP-13A-2P O2: intent-capable schema version 2 (DTI-2.1 §2.2, §6 T14).
 *
 * Fresh install, the backed-up v1 → v2 upgrade with its exact legacy set,
 * rollback on failure, the 2048-id bound, the downgrade fence against a
 * version 1 build, and the two new startup invariants.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import {
  FileActivationMarker,
  MAX_INTENT_LEGACY_CARDS,
  inspectCardSchema,
  provisionFirstInstallMarker,
  referenceSchema,
  serializeIntentLegacy,
} from "../cards/migrations.js";
import { initializeCardStore, type CardBinding, type CardStore, type CardStoreInit } from "../cards/store.js";

const INSTALL = "install-a";
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const BINDING: CardBinding = { sessionKey: "group:g1", channelId: "g1", channelType: 2, topicScope: null, generation: "gen-1", resetEpoch: 0 };

interface Env { root: string; dbPath: string; backupDir: string; markerPath: string }
let env: Env;
const open: DbAdapter[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cards-schema-v2-"));
  env = { root, dbPath: join(root, "data", "cc-octo.db"), backupDir: join(root, "data", "backups"), markerPath: join(root, "recovery", "card-activation.json") };
});

afterEach(() => {
  while (open.length) { try { open.pop()?.close(); } catch { /* already closed */ } }
  rmSync(env.root, { recursive: true, force: true });
});

function openDb(): DbAdapter {
  const a = createAdapter(env.dbPath);
  open.push(a);
  new SessionStore(a).init();
  return a;
}

type Init = typeof initializeCardStore;

async function init(adapter: DbAdapter, at = T0, initialize: Init = initializeCardStore): Promise<CardStoreInit> {
  return initialize({
    adapter, marker: new FileActivationMarker(env.markerPath), installationRef: INSTALL, backupDir: env.backupDir,
    clock: { nowUtcMs: () => at }, newLineageId: () => "lineage-1", newId: () => `card-${randomUUID()}`,
  });
}

async function freshStore(a: DbAdapter): Promise<CardStore> {
  provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
  const r = await init(a);
  if (r.state !== "ready") throw new Error(`not ready: ${r.reason}`);
  return r.store;
}

let messageNo = 0;
function liveRow(store: CardStore, kind: "automatic" | "display" = "automatic"): string {
  const r = store.reserveMessage({ kind, binding: BINDING, bodyDigest: "digest", clientMsgNo: randomUUID(), templateId: "ai.reasoning-process", templateVersion: "0.4.0" });
  if (r.kind !== "reserved") throw new Error("reservation failed");
  expect(store.ackMessage({ cardId: r.cardId, messageId: `7${String(++messageNo).padStart(17, "0")}`, currentResetEpoch: 0, policyAllows: true }).kind).toBe("bound");
  return r.cardId;
}

/** Remove the version 3 (SC-1) additions: exactly what a version 2 build writes. */
function downgradeSchemaToV2(a: DbAdapter): void {
  a.exec("DROP TRIGGER trg_card_explicit_requests_settled");
  for (const c of ["late_at", "late_message_id", "late_outcome", "settled_by"]) a.exec(`ALTER TABLE card_explicit_requests DROP COLUMN ${c}`);
  a.prepare(`UPDATE card_meta SET v = '2' WHERE k = 'schema_version'`).run();
  a.prepare(`UPDATE card_meta SET v = ? WHERE k = 'schema_hash'`).run(referenceSchema(2).hash);
}

/** Rewrite the card family to exactly what a version 1 build writes (8 keys, no intent set). */
function downgradeMetaToV1(a: DbAdapter): void {
  downgradeSchemaToV2(a);
  a.prepare(`DELETE FROM card_meta WHERE k = 'intent_legacy'`).run();
  a.prepare(`UPDATE card_meta SET v = '1' WHERE k = 'schema_version'`).run();
}

function meta(a: DbAdapter): Record<string, string> {
  return Object.fromEntries((a.prepare("SELECT k, v FROM card_meta").all() as Array<{ k: string; v: string }>).map((r) => [r.k, r.v]));
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(".", "");

/** Adapter whose `prepare` throws for one SQL statement. */
function failingOn(a: DbAdapter, fragment: string): DbAdapter {
  return new Proxy(a, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(fragment)) throw new Error("injected failure");
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ─── Fresh install ─────────────────────────────────────────────────────────

describe("T14: fresh install", () => {
  it("writes the current version 3 with an empty legacy set; the first-install backup name is unchanged", async () => {
    const a = openDb();
    provisionFirstInstallMarker(env.markerPath, INSTALL, T0);
    const r = await init(a);
    expect(r).toMatchObject({ state: "ready", provenance: "first_install", meta: { schemaVersion: 3 } });
    if (r.state !== "ready") return;
    expect([...r.meta.legacyIntentCards]).toEqual([]);
    expect(r.backup?.fileName).toBe(`cc-octo.pre-card_v1.${stamp(T0)}.db`);
    expect(meta(a)).toMatchObject({ schema_version: "3", intent_legacy: '{"format":1,"cards":[]}' });
    expect(Object.keys(meta(a))).toHaveLength(9);
    const again = await init(a, T0 + 1000);
    expect(again).toMatchObject({ state: "ready", provenance: "reopened", meta: { schemaVersion: 3 } });
    expect(again.state === "ready" && again.backup).toBe(undefined);
  });
});

// ─── v1 → v2 upgrade ───────────────────────────────────────────────────────

describe("T14: upgrade from a version 1 store", () => {
  it("backs up, records the exact live automatic set as legacy and fences it", async () => {
    const a = openDb();
    const v1 = await freshStore(a);
    const active = liveRow(v1);
    const sending = v1.reserveMessage({ kind: "automatic", binding: BINDING, bodyDigest: "d", clientMsgNo: randomUUID() });
    if (sending.kind !== "reserved") throw new Error("reservation failed");
    const finished = liveRow(v1);
    expect(v1.markTerminal(finished, "completed").kind).toBe("updated");
    const display = liveRow(v1, "display");
    downgradeMetaToV1(a);
    expect(inspectCardSchema(a)).toMatchObject({ state: "complete", meta: { schemaVersion: 1 } });

    const at = T0 + 60_000;
    const r = await init(a, at);
    expect(r).toMatchObject({ state: "ready", provenance: "reopened", meta: { schemaVersion: 3 } });
    if (r.state !== "ready") return;
    const legacy = [active, sending.cardId].sort();
    expect([...r.meta.legacyIntentCards].sort()).toEqual(legacy);
    expect(meta(a).intent_legacy).toBe(serializeIntentLegacy(legacy));
    // The upgrade continues through version 2 to the current version 3.
    expect(meta(a).schema_version).toBe("3");

    // The upgrade backup is a second file next to the untouched first-install one.
    expect(r.backup?.fileName).toBe(`cc-octo.pre-card_v1-s2.${stamp(at)}.db`);
    expect(readdirSync(env.backupDir).sort()).toEqual([`cc-octo.pre-card_v1-s2.${stamp(at)}.db`, `cc-octo.pre-card_v1.${stamp(T0)}.db`]);
    const copy = new Database(join(env.backupDir, r.backup?.fileName as string), { readonly: true });
    try {
      const rows = copy.prepare("SELECT k, v FROM card_meta ORDER BY k").all() as Array<{ k: string; v: string }>;
      expect(rows.find((x) => x.k === "schema_version")?.v).toBe("1");
      expect(rows.some((x) => x.k === "intent_legacy")).toBe(false);
    } finally {
      copy.close();
    }

    const store = r.store;
    expect(store.liveAutomaticCards().map((c) => [c.record.cardId, c.legacy])).toEqual([[active, true]]);
    expect(store.reserveSequence(active)).toEqual({ kind: "invalid_state", state: "active" });
    expect(store.reserveTerminalSequence(active, "interrupted")).toEqual({ kind: "invalid_state", state: "active" });
    expect(store.reserveSequence(display)).toEqual({ kind: "reserved", seq: 1 });
    const fresh = liveRow(store);
    expect(store.liveAutomaticCards().map((c) => [c.record.cardId, c.legacy])).toEqual([[active, true], [fresh, false]]);
    expect(store.reserveTerminalSequence(fresh, "completed")).toEqual({ kind: "reserved", seq: 1 });

    const reopened = await init(a, at + 1000);
    expect(reopened).toMatchObject({ state: "ready", provenance: "reopened" });
    expect(reopened.state === "ready" && reopened.backup).toBe(undefined);
    expect(meta(a).intent_legacy).toBe(serializeIntentLegacy(legacy));
  });

  it("an empty version 1 store upgrades with an empty legacy set", async () => {
    const a = openDb();
    await freshStore(a);
    downgradeMetaToV1(a);
    const r = await init(a, T0 + 1000);
    expect(r).toMatchObject({ state: "ready", meta: { schemaVersion: 3 } });
    expect(meta(a).intent_legacy).toBe('{"format":1,"cards":[]}');
  });

  it("an injected failure inside the upgrade rolls back to version 1 and disables cards", async () => {
    const a = openDb();
    const v1 = await freshStore(a);
    const active = liveRow(v1);
    downgradeMetaToV1(a);
    const before = meta(a);
    const r = await init(failingOn(a, "UPDATE card_meta SET v = ? WHERE k = 'schema_version'"), T0 + 1000);
    expect(r).toEqual({ state: "disabled", reason: "migration_failed" });
    expect(a.inTransaction).toBe(false);
    expect(meta(a)).toEqual(before);
    expect(inspectCardSchema(a)).toMatchObject({ state: "complete", meta: { schemaVersion: 1 } });
    // Ordinary operation is untouched, and the next clean start upgrades.
    const retried = await init(a, T0 + 2000);
    expect(retried).toMatchObject({ state: "ready", meta: { schemaVersion: 3 } });
    expect(meta(a).intent_legacy).toBe(serializeIntentLegacy([active]));
  });

  it("a backup failure leaves version 1 untouched", async () => {
    const a = openDb();
    await freshStore(a);
    downgradeMetaToV1(a);
    writeFileSync(join(env.backupDir, `cc-octo.pre-card_v1-s2.${stamp(T0 + 1000)}.db`), "occupied");
    expect(await init(a, T0 + 1000)).toEqual({ state: "disabled", reason: "migration_failed" });
    expect(meta(a).schema_version).toBe("1");
  });

  function insertLiveAutomatic(a: DbAdapter, n: number): void {
    const stmt = a.prepare(
      `INSERT INTO card_messages (card_id, kind, session_key, channel_id, channel_type, generation, topic_scope, reset_epoch,
         body_digest, client_msg_no, message_id, state, created_at, updated_at)
       VALUES (?, 'automatic', 'group:g1', 'g1', 2, 'gen-1', NULL, 0, 'digest', ?, ?, 'active', ?, ?)`,
    );
    a.exec("BEGIN");
    for (let i = 0; i < n; i++) stmt.run(`bulk-${String(i).padStart(5, "0")}`, `cmn-${i}`, `6${String(i).padStart(17, "0")}`, T0, T0);
    a.exec("COMMIT");
  }

  it(`exactly ${MAX_INTENT_LEGACY_CARDS} legacy cards upgrade`, async () => {
    const a = openDb();
    await freshStore(a);
    insertLiveAutomatic(a, MAX_INTENT_LEGACY_CARDS);
    downgradeMetaToV1(a);
    const r = await init(a, T0 + 1000);
    expect(r).toMatchObject({ state: "ready", meta: { schemaVersion: 3 } });
    expect(r.state === "ready" && r.meta.legacyIntentCards.size).toBe(MAX_INTENT_LEGACY_CARDS);
  });

  it(`more than ${MAX_INTENT_LEGACY_CARDS} legacy cards fail closed and keep version 1`, async () => {
    const a = openDb();
    await freshStore(a);
    insertLiveAutomatic(a, MAX_INTENT_LEGACY_CARDS + 1);
    downgradeMetaToV1(a);
    expect(await init(a, T0 + 1000)).toEqual({ state: "disabled", reason: "migration_failed" });
    expect(meta(a).schema_version).toBe("1");
    expect(meta(a).intent_legacy).toBeUndefined();
  });
});

// ─── Downgrade fence ───────────────────────────────────────────────────────

describe("T14: a version 1 build on a version 2 store", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const builds: string[] = [];
  afterAll(() => { for (const d of builds.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** The card store built with `CARD_SCHEMA_VERSION = 1`, as an older binary would ship it. */
  async function loadV1Build(): Promise<Init> {
    const dir = mkdtempSync(join(here, ".v1-build-"));
    builds.push(dir);
    mkdirSync(join(dir, "cards"));
    const src = join(here, "..", "cards");
    const migrations = readFileSync(join(src, "migrations.ts"), "utf8");
    const patched = migrations.replace("export const CARD_SCHEMA_VERSION = 3;", "export const CARD_SCHEMA_VERSION = 1;");
    expect(patched).not.toBe(migrations);
    writeFileSync(join(dir, "cards", "migrations.ts"), patched);
    writeFileSync(join(dir, "cards", "store.ts"), readFileSync(join(src, "store.ts"), "utf8"));
    writeFileSync(join(dir, "cards", "safe-file.ts"), readFileSync(join(src, "safe-file.ts"), "utf8"));
    const mod = (await import(join(dir, "cards", "store.ts"))) as { initializeCardStore: Init };
    return mod.initializeCardStore;
  }

  const digest = (path: string): string | null => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);

  it("is disabled as newer_schema and leaves the database and marker bytes unchanged", async () => {
    const v1Init = await loadV1Build();
    const a = openDb();
    const store = await freshStore(a);
    liveRow(store);
    a.close();
    open.splice(open.indexOf(a), 1);
    const files = [env.dbPath, `${env.dbPath}-wal`, `${env.dbPath}-shm`, env.markerPath];
    const before = files.map(digest);

    const reopened = createAdapter(env.dbPath);
    open.push(reopened);
    expect(await init(reopened, T0 + 1000, v1Init)).toEqual({ state: "disabled", reason: "newer_schema" });
    reopened.close();
    open.splice(open.indexOf(reopened), 1);
    expect(files.map(digest)).toEqual(before);

    // Re-upgrading (running the current build again) reopens the current version unchanged.
    const current = createAdapter(env.dbPath);
    open.push(current);
    const r = await init(current, T0 + 2000);
    expect(r).toMatchObject({ state: "ready", provenance: "reopened", meta: { schemaVersion: 3 } });
    expect(r.state === "ready" && r.backup).toBe(undefined);
  });
});

// ─── Invariants and meta validation ────────────────────────────────────────

describe("T14: new startup invariants and intent_legacy validation", () => {
  it("terminal_intent_shape: a live terminal reason outside a bound automatic intent row disables cards", async () => {
    const a = openDb();
    const store = await freshStore(a);
    const display = liveRow(store, "display");
    a.prepare(`UPDATE card_messages SET terminal_reason = 'completed' WHERE card_id = ?`).run(display);
    const r = await init(a, T0 + 1000);
    expect(r).toMatchObject({ state: "disabled", reason: "invariant_failed" });
    expect(r.state === "disabled" && r.violations).toContain("terminal_intent_shape");
  });

  it("terminal_intent_shape: an intent before any reserved sequence disables cards", async () => {
    const a = openDb();
    const store = await freshStore(a);
    const id = liveRow(store);
    a.prepare(`UPDATE card_messages SET terminal_reason = 'failed' WHERE card_id = ?`).run(id);
    const r = await init(a, T0 + 1000);
    expect(r.state === "disabled" && r.violations).toEqual(["terminal_intent_shape"]);
  });

  it("intent_legacy_conflict: a legacy id with a live intent disables cards", async () => {
    const a = openDb();
    const store = await freshStore(a);
    const id = liveRow(store);
    expect(store.reserveTerminalSequence(id, "completed").kind).toBe("reserved");
    expect(await init(a, T0 + 1000)).toMatchObject({ state: "ready" });
    a.prepare(`UPDATE card_meta SET v = ? WHERE k = 'intent_legacy'`).run(serializeIntentLegacy([id]));
    const r = await init(a, T0 + 2000);
    expect(r).toMatchObject({ state: "disabled", reason: "invariant_failed" });
    expect(r.state === "disabled" && r.violations).toEqual(["intent_legacy_conflict"]);
  });

  it.each([
    ["unsorted ids", '{"format":1,"cards":["b","a"]}'],
    ["duplicate ids", '{"format":1,"cards":["a","a"]}'],
    ["unknown format", '{"format":2,"cards":[]}'],
    ["extra key", '{"format":1,"cards":[],"x":1}'],
    ["whitespace", '{"format":1, "cards":[]}'],
    ["empty id", '{"format":1,"cards":[""]}'],
    ["not JSON", "legacy"],
  ])("a non-canonical intent_legacy (%s) is an unknown schema", async (_name, value) => {
    const a = openDb();
    await freshStore(a);
    a.prepare(`UPDATE card_meta SET v = ? WHERE k = 'intent_legacy'`).run(value);
    expect(inspectCardSchema(a)).toEqual({ state: "unknown", detail: "meta_invalid" });
    expect(await init(a, T0 + 1000)).toEqual({ state: "disabled", reason: "unknown_schema" });
  });

  it("version 2 without intent_legacy, or version 1 with it, is an unknown schema", async () => {
    const a = openDb();
    await freshStore(a);
    a.prepare(`DELETE FROM card_meta WHERE k = 'intent_legacy'`).run();
    expect(inspectCardSchema(a)).toEqual({ state: "unknown", detail: "meta_invalid" });
    a.prepare(`INSERT INTO card_meta (k, v) VALUES ('intent_legacy', ?)`).run(serializeIntentLegacy([]));
    a.prepare(`UPDATE card_meta SET v = '1' WHERE k = 'schema_version'`).run();
    expect(inspectCardSchema(a)).toEqual({ state: "unknown", detail: "meta_invalid" });
  });
});
