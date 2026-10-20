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
# handlers run, waits up to <grace-s>, then keeps sending KILL to every owned
# process it finds, including ones forked during teardown, until none remain.
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

# Prints "<state> <start-time>" for a live PID (fields 3 and 22 of
# /proc/<pid>/stat, parsed after the last ")" so a comm with spaces is safe).
proc_info() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  # shellcheck disable=SC2086 # split the stat fields on purpose
  set -- ${stat##*) }
  printf '%s %s\n' "$1" "${20}"
}

# Remembered owned processes as " pid:start-time " entries.
tracked=" "

remember() {
  local pid info
  for pid in "$@"; do
    case "$tracked" in *" $pid:"*) continue ;; esac
    info=$(proc_info "$pid") || continue
    [ "${info%% *}" = "Z" ] && continue
    tracked+="$pid:${info#* } "
  done
}

# The session's current descendants by parent link.
tree() {
  [ -n "${leader:-}" ] || return 0
  local pids=" $leader " frontier=" $leader " next pid ppid
  while [ "$frontier" != " " ]; do
    next=" "
    while read -r pid ppid; do
      case "$frontier" in *" $ppid "*) case "$pids" in *" $pid "*) ;; *) pids+="$pid "; next+="$pid " ;; esac ;; esac
    done < <(ps -e -o pid= -o ppid= 2>/dev/null)
    frontier=$next
  done
  # shellcheck disable=SC2086 # PIDs are plain integers
  printf '%s\n' $pids
}

# Every process carrying the attempt token, including orphans.
tokened() {
  local env pid
  for env in /proc/[0-9]*/environ; do
    pid=${env#/proc/}; pid=${pid%/environ}
    [ "$pid" = "$$" ] && continue
    if tr '\0' '\n' 2>/dev/null < "$env" | grep -qxF "CODEX_CI_ATTEMPT=$token"; then
      printf '%s\n' "$pid"
    fi
  done
}

# Owned processes still running: the current tree, token carriers and every
# remembered process whose start time still matches. Zombies have already
# exited; only their parent can collect them.
owned() {
  # shellcheck disable=SC2046 # PIDs are plain integers
  remember $(tree) $(tokened)
  local entry pid info
  for entry in $tracked; do
    pid=${entry%%:*}
    info=$(proc_info "$pid") || continue
    [ "${info%% *}" = "Z" ] && continue
    [ "${info#* }" = "${entry#*:}" ] && printf '%s\n' "$pid"
  done
}

# Owned processes other than the subreaper session leader. The subreaper is
# never signalled while it may still adopt descendants.
descendants() {
  owned | grep -vx "$leader"
}

# True while the subreaper session leader (matched by start time) is running.
leader_alive() {
  local info
  [ -n "${leader_start:-}" ] || return 1
  info=$(proc_info "$leader") || return 1
  [ "${info%% *}" != "Z" ] && [ "${info#* }" = "$leader_start" ]
}

signal_descendants() {
  local sig=$1 p
  # Enumerate before signalling: a parent that exits on TERM re-parents its children.
  for p in $(descendants); do kill "-$sig" "$p" 2>/dev/null; done
}

# Waits until second $1 for every descendant to exit; 0 when none remain.
# With a signal in $2, every poll re-enumerates and signals again, so a
# process forked during teardown (re-parented to the subreaper once its
# parent dies) is caught as well.
await_descendants() {
  local until=$1 sig=${2:-} targets p
  while :; do
    targets=$(descendants)
    [ -z "$targets" ] && return 0
    [ "$SECONDS" -ge "$until" ] && return 1
    if [ -n "$sig" ]; then
      for p in $targets; do kill "-$sig" "$p" 2>/dev/null; done
    fi
    sleep 0.2
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

# TERM to every descendant, <grace-s>, then KILL re-sent on each poll for at
# most $reap_wait seconds. The subreaper exits by itself once it has no
# children left; it is killed only as a last resort, and that, like any
# descendant that could not be reaped, is a failure (125), never a success.
teardown() {
  local reap_until failed=0
  signal_descendants TERM
  if ! await_descendants $((SECONDS + grace)); then
    echo "supervise-attempt: owned processes still running after ${grace}s TERM grace: $(descendants | tr '\n' ' ')" >&2
    reap_until=$((SECONDS + reap_wait))
    if ! await_descendants "$reap_until" KILL; then
      echo "supervise-attempt: could not reap owned processes: $(descendants | tr '\n' ' ')" >&2
      failed=1
    fi
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
leader_start=$(proc_info "$leader") && leader_start=${leader_start#* }

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
  leftover=$(owned | grep -vx "$leader" | tr '\n' ' ')
  if [ -n "${leftover// /}" ]; then
    echo "supervise-attempt: command left owned processes running: ${leftover}" >&2
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
