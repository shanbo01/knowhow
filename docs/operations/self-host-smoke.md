# Self-hosted Appwrite portability smoke

This proves endpoint portability against a fresh local Appwrite installation. It is a development contract test, not a supported customer on-premises package. Capacity planning, upgrades, hardening, backups, monitoring, support, and customer deployment automation remain out of scope.

## Requirements

- Docker Engine and Compose v2 with at least 2 CPU cores, 4 GB RAM, and 2 GB swap available to Appwrite.
- A fresh local Appwrite 1.9.6 installation created with the official Docker installer for the recorded baseline, or a separately reviewed and pinned successor version.
- A disposable project, Web platform for `localhost`, and a project API key with the identity, TablesDB, Storage, Messaging, and Function scopes needed by the smoke and local Site.
- No customer data or production credentials.

Follow the current official installation guide at <https://appwrite.io/docs/advanced/self-hosting/installation>. Pin and record the Appwrite version. The official installer currently exposes its setup wizard on port 20080; complete the wizard locally and close that installer port afterward.

Before provisioning buckets, set the disposable stack's global `_APP_STORAGE_LIMIT` to at least `52428800` bytes, matching the checked-in export-bucket ceiling, and apply the change through that stack's exact Compose project. The stock 30 MB ceiling is too small for the contract.

## Provision the checked-in contract

Configure Appwrite CLI 26.0.0 for the local endpoint, including `/v1`, the disposable project ID, and its API key. Enable self-signed certificates only when the local endpoint actually uses a trusted disposable self-signed certificate.

```text
npx --yes appwrite-cli@26.0.0 client --endpoint http://localhost/v1 --project-id <local-project-id>
npx --yes appwrite-cli@26.0.0 push tables --force
npx --yes appwrite-cli@26.0.0 push buckets --force
npx --yes appwrite-cli@26.0.0 push functions --force
```

Set local Function variables from `.env.example`. A local Messaging provider may be omitted only for the base portability smoke; set `KNOWHOW_SMOKE_REQUIRE_EMAIL_PROVIDER=1` when validating the full adapter configuration.

## Run the contract smoke

Set local-only environment values and start Next.js on `http://localhost:3001` with `KNOWHOW_SMOKE_SITE_ORIGIN` pointing at it. Then run:

```text
npm run appwrite:smoke:self-host
```

The script refuses cloud and nonlocal endpoints. It verifies:

- Appwrite health/version.
- Exact checked-in table IDs, column keys, index keys, empty table permissions, and server-only row policy.
- Both exact private bucket IDs, empty permissions, file security, and encryption.
- Anonymous TablesDB denial.
- TablesDB create/get/update/delete with an isolated `smoke_*` row.
- TablesDB read-your-writes isolation, atomic commit and rollback, stale-write conflict rejection, and deletion of the smoke-owned transaction metadata.
- Private PNG upload/download byte integrity with an isolated file.
- User creation, email/password session creation, returned server session secret, session-authenticated identity, and revocation.
- Messaging-provider API visibility and optional provider presence.
- Optional Next liveness/auth health and anonymous product-API denial.
- Cleanup of the exact transient rows, file, user, session, and smoke-owned transaction records.

The run fails on drift or cleanup-affecting errors and never accepts a Production target. Preserve redacted JSON output, CLI version, Appwrite version, Docker version, release SHA, UTC time, and operator in readiness evidence.

## Teardown

Confirm no `smoke_*` rows, files, or users remain. Remove the disposable Appwrite project/installation through its documented Docker workflow only after evidence review. Do not use broad recursive deletion commands against the workspace or Docker data root.

## Acceptance

Portability evidence is complete only when a fresh instance is provisioned from checked-in resources and Auth, TablesDB, Storage, Messaging-adapter visibility, and the Next API contract all pass.

The 2026-08-11 local portability rehearsal passed on Appwrite 1.9.6 and Docker 29.6.2: 40 tables, 760 columns, 107 indexes, two private buckets, anonymous denial, row CRUD, transactional read-your-writes, commit, rollback, stale-write conflict rejection, private PNG byte integrity, server-session auth, Messaging-adapter visibility, live Next health/auth, and anonymous product-API denial. The exact smoke fixtures, smoke-owned transaction records, API health-check rate-limit row, and its transaction record were removed; zero rows/files/users/transactions were independently verified, and the disposable containers, volumes, project data, key material, and installer directory were removed afterward.
