#!/usr/bin/env bash
#
# Stands up, or updates, a KnowHow deployment.
#
#   ./scripts/deploy.sh all          run every phase in order
#   ./scripts/deploy.sh <phase>      run one phase
#   ./scripts/deploy.sh --list       show the phases
#
# Every phase is idempotent and safe to re-run, so a failure is fixed and the
# same command repeated rather than unpicked. Phases are ordered by dependency;
# `all` stops at the first failure so nothing is built on a broken step.
#
# Configuration comes from deploy.conf beside this repository (see
# deploy.conf.example). Secrets are generated into .env.production and never
# passed on a command line.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
CONF="${KNOWHOW_DEPLOY_CONF:-${ROOT}/deploy.conf}"
ENV_FILE="${ROOT}/.env.production"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; B=""; D=""; N=""
fi
step()  { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()    { printf '    %s✓%s %s\n' "$G" "$N" "$1"; }
info()  { printf '    %s%s%s\n' "$D" "$1" "$N"; }
warn()  { printf '    %s!%s %s\n' "$Y" "$N" "$1"; }
die()   { printf '\n%sfailed:%s %s\n' "$R" "$N" "$1" >&2; exit 1; }

usage() {
  printf 'usage: %s <phase|all>\n\nphases, in order:\n' "$0"
  printf '  preflight   host checks: memory, disk, docker at boot, ports, DNS\n'
  printf '  appwrite    install Appwrite, set runtimes/storage/SMTP, restart policy\n'
  printf '  provision   console account, project, API key, web platform\n'
  printf '  env         generate .env.production and its secrets\n'
  printf '  push        tables, buckets, functions, function variables\n'
  printf '  app         build and start the application behind Caddy\n'
  printf '  verify      readiness, and what is left for a human\n'
  printf '\nEvery phase is idempotent; re-run after fixing a failure.\n'
  printf 'Configuration comes from deploy.conf (see deploy.conf.example).\n'
}

PHASES="preflight appwrite provision env push app verify"

# Answer --help and --list before demanding configuration: someone reading the
# script for the first time has not written deploy.conf yet.
case "${1:-}" in
  ""|-h|--help) usage; exit 0 ;;
  --list) echo "$PHASES"; exit 0 ;;
esac

[ -f "$CONF" ] || die "no ${CONF}. Copy deploy.conf.example and fill it in."
# shellcheck disable=SC1090
. "$CONF"

need() {
  local name="$1"
  [ -n "${!name:-}" ] || die "${name} is not set in ${CONF}"
}
need KNOWHOW_SITE_HOST
need APPWRITE_PUBLIC_HOST
need KNOWHOW_TLS_MODE
need APPWRITE_DIR

APPWRITE_DIR="${APPWRITE_DIR/#\~/$HOME}"
APPWRITE_PORT="${APPWRITE_PORT:-8080}"
APPWRITE_HTTPS_PORT="${APPWRITE_HTTPS_PORT:-8443}"
APPWRITE_PROJECT="${APPWRITE_PROJECT:-knowhow}"
APPWRITE_VERSION="${APPWRITE_VERSION:-1.9.6}"
APPWRITE_NETWORK="${APPWRITE_NETWORK:-appwrite}"
LOCAL_API="http://127.0.0.1:${APPWRITE_PORT}/v1"

# Scopes the application key needs. sessions.write is the one that is easy to
# miss and impossible to diagnose: without it every sign-in reports "the email
# or password is incorrect" while the credentials are perfectly good. The
# collections/attributes/documents names are the older spelling of the same
# resources and are still required when pushing the schema.
API_KEY_SCOPES='["users.read","users.write","sessions.read","sessions.write","teams.read","teams.write","databases.read","databases.write","tables.read","tables.write","columns.read","columns.write","indexes.read","indexes.write","rows.read","rows.write","collections.read","collections.write","attributes.read","attributes.write","documents.read","documents.write","buckets.read","buckets.write","files.read","files.write","functions.read","functions.write","executions.read","executions.write","messages.write","targets.read","locale.read","health.read","rules.read","rules.write"]'

