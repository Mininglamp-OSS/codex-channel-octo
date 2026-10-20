#!/usr/bin/env bash
# Runs one CI attempt under a deadline and owns its whole process tree.
#
#   scripts/supervise-attempt.sh <deadline-s> <grace-s> -- <command> [args...]
#
# The command runs in its own session. Every process it starts inherits an
# attempt token in its environment, which survives `detached` spawns that
# leave the session (the JSONL proxy starts its CLI that way). On the
# deadline the supervisor sends TERM to the session and to every owned
# process so termination handlers run, waits up to <grace-s>, then sends KILL
# and waits for every owned process to disappear. Owned processes left
# behind by a command that exits on its own, and the attempt itself when the
# supervisor is cancelled (TERM/INT/HUP), are torn down the same way.
#
# A child spawned with a replaced environment (the Codex SDK does this) has
# no token, so the tree is also snapshotted by parent link while the attempt
# runs and before any signal is sent; a re-parented orphan is still owned.
# Remembered processes are matched by PID and start time, never PID alone.
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

signal_owned() {
  local sig=$1 p targets
  # Enumerate before signalling: a parent that exits on TERM re-parents its children.
  targets=$(owned)
  kill "-$sig" -- "-$leader" 2>/dev/null
  for p in $targets; do kill "-$sig" "$p" 2>/dev/null; done
}

# Waits up to $1 seconds for every owned process to exit; 0 when none remain.
await_owned() {
  local until=$((SECONDS + $1))
  while :; do
    [ -z "$(owned)" ] && return 0
    [ "$SECONDS" -ge "$until" ] && return 1
    sleep 0.2
  done
}

teardown() {
  signal_owned TERM
  if ! await_owned "$grace"; then
    echo "supervise-attempt: owned processes still running after ${grace}s TERM grace: $(owned | tr '\n' ' ')" >&2
    signal_owned KILL
    if ! await_owned "$reap_wait"; then
      echo "supervise-attempt: could not reap owned processes: $(owned | tr '\n' ' ')" >&2
      return 1
    fi
  fi
  return 0
}

# shellcheck disable=SC2329 # invoked by the traps below
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

CODEX_CI_ATTEMPT=$token setsid -w "$@" &
leader=$!

status=
end=$((SECONDS + deadline))
while kill -0 "$leader" 2>/dev/null; do
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
  wait "$leader"
  status=$?
  leftover=$(owned | grep -vx "$leader" | tr '\n' ' ')
  if [ -n "${leftover// /}" ]; then
    echo "supervise-attempt: command left owned processes running: ${leftover}" >&2
    teardown || status=125
  fi
else
  teardown || status=125
  wait "$leader" 2>/dev/null
fi
exit "$status"
