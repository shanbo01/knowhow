#!/usr/bin/env bash
#
# Checks a host before a KnowHow deployment, so the first `compose up` fails
# for interesting reasons rather than boring ones.
#
#   ./scripts/preflight.sh
#   ./scripts/preflight.sh --env-file .env.production
#
# Read-only: it starts nothing, changes nothing, and prints no secret values.
# Safe to run repeatedly, and worth running again after any change to the
# Appwrite side.
#
# Exit codes: 0 if nothing failed, 1 if any check failed. Warnings never fail
# the run — they are things worth knowing rather than things that stop a deploy.

set -uo pipefail

ENV_FILE=".env.production"
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#*=}"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

PASS=0; WARN=0; FAIL=0
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; N=""
fi

section() { printf '\n%s%s%s\n' "$D" "$1" "$N"; }
pass()  { PASS=$((PASS+1)); printf '  %sPASS%s  %s\n' "$G" "$N" "$1"; }
warn()  { WARN=$((WARN+1)); printf '  %sWARN%s  %s\n' "$Y" "$N" "$1"; }
fail()  { FAIL=$((FAIL+1)); printf '  %sFAIL%s  %s\n' "$R" "$N" "$1"; }
note()  { printf '        %s%s%s\n' "$D" "$1" "$N"; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
section "Host"
# ---------------------------------------------------------------------------
case "$(uname -s)" in
  Linux) pass "Linux $(uname -r)" ;;
  *) fail "this expects Linux; found $(uname -s)" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) pass "architecture ${ARCH}" ;;
  *) warn "unusual architecture ${ARCH}; the base images may not have a matching build" ;;
esac

# The Next.js build runs on this host and is the memory-hungriest thing that
# will ever happen here. Undersizing shows up as an OOM kill partway through a
# build, which reads like a broken Dockerfile rather than a small machine.
if [ -r /proc/meminfo ]; then
  MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  MEM_GB=$(( MEM_KB / 1024 / 1024 ))
  if [ "$MEM_KB" -ge 7500000 ]; then
    pass "memory ${MEM_GB} GB"
  elif [ "$MEM_KB" -ge 3800000 ]; then
    warn "memory ${MEM_GB} GB — enough to run, tight to build on"
    note "if the build is OOM-killed, build the image elsewhere and pull it"
  else
    fail "memory ${MEM_GB} GB — the image build will be killed before it finishes"
    note "either resize the host, or build elsewhere and pull the image"
  fi

  SWAP_KB="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
  if [ "$SWAP_KB" -lt 1 ] && [ "$MEM_KB" -lt 7500000 ]; then
    warn "no swap configured; on a small host it is what turns an OOM kill into a slow build"
  fi
fi

CPUS="$(nproc 2>/dev/null || echo 1)"
pass "${CPUS} CPU$([ "$CPUS" = 1 ] || echo s) — set KNOWHOW_BUILD_CPUS at or below this"

# ---------------------------------------------------------------------------
section "Disk"
# ---------------------------------------------------------------------------
# Screenshots and exports grow without an obvious ceiling, and everything shares
# one disk here: a full disk takes down Appwrite, the app, and the backups at
# the same moment.
check_space() {
  local path="$1" label="$2" avail_kb avail_gb
  [ -d "$path" ] || return 0
  avail_kb="$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$avail_kb" ] || return 0
  avail_gb=$(( avail_kb / 1024 / 1024 ))
  if [ "$avail_kb" -ge 41943040 ]; then
    pass "${label} ${avail_gb} GB free"
  elif [ "$avail_kb" -ge 20971520 ]; then
    warn "${label} ${avail_gb} GB free — enough today, watch it"
  else
    fail "${label} ${avail_gb} GB free — an image build alone can use most of that"
  fi
}
check_space / "root filesystem"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [ -n "$DOCKER_ROOT" ] && [ "$DOCKER_ROOT" != "/var/lib/docker" ]; then
  check_space "$DOCKER_ROOT" "docker root"
fi

# ---------------------------------------------------------------------------
section "Docker"
# ---------------------------------------------------------------------------
if ! have docker; then
  fail "docker is not installed"
else
  if docker info >/dev/null 2>&1; then
    pass "docker daemon reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'version unknown'))"
  else
    fail "docker is installed but the daemon is not reachable by this user"
    note "either start it, or add yourself to the docker group and re-login"
  fi

  if docker compose version >/dev/null 2>&1; then
    pass "compose plugin present"
  else
    fail "the docker compose plugin is missing"
  fi

  # This single line is the difference between a stack that returns after a
  # reboot and one that does not.
  if have systemctl; then
    if systemctl is-enabled docker >/dev/null 2>&1; then
      pass "docker is enabled at boot"
    else
      fail "docker is NOT enabled at boot — nothing comes back after a restart"
      note "sudo systemctl enable --now docker"
    fi
  fi
fi

