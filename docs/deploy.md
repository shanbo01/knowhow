# Deploying KnowHow

One command stands up a deployment:

```bash
cp deploy.conf.example deploy.conf   # edit it
./scripts/deploy.sh all
```

Everything below explains what that does, what it cannot do for you, and how to
run the deployment afterwards. If you are in a hurry, read
[Before you start](#before-you-start) and [What it cannot do](#what-it-cannot-do-for-you);
the rest is reference.

---

## What runs

| Container | Image | Ports | Restart |
| --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | 80 and 443, published | `unless-stopped` |
| `web` | built from `Dockerfile` | 3000, network-internal only | `unless-stopped` |
| Appwrite | its own compose file | 8080/8443, so Caddy can have 80/443 | `unless-stopped` |

Caddy is the only process reachable from the internet. The application declares
no published port at all, so there is no route to it that bypasses TLS or the
forwarded-header pinning in the `Caddyfile`.

---

## Before you start

**A host.** Linux, Docker with the Compose plugin, and Docker enabled at boot:

```bash
sudo systemctl enable --now docker
```

8 GB of memory is comfortable and 4 GB is the floor — the image build is the
heaviest thing that will ever run there, and an undersized host shows up as an
OOM kill partway through a build that reads like a broken Dockerfile.

**Two hostnames**, both resolving to the machine, with 80 and 443 open in the
cloud firewall. Certificates cannot be issued before DNS is live. For a test rig
with no domain, `sslip.io` resolves `app.203-0-113-10.sslip.io` to `203.0.113.10`
with no registration, and `KNOWHOW_TLS_MODE="internal"` makes Caddy sign its own
certificate so no ACME is involved at all.

**`deploy.conf`.** Copy the example and fill it in. It is sourced by the shell,
so **quote every value** — an unquoted `KnowHow <mail@example.com>` is read as a
redirect and will not parse.

---

## The phases

`./scripts/deploy.sh all` runs these in order and stops at the first failure.
Each is idempotent, so fix the problem and run the same command again — there is
nothing to unpick. Any phase can also be run alone:

| Phase | What it does |
| --- | --- |
| `preflight` | Memory, disk, Docker at boot, ports, clock, DNS, config sanity |
| `appwrite` | Installs Appwrite on non-conflicting ports; sets the runtimes, storage limit, domain, SMTP, and restart policies |
| `provision` | Console account, project, API key with the right scopes, web platform |
| `env` | Generates `.env.production` and its secrets |
| `push` | Tables, buckets, functions, function variables |
| `app` | Builds the image and starts the stack behind Caddy |
| `verify` | Reads the readiness endpoint and reports what is left |

```bash
./scripts/deploy.sh --list
./scripts/deploy.sh push        # just re-push the schema and functions
```

### What each phase gets right that is easy to get wrong

These are the things that cost hours when done by hand. The script does them so
you do not have to know them, but they are worth knowing when something breaks.

**The API key needs `sessions.write`.** The application creates sessions on a
user's behalf server-side. Without that scope every sign-in fails with *"The
email or password is incorrect"* while the credentials are perfectly good — a
deployment that looks healthy and cannot log anyone in. It also needs
`executions.read` for the readiness probe, and the older `collections.*`,
`attributes.*` and `documents.*` names alongside the `tables.*` ones, because
pushing the schema uses the legacy spelling internally.

**Appwrite does not enable Node 22.** A stock install offers four runtimes and
none of them is `node-22`, which both workers require. The `appwrite` phase sets
`_APP_FUNCTIONS_RUNTIMES` and then reads the value back *from the container*,
because the file is not proof that a running process picked it up.

**The storage ceiling is below what the schema asks for.** `knowhow_exports`
declares a 50 MB maximum file size against Appwrite's 30 MB default, so that one
bucket fails to push while the other succeeds — which looks like a bad bucket
rather than a project-wide limit.

**Appwrite does not survive a reboot out of the box.** Its compose sets a restart
policy on only some services; the core ones have none, and its database has
`on-failure`, which does not fire after a clean shutdown. The host comes back
with the site answering and every worker silently absent. The phase writes a
`docker-compose.override.yml` beside Appwrite's own compose so an upgrade does
not discard the fix.

**Workers cannot reach the API by default.** Appwrite derives
`APPWRITE_FUNCTION_API_ENDPOINT` from `_APP_DOMAIN` and overwrites any function
variable of that name, so a worker cannot be redirected through configuration.
On a default install that value is `localhost`, which inside a function
container is the container itself. The `env` phase sets
`KNOWHOW_APPWRITE_ENDPOINT` to the Docker gateway, which both workers prefer.

**Never update a function with a partial `PUT`.** Appwrite replaces the whole
resource, so a call that omits `scopes` strips them and the next scheduled run
fails with `missing scopes`. Change functions through `appwrite.config.json` and
re-run the `push` phase.

---

## What it cannot do for you

Three things need a person.

**1. DNS and the firewall.** Preflight checks that the names resolve here, but
it cannot open a cloud firewall or create a record.

**2. The first owner.** Administration is only reachable by someone holding an
owner role, and the first one cannot be granted from inside the product. Sign up
through the site, verify the email, then:

```bash
node --env-file=.env.production scripts/bootstrap-platform-owner.mjs \
  --email=you@example.com --confirm
```

It refuses once any active owner exists, so it can create the first and never a
second. Every later role is granted from Administration, where the change is
attributed to whoever made it.

**3. Backups.** See below. Nothing else on this page matters as much.

---

## Email

Two transports, and they cover different recipients.

**Appwrite sends verification and password-recovery mail** using the `_APP_SMTP_*`
settings, which the `appwrite` phase writes from your `KNOWHOW_SMTP_*` values.

**The application sends invitations** to people who do not yet have an account —
the one message it delivers itself. That path uses `KNOWHOW_SMTP_*` when set and
falls back to Resend otherwise. SMTP is the only option an air-gapped or
on-premises install has.

Setting `KNOWHOW_SMTP_HOST` and `KNOWHOW_SMTP_FROM` satisfies the configuration
check; so does `RESEND_API_KEY`. Neither being set is what makes readiness report
a configuration failure.

---

## Health and readiness

Two endpoints, for two different questions.

`/api/health` is **liveness**: is this process serving? It touches nothing else,
so it stays green while a dependency is down. Point uptime monitoring and the
container health check here — restarting the application because Appwrite
hiccuped only makes an outage longer.

`/api/health?ready=1` is **readiness**: can the deployment do its job? It checks
identity, the database, both buckets, configuration, the notification queue, and
whether the operations worker is actually running.

Readiness reads Appwrite's own execution history rather than asking the worker to
report on itself — a worker wedged mid-run cannot report its own failure, but a
missing execution is visible from outside. A red probe names its cause:

| `workerState` | Meaning |
| --- | --- |
| `ready` | Completed a scheduled run recently |
| `missing` | Never run — not deployed, or no schedule |
| `stale` | Last run older than 15 minutes; see `workerLastRunSeconds` |
| `failed` | Last run errored; read the function's logs in Appwrite |
| `invalid` | Cannot be established — usually a missing `executions.read` scope |

A queued notification is normal for most of every five-minute cycle, so readiness
only fails on one that has outlived three cycles. A queue with work in it is not
an unhealthy queue.

---

## Backups

Two things cannot be rebuilt from this repository: Appwrite's database, and the
volume holding screenshots and generated exports.

```bash
sudo ./scripts/backup.sh
```

It detects the database engine from the running container, dumps it, archives the
uploads volume, and then **verifies what it wrote** — both archives must be valid
gzip, and the dump must be large enough and actually contain the schema. A dump
taken against the wrong database is otherwise indistinguishable from a good one
until the day you need it.

Set one off-host destination in `.env.production`, or the backup sits on the same
disk as the data it protects:

```
KNOWHOW_BACKUP_RCLONE_REMOTE="b2:knowhow-backups"
# or
KNOWHOW_BACKUP_RSYNC_TARGET="user@backup-host:/srv/knowhow"
```

Run it nightly with a systemd timer:

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

### Rehearse the restore

Do it once, on a **separate** host, before there is real data.

```bash
./scripts/restore.sh /var/backups/knowhow/<timestamp> --confirm
```

Do not rehearse on the host you are about to deploy to. Restoring drops and
recreates every collection underneath a running Appwrite, which can leave it
unable to create projects afterwards.

Afterwards, confirm a guide opens **with its screenshots loading**. A restored
database with an empty volume looks perfectly healthy on the dashboard and is
missing every image.

---

## Updating

```bash
git fetch --tags && git checkout <tag>
./scripts/deploy.sh all
```

The `env` phase re-stamps `KNOWHOW_RELEASE` from the checked-out commit, and
`app` rebuilds and replaces the container while Caddy keeps running.

`NEXT_PUBLIC_*` values and the Content-Security-Policy are compiled into the
build, so **changing the environment or a public URL needs a rebuild, not a
restart**. Secrets arrive at run time and only need a restart.

Client version gates come last and separately. Raising
`KNOWHOW_EXTENSION_MIN_VERSION` or `KNOWHOW_DESKTOP_MIN_VERSION` returns `426` to
every client below the new minimum. A browser-store extension auto-updates within
days; a downloaded archive never updates itself, so raising the minimum locks
those users out until each re-downloads. Until a store listing exists, treat that
variable as frozen.

### Rolling back

Images are tagged with the release, so a rollback is a rebuild at the previous
tag. It does **not** roll back Appwrite schema changes — keep column changes
additive so an application rollback is always safe on its own.

---

## Known gaps

- **No automated backups until you configure them.** The script exists; the timer
  is yours to install, and the restore is yours to rehearse.
- **`scripts/deploy.sh` assumes Appwrite lives on the same host.** A managed or
  remote Appwrite works, but the `appwrite` phase has nothing to configure and
  should be skipped.
