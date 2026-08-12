# KnowHow external-pilot readiness report

Report date: 2026-08-12

Delivery branch: `codex/azure-qatar-private-beta`

Baseline checkpoint: `9726071` (`feat: checkpoint Appwrite pilot baseline`)
Overall status: **AZURE STAGING AND PRODUCTION AVAILABLE FOR INVITATION-ONLY PRIVATE-BETA TESTING WITH SYNTHETIC/NON-SENSITIVE DATA**

## Azure private-beta deployment update

On 2026-08-12, after the subscription could not allocate an affordable Qatar Central VM, the owner authorized an availability-first test deployment. Azure subscription/SKU checks selected South India and `Standard_B2ls_v2` (2 vCPU, 4 GiB) as the cheapest sensible available configuration. `location` and `vmSize` remain deployment parameters, so the identical Appwrite/application topology can be redeployed to Qatar Central later without application changes. No HA or second application VM was created.

- Appwrite 1.9.6 control plane: `https://knowhowbeta-2exzhpwnisvnw.southindia.cloudapp.azure.com`
- Staging Site: `https://knowhow-staging.20.235.61.152.sslip.io`
- Production Site: `https://knowhow-prod.20.235.61.152.sslip.io`
- Exact isolated projects: `knowhow-staging` and `knowhow-production`; each has one `knowhow_core` database with 40 private tables, 107 indexes, two private buckets, two ready Functions, one latest-ready Site, and a private Docker-only Mailpit Messaging provider.
- Both environments passed the live controlled contract: endpoint/version, exact table/index and bucket drift, Function/Site readiness, anonymous denial, TablesDB CRUD and transaction commit/rollback/conflict semantics, private PNG byte integrity, server-session Auth, Messaging provider visibility, Next health/readiness identity, anonymous product/media/export/audit/extension denial, and synthetic-fixture cleanup.
- A verified explicit `owner` account for `yousefmshanableh@gmail.com` exists in both projects. Its generated password is stored only in Key Vault as `knowhow-private-beta-owner-password`; administrative MFA remains required by the application.
- Daily encrypted backups are enabled. The first successful age-encrypted archive was uploaded to the private versioned Blob container. Its SHA-256 and every inner payload checksum passed. A same-VM isolated, no-public-port MongoDB rehearsal restored 4,939 documents, both Appwrite projects, and 187 Appwrite collections, then destroyed the disposable container/network/volume and restarted the live stack. Index creation remains reproducible from the checked-in Appwrite manifest on this memory-constrained test SKU.
- Azure VM Backup is enabled with the enhanced policy; the initial user-triggered recovery-point job `5f6a1063-2e7a-4237-8d4e-42210ad6b588` completed its snapshot and is transferring the recovery point to the vault.
- Key Vault, managed identity, Log Analytics/Azure Monitor, TLS, deny-by-default NSG rules, blocked public SSH, encrypted backup/restore tooling, resource locks, and application security controls remain enabled.
- Estimated steady-state Azure cost was disclosed before deployment as approximately USD 70–80/month excluding tax and egress. No additional restore VM was created.

The deployment is approved for controlled invitation-only testing, not for regulated data, public signup, paid production SLA, or unsupervised real-customer data. The temporary Mailpit provider captures notification mail inside the private Docker network and does not deliver external email; invite links must therefore be shared manually until a real sender/domain is configured.

This report separates locally verified implementation evidence from credentialed Staging/Production evidence. A local pass never substitutes for a pending environment, legal, provider, restore, store, or synthetic-customer gate.

## Current execution context

Checks on 2026-08-11 and the Azure migration work on 2026-08-12 established the current evidence boundary:

- The complete Appwrite pilot migration is checkpointed at `9726071` on `codex/azure-qatar-private-beta`. The repository still has no configured Git remote, so protected remote workflow evidence is unavailable.
- Staging was provisioned with a short-lived bootstrap credential. That credential was converted in place to a Site-only runtime key with only `users`, `sessions`, database/table rows, private files, Function-read, and message-write scopes; the local Appwrite CLI configuration was reset to an empty `{}` after deployment.
- A configuration-only snapshot of the old Free Singapore project, `SOP Inventory` (`6a6a53ac002ca43c7ea4`), was recorded without opening Auth users, keys, row contents, or files. The owner then explicitly authorized its permanent deletion, including its users and resources; the project was deleted without exporting or migrating anything.
- The `Personal projects` organization contains exactly two Free-plan projects in Frankfurt: `KnowHow Staging` (`6a7b532a0033dd811cb4`) and `KnowHow Production` (`6a7b534f00071e3d3014`). Staging now has `knowhow_core` with all 40 tables and indexes, the two Functions, and the live `knowhow_web` Site. Production remains an empty project boundary.
- Appwrite's Pro checkout displayed `$25/month` for Pro plus `$15/month` for the second project, for `$40` due immediately and every 30 days. The owner explicitly deferred all paid-plan work on 2026-08-11, so no purchase was submitted.
- The active Azure account is the enabled default `Azure subscription 1`. Required Compute, Network, Storage, Key Vault, Managed Identity, Log Analytics, Insights, and Recovery Services providers are registered. Reproducible Qatar Central Bicep, pinned Appwrite bootstrap, Key Vault secret generation, Azure Monitor, deny-by-default networking, age-encrypted zone-redundant Qatar backups, daily locally redundant VM backup, and fresh-instance-only restore tooling are implemented and locally validated.
- Azure ARM preflight rejected `Standard_B2s` both zonally and regionally with `SkuNotAvailable`. The live Qatar catalog marks every practical 2–4 vCPU SKU `NotAvailableForSubscription`; only 20–128 vCPU families are unrestricted, which exceed the subscription's 4-vCPU regional quota and are not an acceptable cost workaround. No billable Azure resources were created.

