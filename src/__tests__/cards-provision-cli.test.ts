/**
 * Per-Bot card provisioning (WP-13A-1 contract 4): `codex-channel-octo cards
 * provision --bot <id>` resolves the Bot's existing dataDir, writes a fresh
 * installation reference create-only and the first-install marker through
 * `provisionFirstInstallMarker`, and refuses without touching either file when
 * any provenance already exists or the path is unsafe.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "../cli.js";
import {
  FileActivationMarker, isSafeStoreRef, parseActivationMarker, provisionFirstInstallMarker, serializeActivationMarker,
} from "../cards/migrations.js";
import { provisionBotCards, provisionCardProvenance } from "../cards/provision.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime } from "./fixtures/card-write-harness.js";

const forced = vi.hoisted(() => ({ beforeMarker: undefined as undefined | ((path: string) => void) }));
vi.mock("../cards/migrations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/migrations.js")>();
  return {
    ...actual,
    provisionFirstInstallMarker: vi.fn((path: string, ref: string, nowMs: number) => {
      forced.beforeMarker?.(path);
      return actual.provisionFirstInstallMarker(path, ref, nowMs);
    }),
  };
});

const posix = process.platform !== "win32";
const roots: string[] = [];
const adapters: DbAdapter[] = [];
afterEach(() => {
  forced.beforeMarker = undefined;
  vi.restoreAllMocks();
  for (const a of adapters.splice(0)) { try { a.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) {
    try { chmodSync(r, 0o700); } catch { /* gone */ }
    rmSync(r, { recursive: true, force: true });
  }
});

// ─── fixtures ───────────────────────────────────────────────────────────────

const TOKENS = { a: "tok-secret-a-0001", b: "tok-secret-b-0002" } as const;
const WHEN = Date.UTC(2026, 9, 27);

/** A two-layer install: global config listing Bots plus per-Bot token files, as `configure` leaves it. */
function install(opts: { dataDirs?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), "cards-provision-"));
  roots.push(base);
  chmodSync(base, 0o700);
  writeFileSync(join(base, "config.json"),
    JSON.stringify({ apiUrl: "https://octo.test", bots: [{ id: "a" }, { id: "b" }] }), { mode: 0o600 });
  for (const id of ["a", "b"] as const) {
    mkdirSync(join(base, id), { mode: 0o700 });
    writeFileSync(join(base, id, "config.json"), JSON.stringify({ botToken: TOKENS[id] }), { mode: 0o600 });
    if (opts.dataDirs !== false) mkdirSync(join(base, id, "data"), { mode: 0o700 });
  }
  return base;
}

const dataDirOf = (base: string, id: string): string => join(base, id, "data");

/** Content hash and mode of every entry under `dir` (symlinks by target). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = lstatSync(p);
      const mode = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) out[relative(dir, p)] = `link:${p}`;
      else if (st.isDirectory()) { out[`${relative(dir, p)}/`] = mode; walk(p); }
      else out[relative(dir, p)] = `${mode}:${createHash("sha256").update(readFileSync(p)).digest("hex")}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

interface Captured { readonly code: number; readonly out: string; readonly err: string }

async function cli(argv: string[], base: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  try {
    const code = await run(argv, base);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore(); error.mockRestore(); warn.mockRestore();
  }
}

/** Open the card subsystem over a fresh ordinary store in `dataDir`, as `index.ts` startup does. */
async function openCards(dataDir: string) {
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  adapters.push(adapter);
  const sessions = new SessionStore(adapter);
  sessions.init();
  let id = 0;
  return openCardSubsystem({
    adapter, dataDir, clock: manualTime().wall, runtimeIncarnation: "inc-1", newId: () => `id-${++id}-${randomUUID()}`,
  });
}

function readRef(dataDir: string): string {
  return readFileSync(cardSubsystemPaths(dataDir).installationRefPath, "utf8");
}

function expectNoSecrets(c: Captured, ...extra: string[]): void {
  for (const s of [...Object.values(TOKENS), ...extra]) {
    expect(c.out).not.toContain(s);
    expect(c.err).not.toContain(s);
  }
}

// ─── fresh provisioning ─────────────────────────────────────────────────────