# ---------------------------------------------------------------------------
section "Clock"
# ---------------------------------------------------------------------------
# The export worker signs requests with a five-minute skew tolerance, and TLS
# is unforgiving of a wrong clock. Drift here surfaces as sporadic 401s that
# look like an auth bug.
if have timedatectl; then
  if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q '^yes$'; then
    pass "clock is NTP-synchronised"
  else
    warn "clock is not NTP-synchronised"
    note "worker auth allows five minutes of skew; TLS allows none"
  fi
else
  note "skipped: timedatectl not available"
fi

# ---------------------------------------------------------------------------
section "Ports"
# ---------------------------------------------------------------------------
port_holder() {
  local port="$1"
  if have ss; then
    ss -ltnp 2>/dev/null | awk -v p=":${port}$" '$4 ~ p {print $NF; exit}'
  fi
}
if ! have ss; then
  note "skipped: ss(1) not available, cannot see what holds 80/443"
fi
for PORT in 80 443; do
  have ss || break
  HOLDER="$(port_holder "$PORT")"
  if [ -z "$HOLDER" ]; then
    pass "port ${PORT} is free for Caddy"
  else
    # Appwrite's Traefik binds these by default and has to give them up.
    if printf '%s' "$HOLDER" | grep -qi 'docker\|traefik'; then
      fail "port ${PORT} is held by a container — Caddy cannot bind it"
      note "remove the ports: mapping from Appwrite's traefik service"
    else
      fail "port ${PORT} is already in use: ${HOLDER}"
    fi
  fi
done
note "inbound 80/443 must also be open in the cloud firewall; that cannot be checked from here"

# ---------------------------------------------------------------------------
section "Environment file"
# ---------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  fail "${ENV_FILE} not found"
  note "cp .env.controlled.example ${ENV_FILE} and fill it in"
else
  pass "${ENV_FILE} present"

  PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '')"
  case "$PERMS" in
    600|400) pass "permissions ${PERMS}" ;;
    "") ;;
    *) warn "permissions ${PERMS} — this file holds every secret; chmod 600 it" ;;
  esac

  # Read values without exporting them into this shell's environment or
  # printing any of them.
  envval() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -1 | tr -d '\r'; }

  MISSING=""
  for KEY in KNOWHOW_ENVIRONMENT KNOWHOW_RELEASE KNOWHOW_SITE_ORIGIN \
             KNOWHOW_SITE_HOST APPWRITE_PUBLIC_HOST APPWRITE_ENDPOINT \
             APPWRITE_PROJECT_ID APPWRITE_API_KEY KNOWHOW_TOKEN_KEYS_JSON \
             KNOWHOW_TOKEN_ACTIVE_KID KNOWHOW_RATE_LIMIT_PEPPER \
             KNOWHOW_EXPORT_WORKER_SECRET KNOWHOW_DELETION_RECEIPT_PEPPER; do
    [ -n "$(envval "$KEY")" ] || MISSING="${MISSING} ${KEY}"
  done
  if [ -n "$MISSING" ]; then
    fail "missing values:${MISSING}"
  else
    pass "every required key has a value"
  fi

  PLACEHOLDER=""
  while IFS='=' read -r KEY VALUE; do
    case "$KEY" in ''|\#*) continue ;; esac
    case "$VALUE" in
      *replace-with*|*example.com*|*your-domain*) PLACEHOLDER="${PLACEHOLDER} ${KEY}" ;;
    esac
  done < "$ENV_FILE"
  if [ -n "$PLACEHOLDER" ]; then
    fail "template placeholders left in:${PLACEHOLDER}"
  else
    pass "no template placeholders remain"
  fi

  SHORT=""
  for KEY in KNOWHOW_RATE_LIMIT_PEPPER KNOWHOW_EXPORT_WORKER_SECRET \
             KNOWHOW_DELETION_RECEIPT_PEPPER; do
    VALUE="$(envval "$KEY")"
    [ -z "$VALUE" ] || [ "${#VALUE}" -ge 32 ] || SHORT="${SHORT} ${KEY}"
  done
  if [ -n "$SHORT" ]; then
    fail "secrets shorter than 32 characters:${SHORT}"
  else
    pass "secrets are long enough"
  fi

  RELEASE="$(envval KNOWHOW_RELEASE)"
  case "$RELEASE" in
    ""|local|unversioned) fail "KNOWHOW_RELEASE is '${RELEASE:-empty}'; the config checker rejects it" ;;
    *) pass "release identity set" ;;
  esac

  ENVIRONMENT="$(envval KNOWHOW_ENVIRONMENT)"
  case "$ENVIRONMENT" in
    staging|production) pass "environment ${ENVIRONMENT}" ;;
    "") fail "KNOWHOW_ENVIRONMENT is unset" ;;
    *) fail "KNOWHOW_ENVIRONMENT is '${ENVIRONMENT}'; a deployed host must be staging or production" ;;
  esac

  case "$(envval APPWRITE_ENDPOINT)" in
    https://*) pass "public Appwrite endpoint is HTTPS" ;;
    "") ;;
    *) fail "APPWRITE_ENDPOINT must be HTTPS on a deployed host" ;;
  esac

  SITE_HOST="$(envval KNOWHOW_SITE_HOST)"
  APPWRITE_HOST="$(envval APPWRITE_PUBLIC_HOST)"
