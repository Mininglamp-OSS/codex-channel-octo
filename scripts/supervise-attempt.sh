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
# behind by a command that exits on its own are torn down the same way.
#
# Exit status: the command's status; 124 on the deadline; 125 if an owned
# process could not be reaped.
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

# Owned processes: the session's descendants by parent link plus every
# process carrying the attempt token (orphans re-parented away from the tree).
owned() {
  local pids=" "
  if [ -n "${leader:-}" ]; then
    local frontier=" $leader " next pid ppid
    pids+="$leader "
    while [ "$frontier" != " " ]; do
      next=" "
      while read -r pid ppid; do
        case "$frontier" in *" $ppid "*) case "$pids" in *" $pid "*) ;; *) pids+="$pid "; next+="$pid " ;; esac ;; esac
      done < <(ps -e -o pid= -o ppid= 2>/dev/null)
      frontier=$next
    done
  fi
  if [ -d /proc ]; then
    local env
    for env in /proc/[0-9]*/environ; do
      local pid=${env#/proc/}; pid=${pid%/environ}
      [ "$pid" = "$$" ] && continue
      if tr '\0' '\n' 2>/dev/null < "$env" | grep -qxF "CODEX_CI_ATTEMPT=$token"; then
        case "$pids" in *" $pid "*) ;; *) pids+="$pid " ;; esac
      fi
    done
  fi
  local p
  for p in $pids; do
    # Zombies have already exited; only their parent can collect them.
    if [ -r "/proc/$p/stat" ]; then
      [ "$(awk '{print $3}' "/proc/$p/stat" 2>/dev/null)" = "Z" ] && continue
    fi
    kill -0 "$p" 2>/dev/null && printf '%s\n' "$p"
  done
}

signal_owned() {
  local sig=$1 p
  kill "-$sig" -- "-$leader" 2>/dev/null
  for p in $(owned); do kill "-$sig" "$p" 2>/dev/null; done
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

CODEX_CI_ATTEMPT=$token setsid -w "$@" &
leader=$!

status=
end=$((SECONDS + deadline))
while kill -0 "$leader" 2>/dev/null; do
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
