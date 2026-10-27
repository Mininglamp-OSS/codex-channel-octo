/**
 * The activation-marker reader never blocks and fails closed (S2-b).
 *
 * Right after the installation reference, card startup reads
 * `<dataDir>/cards/activation.json` through `FileActivationMarker.read()`. It
 * runs on the main thread while the Bot holds `gateway.lock`, so a FIFO with
 * no writer there must not stall `open(2)`. The marker is read with the same
 * fd-bound checks as the installation reference — no symlink, a private
 * regular file, at most `MAX_MARKER_BYTES` (4096, the marker's own parser
 * bound), a read that matches the file size, strict UTF-8 with a BOM kept and
 * therefore rejected — and every other outcome keeps its existing mapping:
 * missing is `absent`, anything else unreadable or malformed is `invalid`.
 *
 * The writerless FIFO runs in a real subprocess bounded by a timeout and a
 * SIGKILL, so a regression fails the test instead of hanging the suite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { unjammer } from "./fixtures/fifo-unjammer.js";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileActivationMarker, provisionFirstInstallMarker, serializeActivationMarker, type ActivationMarker } from "../cards/migrations.js";
import { cardSubsystemPaths } from "../cards/recovery.js";

const POSIX = process.platform !== "win32";
const VITE_NODE = join(dirname(createRequire(import.meta.url).resolve("vite-node/package.json")), "vite-node.mjs");
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "installation-ref-probe.ts");
/** Generous for a cold vite-node start on CI; a blocked open never finishes. */
const PROBE_TIMEOUT_MS = 30_000;
const MAX_MARKER_BYTES = 4096;

const VALID: ActivationMarker = Object.freeze({
  installationRef: "install-a", everActivated: false, schemaFamily: null, lineageId: null,
  backupRef: null, recoveryClearanceRef: null, updatedAt: Date.UTC(2026, 9, 22),
});

let dataDir: string;
let markerPath: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "s2b-marker-"));
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600 });
  chmodSync(p.installationRefPath, 0o600);
  markerPath = p.markerPath;
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

interface ProbeResult { readonly state: string; readonly reason?: string; readonly adapterTouched: boolean }

