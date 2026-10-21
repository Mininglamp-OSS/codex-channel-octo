#!/usr/bin/env bash
# Runs one CI attempt under a deadline and owns its whole process tree.
#
#   scripts/supervise-attempt.sh <deadline-s> <grace-s> -- <command> [args...]
#
# The command runs in its own session under scripts/attempt_subreaper.py, a
# child subreaper: a descendant whose parent exits is re-parented to it rather
# than to init, so the whole attempt stays reachable by parent link from the
# session leader until it has been torn down. Every process the command starts
# also inherits an attempt token in its environment, which survives `detached`
# spawns that leave the session (the JSONL proxy starts its CLI that way). On the
# deadline the supervisor sends TERM to every owned process so termination
# handlers run and waits up to <grace-s>. It then stops (SIGSTOP) every owned
# process until a round finds none it had not already seen stopped, so the
# tree cannot fork any more, KILLs it and waits until no owned process is left.
# The subreaper is left alive meanwhile so nothing escapes to init; it exits
# once its last child is gone and is killed only as a last resort (125). Owned processes left
# behind by a command that exits on its own, and the attempt itself when the
# supervisor is cancelled (TERM/INT/HUP), are torn down the same way.
#
# A child spawned with a replaced environment (the Codex SDK does this) has
# no token; it stays owned through the subreaper even when its parent exits
# before any snapshot. The tree is also snapshotted while the attempt runs and
# before any signal is sent. Remembered processes are matched by PID and
# start time, never PID alone.
#
# Exit status: the command's status; 124 on the deadline; 125 if an owned
# process could not be reaped; 128+N when the supervisor got signal N.
set -u

if [ "$#" -lt 4 ] || [ "$3" != "--" ]; then
  echo "usage: $0 <deadline-s> <grace-s> -- <command> [args...]" >&2
  exit 2
fi
deadline=$1
grace=$2
shift 3

token="$$-$(date +%s)-${RANDOM}${RANDOM}"
reap_wait=5
subreaper="$(dirname "$0")/attempt_subreaper.py"
status_file=$(mktemp) || exit 2
trap 'rm -f "$status_file"' EXIT

# Sets pi_state and pi_start for a live PID (fields 3 and 22 of
# /proc/<pid>/stat, parsed after the last ")" so a comm with spaces is safe).
# Builtins only, so enumeration cost does not grow with forks per process.
proc_info() {
  local stat
  { read -r stat < "/proc/$1/stat"; } 2>/dev/null || return 1
  # shellcheck disable=SC2086 # split the stat fields on purpose
  set -- ${stat##*) }
  pi_state=$1
  pi_start=${20}
}

# Remembered owned processes as " pid:start-time " entries.
tracked=" "

remember() {
  local pid
  for pid in "$@"; do
    case "$tracked" in *" $pid:"*) continue ;; esac
    proc_info "$pid" || continue
    [ "$pi_state" = "Z" ] && continue
    tracked+="$pid:$pi_start "
  done
}

# The session's current descendants by parent link, from one process-table
# snapshot.
tree() {
  [ -n "${leader:-}" ] || return 0
  ps -e -o pid= -o ppid= 2>/dev/null | awk -v root="$leader" '
    { kids[$2] = kids[$2] " " $1 }
    END {
      q[1] = root; seen[root] = 1; n = 1
      for (i = 1; i <= n; i++) {
        m = split(kids[q[i]], c, " ")
        for (j = 1; j <= m; j++) if (!(c[j] in seen)) { seen[c[j]] = 1; q[++n] = c[j] }
      }
      for (i = 1; i <= n; i++) print q[i]
    }'
}

# Every process carrying the attempt token, including orphans, in one pass.
tokened() {
  local env pid
  while read -r env; do
    pid=${env#/proc/}; pid=${pid%/environ}
    [ "$pid" = "$$" ] || printf '%s\n' "$pid"
  done < <(grep -lzxF "CODEX_CI_ATTEMPT=$token" /proc/[0-9]*/environ 2>/dev/null)
}

# Sets owned_pids to the owned processes other than the subreaper session
# leader that are still running: the current tree, token carriers and every
# remembered process whose start time still matches. Newly found processes
# are remembered. Zombies have already exited; only their parent can collect
# them. The subreaper is never signalled while it may still adopt descendants.
collect_owned() {
  # shellcheck disable=SC2046 # PIDs are plain integers
  remember $(tree) $(tokened)
  local entry pid
  owned_pids=
  for entry in $tracked; do
    pid=${entry%%:*}
    [ "$pid" = "$leader" ] && continue
    proc_info "$pid" || continue
    [ "$pi_state" = "Z" ] && continue
    [ "$pi_start" = "${entry#*:}" ] && owned_pids+="$pid "
  done
}

# True while the subreaper session leader (matched by start time) is running.
leader_alive() {
  [ -n "${leader_start:-}" ] || return 1
  proc_info "$leader" || return 1
  [ "$pi_state" != "Z" ] && [ "$pi_start" = "$leader_start" ]
}

signal_owned() {
  local p
  collect_owned
  for p in $owned_pids; do kill "-$1" "$p" 2>/dev/null; done
}

# Waits until second $1 for every owned process to exit; 0 when none remain.
await_owned() {
  while :; do
    collect_owned
    [ -z "$owned_pids" ] && return 0
    [ "$SECONDS" -ge "$1" ] && return 1
    sleep 0.2
  done
}

# Stops every owned process until second $1, so nothing owned can fork any
# more; 0 once quiesced. A round counts as quiescent only when every process
# it enumerates had already been seen stopped before that round's snapshot:
# such a process cannot have forked since, so the snapshot holds every child
# it ever made. Any other process is stopped and forces another round.
freeze_owned() {
  local stopped=" " seen_stopped p quiet
  while :; do
    collect_owned
    seen_stopped=$stopped
    quiet=1
    for p in $owned_pids; do
      proc_info "$p" || continue
      case "$seen_stopped" in *" $p:$pi_start "*) continue ;; esac
      quiet=0
      if [ "$pi_state" = "T" ] || [ "$pi_state" = "t" ]; then
        stopped+="$p:$pi_start "
      else
        kill -STOP "$p" 2>/dev/null
      fi
    done
    [ "$quiet" -eq 1 ] && return 0
    [ "$SECONDS" -ge "$1" ] && return 1
  done
}

