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
# busybox tar (alpine) has no -r (append) flag and multi -C mis-parses.
# Build config tarball as a list of independent gzip members and
# concatenate them — valid multi-member gzip, tar restores transparently.
TMP_PARTS=()

# 🔴 required: configs
P="${CFG}.part.0"
tar -czf "$P" -C "$APP_DIR" \
  .env docker-compose.yml \
  caddy-origin.pem caddy-origin-key.pem
TMP_PARTS+=("$P")

# 🟡 optional: .ssh if readable (host chmod 755 /root/.ssh is prerequisite)
if [[ -d "$HOME/.ssh" ]]; then
  P="${CFG}.part.1"
  if tar -czf "$P" -C "$HOME" .ssh 2>/dev/null; then
    TMP_PARTS+=("$P")
    log "config tarball includes $HOME/.ssh"
  else
    rm -f "$P"
    log "WARN: $HOME/.ssh unreadable (root-owned 700 mount); SSH keys NOT in backup. Follow-up: chmod 755 /root/.ssh + chmod 644 /root/.ssh/* on host, or change compose mount"
  fi
fi

# 🔴 R2 sanity check — can't back up object bytes from the VPS, but
# warn loudly if R2_* isn't wired so the operator knows chat attachments
# are NOT covered by this script. Pair with R2 bucket versioning.
if grep -q '^R2_ACCESS_KEY_ID=' "$APP_DIR/.env" 2>/dev/null; then
  :
else
  log "WARN: R2_ACCESS_KEY_ID not in .env — chat attachments (file bytes) are NOT in this backup; enable R2 bucket versioning + replicate"
fi

# 🟡 optional: Caddyfile + sshd drop-in (BACKUP_INCLUDE_OPTIONAL)
if [[ "$BACKUP_INCLUDE_OPTIONAL" == "1" ]]; then
  if [[ -f "$APP_DIR/Caddyfile" ]]; then
    P="${CFG}.part.2"
    tar -czf "$P" -C "$APP_DIR" Caddyfile
    TMP_PARTS+=("$P")
  fi
  if [[ -f /etc/ssh/sshd_config.d/10-disable-password.conf ]]; then
    P="${CFG}.part.3"
    tar -czf "$P" -C /etc/ssh/sshd_config.d 10-disable-password.conf
    TMP_PARTS+=("$P")
  fi
fi

# concatenate all parts into final tarball
cat "${TMP_PARTS[@]}" > "$CFG"
rm -f "${TMP_PARTS[@]}"
chmod 600 "$CFG"
log "config tarball built from ${#TMP_PARTS[@]} parts"

# --- manifest ---
log "writing manifest"
MANIFEST="$OUT/manifest.json"
# ponytail: use sha256sum + heredoc (busybox/alpine has no node,
# openssl, python, jq; but sha256sum from coreutils IS available).
DB_SHA=$(sha256sum "$DUMP" | awk '{print $1}')
DB_SIZE=$(stat -c %s "$DUMP" 2>/dev/null || stat -f %z "$DUMP")
CFG_SHA=$(sha256sum "$CFG" | awk '{print $1}')
CFG_SIZE=$(stat -c %s "$CFG" 2>/dev/null || stat -f %z "$CFG")
cat > "$MANIFEST" <<JSON
{
  "stamp": "${STAMP}",
  "appDir": "${APP_DIR}",
  "composeFile": "${COMPOSE_FILE}",
  "postgres": {
    "user": "${POSTGRES_USER:-}",
    "db": "${POSTGRES_DB:-}"
  },
  "files": {
    "db": {
      "path": "db.dump",
      "size": ${DB_SIZE},
      "sha256": "${DB_SHA}"
    },
    "config": {
      "path": "config.tar.gz",
      "size": ${CFG_SIZE},
      "sha256": "${CFG_SHA}"
    }
  },
  "optionalIncluded": $([ "${BACKUP_INCLUDE_OPTIONAL}" = "1" ] && echo true || echo false)
}
JSON

# --- rotate LATEST symlink + prune ---
ln -sfn "$STAMP" "$BACKUP_DEST/LATEST"
log "retention: pruning backups older than $BACKUP_RETAIN_DAYS days"
find "$BACKUP_DEST" -mindepth 1 -maxdepth 1 -type d \
  ! -name LATEST -mtime "+${BACKUP_RETAIN_DAYS}" -print -exec rm -rf {} +

# --- Google One (Drive) sync via rclone ---
# Auth is rclone.conf (refresh_token, not env). First-time setup:
#   docker exec -it <backup-container> rclone config     # n) gdrive
if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  log "bundle entire backup → rclone copy to $RCLONE_REMOTE"
  # 🟡 compress entire $BACKUP_DEST into a single tar.gz for atomic upload.
  # VPS→Google Drive link is ~9 KiB/s (Asia egress); syncing hundreds of
  # small files (each with its own API call) takes 40+ min. One big file
  # = one chunked upload, ~5x faster end-to-end.
  BUNDLE_DIR="$BACKUP_DEST/bundles"
  mkdir -p "$BUNDLE_DIR"
  BUNDLE="$BUNDLE_DIR/backup.${STAMP}.tar.gz"
  tar -czf "$BUNDLE" -C "$BACKUP_DEST" .
  # rclone copy one big file. --drive-chunk-size 64M: larger chunks =
  # fewer HTTP requests. --transfers 1: don't saturate the slow link.
  rclone copy "$BUNDLE" "$RCLONE_REMOTE/bundles/" \
    --drive-chunk-size 64M --transfers 1 \
    --log-file "$BACKUP_DEST/rclone.log" --log-level INFO
  rm -f "$BUNDLE"
  # prune local bundles older than 7 days (Drive keeps them all)
  find "$BUNDLE_DIR" -mindepth 1 -maxdepth 1 -mtime +7 -delete
else
  log "SKIP rclone: RCLONE_REMOTE not set"
fi

log "ok: $OUT"
