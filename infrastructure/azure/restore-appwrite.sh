#!/usr/bin/env bash
set -Eeuo pipefail

source /etc/knowhow/azure.env

if [[ -z "${BACKUP_BLOB:-}" || "${RESTORE_CONFIRM:-}" != "fresh-instance-only:${BACKUP_BLOB:-}" ]]; then
  echo 'Set BACKUP_BLOB and RESTORE_CONFIRM=fresh-instance-only:<exact-blob-name>.' >&2
  exit 2
fi

if [[ -e /etc/knowhow/restore-completed ]]; then
  echo 'This restore target already completed a restore.' >&2
  exit 2
fi

umask 077
work="$(mktemp -d /var/backups/knowhow/restore.XXXXXX)"
trap 'rm -rf "$work"' EXIT

token="$(curl --fail --silent --show-error --header Metadata:true \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2019-08-01&client_id=${MANAGED_IDENTITY_CLIENT_ID}&resource=https%3A%2F%2Fstorage.azure.com%2F" \
  | jq -er '.access_token')"
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${token}" \
  --header 'x-ms-version: 2023-11-03' \
  "https://${STORAGE_ACCOUNT}.blob.core.windows.net/${BACKUP_CONTAINER}/${BACKUP_BLOB}" \
  --output "$work/backup.age"

age --decrypt --identity /etc/knowhow/backup.agekey "$work/backup.age" \
  | tar xzf - -C "$work"
(cd "$work" && sha256sum --check SHA256SUMS)

cd "$APPWRITE_DIR"
docker compose down
while IFS= read -r archive; do
  volume="$(basename "$archive" .tar.gz)"
  docker volume create "$volume" >/dev/null
  docker run --rm --volume "${volume}:/data" --volume "$work/volumes:/backup:ro" alpine:3.21 \
    sh -c "rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; tar xzf '/backup/${volume}.tar.gz' -C /data"
done < <(find "$work/volumes" -maxdepth 1 -type f -name '*.tar.gz' | sort)

install -m 600 "$work/appwrite.env" "$APPWRITE_DIR/.env"
install -m 600 "$work/docker-compose.yml" "$APPWRITE_DIR/docker-compose.yml"
docker compose up -d --remove-orphans
date -u +%FT%TZ > /etc/knowhow/restore-completed
echo "Restore completed from ${BACKUP_BLOB}; verify every project and tenant boundary before any cutover."
