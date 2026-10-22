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
BUSY_PROCESSES = 3000

# argv: <pidfile> <markerfile> <parentOnTerm: exit|ignore|die> <childOnTerm: exit|ignore|fork> <parentEnd: hang|exit>
#       [childEnv: inherit|stripped]
# `stripped` mirrors the Codex SDK, which replaces the CLI environment, so the child carries no attempt token.
# `fork` ignores TERM and then keeps forking detached TERM-ignoring grandchildren until killed (PIDs in <pidfile>.grandchildren),
# all with the child's environment, so teardown has to catch processes created while it runs.
FIXTURE = r"""
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidfile, marker, parentOnTerm, childOnTerm, parentEnd, childEnv = 'inherit'] = process.argv.slice(2);
const forkSource = "const { spawn } = require('node:child_process'); const fs = require('node:fs'); let n = 0;" +
  "process.on('SIGTERM', () => setInterval(() => { if (n++ >= 3000) return;" +
  " const g = spawn('sh', ['-c', 'trap \"\" TERM; exec sleep 600'], { detached: true, stdio: 'ignore', env: process.env });" +
  " fs.appendFileSync(process.argv[1], g.pid + '\\n'); }, 10)); setInterval(() => {}, 1000);";
const childSource = childOnTerm === 'fork' ? forkSource
  : childOnTerm === 'ignore' ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  : "setInterval(() => {}, 1000);";
const env = childEnv === 'stripped' ? { PATH: process.env.PATH } : process.env;
const child = spawn(process.execPath, ['-e', childSource, pidfile + '.grandchildren'], { detached: true, stdio: 'ignore', env });
fs.writeFileSync(pidfile + '.parent', String(process.pid));
fs.writeFileSync(pidfile, String(child.pid));
if (parentOnTerm === 'ignore') process.on('SIGTERM', () => {});
else if (parentOnTerm === 'die') process.on('SIGTERM', () => process.exit(143));
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


@unittest.skipUnless(sys.platform.startswith("linux") and NODE, "Linux process probe")
class SuperviseAttemptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="supervise-attempt-"))
        self.fixture = self.dir / "fixture.js"
        self.fixture.write_text(FIXTURE, encoding="utf-8")
        self.pidfile = self.dir / "child.pid"
        self.marker = self.dir / "term.marker"
        self.child = None

    def tearDown(self) -> None:
        # The probe owns its fixture: never leave it running, even when an assertion failed. Kill the
        # child first so that it cannot fork more grandchildren while they are collected.
        for pid in (self.child, self.parent()):
            if pid is not None and alive(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        time.sleep(0.1)
        for pid in self.grandchildren():
            if alive(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def grandchildren(self) -> list:
        path = Path(str(self.pidfile) + ".grandchildren")
        return [int(pid) for pid in path.read_text(encoding="utf-8").split()] if path.exists() else []

    def parent(self):
        path = Path(str(self.pidfile) + ".parent")
        return int(path.read_text(encoding="utf-8")) if path.exists() else None

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

    def test_tokenless_detached_child_of_an_immediately_exiting_command_is_reaped(self) -> None:
        # The command exits right after spawning, before any tree snapshot, so the child is
        # re-parented with no token and no remembered ancestry. Repeat to cover the race.
        for trial in range(3):
            with self.subTest(trial=trial):
                try:
                    result = self.run_attempt(20, 2, "exit", "ignore", "exit", "stripped")
                    self.assertIsNotNone(self.child)
                    self.assertFalse(alive(self.child), "a finished attempt left its tokenless detached child running")
                    self.assertEqual(result.returncode, 0, result.stderr)
                finally:
                    self.tearDown()
                    self.setUp()

    def test_tokenless_tree_that_forks_during_teardown_leaves_no_survivor(self) -> None:
        # The tokenless child ignores TERM and keeps forking TERM-ignoring grandchildren until it is
        # killed, so teardown races new processes. Unrelated idle processes make the process table
        # look like a busy runner, where every enumeration takes longer. When the supervisor returns,
        # no owned process may be running and none may appear afterwards.
        busy = [subprocess.Popen(["sleep", "600"]) for _ in range(BUSY_PROCESSES)]
        try:
            for trial in range(3):
                with self.subTest(trial=trial):
                    try:
                        result = self.run_attempt(20, 1, "exit", "fork", "exit", "stripped")
                        self.assertIsNotNone(self.child)
                        grandchildren = self.grandchildren()
                        self.assertTrue(grandchildren, "the child forked nothing during teardown")
                        survivors = [pid for pid in (self.child, *grandchildren) if alive(pid)]
                        self.assertEqual(survivors, [], f"teardown left processes running; supervisor exit={result.returncode}")
                        time.sleep(1)
                        self.assertEqual(self.grandchildren(), grandchildren, "processes were forked after the supervisor returned")
                        self.assertEqual(result.returncode, 0, result.stderr)
                    finally:
                        self.tearDown()
                        self.setUp()
        finally:
            for process in busy:
                process.kill()
                process.wait()

    def stuck_subreaper_supervisor(self) -> Path:
        # A copy of the supervisor next to a stand-in subreaper that runs the command, records its
        # status and then never exits.
        stub_dir = self.dir / "stub"
        stub_dir.mkdir(exist_ok=True)
        shutil.copy(SUPERVISOR, stub_dir / "supervise-attempt.sh")
        (stub_dir / "attempt_subreaper.py").write_text(
            "import os, signal, subprocess, sys, time\n"
            "os.setsid()\n"
            "for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, signal.SIG_IGN)\n"
            "status = subprocess.call(sys.argv[2:], preexec_fn=lambda: signal.signal(signal.SIGTERM, signal.SIG_DFL))\n"
            "open(sys.argv[1], 'w').write(f'{status}\\n')\n"
            "while True: time.sleep(1)\n",
            encoding="utf-8",
        )
        return stub_dir / "supervise-attempt.sh"

    def test_a_subreaper_that_cannot_exit_is_killed_and_reported(self) -> None:
        # The supervisor must not wait on a stuck subreaper forever or report the command's success.
        started = time.monotonic()
        result = subprocess.run(
            [str(self.stuck_subreaper_supervisor()), "20", "1", "--", "sh", "-c", "exit 0"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertIn("subreaper did not exit", result.stderr)
        self.assertLess(time.monotonic() - started, 5 + 5, "the stuck subreaper was not bounded by the reap budget")

    def test_a_reaping_failure_keeps_the_originating_failure_status(self) -> None:
        # The reaping failure is still reported, but the test's own failure stays the exit status.
        result = subprocess.run(
            [str(self.stuck_subreaper_supervisor()), "20", "1", "--", "sh", "-c", "exit 3"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("subreaper did not exit", result.stderr)

    def test_a_reaping_failure_after_the_deadline_keeps_the_timeout_status(self) -> None:
        # The detached child ignores TERM and the stand-in subreaper never exits, so teardown fails
        # after the deadline; the deadline must remain the reported cause.
        supervisor = self.stuck_subreaper_supervisor()
        result = subprocess.run(
            [str(supervisor), "2", "1", "--", NODE, str(self.fixture), str(self.pidfile), str(self.marker), "ignore", "ignore", "hang"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        if self.pidfile.exists():
            self.child = int(self.pidfile.read_text(encoding="utf-8"))
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn("subreaper did not exit", result.stderr)

    def test_each_attempt_gets_a_private_temp_dir_that_is_removed(self) -> None:
        receipt = self.dir / "tmpdirs"
        script = 'printf "%s %s %s\\n" "${TMPDIR:--}" "${TMP:--}" "${TEMP:--}" >> "$1"; touch "${TMPDIR:-.}/left-behind"'
        outer = os.path.realpath(tempfile.gettempdir())
        for _ in range(2):
            result = subprocess.run(
                [SUPERVISOR, "5", "1", "--", "sh", "-c", script, "sh", str(receipt)],
                capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        seen = [line.split() for line in receipt.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(seen), 2)
        for tmpdir, tmp, temp in seen:
            self.assertTrue(os.path.isabs(tmpdir), "the attempt has no private temp dir")
            self.assertEqual({tmpdir, tmp, temp}, {tmpdir}, "TMPDIR, TMP and TEMP differ")
            self.assertNotEqual(os.path.realpath(tmpdir), outer, "the attempt shares the runner's temp dir")
            self.assertFalse(Path(tmpdir).exists(), "the attempt's temp dir outlived the attempt")
        self.assertNotEqual(seen[0][0], seen[1][0], "consecutive attempts shared a temp dir")

    def test_a_timed_out_attempt_removes_its_temp_dir_after_teardown(self) -> None:
        receipt = self.dir / "tmpdir"
        script = 'printf "%s" "$TMPDIR" > "$1"; touch "$TMPDIR/in-use"; exec sleep 60'
        result = subprocess.run(
            [SUPERVISOR, "1", "1", "--", "sh", "-c", script, "sh", str(receipt)],
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertTrue(receipt.read_text(encoding="utf-8"))
        self.assertFalse(Path(receipt.read_text(encoding="utf-8")).exists(), "the timed-out attempt's temp dir survived")

    def test_deadline_reaps_a_tokenless_detached_child_whose_parent_dies_on_term(self) -> None:
        # The parent exits on the session TERM before forwarding it; the child was re-parented and has no token.
        result = self.run_attempt(2, 2, "die", "ignore", "hang", "stripped")
        self.assertIsNotNone(self.child)
        self.assertFalse(alive(self.child), "detached child without the attempt token survived the timed-out attempt")
        self.assertEqual(result.returncode, 124, result.stderr)

    def test_cancelling_the_supervisor_tears_down_the_attempt(self) -> None:
        # Output goes to a file: an orphaned command would hold a pipe open past the supervisor's exit.
        log = open(self.dir / "supervisor.log", "w+", encoding="utf-8")
        self.addCleanup(log.close)
        supervisor = subprocess.Popen(
            [SUPERVISOR, "60", "2", "--", NODE, str(self.fixture), str(self.pidfile), str(self.marker), "ignore", "ignore", "hang"],
            stdout=subprocess.DEVNULL, stderr=log,
        )
        try:
            deadline = time.monotonic() + 10
            while not self.pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(0.2)
            self.child = int(self.pidfile.read_text(encoding="utf-8"))
            started = time.monotonic()
            supervisor.send_signal(signal.SIGTERM)
            supervisor.wait(timeout=30)
            elapsed = time.monotonic() - started
            time.sleep(0.2)
        finally:
            if supervisor.poll() is None:
                supervisor.kill()
        self.assertFalse(alive(self.child), "cancelling the supervisor left the detached child running")
        self.assertFalse(alive(self.parent()), "cancelling the supervisor left the command running")
        log.seek(0)
        self.assertEqual(supervisor.returncode, 143, log.read())
        self.assertLess(elapsed, 2 + 5 + 3, "cancellation teardown exceeded its bounded budget")

    def test_command_status_is_preserved(self) -> None:
        result = subprocess.run([SUPERVISOR, "5", "1", "--", "sh", "-c", "exit 3"], capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 3, result.stderr)


if __name__ == "__main__":
    unittest.main()
