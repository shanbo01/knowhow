#!/usr/bin/env bash
#
# Gives every Appwrite service a restart policy.
#
#   sudo ./scripts/appwrite-restart-policy.sh /path/to/appwrite
#
# Appwrite's own compose file declares `restart:` on only some of its services.
# On a stock 1.9 install the core ones — appwrite, redis, traefik, and the
# function workers — have no policy at all, and mongodb has `on-failure`, which
# does not fire after a clean shutdown. A host reboot therefore leaves most of
# the stack down, while anything with `unless-stopped` comes back.
#
# That asymmetry is easy to miss: the site answers, because the web tier
# restarted, and the failure only shows up as workers that never run.
#
# This writes a docker-compose.override.yml alongside Appwrite's own compose,
# so it survives an Appwrite upgrade rather than being overwritten by one.

set -euo pipefail

APPWRITE_DIR="${1:-}"
[ -n "${APPWRITE_DIR}" ] || { echo "usage: $0 /path/to/appwrite" >&2; exit 2; }
COMPOSE="${APPWRITE_DIR}/docker-compose.yml"
[ -f "${COMPOSE}" ] || { echo "no docker-compose.yml in ${APPWRITE_DIR}" >&2; exit 1; }

OVERRIDE="${APPWRITE_DIR}/docker-compose.override.yml"

python3 - "${COMPOSE}" > "${OVERRIDE}" <<'PY'
import re, sys

source = open(sys.argv[1], encoding="utf-8").read()
services, inside = [], False
for line in source.split("\n"):
    if line.startswith("services:"):
        inside = True
        continue
    if inside:
        # A non-indented line ends the services block.
        if line and not line.startswith((" ", "\t")):
            break
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if match:
            services.append(match.group(1))

if not services:
    sys.exit("no services found; is this an Appwrite compose file?")

print("# Written by scripts/appwrite-restart-policy.sh.")
print("#")
print("# Appwrite's compose sets a restart policy on only some services, so a")
print("# host reboot leaves most of the stack down. This gives every service the")
print("# same policy the KnowHow stack uses. It is a separate file so an Appwrite")
print("# upgrade does not discard it.")
print("services:")
for name in services:
    print(f"  {name}:")
    print("    restart: unless-stopped")
print(f"# {len(services)} services", file=sys.stderr)
PY

COUNT="$(grep -c 'restart: unless-stopped' "${OVERRIDE}")"
echo "wrote ${OVERRIDE} covering ${COUNT} services"
echo
echo "Apply it, then confirm from the containers rather than the file:"
echo "  cd ${APPWRITE_DIR} && docker compose up -d"
echo "  docker inspect appwrite --format '{{.HostConfig.RestartPolicy.Name}}'"
echo
echo "Then reboot the host on purpose and watch the stack return unattended."
