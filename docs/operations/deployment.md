# Deployment and update runbook

## Install

1. Install the pinned Appwrite version on the local machine and create project `knowhow-local`.
2. Copy `.env.example` to `.env.local`, generate the required secrets, and keep that file untracked.
3. Configure the Appwrite CLI for `http://localhost/v1` and the local project.
4. Provision the checked-in resources:

   ```text
   npm ci
   npm run appwrite:check
   npx appwrite push tables --force
   npx appwrite push buckets --force
   ```

5. Bootstrap the first local owner with `npm run appwrite:local:owner`.
6. Start Mailpit when local email is needed.
7. Start `npm run workers:local:watch` and `npm run dev` in separate terminals.

## Verify

Run:

```text
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run appwrite:smoke:local
```

Check `/api/health`, then run `npm run workers:local:once` and check `/api/health?ready=1`. Complete a disposable sign-in, guide upload/redaction, review, publication, notification, and export journey before retaining data.

## Update

1. Back up the local Appwrite data and configuration using `backup-restore.md`.
2. Stop the Next.js and worker processes.
3. Install the candidate dependencies and regenerate the manifest.
4. Review manifest drift before pushing schema changes.
5. Start the services and repeat the full verification list.

Never apply a destructive schema downgrade. If an update fails, stop writes, restore the captured local backup into an isolated local instance, and verify it before replacing the active instance.

## Controlled staging or production

Do not infer the provider topology from this repository. Resolve the QHost/provider decision first, then record which service owns Next.js, Appwrite, worker execution, secrets, DNS/TLS, email, monitoring, and backups.

1. Create an isolated Appwrite project and push only the reviewed checked-in resources.
2. Populate `.env.controlled.example` in the deployment secret store. Use exact HTTPS origins, exact Appwrite host allowlists, unique secrets, and the immutable commit/image release ID.
3. Deploy the same release to the Site and workers. The worker readiness response must report that release.
4. Run `npm run release:check` before promotion.
5. With disposable staging credentials, run `KNOWHOW_SMOKE_MODE=controlled npm run appwrite:smoke:controlled`.
6. Require `GET /api/health?ready=1` to return `200` and `status: ready`; do not route traffic when any structured check fails.
7. Complete the authenticated staging journeys and record monitoring, email, redaction, export, lifecycle, purge, and isolated-restore evidence.
8. Promote the immutable artifact/configuration only after all gates pass. Start with private-beta registration.

Paid billing must remain `KNOWHOW_BILLING_PROVIDER=disabled` until a provider adapter, signed raw-body webhook verification, idempotency, reconciliation, cancellation, and entitlement tests are implemented and reviewed.

## Rollback

Roll back application and workers together to the last known-good immutable release. Schema changes must be backward compatible; never attempt a destructive schema downgrade during incident response. Database restoration requires the isolated rehearsal and approval in `backup-restore.md`.