describe("cards provision: fresh Bot", () => {
  it("moves startup from provenance_missing to a ready first install", async () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    expect(await openCards(dataDir)).toMatchObject({ state: "disabled", reason: "provenance_missing" });
    for (const a of adapters.splice(0)) a.close();
    rmSync(join(dataDir, "cc-octo.db"), { force: true });
    rmSync(join(dataDir, "cards"), { recursive: true, force: true });

    const c = await cli(["cards", "provision", "--bot", "a"], base);
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/provisioned/);

    const raw = readRef(dataDir);
    expect(raw.endsWith("\n")).toBe(true);
    const ref = raw.slice(0, -1);
    expect(isSafeStoreRef(ref)).toBe(true);
    expectNoSecrets(c, ref);

    const read = new FileActivationMarker(cardSubsystemPaths(dataDir).markerPath).read();
    expect(read).toEqual({
      state: "present",
      marker: {
        installationRef: ref, everActivated: false, schemaFamily: null, lineageId: null,
        backupRef: null, recoveryClearanceRef: null, updatedAt: expect.any(Number),
      },
    });

    const opened = await openCards(dataDir);
    expect(opened).toMatchObject({ state: "ready", provenance: "first_install" });
  });

  it("writes private files in a private cards directory", async () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    expect((await cli(["cards", "provision", "--bot=a"], base)).code).toBe(0);
    const { cardsDir, installationRefPath, markerPath } = cardSubsystemPaths(dataDir);
    if (posix) {
      expect(statSync(cardsDir).mode & 0o777).toBe(0o700);
      expect(statSync(installationRefPath).mode & 0o777).toBe(0o600);
      expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    }
    expect(lstatSync(installationRefPath).isFile()).toBe(true);
    expect(lstatSync(installationRefPath).nlink).toBe(1);
    // No temporary file is left behind.
    expect(readdirSync(cardsDir).sort()).toEqual(["activation.json", "installation-ref"]);
  });

  it("generates a distinct reference per Bot and touches only the selected Bot", async () => {
    const base = install();
    const before = tree(join(base, "b"));
    expect((await cli(["cards", "provision", "--bot", "a"], base)).code).toBe(0);
    expect(tree(join(base, "b"))).toEqual(before);
    expect((await cli(["cards", "provision", "--bot", "b"], base)).code).toBe(0);
    expect(readRef(dataDirOf(base, "a"))).not.toBe(readRef(dataDirOf(base, "b")));
  });

  it("uses the injected clock for the marker timestamp", () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    const r = provisionCardProvenance(dataDir, { nowMs: () => WHEN, newRef: () => "install-fixed" });
    expect(r).toMatchObject({ kind: "provisioned" });
    const marker = parseActivationMarker(readFileSync(cardSubsystemPaths(dataDir).markerPath, "utf8"));
    expect(marker).toMatchObject({ installationRef: "install-fixed", updatedAt: WHEN });
    expect(readRef(dataDir)).toBe("install-fixed\n");
  });
});

// ─── refusal leaves everything byte-identical ───────────────────────────────