envget() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r'; }
envset() {
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then
    python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().split("\n")
out = [f"{key}={value}" if l.startswith(f"{key}=") else l for l in lines]
open(path, "w", encoding="utf-8", newline="\n").write("\n".join(out))
PY
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
appwrite_env_set() {
  sudo python3 - "${APPWRITE_DIR}/.env" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().split("\n")
found = False
out = []
for line in lines:
    if line.startswith(f"{key}="):
        # Replace rather than append: a second definition of the same key is
        # legal in an env file and silently wins, which makes a stale value
        # look like a change that did not take.
        if not found:
            out.append(f'{key}="{value}"')
            found = True
        continue
    out.append(line)
if not found:
    out.append(f'{key}="{value}"')
open(path, "w", encoding="utf-8", newline="\n").write("\n".join(out))
PY
}

# ---------------------------------------------------------------------------
phase_preflight() {
  step "Preflight"
  KNOWHOW_EXPECTED_PUBLIC_IP="${KNOWHOW_EXPECTED_PUBLIC_IP:-}" \
    "${ROOT}/scripts/preflight.sh" || die "preflight reported failures"
}

# ---------------------------------------------------------------------------
phase_appwrite() {
  step "Appwrite: install and configure"
  command -v docker >/dev/null || die "docker is not installed"

  if [ ! -f "${APPWRITE_DIR}/docker-compose.yml" ]; then
    info "installing Appwrite ${APPWRITE_VERSION} on ports ${APPWRITE_PORT}/${APPWRITE_HTTPS_PORT}"
    mkdir -p "$(dirname "$APPWRITE_DIR")"
    ( cd "$(dirname "$APPWRITE_DIR")" && \
      docker run --rm \
        --volume /var/run/docker.sock:/var/run/docker.sock \
        --volume "$PWD/$(basename "$APPWRITE_DIR")":/usr/src/code/appwrite:rw \
        --entrypoint="install" \
        "appwrite/appwrite:${APPWRITE_VERSION}" \
        --http-port="${APPWRITE_PORT}" --https-port="${APPWRITE_HTTPS_PORT}" \
        --interactive=N --organization=appwrite --image=appwrite ) \
      || die "Appwrite install failed"
    ok "installed"
  else
    ok "already installed at ${APPWRITE_DIR}"
  fi

  # Node 22 is not among the four runtimes a stock install enables, and both
  # workers declare engines.node >= 22.
  local runtimes="node-22,node-16.0,php-8.0,python-3.9,ruby-3.0"
  appwrite_env_set _APP_FUNCTIONS_RUNTIMES "$runtimes"
  # The exports bucket declares a 50 MB maximum file size; Appwrite ships a
  # 30 MB ceiling, and the bucket push fails against it.
  appwrite_env_set _APP_STORAGE_LIMIT "52428800"
  appwrite_env_set _APP_DOMAIN "${APPWRITE_PUBLIC_HOST}"
  appwrite_env_set _APP_DOMAIN_TARGET "${APPWRITE_PUBLIC_HOST}"
  if [ -n "${KNOWHOW_SMTP_HOST:-}" ]; then
    appwrite_env_set _APP_SMTP_HOST "${KNOWHOW_SMTP_HOST}"
    appwrite_env_set _APP_SMTP_PORT "${KNOWHOW_SMTP_PORT:-587}"
    appwrite_env_set _APP_SMTP_SECURE "tls"
    appwrite_env_set _APP_SMTP_USERNAME "${KNOWHOW_SMTP_USERNAME:-}"
    appwrite_env_set _APP_SMTP_PASSWORD "${KNOWHOW_SMTP_PASSWORD:-}"
    appwrite_env_set _APP_SYSTEM_EMAIL_ADDRESS "${KNOWHOW_SMTP_SYSTEM_FROM:-${KNOWHOW_SMTP_FROM:-}}"
    appwrite_env_set _APP_SYSTEM_EMAIL_NAME "KnowHow"
    ok "system mail routed over SMTP"
  else
    warn "no SMTP configured; Appwrite cannot send verification or recovery mail"
  fi

  "${ROOT}/scripts/appwrite-restart-policy.sh" "$APPWRITE_DIR" >/dev/null \
    || die "could not write the restart-policy override"
  ok "restart policy applied to every service"

  ( cd "$APPWRITE_DIR" && sudo docker compose up -d ) >/dev/null 2>&1 \
    || die "docker compose up failed in ${APPWRITE_DIR}"

  local waited=0
  until curl -sf -m 5 "${LOCAL_API}/health/version" >/dev/null 2>&1; do
    sleep 3; waited=$((waited+3))
    [ "$waited" -lt 180 ] || die "Appwrite did not become healthy within 3 minutes"
  done

  # Read it back from the container: the file is not proof.
  local live
  live="$(docker exec appwrite printenv _APP_FUNCTIONS_RUNTIMES 2>/dev/null || true)"
  case "$live" in
    *node-22*) ok "node-22 runtime enabled" ;;
    *) die "node-22 is still not enabled; the container reports: ${live:-nothing}" ;;
  esac
}

