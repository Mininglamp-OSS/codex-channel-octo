"""Linux process probes for scripts/supervise-attempt.sh (the CI launcher repeat lane).

Each fixture mirrors the JSONL proxy: a parent that starts a child in a detached
session. A timed-out or finished attempt must leave no owned process running.
Set SUPERVISE_ATTEMPT to probe another launcher with the same arguments.
"""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SUPERVISOR = os.environ.get("SUPERVISE_ATTEMPT", str(ROOT / "supervise-attempt.sh"))
NODE = shutil.which("node")

# argv: <pidfile> <markerfile> <parentOnTerm: exit|ignore> <childOnTerm: exit|ignore> <parentEnd: hang|exit>
FIXTURE = r"""
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidfile, marker, parentOnTerm, childOnTerm, parentEnd] = process.argv.slice(2);
const childSource = childOnTerm === 'ignore'
  ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  : "setInterval(() => {}, 1000);";
const child = spawn(process.execPath, ['-e', childSource], { detached: true, stdio: 'ignore' });
fs.writeFileSync(pidfile, String(child.pid));
if (parentOnTerm === 'ignore') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => {
  fs.writeFileSync(marker, 'term');
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => process.exit(143), 100);
});
if (parentEnd === 'exit') { child.unref(); process.exit(0); }
setInterval(() => {}, 1000);
"""


def alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as stat:
            return stat.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (FileNotFoundError, ProcessLookupError, IndexError):
        return False


@unittest.skipUnless(sys.platform.startswith("linux") and NODE and shutil.which("setsid"), "Linux process probe")
class SuperviseAttemptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="supervise-attempt-"))
        self.fixture = self.dir / "fixture.js"
        self.fixture.write_text(FIXTURE, encoding="utf-8")
        self.pidfile = self.dir / "child.pid"
        self.marker = self.dir / "term.marker"
        self.child = None

    def tearDown(self) -> None:
        # The probe owns its fixture: never leave it running, even when an assertion failed.
        if self.child is not None and alive(self.child):
            try:
                os.kill(self.child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_attempt(self, deadline: int, grace: int, *flags: str) -> subprocess.CompletedProcess:
        started = time.monotonic()
        result = subprocess.run(
            [SUPERVISOR, str(deadline), str(grace), "--", NODE, str(self.fixture), str(self.pidfile), str(self.marker), *flags],
            capture_output=True, text=True, timeout=deadline + grace + 30, check=False,
        )
        self.elapsed = time.monotonic() - started
        if self.pidfile.exists():
            self.child = int(self.pidfile.read_text(encoding="utf-8"))
        return result

    def test_deadline_terms_first_so_handlers_tear_down_the_detached_child(self) -> None:
        result = self.run_attempt(2, 5, "exit", "exit", "hang")
        self.assertIsNotNone(self.child)
        self.assertFalse(alive(self.child), "detached child survived the timed-out attempt")
        self.assertTrue(self.marker.exists(), "TERM handlers did not run before the attempt was killed")
        self.assertEqual(result.returncode, 124, result.stderr)

    def test_deadline_kills_and_reaps_a_detached_child_that_ignores_term(self) -> None:
        result = self.run_attempt(2, 2, "ignore", "ignore", "hang")
        self.assertIsNotNone(self.child)
        self.assertFalse(alive(self.child), "detached child survived the timed-out attempt")
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertLess(self.elapsed, 2 + 2 + 5 + 3, "teardown exceeded its bounded budget")

    def test_detached_child_left_by_a_finished_attempt_is_reaped(self) -> None:
        result = self.run_attempt(20, 2, "exit", "ignore", "exit")
        self.assertIsNotNone(self.child)
        self.assertFalse(alive(self.child), "a finished attempt left its detached child running")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_command_status_is_preserved(self) -> None:
        result = subprocess.run([SUPERVISOR, "5", "1", "--", "sh", "-c", "exit 3"], capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 3, result.stderr)


if __name__ == "__main__":
    unittest.main()
