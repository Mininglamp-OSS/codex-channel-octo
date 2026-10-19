"""Collect two-profile, gateway, crash and cleanup evidence without any Octo/model call."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from test_profile import Profile, control, cleanup


def wait_status(base, name):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with Profile(base, name) as p:
            status = control(p, 'status')
            if status.get('initialized'):
                return status
        time.sleep(0.05)
    raise AssertionError('Profile startup timed out')


def alive(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith('Z')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    digest = hashlib.sha256(args.codex.read_bytes()).hexdigest()
    launcher = str(Path(__file__).with_name('test_profile.py').resolve())
    entry = Path(__file__).resolve().parent.parent / 'dist/index.js'
    evidence = {'version': '0.142.3', 'executable': str(args.codex), 'sha256': digest, 'profiles': [], 'sharedServiceActions': []}
    jobs = []
    with tempfile.TemporaryDirectory(prefix='env02-') as tmp:
        base = Path(tmp).resolve()
        def start(name, gateway=False):
            command = [sys.executable, launcher, 'start', '--base', str(base), '--profile', name,
                       '--codex', str(args.codex), '--sha256', digest, '--seconds', '30']
            if gateway:
                with Profile(base, name) as p:
                    p.write('gateway.json', json.dumps({'apiUrl': 'https://example.com', 'bots': []}).encode())
                command.extend(['--gateway-entry', str(entry), '--node', str(args.node)])
            job = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            jobs.append(job)
            return job
        try:
            a, b = start('test-a'), start('test-b')
            sa, sb = wait_status(base, 'test-a'), wait_status(base, 'test-b')
            assert sa['pid'] != sb['pid']
            with Profile(base, 'test-a') as p:
                try:
                    cleanup(p)
                    raise AssertionError('Live cleanup accepted')
                except BlockingIOError:
                    pass
                control(p, 'stop')
            out_a, err_a = a.communicate(timeout=10)
            assert a.returncode == 0 and not err_a, (out_a, err_a)
            with Profile(base, 'test-b') as p:
                assert control(p, 'status')['state'] == 'running'
                control(p, 'stop')
            out_b, err_b = b.communicate(timeout=10)
            assert b.returncode == 0 and not err_b, (out_b, err_b)
            evidence['profiles'] = [{'status': sa, 'result': json.loads(out_a)}, {'status': sb, 'result': json.loads(out_b)}]
            evidence['secondProfileUnaffected'] = True
            gateway = start('test-gateway', True)
            sg = wait_status(base, 'test-gateway')
            with Profile(base, 'test-gateway') as p:
                control(p, 'stop')
            out, err = gateway.communicate(timeout=10)
            assert gateway.returncode == 0 and not err, (out, err)
            evidence['gateway'] = {'status': sg, 'result': json.loads(out)}
            crashed = start('test-crash')
            sc = wait_status(base, 'test-crash')
            with Profile(base, 'test-crash') as p:
                state = json.loads(p.read('state.json'))
            crashed.kill()  # Only the process created by this test, never a saved PID.
            crashed.communicate(timeout=10)
            deadline = time.monotonic() + 8
            while (alive(state['pid']) or alive(state['childPid'])) and time.monotonic() < deadline:
                time.sleep(0.1)
            assert not alive(state['pid']), 'Orphan guardian survived supervisor crash'
            assert not alive(state['childPid']), 'Orphan Codex survived supervisor crash'
            with Profile(base, 'test-crash') as p:
                assert control(p, 'status')['state'] == 'stale'
                cleanup(p)
            evidence['crash'] = {'status': sc, 'guardianExited': True, 'childExited': True, 'staleStateCleaned': True}
            for name in ['test-a', 'test-b', 'test-gateway', 'test-crash']:
                with Profile(base, name) as p:
                    assert control(p, 'status')['state'] == 'stopped'
                    cleanup(p)
                    assert not (p.root / 'control.sock').exists()
                    assert not (p.root / 'state.json').exists()
            evidence['cleanup'] = {'allCollected': True, 'liveProfiles': 0, 'temporaryRootsRemovedOnExit': True}
        finally:
            for job in jobs:
                if job.poll() is None:
                    job.terminate()
                    job.communicate(timeout=10)
    args.output.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Two profiles, pinned initialization, gateway, crash cleanup and stale state: PASS')


if __name__ == '__main__':
    main()