Consequently, Staging is available for invitation-only testing with synthetic/non-sensitive data at `https://6a7b5a4e1431645d3de7.appwrite.network/app`. A verified explicit platform-owner account passed real password login and was stopped by the required TOTP-enrollment gate. The UI produces exact-email, single-use fallback invitation links, so testing does not depend on a paid email provider. This is not Production approval: Production, Pro backup/restore, legal, sender, monitoring, store, and full controlled-rehearsal gates remain open, and real customer data remains prohibited.

## Scope decision

Target: up to three invitation-only Qatar design partners, initially one department and 100 users per organization, on signed free 30-day pilots using ordinary business-process data only. First partner only until its first week has no unresolved severe security, data-loss, or onboarding issue.

Excluded: public self-service, live payments/numeric pricing, SSO/SCIM, MSP tenancy, regulated/sensitive/special-category data, customer-ready on-premises delivery, independent media DR, contractual SLA, third-party penetration test, and enterprise GA claims.

## Local implementation evidence

| Gate | Evidence on 2026-08-11 | Result |
| --- | --- | --- |
| Runtime | Standard Next.js 16.3 production build; legacy runtime/server/persistence dependencies and source removed | Pass |
| Legacy boundary | A configuration-only snapshot records the old Free Singapore project's single empty `records` table and absent operational resources; Auth users, keys, content, and secrets were not inspected. The owner-authorized project deletion then removed all legacy users/resources, and nothing was exported or migrated | Pass |
| Appwrite resources | Generated `knowhow_core`, 40 private server-only tables, two private buckets, Site and two Functions; 158 source query/index contracts verified | Pass |
| Self-host portability | Fresh official Appwrite 1.9.6 Docker install on Docker 29.6.2; exact 40-table/107-index and two-bucket contract, anonymous denial, TablesDB CRUD plus read-your-writes/commit/rollback/conflict rejection, private-file byte integrity, server-session auth, live Next health/auth, anonymous product-API denial, and zero-state cleanup verified | Pass (local portability contract) |
| Identity/access | HTTP-only SSR sessions, verified email, invite/appointment-only signup, admin TOTP/recovery, explicit platform roles, default-deny policy, org/workspace/content separation | Pass (unit/static) |
| Transactions/concurrency | One-use invitations, final-admin guards, capture idempotency, audit order, support separation, lifecycle/deletion durability covered by in-memory/worker tests; real Appwrite staged isolation, commit, rollback, and stale-write conflict rejection passed on self-host; competing idempotent commands replay the committed winner while unrelated conflicts return a safe retryable `409` | Pass (local); live cloud-domain rehearsal pending |
| Media/extension | Raster validation, private storage interface, hash integrity, local redaction/privacy review, rotating device credentials, 85 extension tests | Pass (local) |
| Lifecycle/operations | Grace/suspension/retention/notices; approval-gated HMAC-sealed target plan bound to its case/org/workspace; cross-tenant/scope-drift/new-workspace refusal; idempotent file/row retry; hard-deleted workspace/subscription/final-organization roots; guarded tenant-only Auth cleanup; scalar-scrubbed HMAC-bound receipt; read-only HMAC-sealed Production clean-state verifier; notification retry/encrypted credentials and orphan/export cleanup | Pass (local contract/worker execution tests); Production execution pending |
| Backup/restore verifier | Frankfurt-only, database-bound archive and daily-policy checks; HMAC-sealed all-table counts/fingerprints; full audit-chain/head validation; isolated-destination refusal; 24-hour database RPO boundary. Separately access-controlled restored-application mode and HMAC gate bind the exact disposable Site ID/origins, project, release, database, and restoration; verify two real MFA sessions, own/cross-tenant plus organization-metadata separation, one idempotent transaction, audit sequence, queued export, anonymous denial, direct Appwrite server-session revocation, and full application RTO. A third chained HMAC gate uses a read-only key to prove `knowhow_core`/`knowhow_web` survive while the restored database/disposable Site are absent | Pass (local contracts); Pro Production execution and second-operator cleanup evidence pending |
| Commercial/platform | Resumable provisioning, organizations/workspaces, pilot/trial model, entitlements/usage/manual invoices, platform views, support, onboarding | Pass (local) |
| Security tooling | Typecheck, lint, unit suite (103), Function syntax, build, secret scan (286 tracked/untracked source files), high-severity dependency audit (0 vulnerabilities) | Pass at recorded run; repeat before release |
| Browser/accessibility | Public/auth plus mocked critical product routes on the installed branded Chrome and Edge channels and a mobile Chromium Pixel 5 profile; MFA/recovery, activation, capture, exact-email invitation, edit/publish, completion/export, support, provisioning, suspension, deletion approval, and WCAG 2.1 A/AA checks; the credentialed gate additionally binds the live Site to the expected environment, project fingerprint, and release, requires fresh TOTP for both actors, and directly proves their Appwrite server sessions revoked after each journey | 60 passed; 4 credentialed real-environment rehearsals correctly skipped |
| Synthetic load | Local deterministic boundary: 4 tenants × 120 users, 40 guides each, 480 concurrent authorized searches and 48 redacted capture pipelines. Controlled gate: exact Frankfurt Site/project/release readiness, mandatory fresh TOTP for dedicated verified synthetic actors, mutual cross-workspace denial, tenant sentinels, concurrent real search plus redacted upload/discard traffic, request-ID accounting, old extension-token denial, direct Appwrite server-session revocation, and strict HMAC-sealed content-free evidence | Local pass: search p95 722 ms; capture p95 279.5 ms; no leakage/timeouts. Credentialed Staging/Production execution and provider-graph review pending |
| Extension packaging | Stable pinned ID; development/store channels; exact HTTPS store origin injection; no public ZIP distribution; repeated Staging store builds produced SHA-256 `FFDBC5C57FF19CE0BA2881CD1D7EAE0D0F448BDC588EC88600340829DF7A54CC` | Pass locally; store publication pending |
| CI | GitHub verify/browser jobs, Gitleaks, artifacts, conditional Frankfurt Staging integration, plus a non-skippable manually dispatched, environment-protected Staging/Production gate pinned to an exact 40-character release SHA; controlled smoke binds distinct reviewed projects, exact schema/resources and latest-ready Function/Site deployments, Site identity, anonymous denial, and verified fixture cleanup before the real-TOTP/two-user browser and sealed network-load gates | Defined; remote execution evidence pending |

