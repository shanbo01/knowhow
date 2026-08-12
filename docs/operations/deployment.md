# Deployment and rollback runbook

Status: controlled runbook. Execute once for Frankfurt Staging and again for clean Frankfurt Production. Record operator, UTC timestamps, release SHA, Appwrite project ID, Site deployment ID, Function deployment IDs, and links to evidence in `docs/readiness-report.md`.

## Release invariants

- Staging and Production are separate, empty Appwrite projects in `fra.cloud.appwrite.io`.
- Production is on Appwrite Pro before external access and has a daily database backup policy.
- `knowhow_core`, `knowhow_private_media`, `knowhow_exports`, `knowhow_web`, `knowhow_ops`, and `knowhow_export` retain those stable IDs.
- All table and bucket permissions are empty. Browsers never receive a TablesDB, Storage, or server API credential.
- Production has no customer organization until the final synthetic rehearsal has passed and its synthetic tenant has been purged.
- Public signup, payments, the future 14-day trial, SSO/SCIM, and regulated-data use remain disabled.

## Owner checkpoints

Before the first deployment, the owner must provide:

1. Clean Frankfurt Staging and Production projects and a Production Pro subscription.
2. Domain/DNS control and exact canonical HTTPS origins.
3. Resend sender/domain verification with SPF, DKIM, and DMARC evidence.
4. Sentry projects, alert destinations, and build-only source-map credentials.
5. Unlisted Chrome and Edge listings with stable production IDs.
6. Company incorporation plus approved and executable pilot, privacy, DPA, acceptable-use, and subprocessor documents.

Do not accept real customer data while any checkpoint is open.

## Pre-deployment gate

From a clean checkout of the candidate SHA:

```text
npm ci
npm test
npm run test:e2e
npm run load:pilot
```

Review `npm audit` and secret-scan output, confirm generated Appwrite resources are unchanged, and verify the extension artifact was built from the same SHA. A failed, skipped-without-justification, or stale result blocks promotion.

After the candidate Site and Functions are deployed, dispatch `.github/workflows/controlled-release-gates.yml` with `target` set to `staging` or `production` and `release_sha` set to the exact 40-character deployed commit SHA. The selected GitHub environment must require its appropriate reviewers and contain the environment-specific Appwrite smoke key, Site origin, synthetic browser accounts/TOTP seeds, dedicated network-load actor manifest, and release-evidence HMAC key. Repository variables `APPWRITE_STAGING_PROJECT_ID` and `APPWRITE_PRODUCTION_PROJECT_ID` are the independently reviewed project bindings. This workflow cannot silently skip missing credentials: it verifies the immutable checkout, repeats `npm test` and the local load boundary, runs the target-specific exact Appwrite contract/cleanup smoke, completes the credentialed two-user browser rehearsal, and seals the real network-load result. Its green result does not replace email/Sentry/store observation, backup/restore, Production purge, legal, or sign-off evidence below.

## Configure the Appwrite project

Use Appwrite CLI 26.0.0 or the version pinned by the release record. Configure its endpoint, project ID, and an environment-specific API key through the approved secret runner; never paste keys into documentation, Git, CI logs, or shell transcripts.

```text
npx --yes appwrite-cli@26.0.0 client --endpoint https://fra.cloud.appwrite.io/v1 --project-id <environment-project-id>
npx --yes appwrite-cli@26.0.0 push tables --force
npx --yes appwrite-cli@26.0.0 push buckets --force
npx --yes appwrite-cli@26.0.0 push functions --force
npx --yes appwrite-cli@26.0.0 push sites --force
```

The CLI client must also hold the environment API key before the pushes. Keep `appwrite.config.json` at `projectId: environment_specific`; do not commit a real project ID.

Configure Auth in the console:

- Email/password enabled, password minimum 12 characters, common/compromised password protection enabled where available.
- Exact Web platform hostname and verification/recovery callbacks; no wildcard production origins.
- Verification required by KnowHow before product access.
- Conservative session duration and session-count limit; test global and individual revocation.
- MFA available; KnowHow requires TOTP for platform and workspace administrators and before administrator appointments are accepted.