fi

# ---------------------------------------------------------------------------
section "DNS"
# ---------------------------------------------------------------------------
# Every A record, not just the first. A name can legitimately carry several,
# and resolvers reorder them between calls — comparing one address against one
# expectation fails at random rather than when something is actually wrong.
resolve() {
  if have getent; then
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u
  elif have dig; then
    dig +short A "$1" 2>/dev/null | grep -E '^[0-9.]+$' | sort -u
  fi
}
PUBLIC_IP="${KNOWHOW_EXPECTED_PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ] && [ "${KNOWHOW_PREFLIGHT_NO_NET:-}" != "1" ] && have curl; then
  # Best effort, and only an IP echo. Set KNOWHOW_EXPECTED_PUBLIC_IP to skip,
  # or KNOWHOW_PREFLIGHT_NO_NET=1 to make no outbound call at all.
  PUBLIC_IP="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)"
fi
[ -n "$PUBLIC_IP" ] && note "this host appears externally as ${PUBLIC_IP}"

if [ -z "${SITE_HOST:-}${APPWRITE_HOST:-}" ]; then
  # Silence here would read as "DNS is fine" when nothing was actually checked.
  warn "no hostnames configured yet, so nothing was checked"
  note "set KNOWHOW_SITE_HOST and APPWRITE_PUBLIC_HOST in ${ENV_FILE}"
fi
for ENTRY in "site:${SITE_HOST:-}" "appwrite:${APPWRITE_HOST:-}"; do
  LABEL="${ENTRY%%:*}"; HOST="${ENTRY#*:}"
  [ -n "$HOST" ] || continue
  IPS="$(resolve "$HOST")"
  IP_LIST="$(printf '%s' "$IPS" | tr '\n' ' ' | sed 's/ $//')"
  if [ -z "$IPS" ]; then
    fail "${LABEL} hostname ${HOST} does not resolve — Let's Encrypt cannot issue for it"
  elif [ -z "$PUBLIC_IP" ]; then
    pass "${LABEL} hostname ${HOST} resolves to ${IP_LIST}"
    note "confirm that is this host; set KNOWHOW_EXPECTED_PUBLIC_IP to check it automatically"
  elif printf '%s\n' "$IPS" | grep -qxF "$PUBLIC_IP"; then
    pass "${LABEL} hostname ${HOST} resolves to ${PUBLIC_IP}"
  else
    fail "${LABEL} hostname ${HOST} resolves to ${IP_LIST}, which does not include ${PUBLIC_IP}"
  fi
done

# ---------------------------------------------------------------------------
section "Appwrite"
# ---------------------------------------------------------------------------
if have docker && docker info >/dev/null 2>&1; then
  NETWORK="$(sed -n 's/^APPWRITE_NETWORK=//p' "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r')"
  NETWORK="${NETWORK:-appwrite}"
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    pass "network '${NETWORK}' exists"
  else
    fail "network '${NETWORK}' not found"
    note "check 'docker network ls' and set APPWRITE_NETWORK to match"
  fi

  RUNNING="$(docker ps --filter name=appwrite --format '{{.Names}}' 2>/dev/null | wc -l)"
  if [ "$RUNNING" -gt 0 ]; then
    pass "${RUNNING} Appwrite container(s) running"
  else
    fail "no Appwrite containers are running"
  fi

  # Both worker functions declare engines.node >= 22, and Appwrite ships with
  # only four runtimes enabled — none of them Node 22.
  RUNTIMES="$(docker exec appwrite printenv _APP_FUNCTIONS_RUNTIMES 2>/dev/null || true)"
  if [ -z "$RUNTIMES" ]; then
    warn "could not read _APP_FUNCTIONS_RUNTIMES from the appwrite container"
    note "verify with: npx appwrite functions list-runtimes"
  elif printf '%s' "$RUNTIMES" | grep -q 'node-22'; then
    pass "node-22 runtime is enabled"
  else
    fail "node-22 is not in _APP_FUNCTIONS_RUNTIMES — the functions cannot be pushed"
    note "add it in Appwrite's .env and restart Appwrite"
  fi

  # A backup that cannot find its database is not a backup.
  DB_CONTAINER="$(sed -n 's/^KNOWHOW_BACKUP_DB_CONTAINER=//p' "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r')"
  DB_CONTAINER="${DB_CONTAINER:-appwrite-mariadb}"
  if docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    pass "database container '${DB_CONTAINER}' found"
  else
    warn "database container '${DB_CONTAINER}' not found; backups would fail"
  fi
else
  note "skipped: docker is not usable, so Appwrite cannot be inspected"
fi

# ---------------------------------------------------------------------------
printf '\n%s%d passed, %d warning(s), %d failure(s)%s\n' "$D" "$PASS" "$WARN" "$FAIL" "$N"
if [ "$FAIL" -gt 0 ]; then
  printf '%sNot ready to deploy.%s Fix the failures above and run this again.\n' "$R" "$N"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf '%sReady, with caveats.%s\n' "$Y" "$N"
else
  printf '%sReady to deploy.%s\n' "$G" "$N"
fi
