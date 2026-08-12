# KnowHow

KnowHow is an invitation-only, privacy-first SOP platform for controlled external pilots. It captures browser workflows as governed, versioned guides while keeping authorization, customer records, redacted screenshots, exports, and audit history behind a server-only boundary.

The current delivery target is up to three Qatar design partners, initially one department and 100 users per organization, under a signed 30-day pilot using ordinary business-process data only. Public self-service, payments, SSO/SCIM, regulated data, MSP tenancy, and a customer-ready on-premises package are deliberately out of scope.

## Runtime architecture

- One standard Next.js application per environment, with marketing at `/`, product entry at `/app`, workspace routes under `/w`, and platform control under `/platform`.
- Separate Appwrite Cloud Frankfurt projects for Staging and Production.
- Appwrite Auth sessions exchanged and retained only through secure, HTTP-only, same-site server cookies.
- Appwrite TablesDB database `knowhow_core`, private Storage buckets `knowhow_private_media` and `knowhow_exports`, Site `knowhow_web`, and Functions `knowhow_ops` and `knowhow_export`.
- Product tables and files have no browser permissions. Every request passes through KnowHow's default-deny policy layer.
- Organization administration controls metadata and policy but never grants guide or screenshot access by itself. Workspace membership and guide audiences remain separate.
- The Chromium Manifest V3 extension uses short-lived, workspace-scoped device tokens and never receives an Appwrite key or session.

The deployable resource source is [appwrite.config.json](./appwrite.config.json), with generated table and bucket manifests in `infrastructure/appwrite`. Environment IDs and secrets are never committed.

## Pilot data boundary

Permitted data is ordinary internal business-process information that the pilot organization has approved for the trial. Do not submit credentials, secrets, payment information, health information, national IDs, or other sensitive or special-category data.

Screenshots must be rasterized and redacted locally, then explicitly privacy-reviewed before publication. The application does not persist raw screenshots, captured form values, clipboard data, raw keystrokes, or full captured URLs. Analytics contain IDs, event kinds, timestamps, and counts—not guide text or images.

## Prerequisites

- Node.js 22.13 or newer
- npm
- Chromium for Playwright and extension testing
- For a real environment: an empty Appwrite project in Frankfurt, an appropriately scoped server API key, verified email delivery, and exact Site/extension origins
- For the portability smoke test: Docker Compose v2 and a fresh local Appwrite project

## Local development

Copy `.env.example` to `.env.local`, replace every placeholder, and keep the file untracked. Development may point at a dedicated local or disposable Appwrite project; never use Production credentials locally.

```text
npm ci
npm run dev
```

The app listens at `http://localhost:3001`. Appwrite treats `localhost` and `127.0.0.1` as different origins, so configure the exact value. The email-verification callback is `http://localhost:3001/verify`.

Key server variables include:

- `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`
- `APPWRITE_DATABASE_ID`, `APPWRITE_PRIVATE_MEDIA_BUCKET_ID`, `APPWRITE_EXPORTS_BUCKET_ID`
- `KNOWHOW_ALLOWED_ORIGINS`, `KNOWHOW_EXTENSION_ORIGINS`, `KNOWHOW_SITE_ORIGIN`
- `KNOWHOW_TOKEN_KEYS_JSON`, `KNOWHOW_TOKEN_ACTIVE_KID`, `KNOWHOW_RATE_LIMIT_PEPPER`
- `KNOWHOW_EXPORT_WORKER_SECRET`, `KNOWHOW_DELETION_RECEIPT_PEPPER`
- Sentry, Resend, support, lead, release, and unlisted extension-listing settings shown in `.env.example`

`KNOWHOW_PLATFORM_OWNER_EMAILS` is notification metadata only. It does not grant authority. Platform roles must be explicitly bootstrapped in `platform_roles`, with every later change audited.

## Verification commands

```text
npm test
npm run test:e2e
npm run load:pilot
```

`npm test` runs type checking, linting, a standard Next.js production build, application tests, Function syntax checks, all extension tests plus its privacy-guarded build, Appwrite manifest/query-index drift checks, secret scanning, and a high-severity dependency audit.

Useful focused commands:

- `npm run appwrite:generate` — regenerate checked-in Appwrite resources from the canonical schema.
- `npm run appwrite:check` — fail on resource drift or a query without a supporting index.
- `npm run appwrite:smoke:self-host` — destructive-to-transient-fixtures contract smoke against local Appwrite only; it cleans up its exact rows, file, user, session, and transaction metadata.
- `npm run appwrite:smoke:staging` — exact schema/resource/deployment and transient-fixture smoke, bound to reviewed, distinct Frankfurt Staging/Production project IDs and the live Site release identity.
- `npm run appwrite:smoke:production` — the same controlled contract against the explicitly bound Production project; requires synthetic-only/final-Production attestations and exact cleanup.
- `npm run appwrite:backup:capture` — bind a fresh database-bound Production archive to HMAC-sealed, content-free schema/table/audit evidence while synthetic source mutations are paused.
- `npm run appwrite:restore:verify` — verify every restored table and audit chain in a new, unreferenced Frankfurt database; this refuses the active source database and leaves application RTO as a separate gate.
- `npm run appwrite:restore:application` — verify an access-controlled disposable Site against that exact restored database: Site-ID/origin readiness, MFA identity, own/cross-tenant and organization-metadata boundaries, a real idempotent transaction, audit sequence, queued export, anonymous denial, direct Appwrite server-session revocation, and 24-hour application RTO; writes HMAC-sealed content-free evidence chained to the database report.
- `npm run appwrite:restore:application:evidence:verify` — independently verify the saved application report, its HMAC seal, exact disposable-Site/project/release/database/restoration binding, and chain to the sealed database restore report without requiring actor credentials or the Site access secret.
- `npm run appwrite:restore:cleanup:verify` — after independent deletion, use a read-only Frankfurt key to prove `knowhow_core`/`knowhow_web` remain present while the exact restored database/disposable Site are absent; writes a third HMAC report chained to both prior reports.
- `npm run appwrite:restore:cleanup:evidence:verify` — verify that cleanup report and its full evidence chain offline before revoking the final read-only key.
- `npm run appwrite:production:cleanup:verify` — exact-project/release-bound, read-only final Production gate for hard-deleted tenant roots, scrubbed receipts, absent two-user rehearsal accounts, uncached zero customer-scoped rows, and empty stable private/export buckets; writes immutable HMAC-sealed evidence.
- `npm run appwrite:production:cleanup:evidence:verify` — verify a saved cleanup evidence file's HMAC/key ID, reviewed project/release binding, and strict content-free contract without an Appwrite credential.
- `npm run load:controlled` — exact-environment Frankfurt Site load gate using dedicated synthetic actors, mandatory fresh TOTP challenges, cross-tenant denial probes, concurrent authorized searches, redacted capture uploads, direct extension/server-session revocation proof, and immutable HMAC-sealed content-free evidence.
- `npm run load:controlled:evidence:verify` — independently verify that saved live-load evidence belongs to the expected environment, Appwrite project, and release and satisfies its strict request/error/latency/cleanup contract without unexpected fields.
- `npm run extension:build` — build a localhost development extension into ignored `outputs/extension`.
- `KNOWHOW_EXTENSION_ORIGIN=https://... npm run extension:build:store` — build the pinned-ID, exact-origin store artifact.
- `npm run security:secrets` and `npm run security:audit` — local security gates.

Playwright covers public and invitation-only authentication, Appwrite MFA/recovery UX, activation, capture, exact-email invitations, editing, publication, completion/export, support, platform lifecycle controls, and suspended-workspace recovery at desktop and 360px-class mobile widths. Public/auth and representative product states include WCAG 2.1 A/AA checks. Credentialed controlled-environment rehearsals are gated by explicit environment variables and never silently substitute mocks for production evidence.

For a deployed Staging or Production synthetic tenant, set the release-gate variables documented in `.env.example`, including the expected environment/project/release identity, both synthetic accounts, their TOTP seeds, workspace slug, and published guide ID. Then run:

```text
KNOWHOW_REQUIRE_CONTROLLED_REHEARSAL=1 KNOWHOW_E2E_BASE_URL=https://<controlled-host> npx playwright test e2e/controlled-rehearsal.spec.ts --project=chrome --project=edge --workers=1
```

The gate runs sequentially in the installed current stable Google Chrome and Microsoft Edge channels. It requires fresh TOTP for both real server-side sessions, verifies owner-only control-plane routes, a second member's published-guide completion, and in-app support, then directly proves each Appwrite session revoked. It complements—but does not replace—the operator-recorded invitation, email, extension/store, lifecycle, restore, load, and purge rehearsal in the deployment runbook.

## Extension development and distribution

Run `npm --prefix extension test` and `npm --prefix extension run build`, then load `extension/dist` from `chrome://extensions` or `edge://extensions` for local development.

Pilot distribution is through unlisted Chrome and Edge store listings. Controlled deployments fail readiness when either listing URL is missing. The build preserves extension ID `phbofjenfnnnnndghhinoldlfbpaedpo`, injects one exact HTTPS application origin into `host_permissions` and `externally_connectable`, and keeps broad website access optional and requested only when capture starts. Direct public ZIP distribution is intentionally absent.

See [extension/README.md](./extension/README.md) and [extension distribution](./docs/operations/extension-distribution.md).

## Operations and governance

- [Deployment and rollback runbook](./docs/operations/deployment.md)
- [Monitoring and alert thresholds](./docs/operations/monitoring.md)
- [Backup and restore rehearsal](./docs/operations/backup-restore.md)
- [Incident response](./docs/operations/incident-response.md)
- [Self-host portability smoke](./docs/operations/self-host-smoke.md)
- [Threat model and security overview](./docs/security/threat-model.md)
- [Privacy notice draft](./docs/governance/privacy-notice.md)
- [Pilot terms draft](./docs/governance/pilot-terms.md)
- [Acceptable use and data classification](./docs/governance/acceptable-use.md)
- [DPA template](./docs/governance/dpa-template.md)
- [Subprocessor list](./docs/governance/subprocessors.md)
- [Retention schedule](./docs/governance/retention-schedule.md)
- [Support policy](./docs/governance/support-policy.md)
- [Readiness report](./docs/readiness-report.md)

The governance documents are controlled drafts, not executed agreements or legal advice. Qatar-focused counsel must approve them and the company must be incorporated before any real customer data is accepted.

## Release boundary

Local passing tests do not authorize a pilot. External access remains blocked until the owner completes every checkpoint in the readiness report: clean Frankfurt projects, Production Pro, daily backups and isolated restore evidence, verified DNS/email, Sentry alerts, unlisted browser-store listings, executed legal terms, full Staging and Production synthetic journeys, Production synthetic-tenant purge, and no unresolved P0/P1 findings.

Production readiness here means controlled external-pilot readiness, not enterprise GA. Independent media disaster recovery, a contractual SLA, third-party penetration testing, enterprise identity, open self-service, live payments, and customer-ready on-premises delivery remain deferred.
