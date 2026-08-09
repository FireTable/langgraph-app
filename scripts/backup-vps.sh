#!/usr/bin/env bash
# Ponytail: VPS daily backup for the production deployment.
#
# Backs up (in priority order):
#   🔴 postgres-data  via `docker compose exec pg_dump -Fc` (live container's
#                     own env — survives SSH single-quote + minimal cron env,
#                     no host-level pg client needed)
#   🔴 /opt/langgraph-app/.env                         (chmod 600 in tar)
#   🔴 caddy-origin.pem + caddy-origin-key.pem         (CF Origin Cert)
#   🔴 /opt/langgraph-app/docker-compose.yml           (VPS-flavored, NOT
#                                                      the dev tree's compose)
#   🟡 $HOME/.ssh/                                     (whole dir — no
#                                                      authorized_keys /
#                                                      known_hosts / private
#                                                      keys to lose separately)
#   🟡 Caddyfile                                       (gated by
#                                                      BACKUP_INCLUDE_OPTIONAL)
#   🟡 /etc/ssh/sshd_config.d/10-disable-password.conf (same)
#
# Output:
#   $BACKUP_DEST/<stamp>/{db.dump, config.tar.gz, manifest.json}
#   $BACKUP_DEST/LATEST  ->  $BACKUP_DEST/<stamp>
#   (optional) rclone sync to $RCLONE_REMOTE after the local prune
#
# Env (all optional — defaults shown):
#   APP_DIR=/opt/langgraph-app
#   COMPOSE_FILE=$APP_DIR/docker-compose.yml
#   BACKUP_DEST=$HOME/.local/langgraph-backups
#   BACKUP_RETAIN_DAYS=14
#   BACKUP_INCLUDE_OPTIONAL=1
#   RCLONE_REMOTE=                       (empty = skip remote sync)
#   RCLONE_BWLIMIT=0                     (Mbps; 0 = no limit)
#
# Restore (sketch, not in the script):
#   tar -xzf $BACKUP_DEST/LATEST/config.tar.gz -C /opt/langgraph-app
#   docker compose -f $COMPOSE_FILE exec -T postgres \
#     pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
#     < $BACKUP_DEST/LATEST/db.dump
#
# Cron (run as the user that owns /opt/langgraph-app):
#   0 4 * * *  /opt/langgraph-app/scripts/backup-vps.sh \
#              >> $HOME/.local/langgraph-backups/backup.log 2>&1

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/langgraph-app}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.yml}"
BACKUP_DEST="${BACKUP_DEST:-$HOME/.local/langgraph-backups}"
BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
BACKUP_INCLUDE_OPTIONAL="${BACKUP_INCLUDE_OPTIONAL:-1}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DEST/$STAMP"
LOG="$BACKUP_DEST/backup.log"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2 ; }

mkdir -p "$OUT"

# ponytail: read APP_DIR/.env via `set -a; source; set +a` so every KEY=VAL
# becomes an exported env var in this shell — no ssh-side single-quote
# expansion, no heredoc. Empty / missing .env is fine (we only need the
# POSTGRES_* keys for the manifest; the dump itself uses the container's
# own env via `docker compose exec`).
if [[ -f "$APP_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_DIR/.env"
  set +a
fi

# --- 🔴 postgres dump via live container ---
DUMP="$OUT/db.dump"
log "dumping postgres via docker compose exec -> $DUMP"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -Fc --no-owner --no-acl -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-langgraph_app}" \
  > "$DUMP"

# --- 🔴 + 🟡 config tarball ---
CFG="$OUT/config.tar.gz"
log "tarring config -> $CFG"
umask 077
tar -czf "$CFG" \
  -C "$APP_DIR" \
  .env docker-compose.yml \
  caddy-origin.pem caddy-origin-key.pem

# 🟡 whole $HOME/.ssh — without it a perfect restore still locks you out.
# Includes authorized_keys, private keys, known_hosts, config.
# Skip the dir silently if it doesn't exist (non-interactive users with
# no /home). The archive is owner-only; private keys never leave the
# .ssh/ subtree in plaintext form outside that.
if [[ -d "$HOME/.ssh" ]]; then
  tar -rzf "$CFG" -C "$HOME" .ssh
else
  log "WARN: $HOME/.ssh not found — no SSH keys in this backup"
fi

# 🔴 R2 sanity check — can't back up object bytes from the VPS, but
# warn loudly if R2_* isn't wired so the operator knows chat attachments
# are NOT covered by this script. Pair with R2 bucket versioning.
if grep -q '^R2_ACCESS_KEY_ID=' "$APP_DIR/.env" 2>/dev/null; then
  :
else
  log "WARN: R2_ACCESS_KEY_ID not in .env — chat attachments (file bytes) are NOT in this backup; enable R2 bucket versioning + replicate"
fi

if [[ "$BACKUP_INCLUDE_OPTIONAL" == "1" ]]; then
  if [[ -f "$APP_DIR/Caddyfile" ]]; then
    tar -rzf "$CFG" -C "$APP_DIR" Caddyfile
  fi
  if [[ -f /etc/ssh/sshd_config.d/10-disable-password.conf ]]; then
    tar -rzf "$CFG" -C /etc/ssh/sshd_config.d 10-disable-password.conf
  fi
fi
chmod 600 "$CFG"

# --- manifest ---
log "writing manifest"
MANIFEST="$OUT/manifest.json"
node - <<EOF > "$MANIFEST"
const fs = require("node:fs");
const crypto = require("node:crypto");
function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
const dump = "$DUMP", cfg = "$CFG";
const out = {
  stamp: "$STAMP",
  appDir: "$APP_DIR",
  composeFile: "$COMPOSE_FILE",
  postgres: {
    user: process.env.POSTGRES_USER ?? null,
    db: process.env.POSTGRES_DB ?? null,
  },
  files: {
    db: { path: "db.dump", size: fs.statSync(dump).size, sha256: sha256(dump) },
    config: { path: "config.tar.gz", size: fs.statSync(cfg).size, sha256: sha256(cfg) },
  },
  optionalIncluded: "$BACKUP_INCLUDE_OPTIONAL" === "1",
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
EOF

# --- rotate LATEST symlink + prune ---
ln -sfn "$STAMP" "$BACKUP_DEST/LATEST"
log "retention: pruning backups older than $BACKUP_RETAIN_DAYS days"
find "$BACKUP_DEST" -mindepth 1 -maxdepth 1 -type d \
  ! -name LATEST -mtime "+${BACKUP_RETAIN_DAYS}" -print -exec rm -rf {} +

# --- Google One (Drive) sync via rclone ---
# Auth is rclone.conf (refresh_token, not env). First-time setup:
#   docker exec -it <backup-container> rclone config     # n) gdrive
if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  log "rclone sync -> $RCLONE_REMOTE"
  rclone sync "$BACKUP_DEST" "$RCLONE_REMOTE" \
    --transfers 4 --checkers 2 --bwlimit "${RCLONE_BWLIMIT:-0}" \
    --log-file "$BACKUP_DEST/rclone.log" --log-level INFO
else
  log "SKIP rclone: RCLONE_REMOTE not set"
fi

log "ok: $OUT"
