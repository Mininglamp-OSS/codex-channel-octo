"""Real process tests for the Linux CI supervisor; no provider/network calls."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).with_name('repeat-launcher.py')


@unittest.skipUnless(sys.platform == 'linux', 'Linux CI process semantics')
class SupervisorTests(unittest.TestCase):
    def invoke(self, code, *extra):
        return subprocess.run([sys.executable, str(RUNNER), '--attempts', '2', '--seconds', '1', '--grace', '.1', *extra, '--', sys.executable, '-c', code], text=True, capture_output=True, timeout=15)

    def test_success_repeats(self):
        result = self.invoke('print("synthetic pass", flush=True)')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count('exit=0'), 2)

    def test_adopted_zombie_is_reaped_without_false_failure(self):
        result = self.invoke('import os,subprocess,sys,time;subprocess.Popen([sys.executable,"-c","pass"]);time.sleep(.15);os._exit(0)')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count('exit=0'), 2)

    def test_failure_stops_before_next_attempt(self):
        result = self.invoke('raise SystemExit(7)')
        self.assertEqual(result.returncode, 7)
        self.assertNotIn('attempt 2/2', result.stdout)

    def test_timeout_reaps_detached_term_ignoring_descendant_and_tempdir(self):
        with tempfile.TemporaryDirectory() as evidence:
            receipt = Path(evidence) / 'receipt'
            code = f'''import os,signal,subprocess,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],start_new_session=True)
Path({str(receipt)!r}).write_text(str(child.pid)+'\\n'+os.environ['TMPDIR'])
print('synthetic hanging test started',flush=True)
time.sleep(60)
'''
            result = self.invoke(code)
            self.assertEqual(result.returncode, 124, result.stdout + result.stderr)
            self.assertIn('synthetic hanging test started', result.stdout)
            self.assertIn('exit=124', result.stdout)
            self.assertNotIn('attempt 2/2', result.stdout)
            pid, directory = receipt.read_text().splitlines()
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid), 0)
            self.assertFalse(Path(directory).exists())

    def test_success_with_leaked_child_fails_and_reaps_it(self):
        result = self.invoke('import subprocess,sys;subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],start_new_session=True)')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('left descendants', result.stdout)
        self.assertNotIn('attempt 2/2', result.stdout)

    def test_supervisor_term_cleans_and_returns_signal_status(self):
        with tempfile.TemporaryDirectory() as evidence:
            receipt = Path(evidence) / 'receipt'
            code = f'import os,time;from pathlib import Path;Path({str(receipt)!r}).write_text(str(os.getpid())+"\\n"+os.environ["TMPDIR"]);time.sleep(60)'
            child = subprocess.Popen([sys.executable, str(RUNNER), '--seconds', '5', '--grace', '.1', '--', sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                deadline = time.monotonic() + 5
                while not receipt.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(receipt.exists())
                child.send_signal(signal.SIGTERM)
                output, _ = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 143, output)
                pid, directory = receipt.read_text().splitlines()
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pid), 0)
                self.assertFalse(Path(directory).exists())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate()


if __name__ == '__main__':
    unittest.main()