Re-run commands for final local evidence:

```text
npm ci
npm test
npm run test:e2e
npm run load:pilot
```

## Required external evidence

| Gate | Owner | Status / required proof |
| --- | --- | --- |
| Company/legal authority | Company + Qatar counsel | **Blocked:** incorporation and approved/executed pilot agreement, DPA, privacy notice, acceptable use, subprocessors, retention, incident/support terms |
| Azure Qatar Central allocation | Azure subscription owner / Microsoft | **Blocked externally:** ARM reports `SkuNotAvailable` for `Standard_B2s`; every practical Qatar VM SKU is `NotAvailableForSubscription`. Enable one 2-vCPU/4-GB-or-more Qatar SKU, then run `infrastructure/azure/Deploy-KnowHowAzure.ps1` without changing country or selecting an oversized machine. |
| Frankfurt Staging | Product/operations owner | **Available for synthetic Free-plan testing:** `KnowHow Staging` (`6a7b532a0033dd811cb4`) has the full 40-table schema/index set, two ready Functions, one private Free-plan bucket shared by media and exports, and the active Site at `https://6a7b5a4e1431645d3de7.appwrite.network`. Health, Auth, identity, tables, storage, Functions, real owner password login, forced owner TOTP enrollment, session sign-out, and scoped transaction rollback passed. Readiness intentionally remains `503 configuration: attention` for the one-bucket Free-plan deviation and missing Sentry/store-listing settings. Full two-user and controlled load rehearsals remain pending. |
| Qatar self-hosted Production/Staging | Product/operations owner | **Deployment-ready but allocation-blocked:** create two isolated projects on the Qatar control plane, deploy the same manifest with separate credentials/origins, and pass smoke/journey/load/backup/restore/purge. The empty Frankfurt Production project is not the intended paid target. |
| Backup/restore | Product/operations owner | **Blocked:** run the implemented HMAC-sealed source capture and database verifier against a daily `knowhow_core` policy and successful isolated Pro restore; create the access-controlled disposable Site; pass `appwrite:restore:application` and independent evidence verification; then have a second operator remove the disposable resources and pass the read-only live/offline restore-cleanup evidence gates before revoking the final key |
| Email/DNS | Domain owner | **Blocked for automated delivery:** canonical TLS/DNS plus Resend/Appwrite Messaging sender, SPF, DKIM, DMARC, and template evidence are absent. For synthetic testing only, the product displays exact-email, expiring, one-use invitation links for manual sharing. |
| Sentry | Security/operations owner | **Blocked:** projects/alerts, scrubbed synthetic canary inspection, notification route, source-map release evidence |
| Chrome/Edge distribution | Store-account owner | **Blocked:** approved unlisted listings, final IDs/URLs, privacy disclosures, managed-install guide, update/rollback rehearsal |
| Production synthetic journey | Release owner + independent reviewer | **Blocked:** two users perform invite/MFA/onboarding/capture/edit/review/publish/view/complete/support/export/suspension/recovery/deletion approval |
| Production cleanup | Platform owner + reviewer | **Blocked:** execute approved purge and the exact-project/release-bound `npm run appwrite:production:cleanup:verify`; retain immutable HMAC-sealed proof from uncached scans of `knowhow_core` and both stable buckets showing scrubbed receipts, zero organization/workspace roots, zero scoped/raw rehearsal-identifier residues, both rehearsal users absent, and empty private/export buckets |
| Final findings/sign-off | Security, operations, legal | **Blocked:** no unresolved P0/P1 and signed decision to invite first partner |

