/**
 * Bounded, non-blocking read of a small private provenance file (S2, S2-b).
 *
 * Card startup reads `<dataDir>/cards/installation-ref` and
 * `<dataDir>/cards/activation.json` on the main thread while the Bot holds its
 * lock. The open is `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` (where supported), so
 * neither a symlink nor a FIFO with no writer nor a terminal can stall or
 * redirect it; that alone is not the guard. The `fstat` of the opened fd —
 * never a separate `lstat`, so there is no check/open race — must show a
 * regular file, not group/other accessible (POSIX), within `maxBytes`, and the
 * bounded read must match that same file's size. The fd is closed on every path.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export type PrivateFileRead =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

const OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

export function readPrivateRegularFile(path: string, maxBytes: number): PrivateFileRead {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return { kind: "invalid" };
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return { kind: "invalid" };
    const buf = Buffer.alloc(maxBytes + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > maxBytes) return { kind: "invalid" };
    }
    if (len !== st.size) return { kind: "invalid" };
    return { kind: "ok", bytes: buf.subarray(0, len) };
  } catch {
    return { kind: "invalid" };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Strict UTF-8: malformed bytes fail, and a leading BOM is kept (so it fails
 * the caller's own format check) rather than silently stripped.
 */
export function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