# ---------------------------------------------------------------------------
phase_provision() {
  step "Appwrite: project, API key, platform"
  local cookies="${ROOT}/.appwrite-console-cookies"
  local console_email="${APPWRITE_CONSOLE_EMAIL:-}"
  local console_password="${APPWRITE_CONSOLE_PASSWORD:-}"
  [ -n "$console_email" ] || die "APPWRITE_CONSOLE_EMAIL is not set in ${CONF}"
  [ -n "$console_password" ] || die "APPWRITE_CONSOLE_PASSWORD is not set in ${CONF}"

  local ch=(-H 'Content-Type: application/json' -H 'X-Appwrite-Project: console')
  # First run creates the console account; later runs simply fail with 409.
  curl -sS -X POST "${LOCAL_API}/account" "${ch[@]}" \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"userId":"unique()","email":sys.argv[1],"password":sys.argv[2],"name":"KnowHow Admin"}))' "$console_email" "$console_password")" \
    -o /dev/null -w '' 2>/dev/null
  rm -f "$cookies"
  curl -sS -c "$cookies" -X POST "${LOCAL_API}/account/sessions/email" "${ch[@]}" \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$console_email" "$console_password")" \
    -o /dev/null || die "could not sign in to the Appwrite console"
  chmod 600 "$cookies"
  ok "console session established"

  local h=(-H 'Content-Type: application/json' -H 'X-Appwrite-Project: console' -b "$cookies")
  local team
  team="$(curl -sS "${LOCAL_API}/teams" "${h[@]}" | python3 -c 'import sys,json;t=json.load(sys.stdin).get("teams",[]);print(t[0]["$id"] if t else "")')"
  if [ -z "$team" ]; then
    team="$(curl -sS -X POST "${LOCAL_API}/teams" "${h[@]}" -d '{"teamId":"unique()","name":"KnowHow"}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("$id",""))')"
  fi
  [ -n "$team" ] || die "could not create or find an organization"

  if curl -sf "${LOCAL_API}/projects/${APPWRITE_PROJECT}" "${h[@]}" >/dev/null 2>&1; then
    ok "project ${APPWRITE_PROJECT} exists"
  else
    curl -sS -X POST "${LOCAL_API}/projects" "${h[@]}" \
      -d "{\"projectId\":\"${APPWRITE_PROJECT}\",\"name\":\"KnowHow\",\"teamId\":\"${team}\"}" \
      -o /tmp/kh-project.json
    python3 -c 'import json,sys;d=json.load(open("/tmp/kh-project.json"));sys.exit(0 if d.get("$id") else 1)' \
      || die "project creation failed: $(head -c 200 /tmp/kh-project.json)"
    rm -f /tmp/kh-project.json
    ok "project ${APPWRITE_PROJECT} created"
  fi

  # Reuse the key if this deployment already has one, so re-running does not
  # invalidate the key the running application is using.
  if [ -z "$(envget APPWRITE_API_KEY)" ]; then
    curl -sS -X POST "${LOCAL_API}/projects/${APPWRITE_PROJECT}/keys" "${h[@]}" \
      -d "{\"keyId\":\"unique()\",\"name\":\"knowhow-app\",\"scopes\":${API_KEY_SCOPES}}" \
      -o /tmp/kh-key.json
    local secret
    secret="$(python3 -c 'import json;print(json.load(open("/tmp/kh-key.json")).get("secret",""))')"
    rm -f /tmp/kh-key.json
    [ -n "$secret" ] || die "could not create the application API key"
    envset APPWRITE_API_KEY "$secret"
    ok "API key created with $(python3 -c "import json;print(len(json.loads(r'''${API_KEY_SCOPES}''')))") scopes"
  else
    # Re-apply the scope list so a key made before a scope was added is fixed.
    local key_id
    key_id="$(curl -sS "${LOCAL_API}/projects/${APPWRITE_PROJECT}/keys" "${h[@]}" \
      | python3 -c 'import sys,json;k=json.load(sys.stdin).get("keys",[]);print(k[0]["$id"] if k else "")')"
    if [ -n "$key_id" ]; then
      curl -sS -X PUT "${LOCAL_API}/projects/${APPWRITE_PROJECT}/keys/${key_id}" "${h[@]}" \
        -d "{\"name\":\"knowhow-app\",\"scopes\":${API_KEY_SCOPES}}" -o /dev/null
      ok "existing API key kept, scopes re-applied"
    fi
  fi

  # Appwrite rejects browser-originated calls from unregistered hostnames.
  local platforms
  platforms="$(curl -sS "${LOCAL_API}/projects/${APPWRITE_PROJECT}/platforms" "${h[@]}" \
    | python3 -c "import sys,json;print(' '.join(p.get('hostname','') for p in json.load(sys.stdin).get('platforms',[])))")"
  case " $platforms " in
    *" ${KNOWHOW_SITE_HOST} "*) ok "web platform already registered" ;;
    *)
      curl -sS -X POST "${LOCAL_API}/projects/${APPWRITE_PROJECT}/platforms" "${h[@]}" \
        -d "{\"platformId\":\"unique()\",\"type\":\"web\",\"name\":\"KnowHow web\",\"hostname\":\"${KNOWHOW_SITE_HOST}\"}" \
        -o /dev/null
      ok "web platform registered for ${KNOWHOW_SITE_HOST}" ;;
  esac
}

