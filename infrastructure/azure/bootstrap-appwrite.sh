#!/usr/bin/env bash
set -Eeuo pipefail

required=(APPWRITE_DOMAIN PUBLIC_IP OPERATOR_EMAIL OPERATOR_IP KEY_VAULT_NAME STORAGE_ACCOUNT BACKUP_CONTAINER MANAGED_IDENTITY_CLIENT_ID APPWRITE_VERSION)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required bootstrap variable: ${name}" >&2
    exit 2
  fi
done

export DEBIAN_FRONTEND=noninteractive
umask 077

APPWRITE_DIR=/opt/appwrite
KNOWHOW_DIR=/etc/knowhow
COMPOSE_URL="https://raw.githubusercontent.com/appwrite/appwrite/${APPWRITE_VERSION}/docker-compose.yml"
ENV_URL="https://raw.githubusercontent.com/appwrite/appwrite/${APPWRITE_VERSION}/.env"
MONGO_ENTRYPOINT_URL="https://raw.githubusercontent.com/appwrite/appwrite/${APPWRITE_VERSION}/mongo-entrypoint.sh"
MONGO_INIT_URL="https://raw.githubusercontent.com/appwrite/appwrite/${APPWRITE_VERSION}/mongo-init.js"
COMPOSE_SHA256=6466d116dffadb4341b3366b704f1dd0c62f5d602dc4952781f7d389b5c38ff6
ENV_SHA256=a39058714c42ec15c216ef6d2035a5ec2784889131394ffcb247fd43ed0ec24b
MONGO_ENTRYPOINT_SHA256=e4e7087d4e58934eab3208a3db957235154b31c5b400c98aedda4e944f79756c
MONGO_INIT_SHA256=525e61b5aa5d33284c830c9f6f126afc52f39f4b8120f5e5583dd9c084fec81b

retry() {
  local attempts="$1"
  shift
  local delay=3
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if "$@"; then
      return 0
    fi
    if ((attempt == attempts)); then
      return 1
    fi
    sleep "$delay"
    if ((delay < 30)); then
      delay=$((delay * 2))
    fi
  done
}

apt-get update -y
apt-get install -y --no-install-recommends age ca-certificates curl docker-compose-v2 docker.io jq openssl unattended-upgrades
systemctl enable --now docker
systemctl enable --now unattended-upgrades

if ! swapon --show=NAME --noheadings | grep -q .; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p "$APPWRITE_DIR" "$KNOWHOW_DIR" /var/backups/knowhow
chmod 700 "$KNOWHOW_DIR" /var/backups/knowhow

download_verified() {
  local url="$1"
  local expected="$2"
  local target="$3"
  local temporary="${target}.download"
  curl --fail --location --silent --show-error "$url" --output "$temporary"
  echo "${expected}  ${temporary}" | sha256sum --check --status
  mv "$temporary" "$target"
}

download_verified "$COMPOSE_URL" "$COMPOSE_SHA256" "$APPWRITE_DIR/docker-compose.yml"
download_verified "$ENV_URL" "$ENV_SHA256" "$APPWRITE_DIR/.env"
rm -rf "$APPWRITE_DIR/mongo-entrypoint.sh" "$APPWRITE_DIR/mongo-init.js"
download_verified "$MONGO_ENTRYPOINT_URL" "$MONGO_ENTRYPOINT_SHA256" "$APPWRITE_DIR/mongo-entrypoint.sh"
download_verified "$MONGO_INIT_URL" "$MONGO_INIT_SHA256" "$APPWRITE_DIR/mongo-init.js"
chmod 700 "$APPWRITE_DIR/mongo-entrypoint.sh"

# Keep private-beta email testing self-contained and zero-cost. Mailpit is not
# exposed through the VM/NSG; it only accepts SMTP from the Appwrite network.
install -m 600 /dev/stdin "$APPWRITE_DIR/docker-compose.override.yml" <<'YAML'
services:
  traefik:
    networks:
      gateway:
      appwrite:
      runtimes:
        aliases:
          - appwrite-internal
  mailpit:
    image: axllent/mailpit:v1.30.0
    container_name: appwrite-mailpit
    restart: unless-stopped
    environment:
      MP_DATABASE: /data/mailpit.db
      MP_DISABLE_VERSION_CHECK: "true"
      MP_MAX_MESSAGES: "500"
    volumes:
      - appwrite-mailpit:/data
    networks:
      - appwrite
    mem_limit: 128m
    cpus: 0.25

