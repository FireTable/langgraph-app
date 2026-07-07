#!/bin/sh
# Single image, role-dispatched entrypoint.
#
# ROLE controls what runs in this container:
#   all       — Next.js (:3000) + LangGraph uvicorn (:2024)
#   frontend  — Next.js only on :3000
#   backend   — LangGraph uvicorn only on :2024
#
# Backend is `uvicorn langgraph_api.server:app` from the base image's
# Python runtime — honors PostgresSaver when POSTGRES_URI / DATABASE_URL
# is set (LANGGRAPH_RUNTIME_EDITION=postgres is baked into the base).

set -eu

ROLE="${ROLE:-all}"

# Apply DB migrations at startup. Idempotent (CREATE TABLE IF NOT EXISTS
# + PostgresStore/PostgresSaver.setup() both bail on existing objects).
# Compose gates on `service_healthy`, so postgres is up by this point.
# Skipped when DATABASE_URL is unset so dev/in-memory runs aren't blocked.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[start.sh] applying DB migrations..."
  pnpm db:migrate
fi

run_frontend() {
  echo "[start.sh] ROLE=frontend → next start (port 3000)"
  exec pnpm start
}

run_backend() {
  echo "[start.sh] ROLE=backend → langgraph uvicorn (port ${PORT:-2024})"
  start_grpc
  exec uvicorn langgraph_api.server:app \
    --log-config /api/logging.json \
    --host "${LANGGRAPH_SERVER_HOST:-0.0.0.0}" \
    --port "${PORT:-2024}" \
    --no-access-log \
    --timeout-graceful-shutdown 3600 \
    --timeout-keep-alive 75
}

# Wait for either child to exit; kill the other so we don't leak.
trap 'kill ${NEXT_PID:-} ${UVICORN_PID:-} ${GRPC_PID:-} 2>/dev/null || true' TERM INT

# langgraph-api 0.10.x's uvicorn connects to a Go Core API gRPC server on
# localhost:50051 at startup. Base image's /storage/entrypoint.sh starts
# it in-process before uvicorn; we replicate that here.
start_grpc() {
  if [ "${CORE_API_GRPC_SIDECAR:-}" = "1" ] || [ "${CORE_API_GRPC_SIDECAR:-}" = "true" ]; then
    echo "[start.sh] CORE_API_GRPC_SIDECAR set — assuming gRPC runs in another container"
    return
  fi
  if ! command -v core-api-grpc >/dev/null 2>&1; then
    echo "[start.sh] ERROR: core-api-grpc not on PATH" >&2
    return
  fi
  export LSD_GRPC_SERVER_ADDRESS=${LSD_GRPC_SERVER_ADDRESS:-localhost:50051}
  echo "[start.sh] starting core-api-grpc on ${LSD_GRPC_SERVER_ADDRESS}"
  core-api-grpc &
  GRPC_PID=$!
}

run_all() {
  echo "[start.sh] ROLE=all → next start + langgraph uvicorn"
  start_grpc

  uvicorn langgraph_api.server:app \
    --log-config /api/logging.json \
    --host "${LANGGRAPH_SERVER_HOST:-0.0.0.0}" \
    --port "${PORT:-2024}" \
    --no-access-log \
    --timeout-graceful-shutdown 3600 \
    --timeout-keep-alive 75 &
  UVICORN_PID=$!

  # Next.js reads $PORT too; clear it so pnpm start binds 3000, not 2024.
  unset PORT
  pnpm start &
  NEXT_PID=$!

  # POSIX `wait` blocks until any child exits; no `-n` (bash-only).
  wait
  EXIT=$?
  kill $NEXT_PID $UVICORN_PID ${GRPC_PID:-} 2>/dev/null || true
  exit $EXIT
}

case "$ROLE" in
  all)      run_all ;;
  frontend) run_frontend ;;
  backend)  run_backend ;;
  *)
    echo "[start.sh] unknown ROLE=$ROLE (want all|frontend|backend)" >&2
    exit 1
    ;;
esac