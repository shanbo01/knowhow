#!/usr/bin/env bash
#
# Backs up everything a KnowHow deployment cannot be rebuilt without: Appwrite's
# database, and the storage volume holding captured screenshots and generated
# exports.
#
#   ./scripts/backup.sh
#
# Designed to be run from cron or a systemd timer. It exits non-zero on any
# failure so the timer surfaces it, and it verifies what it wrote rather than
# assuming the dump succeeded — a backup that has never been read is a belief,
# not a safety net.
#
# Configuration comes from the environment; every value below has a default
# matching a stock Appwrite install. Override in .env.production.

set -euo pipefail

BACKUP_DIR="${KNOWHOW_BACKUP_DIR:-/var/backups/knowhow}"
KEEP_DAYS="${KNOWHOW_BACKUP_KEEP_DAYS:-14}"
DB_CONTAINER="${KNOWHOW_BACKUP_DB_CONTAINER:-appwrite-mariadb}"
DB_USER="${_APP_DB_USER:-user}"
DB_PASS="${_APP_DB_PASS:-password}"
DB_SCHEMA="${_APP_DB_SCHEMA:-appwrite}"
UPLOADS_VOLUME="${KNOWHOW_BACKUP_UPLOADS_VOLUME:-appwrite-uploads}"

# Off-host destination. Set one of these, or the backup lives on the same disk
# as the thing it protects, which is not a backup.
RCLONE_REMOTE="${KNOWHOW_BACKUP_RCLONE_REMOTE:-}"
RSYNC_TARGET="${KNOWHOW_BACKUP_RSYNC_TARGET:-}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${BACKUP_DIR}/${STAMP}"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'backup failed: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not on PATH"
docker inspect "${DB_CONTAINER}" >/dev/null 2>&1 \
  || die "database container '${DB_CONTAINER}' not found; set KNOWHOW_BACKUP_DB_CONTAINER"
docker volume inspect "${UPLOADS_VOLUME}" >/dev/null 2>&1 \
  || die "volume '${UPLOADS_VOLUME}' not found; set KNOWHOW_BACKUP_UPLOADS_VOLUME"

mkdir -p "${WORK}"
# The dump contains every row in the deployment. Keep it unreadable to others
# from the moment it exists, not after it is written.
chmod 700 "${BACKUP_DIR}" "${WORK}"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
# Appwrite ships MariaDB; the dump client was renamed in 11.x, so accept either.
DUMP_BIN="mariadb-dump"
docker exec "${DB_CONTAINER}" sh -c "command -v mariadb-dump" >/dev/null 2>&1 \
  || DUMP_BIN="mysqldump"

log "dumping ${DB_SCHEMA} with ${DUMP_BIN}"
# --single-transaction keeps the dump consistent without locking the site.
# The password reaches the client through the environment rather than argv,
# where it would be visible to every process on the host.
docker exec -e MYSQL_PWD="${DB_PASS}" "${DB_CONTAINER}" \
  "${DUMP_BIN}" \
    --user="${DB_USER}" \
    --single-transaction \
    --quick \
    --routines \
    --triggers \
    --databases "${DB_SCHEMA}" \
  | gzip -9 > "${WORK}/database.sql.gz"

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
log "archiving volume ${UPLOADS_VOLUME}"
docker run --rm \
  -v "${UPLOADS_VOLUME}:/data:ro" \
  -v "${WORK}:/backup" \
  alpine:3 \
  tar czf /backup/uploads.tar.gz -C /data .

# ---------------------------------------------------------------------------
# Verify before trusting
# ---------------------------------------------------------------------------
log "verifying archives"
gzip -t "${WORK}/database.sql.gz" || die "database dump is not a valid gzip stream"
gzip -t "${WORK}/uploads.tar.gz" || die "uploads archive is not a valid gzip stream"

# A dump that succeeded but wrote almost nothing means the credentials were
# accepted against an empty or wrong schema. Catch that here rather than on the
# day it is needed.
DB_BYTES="$(gzip -dc "${WORK}/database.sql.gz" | wc -c)"
[ "${DB_BYTES}" -gt 10240 ] \
  || die "database dump is only ${DB_BYTES} bytes; check _APP_DB_SCHEMA and credentials"
grep -q "CREATE TABLE" <(gzip -dc "${WORK}/database.sql.gz") \
  || die "database dump contains no table definitions"

( cd "${WORK}" && sha256sum ./*.gz > SHA256SUMS )
log "database $(du -h "${WORK}/database.sql.gz" | cut -f1), uploads $(du -h "${WORK}/uploads.tar.gz" | cut -f1)"

# ---------------------------------------------------------------------------
# Off-host copy
# ---------------------------------------------------------------------------
if [ -n "${RCLONE_REMOTE}" ]; then
  command -v rclone >/dev/null || die "KNOWHOW_BACKUP_RCLONE_REMOTE is set but rclone is not installed"
  log "copying to ${RCLONE_REMOTE}"
  rclone copy "${WORK}" "${RCLONE_REMOTE}/${STAMP}" --checksum
elif [ -n "${RSYNC_TARGET}" ]; then
  command -v rsync >/dev/null || die "KNOWHOW_BACKUP_RSYNC_TARGET is set but rsync is not installed"
  log "copying to ${RSYNC_TARGET}"
  rsync -a --checksum "${WORK}/" "${RSYNC_TARGET}/${STAMP}/"
else
  printf '\n  WARNING: no off-host destination configured.\n' >&2
  printf '  This backup is on the same disk as the data it protects. Set\n' >&2
  printf '  KNOWHOW_BACKUP_RCLONE_REMOTE or KNOWHOW_BACKUP_RSYNC_TARGET.\n\n' >&2
fi

# ---------------------------------------------------------------------------
# Prune
# ---------------------------------------------------------------------------
# Local copies only. Whatever is off-host is governed by that provider's own
# retention, so this never deletes the copy that matters most.
find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" \
  -exec rm -rf {} + 2>/dev/null || true

log "backup complete: ${WORK}"
