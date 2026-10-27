/**
 * The installation-reference reader never blocks and fails closed (S2).
 *
 * `<dataDir>/cards/installation-ref` is opened `O_NOFOLLOW | O_NONBLOCK`, so a
 * FIFO with no writer cannot stall `open(2)`; the opened fd must then be a
 * private regular file, read with a bound, whose byte count matches its size.
 * `O_NONBLOCK` alone is not the guard: a FIFO, directory or device that opens
 * is still rejected by the fd check. Every rejection happens before any
 * database access, and the fd is closed on every path.
 *
 * The writerless FIFO runs in a real subprocess bounded by a timeout and a
 * SIGKILL, so a regression fails the test instead of hanging the suite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbAdapter } from "../db-adapter.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import { createAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";

const POSIX = process.platform !== "win32";
const VITE_NODE = join(dirname(createRequire(import.meta.url).resolve("vite-node/package.json")), "vite-node.mjs");
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "installation-ref-probe.ts");
/** Generous for a cold vite-node start on CI; a blocked open never finishes. */
const PROBE_TIMEOUT_MS = 30_000;

let dataDir: string;
let refPath: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "s2-ref-"));
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { mode: 0o700 });
  refPath = p.installationRefPath;
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

/** An adapter whose first use throws: a rejected reference must not reach the database. */
function untouchable(): { readonly adapter: DbAdapter; readonly touched: () => boolean } {
  let touched = false;
  const adapter = new Proxy({}, { get() { touched = true; throw new Error("adapter touched"); } }) as DbAdapter;
  return { adapter, touched: () => touched };
}

async function open(adapter: DbAdapter) {
  return openCardSubsystem({ adapter, dataDir, runtimeIncarnation: "test", clock: { nowUtcMs: () => Date.now() } });
}

function writeRef(content: string | Buffer, mode = 0o600): void {
  writeFileSync(refPath, content, { mode });
  chmodSync(refPath, mode);
}

function openFds(): number {
  return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
}

describe.runIf(POSIX)("a writerless FIFO in a real subprocess", () => {
  it("is rejected promptly as provenance_invalid without touching the database", () => {
    execFileSync("mkfifo", ["-m", "600", refPath]);
    const { result, timedOut, ms } = probe();
    expect(timedOut, `probe blocked for ${ms} ms`).toBe(false);
    expect(result).toEqual({ state: "disabled", reason: "provenance_invalid", adapterTouched: false });
  }, PROBE_TIMEOUT_MS + 10_000);

  it("positive control: a valid regular file passes the reader in the same subprocess", () => {
    writeRef("install-a\n");
    provisionFirstInstallMarker(cardSubsystemPaths(dataDir).markerPath, "install-a", Date.UTC(2026, 9, 22));
    const { result, timedOut } = probe();
    expect(timedOut).toBe(false);
    // The reader accepted the reference and startup went on to the (stub) database.
    expect(result?.adapterTouched).toBe(true);
    expect(result?.reason).not.toMatch(/^provenance_/);
  }, PROBE_TIMEOUT_MS + 10_000);
});

describe.runIf(POSIX)("in-process fail-closed cases", () => {
  const invalid: [string, () => void][] = [
    ["a symlink to a valid reference", () => {
      const target = join(dataDir, "elsewhere");
      writeFileSync(target, "install-a\n", { mode: 0o600 });
      symlinkSync(target, refPath);
    }],
    ["a symlink to a character device", () => { symlinkSync("/dev/null", refPath); }],
    ["a directory", () => { mkdirSync(refPath, { mode: 0o700 }); }],
    ["an oversize file", () => { writeRef(`${"a".repeat(2048)}\n`); }],
    ["a group/other readable file", () => { writeRef("install-a\n", 0o644); }],
    ["an empty file", () => { writeRef(""); }],
    ["two lines", () => { writeRef("install-a\ninstall-b\n"); }],
    ["an unsafe reference", () => { writeRef("../escape\n"); }],
    ["invalid UTF-8", () => { writeRef(Buffer.from([0x69, 0xff, 0xfe, 0x0a])); }],
    ["a BOM-prefixed reference", () => { writeRef(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("install-a\n")])); }],
  ];

  it.each(invalid)("%s is provenance_invalid before any database access", async (_name, arrange) => {
    arrange();
    const { adapter, touched } = untouchable();
    await expect(open(adapter)).resolves.toMatchObject({ state: "disabled", reason: "provenance_invalid" });
    expect(touched()).toBe(false);
  });

  it("a missing file is provenance_missing before any database access", async () => {
    const { adapter, touched } = untouchable();
    await expect(open(adapter)).resolves.toMatchObject({ state: "disabled", reason: "provenance_missing" });
    expect(touched()).toBe(false);
  });

  it("closes the fd on every rejection path", async () => {
    const before = openFds();
    for (const [, arrange] of invalid) {
      rmSync(refPath, { recursive: true, force: true });
      arrange();
      for (let i = 0; i < 20; i++) await open(untouchable().adapter);
    }
    rmSync(refPath, { recursive: true, force: true });
    for (let i = 0; i < 20; i++) await open(untouchable().adapter);
    expect(openFds()).toBe(before);
  });

  it("positive control: a valid regular file opens the real card store", async () => {
    writeRef("install-a\n");
    provisionFirstInstallMarker(cardSubsystemPaths(dataDir).markerPath, "install-a", Date.UTC(2026, 9, 22));
    const adapter = createAdapter(join(dataDir, "cc-octo.db"));
    new SessionStore(adapter).init();
    const before = openFds();
    const sub = await open(adapter);
    expect(sub.state).toBe("ready");
    if (sub.state === "ready") { expect(sub.meta.installationRef).toBe("install-a"); sub.store.retire(); }
    expect(openFds()).toBe(before);
    adapter.close();
  });
});