Configure server API keys with the minimum scopes required by the Site or each Function. The Site needs identity, TablesDB, Storage, Functions-read, and Messaging access used by its server routes. Functions receive only the current granular scopes declared in `appwrite.config.json`: `knowhow_export` has `rows.read`; `knowhow_ops` has row/file read-write, `messages.write`, and user read-write. `knowhow_ops` alone receives `users.write`, solely so an approved purge can remove an Auth account after proving that no remaining table references it and that it has no platform role. Each Function consumes Appwrite's per-execution dynamic key from `x-appwrite-key`; a local environment-key fallback exists only for controlled Function emulation. Compare the manifest to Appwrite's current [API-key scope catalog](https://appwrite.io/docs/partners/project/api-keys) during every release, and rotate or revoke any deployment key that is broader than its runtime purpose.

Create a separate short-lived contract-smoke key with exactly `databases.read`, `tables.read`, `columns.read`, `indexes.read`, `rows.read`, `rows.write`, `buckets.read`, `files.read`, `files.write`, `users.read`, `users.write`, `sessions.write`, `providers.read`, `functions.read`, and `sites.read`. These scopes cover exact schema/resource inspection plus transient row/file/user/session fixtures; they do not grant schema, bucket, Function, Site, provider, key, or project mutation. Revoke the key after each controlled smoke.

## Environment settings

Set the variables in `.env.example` separately on the Site and Functions. In controlled environments:

- `KNOWHOW_ENVIRONMENT` and its public counterpart are exactly `staging` or `production`.
- `APPWRITE_ENDPOINT` is exactly `https://fra.cloud.appwrite.io/v1`.
- Origins are exact HTTPS values; extension origins use exact 32-character Chromium IDs.
- Token keys are a versioned keyring. Rotation adds a new key ID, deploys it as active, retains the previous verification key through the longest token lifetime, then removes the old key in a later release.
- Notification credential encryption and token signing use the same versioned source keyring with domain-separated cryptographic keys.
- `KNOWHOW_EXPORT_WORKER_SECRET` is identical on the Site and export Function, at least 32 random bytes, and distinct between environments.
- Sentry has `sendDefaultPii` disabled and low trace sampling. Resend and deletion receipt secrets exist only on `knowhow_ops`.
- Both unlisted store URLs are configured. Controlled readiness reports `extension_install_urls` if either is absent.

Set Function variables after resource creation. Do not place secret values in the checked-in `vars` arrays.

## Deploy and verify Staging

1. Push TablesDB and buckets. Run `npm run appwrite:check`, then `npm run appwrite:smoke:staging` with the short-lived smoke key. Bind `KNOWHOW_SMOKE_EXPECTED_PROJECT_ID` to the reviewed Staging project ID, `KNOWHOW_SMOKE_FORBIDDEN_PROJECT_ID` to the distinct Production project ID, `KNOWHOW_SMOKE_MUTATION_CONFIRM=staging-transient-fixtures`, and `KNOWHOW_SMOKE_EXPECTED_RELEASE` to the candidate SHA. The smoke refuses a local/Production/mismatched target, verifies the exact database/table/column/index/bucket/Function/Site contracts and latest live deployments, validates the Site's environment/project/release identity and anonymous denials, then proves every `smoke_*` fixture was removed.
2. Deploy Functions and confirm schedules/events, current deployments, declared scopes, and structured completion logs.
3. Deploy the Site and require `GET /api/health` and `GET /api/health?ready=1` to return 200. Preserve their `x-request-id` values in evidence.
4. Confirm unauthenticated product, media, export, audit, and extension endpoints deny access; verify CSRF and origin failures on mutations.
5. Build store artifacts with the exact Staging origin. Inspect the packaged manifest, install from the controlled listing, pair, capture one redacted workflow, revoke the device, and confirm the token no longer works.
6. Run the credentialed Playwright gate sequentially in the installed current stable Google Chrome and Microsoft Edge channels with the two synthetic accounts, their TOTP seeds, workspace slug, and published guide ID from the secret runner: `npx playwright test e2e/controlled-rehearsal.spec.ts --project=chrome --project=edge --workers=1`. The gate rejects an immediate post-password dashboard, requires a fresh TOTP challenge for both users in each browser, and after each journey directly proves the exact pre-logout Appwrite session returns `401`. Then complete and record the full two-user activation rehearsal: invitation, verified email, required administrator MFA, onboarding, capture, edit, review, publication, second-user view/completion, support, authorized export, suspension/recovery, and deletion-approval dry run.
7. Provision exactly three dedicated Staging load workspaces with distinct verified, TOTP-enabled creator actors, tenant-specific published sentinel guides, and at least 100 synthetic members per workspace. Store the actor emails, passwords, TOTP seeds, workspace IDs, sentinel guide IDs, and sentinel search terms only in `KNOWHOW_NETWORK_LOAD_ACTORS_JSON` in the approved secret runner. Set the exact Frankfurt endpoint, Site/project/release, pinned extension origin/version, synthetic email domain, `KNOWHOW_NETWORK_LOAD_CONFIRM=staging-synthetic-network-load`, both synthetic/dedicated attestations, an HMAC key/key ID, and a unique private evidence path. Run `npm run load:controlled`, then independently run `npm run load:controlled:evidence:verify`. The gate requires a fresh TOTP challenge for every actor; performs warm-up and mutual cross-workspace denial probes, 110 concurrent authorized reads per tenant, 12 concurrent redacted capture upload/discard pipelines per tenant, exact request-ID accounting, zero-error and p95 budgets, idempotent discards, and old extension-token denial; and directly requires every pre-logout Appwrite session secret to return `401` from Frankfurt. It retains only HMAC fingerprints and aggregate timings in an exact-field immutable report; discarded/quarantined synthetic rows remain purge targets. Record Function queue depth/failures plus Appwrite and Sentry graphs for the exact `startedAt`/`generatedAt` window and attach their private references to the release record.
8. Resolve every P0/P1 issue and repeat affected tests.

## Promote to Production

Production is a fresh project, not a clone containing Staging data. Repeat configuration checks, then run `npm run appwrite:smoke:production` with the short-lived smoke key, expected/forbidden project bindings reversed, `KNOWHOW_SMOKE_MUTATION_CONFIRM=production-transient-fixtures`, both `KNOWHOW_SMOKE_SYNTHETIC_ONLY=1` and `KNOWHOW_SMOKE_FINAL_PRODUCTION=1`, and the candidate release SHA. The command still creates only random `smoke_*` fixtures and must prove their exact cleanup. Then:

1. Confirm Pro status and successful daily-backup policy.
2. Using the same two verified, TOTP-enabled synthetic Auth accounts that will be removed by the final clean-state gate, create two distinct dedicated load workspaces with one tenant sentinel each. They may also share a separate journey workspace, but neither actor may belong to the other actor's load workspace. Configure the Production actor manifest with exactly those two users, `KNOWHOW_NETWORK_LOAD_EXPECTED_TENANTS=2`, `KNOWHOW_NETWORK_LOAD_MINIMUM_MEMBERS=1`, `KNOWHOW_NETWORK_LOAD_CONFIRM=production-synthetic-network-load`, and all three controlled attestations. Run and independently verify the same sealed `load:controlled` gate, including fresh TOTP and direct server-session revocation proof. Preserve Appwrite/Sentry observations for its exact window and include every load/journey organization and workspace in the eventual purge targets.
3. Capture HMAC-sealed source evidence with `npm run appwrite:backup:capture`, restore to a new unreferenced database ID, and pass `npm run appwrite:restore:verify`. From the exact release, create the separately access-controlled disposable Site defined in `backup-restore.md`, point only that Site at the new `knowhow_restore_*` database, and run `npm run appwrite:restore:application` followed by an independent `npm run appwrite:restore:application:evidence:verify`. Retain both chained HMAC reports. The application gate must prove exact disposable Site-ID/configured-origin/source-origin and restored-database/restoration readiness, verified MFA identity, own/cross-tenant and organization-metadata separation, a real idempotent transaction, audit sequencing, a queued isolated export, anonymous denial, direct Appwrite server-session revocation, and full verification within 24 elapsed hours. A second operator must then delete the exact restored database and disposable Site and run the read-only `npm run appwrite:restore:cleanup:verify` plus offline `npm run appwrite:restore:cleanup:evidence:verify`; the third chained HMAC report must prove `knowhow_core`/`knowhow_web` still exist and both disposable resources do not. The database verifier alone is not application RTO evidence.
4. Confirm canonical DNS, TLS, email authentication, Sentry alerts, and both production store listings.
5. Rehearse the full journey with the same two synthetic users only.
6. Approve and execute the synthetic tenant purge. The worker must freeze exact row/file targets, delete—not tombstone—the workspace, subscription, and final organization roots, remove only Auth users with no surviving reference, and retain only a scalar-scrubbed receipt whose organization, workspace, and approving-actor values are HMAC hashes.
7. Create a short-lived read-only verification key with exactly `rows.read`, `files.read`, and `users.read`. Bind `KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID` to the reviewed Production project, `KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID` to the distinct Staging project, and `KNOWHOW_CLEANUP_EXPECTED_RELEASE` to the exact deployed 40-character SHA. Set `KNOWHOW_CLEANUP_TARGETS_JSON` to every load/journey receipt mapping (`caseId`, `organizationId`, `workspaceId`, and expected `organizationDeleted`), set `KNOWHOW_CLEANUP_USER_IDS_JSON` to exactly the two rehearsal Auth user IDs, set both cleanup attestations to `1`, and run `npm run appwrite:production:cleanup:verify`. The gate accepts only the exact Frankfurt endpoint, reviewed Production project/release, `knowhow_core`, both stable private buckets, and final Production attestation; it disables row caching and requires zero organization/workspace roots, zero customer-scoped or raw rehearsal-identifier residues across all 40 tables, both users absent, both private buckets empty, and valid content-free receipts. Store its immutable HMAC-sealed output outside the repository or beneath ignored `.tmp/`; have the independent reviewer run `npm run appwrite:production:cleanup:evidence:verify` with the expected bindings but no Appwrite key, then revoke the live key. Follow `docs/operations/production-cleanup.md` for the exact failure and evidence procedure.
8. Obtain sign-off from product/security, operations, and legal owners. Only then invite the first design partner.

## Rollback

Application and Function rollback is forward-safe:

1. Disable new invitations and captures if data integrity or isolation may be affected.
2. Repoint the Site and each Function to the last known-good deployment from the release record. Never roll database schema backward destructively.
3. Revoke affected extension/device credentials and raise `KNOWHOW_EXTENSION_MIN_VERSION` if the client build is implicated.
4. If a schema change caused failure, deploy a compatible forward fix. Restore a backup only under the backup/restore runbook and only into an isolated database until the incident commander approves cutover.
5. Verify readiness, anonymous denial, tenant isolation, notification queues, and a synthetic read/write flow after rollback.
6. Record the incident, affected window, release IDs, evidence, and follow-up actions.

Any suspected cross-tenant disclosure, unredacted media persistence, credential exposure, unauthorized purge, or unrecoverable customer-data loss is P0: stop pilot access and invoke incident response immediately.
