#!/usr/bin/env bash
#
# Restores a KnowHow backup into a running Appwrite stack.
#
#   ./scripts/restore.sh /var/backups/knowhow/20260301T020000Z --confirm
#
# This overwrites the database and the storage volume. It is meant for a scratch
# host during a restore rehearsal, and refuses by default on anything that looks
# like production — see the guard below.
#
# Rehearse it before you need it. An untested backup is a belief.

set -euo pipefail

SOURCE="${1:-}"
DB_ADAPTER="${KNOWHOW_BACKUP_DB_ADAPTER:-}"
DB_CONTAINER="${KNOWHOW_BACKUP_DB_CONTAINER:-}"
DB_USER="${_APP_DB_USER:-user}"
DB_PASS="${_APP_DB_PASS:-password}"
DB_SCHEMA="${_APP_DB_SCHEMA:-appwrite}"
UPLOADS_VOLUME="${KNOWHOW_BACKUP_UPLOADS_VOLUME:-appwrite-uploads}"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'restore refused: %s\n' "$*" >&2; exit 1; }

[ -n "${SOURCE}" ] || die "pass the backup directory to restore"
[ -d "${SOURCE}" ] || die "${SOURCE} is not a directory"
[ -f "${SOURCE}/uploads.tar.gz" ] || die "${SOURCE}/uploads.tar.gz is missing"

# The engine is inferred from what the backup actually contains, so an archive
# restores the way it was taken regardless of what happens to be running now.
if [ -f "${SOURCE}/database.archive.gz" ]; then
  DB_FILE="database.archive.gz"; DB_ADAPTER="${DB_ADAPTER:-mongodb}"
elif [ -f "${SOURCE}/database.sql.gz" ]; then
  DB_FILE="database.sql.gz"; DB_ADAPTER="${DB_ADAPTER:-mariadb}"
elif [ -f "${SOURCE}/database.dump.gz" ]; then
  DB_FILE="database.dump.gz"; DB_ADAPTER="${DB_ADAPTER:-postgres}"
else
  die "${SOURCE} holds no database archive"
fi

if [ -z "${DB_CONTAINER}" ]; then
  case "${DB_ADAPTER}" in
    mongodb) DB_CONTAINER="appwrite-mongodb" ;;
    mariadb|mysql) DB_CONTAINER="appwrite-mariadb" ;;
    postgres*) DB_CONTAINER="appwrite-postgres" ;;
    *) die "unrecognised database adapter '${DB_ADAPTER}'" ;;
  esac
fi

case " $* " in
  *" --confirm "*) ;;
  *) die "this overwrites ${DB_SCHEMA} and ${UPLOADS_VOLUME}. Re-run with --confirm." ;;
esac

# Restoring onto a live deployment is almost never what someone means to do, and
# is unrecoverable when it isn't. Require the intent to be stated twice.
if [ "${KNOWHOW_ENVIRONMENT:-}" = "production" ] && [ "${KNOWHOW_RESTORE_PRODUCTION:-}" != "i-accept-data-loss" ]; then
  die "KNOWHOW_ENVIRONMENT=production. Set KNOWHOW_RESTORE_PRODUCTION=i-accept-data-loss if that is genuinely the intent."
fi

command -v docker >/dev/null || die "docker is not on PATH"
docker inspect "${DB_CONTAINER}" >/dev/null 2>&1 || die "container '${DB_CONTAINER}' not found"

if [ -f "${SOURCE}/SHA256SUMS" ]; then
  log "verifying checksums"
  ( cd "${SOURCE}" && sha256sum -c SHA256SUMS ) || die "checksums do not match; this backup is damaged"
else
  printf '  WARNING: no SHA256SUMS in %s; restoring unverified.\n' "${SOURCE}" >&2
fi

gzip -t "${SOURCE}/${DB_FILE}" || die "database dump is not a valid gzip stream"
gzip -t "${SOURCE}/uploads.tar.gz" || die "uploads archive is not a valid gzip stream"

log "restoring database ${DB_SCHEMA} into ${DB_CONTAINER} (${DB_ADAPTER})"
case "${DB_ADAPTER}" in
  mongodb)
    # --drop replaces each collection as it is read, so nothing from the
    # current contents outlives the restore.
    gzip -dc "${SOURCE}/${DB_FILE}" \
      | docker exec -i "${DB_CONTAINER}" \
          mongorestore \
            --quiet \
            --archive \
            --drop \
            --username="${DB_USER}" \
            --password="${DB_PASS}" \
            --authenticationDatabase=admin
    ;;
  mariadb|mysql)
    CLIENT_BIN="mariadb"
    docker exec "${DB_CONTAINER}" sh -c "command -v mariadb" >/dev/null 2>&1 || CLIENT_BIN="mysql"
    gzip -dc "${SOURCE}/${DB_FILE}" \
      | docker exec -i -e MYSQL_PWD="${DB_PASS}" "${DB_CONTAINER}" \
          "${CLIENT_BIN}" --user="${DB_USER}"
    ;;
  postgres*)
    gzip -dc "${SOURCE}/${DB_FILE}" \
      | docker exec -i -e PGPASSWORD="${DB_PASS}" "${DB_CONTAINER}" \
          pg_restore --username="${DB_USER}" --clean --if-exists --dbname="${DB_SCHEMA}"
    ;;
esac

log "restoring volume ${UPLOADS_VOLUME}"
# Clear first: leaving orphaned files behind would make the restored deployment
# disagree with its own database about what exists.
docker run --rm \
  -v "${UPLOADS_VOLUME}:/data" \
  -v "${SOURCE}:/backup:ro" \
  alpine:3 \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/uploads.tar.gz -C /data'

log "restore complete"
printf '\n  Restart the stack, then check:\n' >&2
printf '    docker compose --env-file .env.production restart\n' >&2
printf '    curl -fsS https://<host>/api/health?ready=1\n' >&2
printf '  Then open a guide and confirm its screenshots load.\n\n' >&2
