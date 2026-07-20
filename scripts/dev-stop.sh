#!/bin/sh
# Ponytail: comprehensive dev-server shutdown.
#
# The previous inline `pnpm dev:stop` only matched `langgraph-cli dev` by
# string. tsx watch wrappers around the langgraph-api entrypoint often
# survive after the CLI child dies (kill -9 on the child doesn't
# propagate to the watch parent), leaving orphan tsx nodes holding port
# 2024 in TIME_WAIT. pnpm itself spawns children via /bin/sh -c, so the
# process tree isn't `pnpm → langgraph-cli` directly.
#
# This script:
#   1. kills by command pattern (langgraph-cli / langgraphjs / tsx watch
#      wrapping langgraph-api / next dev / pnpm dev wrappers);
#   2. SIGTERM, sleep, SIGKILL each pass;
#   3. sweeps ports 2024 / 3000 / 3001;
#   4. walks parent→child so the watch wrappers don't leak.
#
# Idempotent: safe to run when nothing's listening (every kill is
# guarded with `|| true`).
#
# Override via env: DEV_STOP_PORTS="2024 3000"  DEV_STOP_PATTERNS="…"

set -u

# ponytail: pattern list uses NEWLINE as separator (not space — every
# pattern below contains a space, so a space-separated list would
# re-split into meaningless substrings that match random processes).
PORTS="${DEV_STOP_PORTS:-2024 3000 3001}"
PATTERNS="${DEV_STOP_PATTERNS:-
langgraph-cli dev
langgraphjs dev
langgraph-api.*entrypoint
tsx.*langgraph-api
next dev
next-server
}"

log() { printf '[dev-stop] %s\n' "$*"; }

# Filter out dev-stop.sh itself + the calling shell so we never
# self-terminate. pgrep -f would match the full command line and
# include this script's path.
filter_self() {
  # shellcheck disable=SC2009
  ps -axo pid,ppid,command 2>/dev/null \
    | grep -E "$1" \
    | grep -v 'grep\|dev-stop\.sh' \
    | awk '{ print $1 }' \
    | grep -v "^$$\$" \
    | grep -v "^${PPID:-0}\$" \
    | grep -v "^${PPID_PARENT:-0}\$"
}

# ponytail: resolve ancestors of $$ to exclude from kill (pnpm wrapper
# invokes sh → sh scripts/dev-stop.sh, so pnpm itself appears as
# PPID's parent — pattern `pnpm dev` would otherwise self-terminate).
PPID_PARENT=$(ps -o ppid= -p "${PPID:-1}" 2>/dev/null | tr -d ' ')

kill_pattern() {
  signal="$1" pattern="$2"
  pids=$(filter_self "$pattern")
  if [ -n "$pids" ]; then
    log "$signal  /$pattern/  → $pids"
    # shellcheck disable=SC2086
    kill -"$signal" $pids 2>/dev/null || true
  fi
}

kill_port() {
  port="$1"
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log "KILL  port $port  → $pids"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
  fi
}

# ponytail: walk parent→child so tsx watch wrappers don't leak.
# tsx watch parents keep respawning children until they're TERM'd; a
# plain TERM on the child leaves the parent alive. We TERM parents
# first, give them 2s to die cleanly, then sweep by port for anything
# that didn't.
log "Pass 1: TERM by pattern"
printf '%s' "$PATTERNS" | while IFS= read -r p; do
  [ -n "$p" ] && kill_pattern TERM "$p"
done
sleep 2

log "Pass 2: KILL stragglers by pattern"
printf '%s' "$PATTERNS" | while IFS= read -r p; do
  [ -n "$p" ] && kill_pattern KILL "$p"
done

log "Pass 3: KILL by port"
for port in $PORTS; do
  kill_port "$port"
done

sleep 1

log "Pass 4: second port sweep (catches respawned listeners)"
for port in $PORTS; do
  kill_port "$port"
done

remaining=""
for port in $PORTS; do
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    remaining="$remaining $port($pids)"
  fi
done

if [ -n "$remaining" ]; then
  log "WARN  still listening:$remaining"
  exit 1
fi

log "ok — ports clear: $PORTS"