## Critical-path test matrix

The controlled Staging/Production rehearsal must retain evidence for:

1. Anonymous denial, exact origins, CSRF, rate/size limits, secure cookies, session limits/revocation, password recovery/verification, TOTP/recovery codes.
2. Invitation and initial-admin appointment one-use behavior under concurrency; no domain/self-service join path.
3. Platform, organization, workspace, vault, audience, support, billing, auditor, and suspended/read-only boundaries across two tenants.
4. Organization administrator metadata management without guide, revision, screenshot, search, media, or export access.
5. Resumable provisioning/onboarding and activation metrics without customer content.
6. Manual and extension capture, privacy redaction, edit/review/publication, audience view, second-user completion, immutable history.
7. Support thread and exceptional-access request/approval/TOTP/expiry/revoke/notification/audit.
8. Authorized/restricted export, expiring private artifact, retry/cleanup.
9. Pilot expiry/read-only grace/suspension/recovery/extension, all notices, deletion eligibility/approval, exact frozen purge targets, hard-deleted roots/files, guarded Auth-user removal, scrubbed receipt, and clean-state evidence.
10. Sentry scrubbing, email-template privacy, token key rotation/revocation, storage integrity/orphan reconciliation, notification failure queue.
11. Multiple 100-user tenants under concurrent reads/capture uploads with no leak/timeout and recorded API p95 budget.
12. Current Chrome and Edge at 360px through desktop, with WCAG 2.1 AA on every critical path.

## Residual risks accepted only within pilot scope

- Independent private-media disaster recovery is deferred; database backup does not create a full media recovery guarantee.
- No external penetration test or enterprise identity federation has occurred.
- A small operator team creates concentration/on-call risk; temporary content access is still customer-approved and audited.
- Automated redaction cannot reliably inspect canvas, video, images, native browser UI, or closed shadow roots; human review and prohibited-data rules remain mandatory.
- Email and browser-store providers introduce delivery/review dependencies.
- The full local Appwrite 1.9.6 portability contract passed, including the live Next API check, but production hardening, upgrades, backups, monitoring, support, and customer deployment automation were not exercised; no customer-ready on-prem support is claimed.
- Local load numbers exclude network/provider latency and remain only a deterministic service-layer baseline; the exact-release controlled network gate is implemented but has no Frankfurt evidence yet.
- The restored-application access/RTO gate is implemented and locally contract-tested, but no sealed report from a real Frankfurt Pro restoration or second-operator deletion record exists yet.

Any design partner requiring a deferred control is out of scope. Residual-risk acceptance must be documented by named legal/security/product owners.

## Rollback summary

Disable invitations/capture/export if integrity or isolation is in doubt; revoke affected sessions/devices/grants; roll Site and Functions forward to the recorded last-known-good deployments; use a higher-version store rollback; never destructively reverse schema; restore only into isolation first; rerun readiness/tenant/synthetic checks; document the incident and communications. Full procedure: `docs/operations/deployment.md`.

## Final decision record

- Product/operations owner: `[pending]`
- Security/privacy reviewer: `[pending]`
- Qatar legal reviewer/company signatory: `[pending]`
- First design-partner approval: `[pending]`
- Evidence repository/location: `[pending — private, content-free]`
- Decision/date: **NOT APPROVED / pending**

This report must remain NOT READY until every blocked row has evidence and no P0/P1 remains.