# Waits until second $1 for the subreaper to exit on its own.
await_leader() {
  while leader_alive; do
    [ "$SECONDS" -ge "$1" ] && return 1
    sleep 0.2
  done
  return 0
}

# TERM to every owned process and <grace-s> for termination handlers. Then,
# within $reap_wait seconds, freeze the remaining tree so it cannot fork
# during teardown, KILL every frozen process and wait until none is left.
# The subreaper exits by itself once it has no children left; it is killed
# only as a last resort. That, like an owned process that could not be
# frozen or reaped, is a failure (125), never a success.
teardown() {
  local reap_until failed=0
  signal_owned TERM
  if ! await_owned $((SECONDS + grace)); then
    collect_owned
    echo "supervise-attempt: owned processes still running after ${grace}s TERM grace: ${owned_pids}" >&2
    reap_until=$((SECONDS + reap_wait))
    if ! freeze_owned "$reap_until"; then
      echo "supervise-attempt: owned processes kept forking past the reap window" >&2
      failed=1
    fi
    # Frozen processes cannot fork, so one KILL pass covers the whole tree;
    # anything still found while waiting is killed again.
    while :; do
      signal_owned KILL
      [ -z "$owned_pids" ] && break
      if [ "$SECONDS" -ge "$reap_until" ]; then
        echo "supervise-attempt: could not reap owned processes: ${owned_pids}" >&2
        failed=1
        break
      fi
      sleep 0.2
    done
  fi
  [ -n "${reap_until:-}" ] || reap_until=$((SECONDS + reap_wait))
  if [ "$failed" -eq 1 ] || ! await_leader "$reap_until"; then
    if leader_alive; then
      echo "supervise-attempt: attempt subreaper did not exit; killing it" >&2
      kill -KILL "$leader" 2>/dev/null
      failed=1
    fi
  fi
  return "$failed"
}

# shellcheck disable=SC2317,SC2329 # invoked by the traps below
cancel() {
  trap '' TERM INT HUP
  echo "supervise-attempt: cancelled by signal $1; terminating the attempt" >&2
  if [ -n "${leader:-}" ]; then
    teardown
    wait "$leader" 2>/dev/null
  fi
  exit $((128 + $1))
}
trap 'cancel 15' TERM
trap 'cancel 2' INT
trap 'cancel 1' HUP

# The subreaper leads the session and exits only once the command and every
# descendant it adopted are gone; it records the command's status first.
CODEX_CI_ATTEMPT=$token python3 "$subreaper" "$status_file" "$@" &
leader=$!
leader_start=
proc_info "$leader" && leader_start=$pi_start

status=
end=$((SECONDS + deadline))
while kill -0 "$leader" 2>/dev/null && [ ! -s "$status_file" ]; do
  # shellcheck disable=SC2046 # PIDs are plain integers
  remember $(tree)
  if [ "$SECONDS" -ge "$end" ]; then
    echo "supervise-attempt: deadline of ${deadline}s reached; terminating the attempt" >&2
    status=124
    break
  fi
  sleep 0.2
done

if [ -z "$status" ]; then
  unreaped=0
  collect_owned
  if [ -n "$owned_pids" ]; then
    echo "supervise-attempt: command left owned processes running: ${owned_pids}" >&2
    teardown || unreaped=1
  elif ! await_leader $((SECONDS + reap_wait)); then
    echo "supervise-attempt: attempt subreaper did not exit; killing it" >&2
    kill -KILL "$leader" 2>/dev/null
    unreaped=1
  fi
  wait "$leader"
  status=$?
  [ -s "$status_file" ] && status=$(cat "$status_file")
  [ "$unreaped" -eq 0 ] || status=125
else
  teardown || status=125
  wait "$leader" 2>/dev/null
fi
exit "$status"