volumes:
  appwrite-mailpit:
networks:
  runtimes:
    external: true
    name: runtimes
YAML

metadata_token() {
  local resource="$1"
  curl --fail --silent --show-error \
    --header Metadata:true \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2019-08-01&client_id=${MANAGED_IDENTITY_CLIENT_ID}&resource=${resource}" \
    | jq -er '.access_token'
}

vault_token=''
refresh_vault_token() {
  vault_token="$(metadata_token 'https%3A%2F%2Fvault.azure.net')"
}

read_vault_secret() {
  local name="$1"
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${vault_token}" \
    "https://${KEY_VAULT_NAME}.vault.azure.net/secrets/${name}?api-version=7.4" \
    | jq -er '.value'
}

write_vault_secret() {
  local name="$1"
  local value="$2"
  jq -n --arg value "$value" '{value: $value, attributes: {enabled: true}}' \
    | curl --fail --silent --show-error \
      --request PUT \
      --header "Authorization: Bearer ${vault_token}" \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      "https://${KEY_VAULT_NAME}.vault.azure.net/secrets/${name}?api-version=7.4" \
    | jq -er '.id' >/dev/null
}

ensure_hex_secret() {
  local name="$1"
  local bytes="$2"
  local value
  if value="$(read_vault_secret "$name" 2>/dev/null)"; then
    printf '%s' "$value"
    return
  fi
  value="$(openssl rand -hex "$bytes")"
  write_vault_secret "$name" "$value"
  printf '%s' "$value"
}

retry 10 refresh_vault_token
retry 10 write_vault_secret knowhow-bootstrap-ready "$(openssl rand -hex 16)"
openssl_key="$(ensure_hex_secret appwrite-openssl-key 64)"
executor_secret="$(ensure_hex_secret appwrite-executor-secret 32)"
db_password="$(ensure_hex_secret appwrite-database-password 32)"
db_root_password="$(ensure_hex_secret appwrite-database-root-password 32)"

if backup_age_key="$(read_vault_secret appwrite-backup-age-key 2>/dev/null)"; then
  :
else
  backup_age_key="$(age-keygen 2>&1 | sed -n '/^AGE-SECRET-KEY-/p')"
  if [[ -z "$backup_age_key" ]]; then
    echo 'Unable to generate the backup age key.' >&2
    exit 1
  fi
  write_vault_secret appwrite-backup-age-key "$backup_age_key"
fi
printf '%s\n' "$backup_age_key" > "$KNOWHOW_DIR/backup.agekey"
chmod 600 "$KNOWHOW_DIR/backup.agekey"

set_env() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
  if grep -q "^${key}=" "$APPWRITE_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$APPWRITE_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$APPWRITE_DIR/.env"
  fi
}

set_env _APP_ENV production
set_env _APP_LOCALE en
# Site SSR calls back into the Appwrite API. Four workers per core avoids a
# synchronous proxy/API worker deadlock on the minimum two-vCPU beta VM.
set_env _APP_WORKER_PER_CORE 4
set_env _APP_OPTIONS_ABUSE enabled
set_env _APP_OPTIONS_ROUTER_FORCE_HTTPS enabled
set_env _APP_OPENSSL_KEY_V1 "$openssl_key"
set_env _APP_EXECUTOR_SECRET "$executor_secret"
set_env _APP_DOMAIN "$APPWRITE_DOMAIN"
set_env _APP_DOMAIN_TARGET_CNAME "$APPWRITE_DOMAIN"
set_env _APP_DOMAIN_TARGET_A "$PUBLIC_IP"
# Appwrite's upstream .env currently carries a development-network resolver
# address. Use Azure's platform DNS resolver so custom hostname verification
# works on an Azure VNet without coupling the deployment to a Docker subnet.
set_env _APP_DNS '168.63.129.16'
# Function deployments still require a configured preview-domain suffix even
# when they are invoked through the Appwrite API rather than a public hostname.
set_env _APP_DOMAIN_FUNCTIONS "$APPWRITE_DOMAIN"
# Sites are ultimately exposed through explicit sslip.io/custom rules, but the
# Appwrite API still requires a non-empty preview-domain suffix at creation.
set_env _APP_DOMAIN_SITES "$APPWRITE_DOMAIN"
set_env _APP_CONSOLE_HOSTNAMES "$APPWRITE_DOMAIN"
set_env _APP_CONSOLE_WHITELIST_ROOT enabled
set_env _APP_CONSOLE_WHITELIST_EMAILS "$OPERATOR_EMAIL"
set_env _APP_CONSOLE_WHITELIST_IPS "$OPERATOR_IP"
set_env _APP_SYSTEM_SECURITY_EMAIL_ADDRESS "$OPERATOR_EMAIL"
set_env _APP_SYSTEM_EMAIL_ADDRESS "$OPERATOR_EMAIL"
set_env _APP_DB_ADAPTER mongodb
set_env _APP_DB_HOST mongodb
set_env _APP_DB_PORT 27017
set_env _APP_DB_PASS "$db_password"
set_env _APP_DB_ROOT_PASS "$db_root_password"
set_env _APP_REDIS_PASS ''
set_env _APP_USAGE_STATS disabled
set_env _APP_STORAGE_ANTIVIRUS disabled
set_env _APP_STORAGE_LIMIT 52428800
set_env _APP_SITES_RUNTIMES node-22
set_env _APP_FUNCTIONS_RUNTIMES node-22
set_env _APP_SMTP_HOST mailpit
set_env _APP_SMTP_PORT 1025
set_env _APP_SMTP_SECURE ''
set_env _APP_SMTP_USERNAME ''
set_env _APP_SMTP_PASSWORD ''

