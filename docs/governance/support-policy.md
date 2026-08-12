# Controlled-pilot support policy

KnowHow provides lightweight in-app support to authorized pilot users. The target for an initial human response is one Qatar business day. This is a service target, not a contractual SLA, and does not promise resolution within that period.

## Channels and hours

- Primary: in-app support thread, scoped to the user's organization/workspace.
- Operational/security escalation: approved contact address in the executed pilot documents.
- Scheduling and sales follow-up remain manual. Inbound-email parsing and a full helpdesk are out of scope.
- Business hours/holidays and emergency contact coverage: `[approve and publish before pilot]`.

## What users may submit

Include a concise symptom, time, affected workflow/feature, request ID, browser/version, and non-sensitive reproduction steps. Do not include passwords, tokens, secrets, payment/health/national-ID data, unredacted screenshots, full guide copy, or data belonging to another tenant. Support may ask the user to create a synthetic reproduction.

## Priority and targets

- P0 security/privacy/data-loss: use the incident channel immediately; service containment takes priority.
- P1 access/outage/lifecycle/deletion failure: acknowledge promptly during coverage and investigate as an incident.
- P2 material degraded function: initial response within one business day.
- P3 question, feedback, or cosmetic issue: initial response within one business day, scheduled by impact.

The incident-response runbook defines operational severity. Contractual language, if any, supersedes this draft.

## Support access

Support personnel see ticket metadata/messages authorized to the support workflow, not customer guides/screenshots by default. Content access requires a separate customer-approved grant, stated reason, current TOTP reauthentication, short expiry, notifications, and full audit. Platform operators never become permanent workspace members. Grants are reviewed daily and expire automatically.

## Notifications and privacy

Support updates use content-minimized email notifications. Credentials in invitation/appointment notices are encrypted while queued and removed after successful or terminal delivery. Logs and Sentry contain no support body or customer content. If a ticket contains prohibited data, restrict access, notify the privacy/security owner, and follow incident response.

## Customer responsibilities

Maintain current contacts and membership, use supported browsers/extensions, supply request IDs, preserve relevant non-sensitive evidence, cooperate on synthetic reproduction, and follow acceptable use. KnowHow may pause a request that would require unsafe data sharing.

## Closure and escalation

Record resolution and customer-visible action. Escalate unresolved P0/P1 issues to the incident commander; an organization may not be added and a pilot may not continue while severe security, data-loss, or onboarding issues remain unresolved. Support records follow the retention schedule.

Owner/version/effective date: `[pending]`
