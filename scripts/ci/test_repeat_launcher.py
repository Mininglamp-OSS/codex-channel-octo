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
        result = self.invoke('import os,subprocess,sys,time;child=subprocess.Popen([sys.executable,"-c","pass"]);os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT);os._exit(0)')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count('exit=0'), 2)

    def test_bounded_natural_descendant_teardown_is_not_a_leak(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = str(Path(directory) / 'natural')
            inner = f'from pathlib import Path;import time;time.sleep(.4);Path({receipt!r}).write_text("done")'
            result = self.invoke(f'import subprocess,sys;subprocess.Popen([sys.executable,"-c",{inner!r}],start_new_session=True)')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(Path(receipt).exists())

    def test_inter_attempt_cancellation_prevents_another_spawn(self):
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=sig), tempfile.TemporaryDirectory() as directory:
                receipt = str(Path(directory) / 'launches')
                command = f'from pathlib import Path;p=Path({receipt!r});p.write_text(p.read_text()+"x" if p.exists() else "x")'
                bootstrap = f"""import runpy,tempfile,os,signal,sys
namespace=runpy.run_path({str(RUNNER)!r})
original=tempfile.TemporaryDirectory
class CancelBetween(original):
 def __exit__(self,*args):
  result=super().__exit__(*args)
  os.kill(os.getpid(),{int(sig)})
  return result
tempfile.TemporaryDirectory=CancelBetween
sys.argv=['supervisor','--attempts','2','--seconds','5','--grace','.1','--',sys.executable,'-c',{command!r}]
sys.exit(namespace['main']())
"""
                result = subprocess.run([sys.executable, '-c', bootstrap], capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 128 + sig, result.stdout + result.stderr)
                self.assertEqual(Path(receipt).read_text(), 'x')
                self.assertNotIn('attempt 2/2', result.stdout)

    def test_cancellation_during_attempt_preparation_prevents_spawn(self):
        bootstrap = f"""import runpy,builtins,os,signal,sys
namespace=runpy.run_path({str(RUNNER)!r})
original_spawn=namespace['subprocess'].Popen
def tracked_spawn(*args,**kwargs):
 builtins.print('UNEXPECTED_SPAWN',flush=True)
 return original_spawn(*args,**kwargs)
namespace['subprocess'].Popen=tracked_spawn
original=builtins.print
def cancel(*args,**kwargs):
 original(*args,**kwargs)
 if args and ' start cap=' in str(args[0]):os.kill(os.getpid(),signal.SIGTERM)
builtins.print=cancel
sys.argv=['supervisor','--attempts','2','--',sys.executable,'-c','raise SystemExit(99)']
sys.exit(namespace['main']())
"""
        result = subprocess.run([sys.executable, '-c', bootstrap], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 143, result.stdout + result.stderr)
        self.assertNotIn('UNEXPECTED_SPAWN', result.stdout)

    def test_cleanup_warning_preserves_original_failure_code(self):
        bootstrap = f"""import runpy,sys
namespace=runpy.run_path({str(RUNNER)!r})
original=namespace['cleanup']
def reported_incomplete(grace):
 original(grace)
 return False
namespace['main'].__globals__['cleanup']=reported_incomplete
sys.argv=['supervisor','--attempts','2','--',sys.executable,'-c','raise SystemExit(7)']
sys.exit(namespace['main']())
"""
        result = subprocess.run([sys.executable, '-c', bootstrap], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertIn('cleanup incomplete', result.stdout)

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
            child = subprocess.Popen([sys.executable, str(RUNNER), '--seconds', '30', '--grace', '.1', '--', sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
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
