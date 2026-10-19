#!/usr/bin/env python3
"""Linux-only CI subreaper: bound tests and reap even detached descendants."""
import argparse
import ctypes
import os
import signal
import subprocess
import sys
import tempfile
import time


def children():
    """Only this supervisor's descendants; never scan/kill by command name."""
    found = []
    pending = [os.getpid()]
    while pending:
        parent = pending.pop()
        descendants = set()
        try:
            tasks = os.listdir(f'/proc/{parent}/task')
        except FileNotFoundError:
            continue
        for task in tasks:
            try:
                with open(f'/proc/{parent}/task/{task}/children', encoding='ascii') as stream:
                    descendants.update(int(pid) for pid in stream.read().split())
            except FileNotFoundError:
                continue
        found.extend(descendants)
        pending.extend(descendants)
    return found


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if not pid:
                return
        except ChildProcessError:
            return


def signal_children(sig):
    # pidfds bind the signal to the observed process, avoiding PID reuse races.
    # The parent relationship is rechecked after opening each handle.
    for pid in reversed(children()):
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            if pid in children():
                signal.pidfd_send_signal(fd, sig)
        except ProcessLookupError:
            pass
        finally:
            os.close(fd)


def cleanup(grace):
    signal_children(signal.SIGTERM)
    deadline = time.monotonic() + grace
    while children() and time.monotonic() < deadline:
        reap()
        time.sleep(0.02)
    # Subreaper adoption keeps orphaned detached children in our ownership tree.
    deadline = time.monotonic() + 3
    while children() and time.monotonic() < deadline:
        signal_children(signal.SIGKILL)
        reap()
        time.sleep(0.02)
    reap()
    return not children()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--attempts', type=int, default=20)
    parser.add_argument('--seconds', type=float, default=90)
    parser.add_argument('--grace', type=float, default=15)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not 1 <= args.attempts <= 20 or not 0 < args.seconds <= 90 or not 0 < args.grace <= 15 or not command:
        parser.error('invalid bounded execution options')
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        parser.error('Linux with pidfd support is required')
    # PR_SET_CHILD_SUBREAPER: adopted orphans remain waitable by this process.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'cannot enable child subreaper')
    interrupted = []
    def stop(sig, _frame):
        interrupted.append(sig)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    for attempt in range(1, args.attempts + 1):
        started = time.monotonic()
        status = 1
        with tempfile.TemporaryDirectory(prefix='launcher-attempt-') as temporary:
            env = dict(os.environ, TMPDIR=temporary, TMP=temporary, TEMP=temporary)
            print(f'Launcher attempt {attempt}/{args.attempts} start cap={args.seconds}s grace={args.grace}s', flush=True)
            try:
                child = subprocess.Popen(command, env=env, start_new_session=True)
                deadline = started + args.seconds
                while child.poll() is None and not interrupted and time.monotonic() < deadline:
                    time.sleep(0.02)
                if interrupted:
                    status = 128 + interrupted[0]
                elif child.poll() is None:
                    status = 124
                    print('Launcher timeout: sending TERM to owned process tree, then KILL after grace', flush=True)
                else:
                    status = child.returncode if child.returncode >= 0 else 128 - child.returncode
                # Reap through Popen first so waitpid cannot obscure its status.
                leaked = bool(children()) if child.poll() is not None else False
                clean = cleanup(args.grace)
                child.wait(timeout=1)
                if leaked and status == 0:
                    print('Launcher left descendants after exit; refusing a successful result', flush=True)
                    status = 1
                if not clean:
                    print('Launcher cleanup incomplete; refusing further attempts', flush=True)
                    status = 1
            except (OSError, subprocess.TimeoutExpired) as error:
                print(f'Launcher supervision failed: {type(error).__name__}', flush=True)
                cleanup(args.grace)
                status = 1
            print(f'Launcher attempt {attempt}/{args.attempts} exit={status} duration={time.monotonic()-started:.3f}s', flush=True)
        if status:
            return status
    return 0


if __name__ == '__main__':
    sys.exit(main())
