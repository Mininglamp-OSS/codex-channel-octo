/**
 * Deployment-side card provisioning for one Bot (WP-13A-1 contract 4).
 *
 * `codex-channel-octo cards provision --bot <id>` is the only route out of
 * card-inert (`provenance_missing`). It resolves the Bot's dataDir through the
 * existing config resolver (`loadConfig` + `resolveBotConfigs`), then writes
 * the two provenance files that `openCardSubsystem` reads, at the paths from
 * `cardSubsystemPaths`:
 * - `installation-ref`: a fresh opaque reference passing `isSafeStoreRef`,
 *   written to a private temp file, fsynced, and published with `link(2)`, so
 *   it appears complete or not at all and never replaces an existing entry;
 * - `activation.json`: through the existing `provisionFirstInstallMarker`,
 *   which creates it exclusively and never overwrites.
 *
 * Every check runs before the first write. If either file exists in any form
 * (including a dangling symlink), nothing is written. A symlinked, foreign or
 * group/other-writable dataDir, or a cards directory that is not a private
 * directory, fails closed. A concurrent writer that wins either file makes this
 * run remove only the reference it created itself (matched by inode) and
 * report `concurrent_writer`. Startup reads a reference without a marker as
 * `provenance_missing`, so the window between the two writes is card-inert.
 *
 * No network, model or database access, and no reference, token or config
 * content is ever returned in a message.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync,
  writeSync, chmodSync, type Stats,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveBotConfigs } from "../config.js";
import { FileActivationMarker, isSafeStoreRef, provisionFirstInstallMarker } from "./migrations.js";
import { cardSubsystemPaths } from "./recovery.js";
import { decodeStrictUtf8, readPrivateRegularFile } from "./safe-file.js";

export type ProvisionRefusal =
  | "config_unavailable"
  | "unknown_bot"
  | "data_dir_missing"
  | "unsafe_path"
  | "already_provisioned"
  | "invalid_ref"
  | "invalid_clock"
  | "concurrent_writer"
  | "write_failed"
  | "readback_failed";

export type ProvisionResult =
  | { readonly kind: "provisioned"; readonly cardsDir: string }
  | { readonly kind: "refused"; readonly reason: ProvisionRefusal };

export interface ProvenanceOptions {
  /** Wall clock for the marker's `updatedAt`; defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** Fresh opaque reference; defaults to `randomUUID`. */
  readonly newRef?: () => string;
}

export interface ProvisionOptions extends ProvenanceOptions {
  readonly botId: string;
  /** Global config path; defaults to the runtime config, as at gateway start. */
  readonly configPath?: string;
}

/** Bound on the reference file read back; matches the startup reader. */
const MAX_REF_FILE_BYTES = 1024;

