# Deploying KnowHow on a Linux VPS

This covers the web application: how it is built, how it starts, and how it
comes back after a reboot. Appwrite is deployed separately from its own compose
file; the one change required on that side is in
[Prepare Appwrite](#prepare-appwrite) below.

> **Status.** This document describes what currently exists. Two things are
> still missing before a deployment is fully operable, and each is called out
> where it bites: deploying the two Appwrite Functions, and the deep readiness
> probe. See [Known gaps](#known-gaps).

## What runs

| Container | Image | Ports | Restart |
| --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | 80, 443 published | `unless-stopped` |
| `web` | built from `Dockerfile` | 3000, network-internal only | `unless-stopped` |
| Appwrite | its own compose file | none published | set by Appwrite |

Only Caddy is reachable from the internet. The application has no `ports:`
mapping at all, so there is no route to it that bypasses TLS or the forwarded
header pinning in the `Caddyfile`.

## Prerequisites

- A VPS with Docker Engine and the Compose plugin
- DNS `A` records for two hostnames pointing at the VPS: one for the
  application, one for Appwrite
- Ports 80 and 443 open; port 22 restricted to your key

Enable Docker at boot before anything else. Nothing below survives a reboot
without it:

```bash
sudo systemctl enable --now docker
```

## Prepare Appwrite

Appwrite ships its own Traefik, which binds 80 and 443 by default. Caddy needs
those ports, so Appwrite's proxy has to stop publishing them and be reached over
the Docker network instead.

In Appwrite's `docker-compose.yml`, remove the `ports:` mapping from the
`traefik` service. Leave the service itself alone — Caddy forwards to it by
container name. Then confirm the network name and the container name, and set
`APPWRITE_NETWORK` and `APPWRITE_UPSTREAM` to match:

```bash
docker network ls
docker ps --format '{{.Names}}\t{{.Networks}}'
```

Appwrite must also be told it is behind a TLS-terminating proxy, or it will
generate `http://` URLs and redirect loops. In Appwrite's `.env`:

```
_APP_OPTIONS_FORCE_HTTPS=enabled
_APP_DOMAIN=appwrite.your-domain.com
_APP_DOMAIN_TARGET=appwrite.your-domain.com
```

## Generate secrets

Every value below needs at least 32 random bytes and must be unique to this
deployment. Never copy one from a local profile.

```bash
openssl rand -hex 32
```

Generate a separate value for each of `KNOWHOW_EXPORT_WORKER_SECRET`,
`KNOWHOW_RATE_LIMIT_PEPPER`, `KNOWHOW_DELETION_RECEIPT_PEPPER`, and the key
inside `KNOWHOW_TOKEN_KEYS_JSON`.

Use the `KNOWHOW_TOKEN_KEYS_JSON` keyring rather than the legacy
`KNOWHOW_TOKEN_SIGNING_KEY`. Only the keyring supports rotating a signing key
without invalidating every outstanding invitation and device token at once.

## Configure

Copy the template and fill in every placeholder:

```bash
cp .env.controlled.example .env.production
```

`.env.production` is gitignored and must stay that way. It serves two purposes at
once — Compose reads it for `${...}` substitution, and hands the same values to
the container — which is why every command below passes `--env-file`.

Two settings deserve attention:

**`APPWRITE_INTERNAL_ENDPOINT`** should address Appwrite by container name over
the private network, with the name listed in `KNOWHOW_APPWRITE_INTERNAL_HOSTS`:

```
KNOWHOW_APPWRITE_INTERNAL_HOSTS=appwrite-traefik
APPWRITE_INTERNAL_ENDPOINT=http://appwrite-traefik/v1
APPWRITE_ENDPOINT=https://appwrite.your-domain.com/v1
```

The public endpoint stays HTTPS regardless: browsers, the desktop app, and the
export function all reach Appwrite from outside the network. Only bare DNS
labels are accepted in the internal allowlist — a label has no dot, so it can
never name a public host, and loopback names are rejected outright.

**`KNOWHOW_RELEASE`** must be an immutable identifier. The configuration checker
rejects `local` and `unversioned`. Use the commit you are deploying:

```bash
echo "KNOWHOW_RELEASE=$(git rev-parse --short HEAD)" >> .env.production
```

## Deploy

```bash
docker compose --env-file .env.production up -d --build
```

The build takes several minutes. It compiles the application, builds the capture
extension archive with this deployment's origin baked in, and traces the server
into a standalone runtime.

Caddy obtains certificates on first start. Watch for it:

```bash
docker compose --env-file .env.production logs -f caddy
```

Then confirm the application is serving:

```bash
curl -fsS https://your-domain.com/api/health
```

## Grant the first Administration owner

Platform roles are only writable through the administration API, which itself
requires an existing owner. A fresh deployment therefore has no way in, and this
is it.

Create the account through the normal sign-up flow first and verify its email
address — a controlled deployment will not promote an unverified account. Then:

```bash
docker compose --env-file .env.production run --rm ops \
  scripts/bootstrap-platform-owner.mjs --email=you@your-domain.com --confirm
```

`--confirm` is required outside development, because this grants permanent
administrative access to every workspace on the deployment.

The script refuses to run once any active owner exists. That is what makes it
safe to leave in place: it can create the first owner and never a second. Grant
every later role from Administration, where the change is attributed to the
person who made it.

Note the separate `ops` image. It exists because `node-appwrite` is bundled into
the server output rather than left external, so a script inside the deployed
runtime could not import it.

## Verify the reboot path

This is the step people skip and regret. Do it before there is any real data.

```bash
sudo reboot
```

Wait, reconnect, and check that everything returned without being asked:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
curl -fsS https://your-domain.com/api/health
```

Every container should be `Up`, including Appwrite's. If Appwrite's did not
return, its compose file is missing restart policies or Docker is not enabled at
boot.

## Build-time versus runtime configuration

Next.js inlines every `NEXT_PUBLIC_*` value into the client bundle, and freezes
response headers — including the Content-Security-Policy built from
`APPWRITE_ENDPOINT` — into the routes manifest at build time. Those are build
arguments, so **an image is specific to one environment**, and changing any of
them requires a rebuild rather than a restart.

Secrets are never build arguments. They arrive through `env_file` at run time and
can be rotated with a restart.

## Updating

```bash
git fetch --tags && git checkout <tag>
echo "KNOWHOW_RELEASE=<tag>" >> .env.production   # or edit in place
docker compose --env-file .env.production up -d --build
```

Compose replaces the `web` container and leaves Caddy running, so the only
interruption is the application restart.

Order matters when a release also changes Appwrite resources: push the schema
first, then the functions, then the application. Client version gates come last
and separately — raising `KNOWHOW_EXTENSION_MIN_VERSION` or
`KNOWHOW_DESKTOP_MIN_VERSION` returns `426` to every client below the new
minimum, so only raise them once the new client has been available long enough
to have been installed.

### Rolling back

Images are tagged with the release, so a rollback is a rebuild at the previous
tag. Note that this does **not** roll back Appwrite schema changes — keep column
changes additive so that an application rollback is always safe on its own.

## Known gaps

These are tracked and not yet done. A deployment works without them, but is not
fully operable:

- **The Appwrite Functions are not declared.** `appwrite.config.json` has no
  `functions` section, so the export and operations workers must be created by
  hand with their environment variables and triggers. Without them, exports never
  complete and notification emails are never sent.
- **The deep readiness probe cannot pass.** `/api/health?ready=1` requires a
  worker health service that does not exist yet, so it always returns 503. Point
  uptime monitoring at `/api/health` — the liveness endpoint — until that lands.
