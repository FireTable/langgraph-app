#!/usr/bin/env bash
# Ponytail: one-liner pg_dump wrapper called before any out-of-app DB
# mutation per CLAUDE.md rule #12.
#
# Usage: scripts/db-snapshot.sh [db-name-suffix]
#   - Loads .env.local (and .env) via a Node helper that mimics
#     @next/env's precedence, then exports the vars into this shell.
#   - Writes ~/.local/db-snapshots/<db>-<timestamp>.dump (custom format,
#     compressed).
#   - Refuses to run if DATABASE_URL points at a non-localhost host —
#     this is a DEV-DB-ONLY safety net, not a prod backup.
#
# Why custom format (`-Fc`): ~3x smaller than plain SQL for typical
# schema+data dumps, and `pg_restore` round-trips losslessly. `pg_restore
# --clean --if-exists -d "$DATABASE_URL" file.dump` brings it back.

set -euo pipefail

# Load env via the project-local Node helper (bash↔node quoting is the
# worst part of this script; keeping the loader under scripts/ means
# node's path resolution for @next/env works from the project root).
env_output=$(node "$(dirname "$0")/_db-snapshot-env-loader.mjs" 2>/dev/null) || {
  echo "node env-load failed (missing @next/env?)" >&2
  exit 1
}

if [[ -z "$env_output" ]]; then
  echo "no env vars to export from .env.local" >&2
  exit 1
fi
eval "$env_output"

: "${DATABASE_URL:?DATABASE_URL is not set (check .env.local)}"

host=$(node -e "process.stdout.write(new URL(process.env.DATABASE_URL).hostname)")
if [[ "$host" != "localhost" && "$host" != "127.0.0.1" && "$host" != "::1" ]]; then
  echo "Refusing to snapshot non-localhost DB (host=$host). This script is dev-only." >&2
  exit 1
fi

db_name=$(node -e "process.stdout.write(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''))")
suffix="${1:-}"
stamp=$(date +%Y%m%d-%H%M%S)
out_dir="${HOME}/.local/db-snapshots"
mkdir -p "$out_dir"
out_file="${out_dir}/${db_name}${suffix:+-$suffix}-${stamp}.dump"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found in PATH — install Postgres client tools first." >&2
  exit 1
fi

pg_dump -Fc --no-owner --no-acl "$DATABASE_URL" -f "$out_file"

echo "snapshot: $out_file"
echo "size:     $(du -h "$out_file" | cut -f1)"
echo "restore:  pg_restore --clean --if-exists -d \"\$DATABASE_URL\" \"$out_file\""