describe("cards provision: never overwrites", () => {
  it("refuses a second run and leaves both files byte-identical", async () => {
    const base = install();
    expect((await cli(["cards", "provision", "--bot", "a"], base)).code).toBe(0);
    const before = tree(base);
    const c = await cli(["cards", "provision", "--bot", "a"], base);
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/already/);
    expect(tree(base)).toEqual(before);
  });

  it("leaves an activated marker untouched", async () => {
    const base = install();
    const { cardsDir, markerPath, installationRefPath } = cardSubsystemPaths(dataDirOf(base, "a"));
    mkdirSync(cardsDir, { mode: 0o700 });
    writeFileSync(markerPath, serializeActivationMarker({
      installationRef: "install-old", everActivated: true, schemaFamily: "card_v1", lineageId: "lineage-old",
      backupRef: null, recoveryClearanceRef: null, updatedAt: WHEN,
    }), { mode: 0o600 });
    const before = tree(base);
    const c = await cli(["cards", "provision", "--bot", "a"], base);
    expect(c.code).toBe(1);
    expect(tree(base)).toEqual(before);
    expect(existsSync(installationRefPath)).toBe(false);
  });

  it("refuses partial state with only the installation reference present", async () => {
    const base = install();
    const { cardsDir, markerPath, installationRefPath } = cardSubsystemPaths(dataDirOf(base, "a"));
    mkdirSync(cardsDir, { mode: 0o700 });
    writeFileSync(installationRefPath, "install-partial\n", { mode: 0o600 });
    const before = tree(base);
    expect((await cli(["cards", "provision", "--bot", "a"], base)).code).toBe(1);
    expect(tree(base)).toEqual(before);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("refuses partial state with only the marker present", async () => {
    const base = install();
    const { cardsDir, markerPath, installationRefPath } = cardSubsystemPaths(dataDirOf(base, "a"));
    provisionFirstInstallMarker(markerPath, "install-partial", WHEN);
    expect(existsSync(cardsDir)).toBe(true);
    const before = tree(base);
    expect((await cli(["cards", "provision", "--bot", "a"], base)).code).toBe(1);
    expect(tree(base)).toEqual(before);
    expect(existsSync(installationRefPath)).toBe(false);
  });

  it("treats a dangling symlink at either path as existing provenance", () => {
    const base = install();
    for (const which of ["installationRefPath", "markerPath"] as const) {
      const dataDir = dataDirOf(base, which === "markerPath" ? "b" : "a");
      const paths = cardSubsystemPaths(dataDir);
      mkdirSync(paths.cardsDir, { mode: 0o700 });
      const target = join(base, `target-${which}`);
      symlinkSync(target, paths[which]);
      const before = tree(base);
      expect(provisionCardProvenance(dataDir, { nowMs: () => WHEN })).toMatchObject({
        kind: "refused", reason: "already_provisioned",
      });
      expect(tree(base)).toEqual(before);
      expect(existsSync(target)).toBe(false);
    }
  });
});

// ─── nothing is written on resolution or validation failure ─────────────────

describe("cards provision: writes nothing on failure", () => {
  it("rejects an unknown Bot", async () => {
    const base = install();
    const before = tree(base);
    const c = await cli(["cards", "provision", "--bot", "zz"], base);
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/unknown bot/i);
    expect(tree(base)).toEqual(before);
    expect(provisionBotCards({ botId: "../a", configPath: join(base, "config.json") }))
      .toMatchObject({ kind: "refused", reason: "unknown_bot" });
    expect(tree(base)).toEqual(before);
  });

  it("rejects a Bot whose dataDir does not exist yet, creating nothing", async () => {
    const base = install({ dataDirs: false });
    const before = tree(base);
    const c = await cli(["cards", "provision", "--bot", "a"], base);
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/data directory/i);
    expect(tree(base)).toEqual(before);
    expect(existsSync(dataDirOf(base, "a"))).toBe(false);
  });

  it("rejects an invalid generated reference before any write", () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    const before = tree(base);
    for (const bad of ["", "../escape", "has space", "x".repeat(129), "﻿ref", "ref\n"]) {
      expect(provisionCardProvenance(dataDir, { nowMs: () => WHEN, newRef: () => bad }))
        .toEqual({ kind: "refused", reason: "invalid_ref" });
    }
    expect(provisionCardProvenance(dataDir, { nowMs: () => WHEN, newRef: () => { throw new Error("rng"); } }))
      .toEqual({ kind: "refused", reason: "invalid_ref" });
    expect(tree(base)).toEqual(before);
    expect(existsSync(cardSubsystemPaths(dataDir).cardsDir)).toBe(false);
  });

  it("rejects an invalid clock before any write", () => {
    const base = install();
    const before = tree(base);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(provisionCardProvenance(dataDirOf(base, "a"), { nowMs: () => bad }))
        .toEqual({ kind: "refused", reason: "invalid_clock" });
    }
    expect(tree(base)).toEqual(before);
  });

  it("reports an unreadable configuration without echoing its content", async () => {
    const base = install();
    writeFileSync(join(base, "a", "config.json"), `{"botToken": "${TOKENS.a}",`, { mode: 0o600 });
    const before = tree(base);
    const c = await cli(["cards", "provision", "--bot", "a"], base);
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/configuration/i);
    expectNoSecrets(c);
    expect(tree(base)).toEqual(before);
  });

  it("requires --bot and a known subcommand", async () => {
    const base = install();
    const before = tree(base);
    expect((await cli(["cards", "provision"], base)).code).toBe(2);
    expect((await cli(["cards", "provision", "--bot"], base)).code).toBe(2);
    expect((await cli(["cards", "provision", "--bot="], base)).code).toBe(2);
    expect((await cli(["cards"], base)).code).toBe(2);
    expect((await cli(["cards", "reset", "--bot", "a"], base)).code).toBe(2);
    expect(tree(base)).toEqual(before);
  });

  it("documents the subcommand in help", async () => {
    const c = await cli(["help"], install());
    expect(c.out).toContain("cards provision --bot <botId>");
  });
});

// ─── unsafe paths fail closed ───────────────────────────────────────────────