function probe(): { readonly result?: ProbeResult; readonly timedOut: boolean; readonly ms: number } {
  const started = Date.now();
  const r = spawnSync(process.execPath, [VITE_NODE, PROBE, dataDir], {
    cwd: dirname(dirname(dirname(PROBE))), encoding: "utf8", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const ms = Date.now() - started;
  const timedOut = r.signal === "SIGKILL" || (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const line = r.stdout?.trim().split("\n").pop();
  return { result: !timedOut && r.status === 0 && line ? JSON.parse(line) as ProbeResult : undefined, timedOut, ms };
}

function writeMarker(content: string | Buffer, mode = 0o600): void {
  writeFileSync(markerPath, content, { mode });
  chmodSync(markerPath, mode);
}

/** A valid marker padded with JSON whitespace to exactly `bytes` bytes. */
function paddedMarker(bytes: number): string {
  const text = serializeActivationMarker(VALID);
  return `${" ".repeat(bytes - Buffer.byteLength(text))}${text}`;
}

function read() {
  return new FileActivationMarker(markerPath).read();
}

function openFds(): number {
  return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
}

describe.runIf(POSIX)("a writerless FIFO marker in a real subprocess", () => {
  it("is rejected promptly as provenance_invalid", () => {
    execFileSync("mkfifo", ["-m", "600", markerPath]);
    const { result, timedOut, ms } = probe();
    expect(timedOut, `probe blocked for ${ms} ms`).toBe(false);
    expect(result).toMatchObject({ state: "disabled", reason: "provenance_invalid" });
  }, PROBE_TIMEOUT_MS + 10_000);

  it("positive control: a valid marker passes the reader in the same subprocess", () => {
    provisionFirstInstallMarker(markerPath, "install-a", Date.UTC(2026, 9, 22));
    const { result, timedOut } = probe();
    expect(timedOut).toBe(false);
    // The marker was accepted and startup went on to the (stub) database.
    expect(result?.adapterTouched).toBe(true);
    expect(result?.reason).not.toMatch(/^provenance_/);
  }, PROBE_TIMEOUT_MS + 10_000);
});

describe.runIf(POSIX)("in-process marker reads", () => {
  const invalid: [string, () => void][] = [
    ["a symlink to a valid marker", () => {
      const target = join(dataDir, "elsewhere.json");
      writeFileSync(target, serializeActivationMarker(VALID), { mode: 0o600 });
      symlinkSync(target, markerPath);
    }],
    ["a symlink to a character device", () => { symlinkSync("/dev/null", markerPath); }],
    ["a directory", () => { mkdirSync(markerPath, { mode: 0o700 }); }],
    ["an oversize file", () => { writeMarker(paddedMarker(MAX_MARKER_BYTES + 1)); }],
    ["a group/other readable file", () => { writeMarker(serializeActivationMarker(VALID), 0o640); }],
    ["a BOM-prefixed marker", () => { writeMarker(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serializeActivationMarker(VALID))])); }],
    ["invalid UTF-8", () => { writeMarker(Buffer.concat([Buffer.from(serializeActivationMarker(VALID).slice(0, -2)), Buffer.from([0xff, 0x7d, 0x0a])])); }],
    ["an empty file", () => { writeMarker(""); }],
    ["truncated JSON", () => { writeMarker('{"format":"cc-octo-card-activation"'); }],
    ["a marker with an extra key", () => { writeMarker(serializeActivationMarker(VALID).replace(/}\n$/, ',"x":1}\n')); }],
  ];

  it.each(invalid)("%s is invalid", (_name, arrange) => {
    arrange();
    expect(read()).toEqual({ state: "invalid" });
  });

  it("a writerless FIFO is invalid without blocking, and its fd is closed", async () => {
    execFileSync("mkfifo", ["-m", "600", markerPath]);
    // Bounds a regression in-process: a reader still blocked in open(2) after
    // the delay is released by a writer, and the test then fails.
    const guard = unjammer(markerPath);
    const first = read();
    expect(await guard.settle()).toBe("never_blocked");
    expect(first).toEqual({ state: "invalid" });
    const before = openFds();
    for (let i = 0; i < 20; i++) expect(read()).toEqual({ state: "invalid" });
    expect(openFds()).toBe(before);
  }, 20_000);

  it("a missing marker is absent", () => {
    expect(read()).toEqual({ state: "absent" });
  });

  it("positive control: a provisioned marker is present", () => {
    provisionFirstInstallMarker(markerPath, "install-a", Date.UTC(2026, 9, 22));
    expect(read()).toEqual({ state: "present", marker: VALID });
  });

  it("positive control: a marker of exactly the size bound is present", () => {
    writeMarker(paddedMarker(MAX_MARKER_BYTES));
    expect(read()).toEqual({ state: "present", marker: VALID });
  });

  it("positive control: a marker written by write() reads back", () => {
    const activated: ActivationMarker = { ...VALID, everActivated: true, schemaFamily: "card_v1", lineageId: "lineage-1", backupRef: "b.db" };
    new FileActivationMarker(markerPath).write(activated);
    expect(read()).toEqual({ state: "present", marker: activated });
  });

  it("closes the fd on every path", () => {
    const before = openFds();
    for (const [, arrange] of invalid) {
      rmSync(markerPath, { recursive: true, force: true });
      arrange();
      for (let i = 0; i < 20; i++) read();
    }
    rmSync(markerPath, { recursive: true, force: true });
    for (let i = 0; i < 20; i++) read();
    provisionFirstInstallMarker(markerPath, "install-a", Date.UTC(2026, 9, 22));
    for (let i = 0; i < 20; i++) read();
    expect(openFds()).toBe(before);
  });
});