cat > "$KNOWHOW_DIR/azure.env" <<EOF
APPWRITE_DIR=${APPWRITE_DIR}
APPWRITE_DOMAIN=${APPWRITE_DOMAIN}
STORAGE_ACCOUNT=${STORAGE_ACCOUNT}
BACKUP_CONTAINER=${BACKUP_CONTAINER}
MANAGED_IDENTITY_CLIENT_ID=${MANAGED_IDENTITY_CLIENT_ID}
EOF
chmod 600 "$KNOWHOW_DIR/azure.env"

install -m 700 /dev/stdin /usr/local/sbin/knowhow-backup <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
source /etc/knowhow/azure.env
umask 077

work="$(mktemp -d /var/backups/knowhow/run.XXXXXX)"
archive="knowhow-appwrite-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
stack_stopped=0

start_stack() {
  cd "$APPWRITE_DIR"
  docker compose start
  docker compose stop \
    appwrite-assistant \
    appwrite-embedding \
    mariadb \
    appwrite-task-stats-resources \
    appwrite-worker-stats-resources \
    appwrite-worker-stats-usage
}

cleanup() {
  local code=$?
  if [[ "$stack_stopped" == 1 ]]; then
    start_stack || true
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT

mkdir -p "$work/payload/volumes"
cd "$APPWRITE_DIR"
# Site/Function runtime containers are disposable deployment instances. Remove
# them before restarting the executor so Docker does not retain stale runtime
# network endpoints across the maintenance window.
mapfile -t runtime_containers < <(docker ps -aq --filter 'name=^exc1-knowhow-')
if [[ "${#runtime_containers[@]}" -gt 0 ]]; then
  docker rm -f "${runtime_containers[@]}" >/dev/null
fi
docker compose stop
stack_stopped=1

# Keep the 4 GB beta VM inside its memory envelope: quiesce the application,
# bring back only MongoDB for the logical dump, then stop it before archiving
# the Docker volumes. The cleanup trap always restarts the complete stack.
docker compose start mongodb
for attempt in $(seq 1 60); do
  if docker compose exec -T mongodb sh -c 'mongosh --quiet --username=root --password="$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase=admin --eval "db.adminCommand({ping: 1}).ok"' | grep -qx 1; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo 'MongoDB did not become ready for backup' >&2
    exit 1
  fi
  sleep 2
done
docker compose exec -T mongodb sh -c 'exec mongodump --username=root --password="$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase=admin --archive' > "$work/payload/mongodb.archive"
docker compose stop mongodb

while IFS= read -r volume; do
  [[ -n "$volume" ]] || continue
  docker run --rm --volume "${volume}:/data:ro" --volume "$work/payload/volumes:/backup" alpine:3.21 \
    tar czf "/backup/${volume}.tar.gz" -C /data .
done < <(docker volume ls --format '{{.Name}}' | grep '^appwrite-' | sort)

cp "$APPWRITE_DIR/.env" "$work/payload/appwrite.env"
cp "$APPWRITE_DIR/docker-compose.yml" "$work/payload/docker-compose.yml"
cp "$APPWRITE_DIR/docker-compose.override.yml" "$work/payload/docker-compose.override.yml"
docker compose config --images | sort > "$work/payload/container-images.txt"
date -u +%FT%TZ > "$work/payload/created-at.txt"
(cd "$work/payload" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

start_stack
stack_stopped=0

tar czf - -C "$work/payload" . \
  | age --encrypt --recipient "$(age-keygen -y /etc/knowhow/backup.agekey)" \
  > "/var/backups/knowhow/${archive}"
sha256sum "/var/backups/knowhow/${archive}" > "/var/backups/knowhow/${archive}.sha256"

token="$(curl --fail --silent --show-error --header Metadata:true \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2019-08-01&client_id=${MANAGED_IDENTITY_CLIENT_ID}&resource=https%3A%2F%2Fstorage.azure.com%2F" \
  | jq -er '.access_token')"

upload() {
  local path="$1"
  local blob="$2"
  curl --fail --silent --show-error --request PUT --upload-file "$path" \
    --header "Authorization: Bearer ${token}" \
    --header 'x-ms-version: 2023-11-03' \
    --header "x-ms-date: $(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')" \
    --header 'x-ms-blob-type: BlockBlob' \
    "https://${STORAGE_ACCOUNT}.blob.core.windows.net/${BACKUP_CONTAINER}/${blob}"
}

upload "/var/backups/knowhow/${archive}" "$archive"
upload "/var/backups/knowhow/${archive}.sha256" "${archive}.sha256"

find /var/backups/knowhow -maxdepth 1 -type f -name 'knowhow-appwrite-*' -mtime +2 -delete
logger --tag knowhow-backup "completed blob=${archive}"
SCRIPT

install -m 700 /dev/stdin /usr/local/sbin/knowhow-healthcheck <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
source /etc/knowhow/azure.env
if ! curl --fail --silent --show-error --max-time 20 "https://${APPWRITE_DOMAIN}/v1/health/version" >/dev/null; then
  logger --priority daemon.err --tag knowhow-healthcheck 'Appwrite health endpoint failed'
  exit 1
fi
logger --tag knowhow-healthcheck 'Appwrite health endpoint passed'
SCRIPT

cat > /etc/systemd/system/knowhow-backup.service <<'EOF'
[Unit]
Description=Encrypted KnowHow Appwrite backup to Azure Blob
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/knowhow-backup
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

cat > /etc/systemd/system/knowhow-backup.timer <<'EOF'
[Unit]
Description=Daily KnowHow Appwrite backup timer

[Timer]
OnCalendar=*-*-* 02:20:00 UTC
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/knowhow-healthcheck.service <<'EOF'
[Unit]
Description=KnowHow Appwrite external health check
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/knowhow-healthcheck
EOF

cat > /etc/systemd/system/knowhow-healthcheck.timer <<'EOF'
[Unit]
Description=KnowHow Appwrite health timer

[Timer]
OnBootSec=10m
OnUnitActiveSec=5m
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now knowhow-backup.timer knowhow-healthcheck.timer

cd "$APPWRITE_DIR"
docker compose pull
docker compose up -d --remove-orphans
# The private beta does not use Appwrite Assistant/embeddings, MariaDB, or
# usage aggregation. Keeping these stopped saves roughly 400 MiB on the
# minimum 4-GiB VM without removing Auth, TablesDB, Storage, Functions, Sites,
# Messaging, MongoDB, PostgreSQL, Redis, or the operational workers.
docker compose stop \
  appwrite-assistant \
  appwrite-embedding \
  mariadb \
  appwrite-task-stats-resources \
  appwrite-worker-stats-resources \
  appwrite-worker-stats-usage

for _ in {1..60}; do
  if curl --fail --silent --show-error http://127.0.0.1/v1/health/version >/dev/null 2>&1; then
    break
  fi
  sleep 10
done
curl --fail --silent --show-error http://127.0.0.1/v1/health/version >/dev/null
curl --insecure --fail --silent --show-error "https://${APPWRITE_DOMAIN}/v1/health/version" >/dev/null
docker compose exec -T appwrite ssl || true

echo "Appwrite ${APPWRITE_VERSION} is running at https://${APPWRITE_DOMAIN}"
