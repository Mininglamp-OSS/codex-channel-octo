"""Profile-owned process group, stopped on parent pipe EOF, death or deadline."""
import json
import os
import selectors
import signal
import subprocess
import sys
import time


def main():
    descriptors = tuple(int(os.environ[k]) for k in ['ENV02_MANIFEST_FD', 'ENV02_TOKEN_FD', 'ENV02_EVIDENCE_FD'] if k in os.environ)
    child = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, start_new_session=True, pass_fds=descriptors)
    print(json.dumps({'env02ChildPid': child.pid}), flush=True)
    stop = False
    def terminate(*_):
        nonlocal stop
        stop = True
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, terminate)
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ)
    deadline = time.monotonic() + 310
    try:
        while child.poll() is None and not stop and time.monotonic() < deadline:
            for _, _ in selector.select(0.1):
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    stop = True
                    break
                try:
                    child.stdin.write(data)
                    child.stdin.flush()
                except BrokenPipeError:
                    stop = True
                    break
    finally:
        selector.close()
        child.stdin.close()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        # A gateway may have left descendants after its own graceful exit.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return child.returncode


if __name__ == '__main__':
    raise SystemExit(main())
