# Production-readiness report

Status: **application release gates implemented; infrastructure certification pending**.

## Supported runtime

- Development runs Next.js on `http://localhost:3001` and Appwrite on the local machine at `http://localhost/v1` in project `knowhow-local`.
- Staging/production require exact HTTPS application origins and Appwrite `/v1` endpoints on `KNOWHOW_APPWRITE_HOSTS`.
- TablesDB uses `knowhow_core`; private media and exports use the two checked-in private buckets.
- Controlled workers must expose an authenticated readiness endpoint that reports the deployed release. Mailpit remains development-only.
- Online billing is deliberately disabled. Pro/Enterprise requests create sales leads and cannot grant paid entitlements.

The application now has provider-neutral controlled-environment validation, but the QHost topology, managed-service ownership, network boundaries, backup commands, and restore evidence remain deliberately undecided until the infrastructure review.

## Verification boundary

`npm run release:check` provides type checking, zero-warning linting, a production Next.js build, unit and extension tests/builds, Appwrite manifest/query-index drift checks, secret and dependency scans, browser journeys, accessibility checks, visual-system coverage, and the configured load boundary. The controlled contract smoke additionally verifies a deployed Appwrite schema, transactions, Auth, private Storage, anonymous denial, application readiness, and exact fixture cleanup.

## Before a controlled release

1. Resolve the QHost/provider topology and record ownership of the Site, Appwrite, workers, secrets, email, monitoring, backups, and DNS/TLS.
2. Populate `.env.controlled.example` through the deployment secret store using unique staging values and an immutable release ID.
3. Run `npm run release:check` against the candidate revision.
4. Deploy to isolated staging, then run `KNOWHOW_SMOKE_MODE=controlled npm run appwrite:smoke:controlled`.
5. Confirm `/api/health` is live and `/api/health?ready=1` reports every Appwrite, Storage, worker, notification, and configuration check ready.
6. Rehearse sign-in, invitation, capture/redaction, review, publication, notification, export, lifecycle, and deletion using disposable data.
7. Complete and record an isolated backup/restore rehearsal before accepting real customer data.

## Open operational work

- Select and document the QHost deployment topology and provider responsibilities.
- Record provider-specific backup commands, retention, encryption, and a successful isolated restore with recovery observations.
- Verify production DNS/TLS, secret rotation, monitoring delivery/scrubbing, email delivery, and worker scheduling.
- Complete legal review before accepting any real customer or regulated data.
- Re-run the checks after every Appwrite, Node.js, browser, extension, or schema upgrade.

Passing application tests are an engineering checkpoint, not production certification. Production remains blocked until the infrastructure and restore gates above have evidence.