function refused(reason: ProvisionRefusal): ProvisionResult {
  return Object.freeze({ kind: "refused", reason });
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** Owned by this user (POSIX); Windows has no comparable uid. */
function ownedBySelf(st: Stats): boolean {
  return typeof process.getuid !== "function" || st.uid === process.getuid();
}

function privateDir(st: Stats): boolean {
  return st.isDirectory() && ownedBySelf(st) && (process.platform === "win32" || (st.mode & 0o077) === 0);
}

/**
 * Resolve the Bot's dataDir through the gateway's own resolver. Config errors
 * are reported by a fixed reason only: their messages may quote file content.
 */
export function resolveBotDataDir(botId: string, configPath?: string): string | ProvisionRefusal {
  let bots;
  try {
    bots = resolveBotConfigs(loadConfig(configPath));
  } catch {
    return "config_unavailable";
  }
  const bot = bots.find((b) => b.botId === botId);
  return bot ? bot.dataDir : "unknown_bot";
}

/** Resolve `botId` and provision its card provenance. Never throws. */
export function provisionBotCards(options: ProvisionOptions): ProvisionResult {
  const dataDir = resolveBotDataDir(options.botId, options.configPath);
  if (dataDir === "config_unavailable" || dataDir === "unknown_bot") return refused(dataDir);
  return provisionCardProvenance(dataDir, options);
}

/**
 * Write `installation-ref` and `activation.json` under an existing dataDir.
 * Never throws and never modifies a pre-existing provenance file.
 */
export function provisionCardProvenance(dataDir: string, options: ProvenanceOptions = {}): ProvisionResult {
  let ref: string;
  try {
    ref = (options.newRef ?? randomUUID)();
  } catch {
    return refused("invalid_ref");
  }
  if (!isSafeStoreRef(ref)) return refused("invalid_ref");
  let nowMs: number;
  try {
    nowMs = Math.trunc((options.nowMs ?? Date.now)());
  } catch {
    return refused("invalid_clock");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return refused("invalid_clock");

  const { cardsDir, installationRefPath, markerPath } = cardSubsystemPaths(dataDir);

  // ── checks: nothing is written until all pass ──
  let cardsExisted: boolean;
  try {
    const data = lstatOrNull(dataDir);
    if (data === null) return refused("data_dir_missing");
    // A symlinked dataDir is refused; only its owner may write it, so no other
    // user can swap the cards directory underneath this run.
    if (!data.isDirectory() || !ownedBySelf(data)) return refused("unsafe_path");
    if (process.platform !== "win32" && (data.mode & 0o022) !== 0) return refused("unsafe_path");
    const cards = lstatOrNull(cardsDir);
    if (cards !== null && !privateDir(cards)) return refused("unsafe_path");
    cardsExisted = cards !== null;
    if (cardsExisted && (lstatOrNull(installationRefPath) !== null || lstatOrNull(markerPath) !== null)) {
      return refused("already_provisioned");
    }
  } catch (err) {
    return refused(errCode(err) === "ENOTDIR" ? "data_dir_missing" : "unsafe_path");
  }

  // ── writes ──
  if (!cardsExisted) {
    try {
      mkdirSync(cardsDir, { mode: 0o700 });
    } catch (err) {
      return refused(errCode(err) === "EEXIST" ? "concurrent_writer" : "write_failed");
    }
    try {
      chmodSync(cardsDir, 0o700);
      if (!privateDir(lstatSync(cardsDir))) return refused("unsafe_path");
    } catch {
      return refused("write_failed");
    }
  }
  const dropCardsDir = (): void => {
    if (cardsExisted) return;
    try { rmdirSync(cardsDir); } catch { /* not empty or gone: leave it */ }
  };

  const tmp = join(cardsDir, `.installation-ref.${randomUUID()}.tmp`);
  let ours: { dev: number; ino: number };
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${ref}\n`);
      fsyncSync(fd);
      const st = fstatSync(fd);
      ours = { dev: st.dev, ino: st.ino };
    } finally {
      closeSync(fd);
    }
  } catch {
    try { unlinkSync(tmp); } catch { /* never created */ }
    dropCardsDir();
    return refused("write_failed");
  }
  try {
    linkSync(tmp, installationRefPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    if (errCode(err) === "EEXIST") return refused("concurrent_writer");
    dropCardsDir();
    return refused("write_failed");
  }
  try { unlinkSync(tmp); } catch { /* the published link keeps the data */ }

  const removeOwnRef = (): void => {
    try {
      const st = lstatSync(installationRefPath);
      if (st.dev === ours.dev && st.ino === ours.ino) unlinkSync(installationRefPath);
    } catch { /* gone or replaced: leave it */ }
  };
  try {
    provisionFirstInstallMarker(markerPath, ref, nowMs);
  } catch (err) {
    removeOwnRef();
    if (errCode(err) === "EEXIST") return refused("concurrent_writer");
    dropCardsDir();
    return refused("write_failed");
  }
  syncDir(cardsDir);

  // ── readback through the startup readers ──
  const refFile = readPrivateRegularFile(installationRefPath, MAX_REF_FILE_BYTES);
  const marker = new FileActivationMarker(markerPath).read();
  if (
    refFile.kind !== "ok" ||
    decodeStrictUtf8(refFile.bytes) !== `${ref}\n` ||
    marker.state !== "present" ||
    marker.marker.installationRef !== ref ||
    marker.marker.everActivated
  ) {
    return refused("readback_failed");
  }
  return Object.freeze({ kind: "provisioned", cardsDir });
}

function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms reject fsync on a directory handle; the link is still atomic.
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** Operator-facing line for a result. Fixed text: no reference, token or config content. */
export function describeProvisionResult(botId: string, result: ProvisionResult): string {
  if (result.kind === "provisioned") {
    return `provisioned card provenance for bot ${botId} in ${result.cardsDir}; restart the gateway to enable cards`;
  }
  switch (result.reason) {
    case "config_unavailable":
      return "cannot load the bot configuration; nothing was written";
    case "unknown_bot":
      return "unknown bot id; nothing was written";
    case "data_dir_missing":
      return "the bot's data directory does not exist yet (start the gateway once first); nothing was written";
    case "unsafe_path":
      return "the bot's data or cards directory is not a private directory owned by this user; nothing was written";
    case "already_provisioned":
      return "card provenance already exists for this bot; nothing was changed";
    case "invalid_ref":
      return "could not generate a valid installation reference; nothing was written";
    case "invalid_clock":
      return "the system clock is invalid; nothing was written";
    case "concurrent_writer":
      return "another writer created card provenance concurrently; its files were left untouched";
    case "write_failed":
      return "writing card provenance failed; any reference written by this run was removed";
    case "readback_failed":
      return "card provenance did not read back as written; inspect the cards directory before retrying";
  }
}