# ---------------------------------------------------------------------------
phase_env() {
  step "Environment file"
  if [ ! -f "$ENV_FILE" ]; then
    cp "${ROOT}/.env.controlled.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "created .env.production from the template"
  fi

  local secret
  for key in KNOWHOW_EXPORT_WORKER_SECRET KNOWHOW_RATE_LIMIT_PEPPER KNOWHOW_DELETION_RECEIPT_PEPPER; do
    case "$(envget "$key")" in
      ""|*replace-with*) secret="$(openssl rand -hex 32)"; envset "$key" "$secret"; ok "generated ${key}" ;;
    esac
  done
  case "$(envget KNOWHOW_TOKEN_KEYS_JSON)" in
    ""|*replace-with*)
      envset KNOWHOW_TOKEN_KEYS_JSON "{\"v1\":\"$(openssl rand -hex 32)\"}"
      envset KNOWHOW_TOKEN_ACTIVE_KID "v1"
      ok "generated the token keyring" ;;
  esac

  envset KNOWHOW_ENVIRONMENT "${KNOWHOW_ENVIRONMENT:-production}"
  envset NEXT_PUBLIC_KNOWHOW_ENVIRONMENT "${KNOWHOW_ENVIRONMENT:-production}"
  local release; release="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unversioned)"
  envset KNOWHOW_RELEASE "$release"
  envset NEXT_PUBLIC_KNOWHOW_RELEASE "$release"
  envset KNOWHOW_REGISTRATION_MODE "${KNOWHOW_REGISTRATION_MODE:-private_beta}"
  envset NEXT_PUBLIC_KNOWHOW_REGISTRATION_MODE "${KNOWHOW_REGISTRATION_MODE:-private_beta}"
  envset KNOWHOW_SITE_HOST "$KNOWHOW_SITE_HOST"
  envset APPWRITE_PUBLIC_HOST "$APPWRITE_PUBLIC_HOST"
  envset KNOWHOW_TLS_MODE "$KNOWHOW_TLS_MODE"
  for k in KNOWHOW_SITE_ORIGIN KNOWHOW_WEB_ORIGIN KNOWHOW_ALLOWED_ORIGINS KNOWHOW_PUBLIC_APP_ORIGIN; do
    envset "$k" "https://${KNOWHOW_SITE_HOST}"
  done
  envset KNOWHOW_APPWRITE_HOSTS "$APPWRITE_PUBLIC_HOST"
  envset APPWRITE_ENDPOINT "https://${APPWRITE_PUBLIC_HOST}/v1"
  envset APPWRITE_PROJECT_ID "$APPWRITE_PROJECT"
  envset APPWRITE_NETWORK "$APPWRITE_NETWORK"
  envset APPWRITE_UPSTREAM "${APPWRITE_UPSTREAM:-appwrite-traefik:80}"
  envset KNOWHOW_APPWRITE_INTERNAL_HOSTS "${APPWRITE_INTERNAL_HOST:-appwrite-traefik}"
  envset APPWRITE_INTERNAL_ENDPOINT "http://${APPWRITE_INTERNAL_HOST:-appwrite-traefik}/v1"
  envset KNOWHOW_BUILD_CPUS "${KNOWHOW_BUILD_CPUS:-2}"

  # Workers reach Appwrite over the private network. The endpoint Appwrite
  # injects is derived from _APP_DOMAIN and cannot be overridden by a function
  # variable, so a runtime that cannot resolve or trust that name needs this.
  local gateway
  gateway="$(docker network inspect runtimes --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
  [ -n "$gateway" ] && envset KNOWHOW_APPWRITE_ENDPOINT "http://${gateway}:${APPWRITE_PORT}/v1"

  for k in KNOWHOW_SMTP_HOST KNOWHOW_SMTP_PORT KNOWHOW_SMTP_USERNAME KNOWHOW_SMTP_PASSWORD KNOWHOW_SMTP_FROM; do
    [ -n "${!k:-}" ] && envset "$k" "${!k}"
  done
  for k in KNOWHOW_PLATFORM_OWNER_EMAILS KNOWHOW_SUPPORT_EMAIL KNOWHOW_LEADS_EMAIL; do
    [ -n "${KNOWHOW_OWNER_EMAIL:-}" ] && envset "$k" "$KNOWHOW_OWNER_EMAIL"
  done
  if [ -f "${APPWRITE_DIR}/.env" ]; then
    for k in _APP_DB_USER _APP_DB_PASS _APP_DB_SCHEMA; do
      local v; v="$(sudo sed -n "s/^${k}=//p" "${APPWRITE_DIR}/.env" | tail -1 | tr -d '"')"
      [ -n "$v" ] && envset "$k" "$v"
    done
  fi
  ok "environment written (${ENV_FILE})"

  local left; left="$(grep -cE '^[A-Z_]+=.*(replace-with|example\.com)' "$ENV_FILE" || true)"
  [ "$left" = "0" ] || warn "${left} template placeholder(s) still need a real value"
}

