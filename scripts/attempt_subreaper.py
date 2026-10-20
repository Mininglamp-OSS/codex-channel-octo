"""Runs one CI attempt as a Linux child subreaper for scripts/supervise-attempt.sh.

  attempt_subreaper.py <status-file> <command> [args...]

Starts a new session, marks itself PR_SET_CHILD_SUBREAPER and runs the command
as its child. A descendant orphaned inside the attempt, including a detached
child with a replaced environment whose parent already exited, is re-parented
here instead of to init, so the supervisor keeps finding it by parent link.
When the command exits, its status is written to <status-file>; adopted
descendants are then reaped as they exit, and this process exits with the
command's status once none remain. TERM, INT and HUP are left to the
supervisor's teardown; the command itself gets the default dispositions.
"""

import ctypes
import os
import signal
import sys

PR_SET_CHILD_SUBREAPER = 36


def write_status(path: str, status: int) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as out:
        out.write(f"{status}\n")
    os.replace(tmp, path)


def main(argv: list) -> int:
    if len(argv) < 3:
        print(f"usage: {argv[0]} <status-file> <command> [args...]", file=sys.stderr)
        return 2
    status_file, command = argv[1], argv[2:]

    os.setsid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        print(f"attempt_subreaper: prctl(PR_SET_CHILD_SUBREAPER): {os.strerror(ctypes.get_errno())}", file=sys.stderr)
        return 2

    # Python handlers (unlike SIG_IGN) are reset to the default on exec.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: None)

    try:
        leader = os.posix_spawnp(command[0], command, os.environ)
    except OSError as error:
        print(f"attempt_subreaper: {command[0]}: {error.strerror}", file=sys.stderr)
        status = 127 if isinstance(error, FileNotFoundError) else 126
        write_status(status_file, status)
        return status

    status = None
    while True:
        try:
            pid, raw = os.wait()
        except ChildProcessError:
            break
        if pid == leader:
            code = os.waitstatus_to_exitcode(raw)
            status = 128 - code if code < 0 else code
            write_status(status_file, status)
    return 125 if status is None else status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
