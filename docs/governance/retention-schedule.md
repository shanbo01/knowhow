# Pilot retention schedule

Status: operational draft subject to legal approval, provider capabilities, executed customer terms, and documented legal holds. Periods are measured from the stated trigger in UTC.

| Record | Default pilot retention / trigger | Disposition |
| --- | --- | --- |
| Active account, organization, workspace, memberships, guides/revisions/steps/audiences/completions | Active pilot/contract plus lifecycle below | Approval-gated tenant purge; content-free receipt retained as approved |
| Redacted screenshots/private-media metadata | Active plus lifecycle; soft-deleted/quarantined when removed or integrity/orphan issue occurs | Reconciliation and approved purge delete file/metadata; independent media DR deferred |
| Expiring export artifacts/jobs | Short configured download window; worker deletes after `expires_at` | Delete private file and close/scrub job metadata according to implementation |
| Pilot/trial data after original expiry | 7-day read-only grace, then suspended; deletion eligibility at 90 days from original expiry | Notices around expiry, mid-grace, 24h grace, ~30 days, 7 days/24h before eligibility; no purge without approval |
| Approved deletion case/receipt | Case through purge; content-free receipt `[legal period]` | Delete tenant roots rather than retaining tombstones; retain HMAC organization/workspace/approving-actor hashes, counts and times only—no raw identifiers or customer content |
| Audit segments/security evidence | Active plus `[legal/security period]`; policy-managed and append-only | Cryptographically verify, then delete only under approved policy/legal hold |
| Support tickets/messages | Pilot plus `[e.g. 12 months, legal approval]` after closure | Delete customer message content; retain minimal service metrics if approved |
| Leads/demo/pilot requests | `[e.g. 12 months]` from last interaction unless earlier request/obligation | Delete or anonymize; no automatic CRM transfer in pilot |
| Notification queue/delivery metadata | Credential scrubbed immediately after success or terminal fifth failure; remaining metadata `[e.g. 90 days]` | Delete recipient/template delivery metadata after operational period |
| Usage events/rollups | Content-free events `[e.g. 13 months]`; aggregated business metrics as approved | Delete tenant-identifiable events; retain genuinely anonymized aggregates if lawful |
| Rate-limit/idempotency records | Until their explicit expiry, then scheduled cleanup | Hard delete expired technical record |
| Provisioning drafts | 30 days after abandoned staged run | Worker deletes staged metadata/files; completed provisioning follows tenant lifecycle |
| Appwrite sessions/device credentials | Session policy / device refresh up to 30 days; access tokens 5 minutes | Revoke/delete on logout, membership/device revoke, expiry, reuse detection, or tenant purge |
| Sentry events/logs | Minimum useful provider period, target `[30–90 days]` | Provider expiry/deletion; events must already be scrubbed |
| Database backups | Daily Appwrite Pro policy and provider retention `[record actual]` | Provider-managed expiry; restored copies destroyed after rehearsal/evidence approval |
| Build/test evidence | Release plus `[security/legal period]`; synthetic/content-free only | Delete per evidence policy; never store secrets/customer screenshots |

## Lifecycle rules

- Future 14-day public trial remains disabled but shares the lifecycle engine.
- The 30-day design-partner pilot uses configurable dates and the same default grace/retention engine unless manually extended or converted.
- Expiry immediately limits mutations and starts seven days of read-only access for sign-in, viewing, export, and account/settings.
- After grace, only the recovery/suspension experience is available.
- At 90 days after original expiry, a critical deletion-approval case is created and continuously escalated. Overdue does not mean automatically deleted.
- Approval requires an authorized platform owner, recent TOTP, and exact typed confirmation. The worker freezes exact row/file targets in an HMAC-sealed plan bound to the case, organization, and workspace; rejects plan tampering, a newly introduced final-organization workspace, other scope drift, or cross-tenant inconsistencies; retries missing targets idempotently; hard-deletes tenant roots/files; and issues a scalar-scrubbed content-free receipt. It deletes an Appwrite Auth account and its preference only when no surviving table references that user; shared identities and platform-role holders are preserved.

## Exceptions and holds

Legal hold, incident preservation, customer instruction, or mandatory law may extend or restrict deletion. Record scope, authority, start/review/end dates, and affected systems. Holds must not silently expand ordinary access. When the exception ends, resume the approved lifecycle and document disposition.

Owner/legal approval/version/effective date: `[pending]`
