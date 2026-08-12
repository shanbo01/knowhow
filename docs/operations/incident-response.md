# Incident-response runbook

This runbook covers suspected or confirmed security, privacy, availability, integrity, notification, backup, and deletion incidents during the controlled pilot. The incident commander owns severity, containment, evidence, communications, and closure. Legal counsel determines statutory/contractual notification duties and deadlines; do not improvise legal conclusions.

## Severity

- P0: cross-tenant or unauthorized customer-content access; raw/unredacted screenshot or prohibited-data persistence; credential/key exposure; audit tampering; unauthorized/incorrect purge; material customer-data loss; active compromise.
- P1: prolonged authentication or service outage; repeated Function failure affecting lifecycle/deletion; terminal security-notice failure; failed backup/restore gate; exploitable authorization weakness without observed disclosure.
- P2: degraded latency, bounded single-tenant malfunction, recoverable queue delay, or noncritical notification/support target miss.
- P3: cosmetic or low-impact operational issue with no confidentiality, integrity, or availability consequence.

## First 30 minutes

1. Open an incident record with a random ID, UTC detection time, reporter, environment, release, symptoms, and initial severity. Never paste secrets or customer content.
2. Assign incident commander, technical lead, communications owner, and evidence recorder—even if one person holds multiple roles.
3. Preserve Sentry event IDs, Appwrite deployment/function logs, request IDs, audit-segment heads, provider status, and relevant configuration metadata. Do not export guide text or screenshots for convenience.
4. Contain narrowly: disable invitations/capture/export, revoke affected sessions/device tokens/support grants, suspend the affected workspace, or roll back the release. Stop the whole service for any plausible cross-tenant or ongoing data exposure.
5. Rotate exposed credentials using versioned key rotation where applicable. Retain old verification keys only if they are not compromised and are needed for controlled token transition.
6. Contact Appwrite, Resend, Sentry, or store-provider support through approved accounts if provider involvement is suspected.

## Investigation

- Establish the affected organization/workspace, data categories, first/last possible exposure, actors, actions, and exact evidence confidence.
- Correlate request IDs across Site, Function, Sentry, and audit logs. Audit metadata is evidence; platform/support roles do not authorize viewing content to investigate.
- Use exceptional support access only with customer approval, TOTP reauthentication, a reason, short expiry, notification, and complete audit. For a P0 where customer approval is impossible, obtain legal/incident-commander authorization and record the emergency basis; do not silently create permanent membership.
- Verify whether notification credentials, session cookies, Appwrite keys, extension refresh tokens, token keyrings, export links, or deletion receipts were exposed.
- Check backup integrity and media hashes before any recovery action.

## Communications

- Keep one timestamped internal incident log. State facts, confidence, impact, actions, and next update time.
- The communications owner contacts affected pilot organizations through contract contacts. Do not include guide content, screenshots, credentials, or speculative attribution.
- Qatar-focused counsel decides whether regulator/data-subject notifications apply, their content, and timing. Contractual notification terms in the executed pilot/DPA control.
- For material service impact, communicate at an agreed cadence even when there is no new finding.

## Recovery

1. Apply a reviewed fix or roll back to the last known-good Site/Function/extension deployment.
2. Restore databases only through `backup-restore.md`, into isolation first.
3. Re-run relevant unit/concurrency/security tests, Appwrite smoke, anonymous denial, tenant isolation, Sentry scrubbing, and synthetic customer journeys.
4. Confirm notification/deletion/export queues are idempotent before replay. Never manually mark a purge complete without the worker's content-free receipt.
5. Re-enable access in stages. Require incident-commander approval and customer communication where impact was external.

## Closure

Close only after containment is durable, affected data and customers are understood, recovery is verified, required notices are handled, and follow-up owners/dates exist. Within five business days for P0/P1, document timeline, root cause, contributing controls, detection gap, customer impact, evidence, corrective actions, and whether the threat model/runbooks/tests changed. Treat the review as blameless but evidence-driven.

Never delete evidence to make an incident appear resolved. Apply the retention schedule and legal hold decisions.
