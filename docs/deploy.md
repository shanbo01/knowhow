# Deploying KnowHow on a Linux VPS

This covers the web application: how it is built, how it starts, and how it
comes back after a reboot. Appwrite is deployed separately from its own compose
file; the one change required on that side is in
[Prepare Appwrite](#prepare-appwrite) below.

> **Status.** This document describes what currently exists and has been
> verified. Remaining gaps are listed in [Known gaps](#known-gaps); none of them
> stop a deployment from running.

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

## Check the host first

```bash
./scripts/preflight.sh
```

Read-only: it starts nothing, changes nothing, and prints no secret values. It
checks the things that otherwise fail halfway through a deploy for boring
reasons — memory and disk, Docker enabled at boot, whether anything already
holds 80 and 443, clock sync, DNS, whether `node-22` is enabled in Appwrite, and
whether `.env.production` still contains template placeholders or short secrets.

Run it again after any change on the Appwrite side. Failures block a deploy;
warnings are worth knowing but do not.

Two checks it cannot do from inside the host: whether your cloud firewall
actually allows inbound 80 and 443, and whether the address DNS points at is
this machine. For the second, set `KNOWHOW_EXPECTED_PUBLIC_IP` and it will
verify; otherwise it prints what resolved for you to confirm.

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

Two more settings in that file are required, and both fail late rather than
early if they are missed:

```
_APP_FUNCTIONS_RUNTIMES="node-22,node-16.0,php-8.0,python-3.9,ruby-3.0"
_APP_STORAGE_LIMIT=52428800
```

`node-22` is covered under [the functions](#enable-the-node-runtime-first).
The storage limit matters because `knowhow_exports` declares a 50 MB maximum
file size and Appwrite ships a 30 MB ceiling, so pushing that bucket fails with
`Value must be a valid range between 1 and 30,000,000` — while the other bucket
pushes fine, which makes it look like a problem with one bucket rather than a
project-wide limit.

Recreate the affected containers after editing, since a running container keeps
the values it started with:

```bash
sudo docker compose up -d --force-recreate appwrite appwrite-worker-functions appwrite-worker-builds
docker exec appwrite printenv _APP_FUNCTIONS_RUNTIMES
```

Read the value back from the container rather than the file. It is the only
thing that proves the change took effect.

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

## Deploy the Appwrite Functions

Two functions do the work no web request can: `knowhow-operations` sweeps the
lifecycle, expiries, usage rollups, purges, and the notification queue, and
`knowhow-export` turns queued export jobs into files. Both are declared in
`appwrite.config.json` and pushed with the CLI, which is pinned as a
devDependency so the version cannot drift from the server.

Without them, nothing fails loudly: exports queue forever, invitation and
verification emails are never sent, trials never expire, and deleted workspaces
are never purged.

### Enable the Node runtime first

Appwrite ships with only four runtimes enabled, and Node 22 is not one of them.
Check what your instance actually has:

```bash
npx appwrite functions list-runtimes
```

If `node-22` is absent, add it to `_APP_FUNCTIONS_RUNTIMES` in Appwrite's `.env`
and restart Appwrite. Both functions declare `"engines": { "node": ">=22" }`, so
an older runtime is not a workaround. A push against an instance without it
fails with `Runtime "node-22" is not supported`.

### Push, then supply the variables

```bash
npx appwrite login
npm run appwrite:functions:push
```

The functions' environment variables cannot travel in the config: most are
secrets, and a committed file is the wrong place for a signing key. Sync them
from the deployment's own environment instead. It prints a plan first and
changes nothing until `--apply`:

```bash
node --env-file=.env.production scripts/sync-function-variables.mjs
node --env-file=.env.production scripts/sync-function-variables.mjs --apply
```

Values are never printed — only key names and whether each was created, updated,
or already current. Secrets are rewritten every run, because Appwrite redacts
them on read and an unchanged secret is otherwise indistinguishable from a
rotated one.

Neither function needs an API key variable. Both prefer the dynamic key Appwrite
injects per execution, scoped by the `scopes` array in `appwrite.config.json` —
which is why that array is checked to be non-empty: a function with no scopes
receives a powerless key and fails at run time rather than at push time.

### Confirm the triggers

`knowhow-export` runs on two triggers: a row created in `export_jobs`, and a
five-minute sweep that retries jobs the event missed. `knowhow-operations` runs
on schedule only. Neither is executable over HTTP, which
`npm run appwrite:check` enforces.

```bash
npx appwrite functions list
```

Then queue an export from the application and confirm the file appears.

## Health and readiness

Two endpoints, for two different questions.

`/api/health` is liveness: is this process serving? It touches nothing else, so
it stays green while a dependency is down. **This is what uptime monitoring and
the container health check should watch** — restarting the application because
Appwrite hiccuped would only make an outage longer.

`/api/health?ready=1` is readiness: is the whole deployment able to do its job?
It checks identity, the database, both buckets, configuration, the notification
queue, and whether the operations worker is actually running. Use it after a
deploy, and for alerting that a human should look at something.

Readiness reads Appwrite's own execution history for `knowhow-operations`
rather than asking the worker to report on itself — a worker wedged mid-run
cannot report its own failure, but a missing execution is visible from outside.
**`APPWRITE_API_KEY` therefore needs the `executions.read` scope**, or readiness
reports `workerState: "invalid"` and never goes green.

A red probe names its own cause:

```bash
curl -s 'https://your-domain.com/api/health?ready=1' | jq '.checks'
```

| `workerState` | Meaning |
| --- | --- |
| `ready` | The function completed a scheduled run recently |
| `missing` | It has never run — not deployed, or the schedule is not set |
| `stale` | Its last run is older than 15 minutes; check `workerLastRunSeconds` |
| `failed` | Its last run errored; read the function's logs in Appwrite |
| `invalid` | Readiness could not be established — usually the missing `executions.read` scope |

A queued notification is normal for most of every five-minute cycle, so
readiness only fails on one that has outlived three cycles
(`notificationQueueOverdue`). A queue with work in it is not an unhealthy queue.
Any terminally failed delivery does fail readiness, since nothing retries it.

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

## Backups

Two things cannot be rebuilt from this repository: Appwrite's database, and the
storage volume holding captured screenshots and generated exports. Everything
else — the image, the schema, the functions — is reproducible from a git tag.

```bash
sudo ./scripts/backup.sh
```

The script dumps the database with `--single-transaction`, so it stays
consistent without locking the site, archives the uploads volume, then
**verifies what it wrote**: both archives must be valid gzip streams, and the
dump must be large enough and contain table definitions. A dump that succeeds
against the wrong schema is otherwise indistinguishable from a good one until
the day you need it.

### Send it off the host

A backup on the same disk as the data it protects is not a backup. Set one
destination in `.env.production`; the script warns loudly if neither is set:

```
KNOWHOW_BACKUP_RCLONE_REMOTE=b2:knowhow-backups   # any rclone remote
# or
KNOWHOW_BACKUP_RSYNC_TARGET=user@backup-host:/srv/knowhow
```

Local copies are pruned after `KNOWHOW_BACKUP_KEEP_DAYS` (14 by default).
Off-host copies are never pruned by this script — that retention belongs to the
provider, so the copy that matters most is never deleted by a bug here.

### Run it nightly

```ini
# /etc/systemd/system/knowhow-backup.service
[Unit]
Description=KnowHow backup
After=docker.service

[Service]
Type=oneshot
EnvironmentFile=/opt/knowhow/.env.production
ExecStart=/opt/knowhow/scripts/backup.sh
```

```ini
# /etc/systemd/system/knowhow-backup.timer
[Unit]
Description=Nightly KnowHow backup

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now knowhow-backup.timer
sudo systemctl list-timers knowhow-backup.timer
```

The script exits non-zero on any failure, so a broken backup shows up in
`systemctl status` rather than passing silently.

### Rehearse the restore

Do this once, on a scratch host, **before there is real customer data**. It is
the only step that turns a backup into a safety net.

```bash
./scripts/restore.sh /var/backups/knowhow/<timestamp> --confirm
```

It verifies checksums before touching anything, clears the uploads volume
before unpacking so no orphaned files survive, and refuses to run against
`KNOWHOW_ENVIRONMENT=production` unless the intent is stated a second time.

Afterwards, restart the stack and confirm a guide opens **with its screenshots
loading** — a restored database with an empty volume looks healthy on the
dashboard and is missing every image.

## Known gaps

These are tracked and not yet done. A deployment works without them, but is not
fully operable:

- **No automated backups.** Nothing dumps Appwrite's database or storage
  volumes, and no restore has been rehearsed. Do this before real customer data
  exists, not after.
- **500s carry no stack trace.** `lib/server/telemetry.ts` records only the
  error type, so an unexpected failure in production gives you `"TypeError"` and
  nothing else to work from.