# ---------------------------------------------------------------------------
phase_push() {
  step "Appwrite: schema, buckets, functions"
  command -v appwrite >/dev/null || die "the appwrite CLI is not installed (npm i -g appwrite-cli)"
  local key; key="$(envget APPWRITE_API_KEY)"
  [ -n "$key" ] || die "APPWRITE_API_KEY is not set; run the provision phase first"

  appwrite client --endpoint "$LOCAL_API" --project-id "$APPWRITE_PROJECT" --key "$key" >/dev/null 2>&1 \
    || die "could not configure the appwrite CLI"

  # appwrite.config.json is committed pointing at the local development project.
  # Retarget a copy rather than editing the tracked file.
  python3 - "$APPWRITE_PROJECT" "$LOCAL_API" <<'PY'
import json, sys
config = json.load(open("appwrite.config.json", encoding="utf-8"))
config["projectId"], config["endpoint"] = sys.argv[1], sys.argv[2]
json.dump(config, open("appwrite.config.json", "w", encoding="utf-8"), indent=2)
PY

  appwrite push table --all --force >/dev/null 2>&1 || die "pushing tables failed"
  ok "tables pushed"
  appwrite push bucket --all --force >/dev/null 2>&1 || die "pushing buckets failed (check _APP_STORAGE_LIMIT)"
  ok "buckets pushed"
  appwrite push function --all --force >/dev/null 2>&1 || die "pushing functions failed (check the node-22 runtime)"
  ok "functions pushed"

  NODE_EXTRA_CA_CERTS="${KNOWHOW_CA_BUNDLE:-}" \
    node --env-file="$ENV_FILE" "${ROOT}/scripts/sync-function-variables.mjs" --apply >/dev/null \
    || die "syncing function variables failed"
  ok "function variables synced"
  git -C "$ROOT" checkout -- appwrite.config.json 2>/dev/null || true
}