describe.skipIf(!posix)("cards provision: unsafe paths", () => {
  it("refuses a symlinked dataDir", () => {
    const base = install();
    const real = join(base, "elsewhere");
    mkdirSync(real, { mode: 0o700 });
    rmSync(dataDirOf(base, "a"), { recursive: true });
    symlinkSync(real, dataDirOf(base, "a"));
    const before = tree(base);
    expect(provisionCardProvenance(dataDirOf(base, "a"), { nowMs: () => WHEN }))
      .toEqual({ kind: "refused", reason: "unsafe_path" });
    expect(tree(base)).toEqual(before);
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a group- or other-writable dataDir", () => {
    const base = install();
    chmodSync(dataDirOf(base, "a"), 0o770);
    const before = tree(base);
    expect(provisionCardProvenance(dataDirOf(base, "a"), { nowMs: () => WHEN }))
      .toEqual({ kind: "refused", reason: "unsafe_path" });
    expect(tree(base)).toEqual(before);
  });

  it("refuses a symlinked cards directory and leaves its target untouched", () => {
    const base = install();
    const real = join(base, "cards-target");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, cardSubsystemPaths(dataDirOf(base, "a")).cardsDir);
    const before = tree(base);
    expect(provisionCardProvenance(dataDirOf(base, "a"), { nowMs: () => WHEN }))
      .toEqual({ kind: "refused", reason: "unsafe_path" });
    expect(tree(base)).toEqual(before);
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a cards directory that is not private, without changing its mode", () => {
    const base = install();
    const { cardsDir } = cardSubsystemPaths(dataDirOf(base, "a"));
    mkdirSync(cardsDir);
    chmodSync(cardsDir, 0o755);
    const before = tree(base);
    expect(provisionCardProvenance(dataDirOf(base, "a"), { nowMs: () => WHEN }))
      .toEqual({ kind: "refused", reason: "unsafe_path" });
    expect(tree(base)).toEqual(before);
  });

  it("refuses a cards path that is a regular file", () => {
    const base = install();
    writeFileSync(cardSubsystemPaths(dataDirOf(base, "a")).cardsDir, "x", { mode: 0o600 });
    const before = tree(base);
    expect(provisionCardProvenance(dataDirOf(base, "a"), { nowMs: () => WHEN }))
      .toEqual({ kind: "refused", reason: "unsafe_path" });
    expect(tree(base)).toEqual(before);
  });
});

// ─── concurrent writers ─────────────────────────────────────────────────────

describe("cards provision: concurrent writer", () => {
  it("rolls back its own reference when a marker appears before the marker write", () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    const { markerPath, installationRefPath } = cardSubsystemPaths(dataDir);
    const foreign = serializeActivationMarker({
      installationRef: "install-other", everActivated: true, schemaFamily: "card_v1", lineageId: "lineage-other",
      backupRef: null, recoveryClearanceRef: null, updatedAt: WHEN,
    });
    forced.beforeMarker = (path) => { writeFileSync(path, foreign, { mode: 0o600, flag: "wx" }); };
    expect(provisionCardProvenance(dataDir, { nowMs: () => WHEN, newRef: () => "install-mine" }))
      .toEqual({ kind: "refused", reason: "concurrent_writer" });
    expect(readFileSync(markerPath, "utf8")).toBe(foreign);
    expect(existsSync(installationRefPath)).toBe(false);
    expect(readdirSync(cardSubsystemPaths(dataDir).cardsDir)).toEqual(["activation.json"]);
  });

  it("does not remove a reference it did not write", () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    const { installationRefPath } = cardSubsystemPaths(dataDir);
    forced.beforeMarker = (path) => {
      // Another writer replaces the reference and then creates the marker.
      rmSync(installationRefPath);
      writeFileSync(installationRefPath, "install-other\n", { mode: 0o600 });
      writeFileSync(path, "{}", { mode: 0o600, flag: "wx" });
    };
    expect(provisionCardProvenance(dataDir, { nowMs: () => WHEN, newRef: () => "install-mine" }))
      .toEqual({ kind: "refused", reason: "concurrent_writer" });
    expect(readFileSync(installationRefPath, "utf8")).toBe("install-other\n");
  });

  it("removes its own reference when the marker write fails for another reason", () => {
    const base = install();
    const dataDir = dataDirOf(base, "a");
    forced.beforeMarker = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    expect(provisionCardProvenance(dataDir, { nowMs: () => WHEN, newRef: () => "install-mine" }))
      .toEqual({ kind: "refused", reason: "write_failed" });
    expect(existsSync(cardSubsystemPaths(dataDir).installationRefPath)).toBe(false);
  });
});
