/**
 * Bounds a FIFO read regression in-process. A child process waits, then opens
 * the FIFO for writing with `O_NONBLOCK`: that open succeeds only while some
 * reader is blocked in `open(2)` (the write side then releases it, the reader
 * sees EOF and the test can fail instead of hanging); with no reader it fails
 * with ENXIO. `settle()` stops the child once the caller is done, so a passing
 * run does not wait for the delay, and still reads anything it already wrote.
 */

import { spawn } from "node:child_process";

export type UnjamOutcome = "never_blocked" | "reader_was_blocked";

const SCRIPT = `
const fs = require("node:fs");
setTimeout(() => {
  try {
    const fd = fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    process.stdout.write("reader_was_blocked");
    // Hold the write side until the blocked reader has woken; closing at once can leave it asleep.
    setTimeout(() => fs.closeSync(fd), 500);
  } catch {
    process.stdout.write("never_blocked");
  }
}, Number(process.argv[2]));
`;

export function unjammer(fifoPath: string, delayMs = 3_000): { settle(): Promise<UnjamOutcome> } {
  const child = spawn(process.execPath, ["-e", SCRIPT, fifoPath, String(delayMs)], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
  const drained = new Promise<void>((resolve) => { child.stdout.once("close", () => resolve()); });
  return {
    async settle(): Promise<UnjamOutcome> {
      // Harmless once the child has exited; anything it wrote is still read from the pipe.
      child.kill("SIGKILL");
      await drained;
      return out === "reader_was_blocked" ? "reader_was_blocked" : "never_blocked";
    },
  };
}