# ---------------------------------------------------------------------------
phase_app() {
  step "Application"
  docker compose --env-file "$ENV_FILE" up -d --build 2>&1 | tail -3
  local waited=0
  until curl -skf -m 5 "https://${KNOWHOW_SITE_HOST}/api/health" >/dev/null 2>&1; do
    sleep 3; waited=$((waited+3))
    [ "$waited" -lt 240 ] || die "the application did not answer within four minutes"
  done
  ok "application answering on https://${KNOWHOW_SITE_HOST}"
}

# ---------------------------------------------------------------------------
phase_verify() {
  step "Verify"
  local body; body="$(curl -sk -m 30 "https://${KNOWHOW_SITE_HOST}/api/health?ready=1")"
  python3 - <<PY
import json, sys
try:
    d = json.loads(r'''${body}''')
except Exception:
    sys.exit("readiness returned nothing parseable")
print(f"    status: {d['status']}  environment: {d['deployment']['environment']}  release: {d['deployment']['release']}")
for k, v in d["checks"].items():
    print(f"      {k}: {v}")
sys.exit(0 if d["status"] == "ready" else 3)
PY
  case $? in
    0) ok "ready" ;;
    3) warn "not ready — see the checks above"
       info "workerState missing/stale means the operations function has not completed a scheduled run yet; it runs every five minutes" ;;
    *) die "could not read the readiness endpoint" ;;
  esac
  printf '\n%sRemaining, and only a person can do it:%s\n' "$B" "$N"
  info "1. sign up at https://${KNOWHOW_SITE_HOST} and verify the email"
  info "2. node --env-file=.env.production scripts/bootstrap-platform-owner.mjs --email=<you> --confirm"
  info "3. set up backups: scripts/backup.sh, and rehearse scripts/restore.sh once"
}

case "${1}" in
  all)
    for p in $PHASES; do "phase_${p}" || exit 1; done
    printf '
%sDeployment complete.%s
' "$G" "$N" ;;
  *)
    case " $PHASES " in
      *" $1 "*) "phase_$1" ;;
      *) usage; die "unknown phase: $1" ;;
    esac ;;
esac
