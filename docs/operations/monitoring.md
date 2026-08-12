# Monitoring and alert thresholds

KnowHow emits content-free structured events with UTC timestamps, event names, request IDs, status/error codes, operation names, durations, and aggregate counts. Logs and telemetry must never contain authorization headers, cookies, request bodies, form values, guide text, screenshots, full URLs, invitation/device credentials, email tokens, or encryption material.

## Signals

- `GET /api/health` is liveness. `GET /api/health?ready=1` verifies identity, TablesDB, both private buckets, both Functions, and controlled configuration.
- Site/API exceptions and performance traces go to Sentry only after `lib/telemetry-scrubber.ts` removes user identity, request data, headers, query strings, raw exception messages, identifiers, and non-allowlisted tags/extras.
- `knowhow_ops` emits completion/failure events, duration, lifecycle transition count, notification failures, purge count, cleanup counts, and orphan reconciliation results.
- `knowhow_export` emits request/job IDs, state, attempts, duration, and content-free failure codes.
- The platform console exposes organization/workspace metadata, subscriptions, entitlements, usage counts, leads, activation milestones, support queues, notification failures, expiring pilots, deletion approvals, health, and audit metadata. Platform views do not expose customer content.

## Pilot alerts

| Priority | Condition | Initial action |
| --- | --- | --- |
| P0 | Any tenant-isolation failure, unauthorized content/file access, raw/unredacted screenshot persistence, secret exposure, unauthorized purge, or audit-chain corruption | Disable affected access, preserve evidence, rotate credentials as needed, notify incident commander immediately |
| P1 | Readiness fails for 10 minutes; auth or product 5xx exceeds 2% for 10 minutes; operations/export worker fails three runs; deletion job partially fails; restore/backup policy fails; storage integrity mismatch | Stop new onboarding/captures as applicable and investigate within 30 minutes |
| P1 | Notification delivery reaches terminal failure for security, deletion, administrator, or pilot-expiry notices | Use approved manual notification channel, preserve delivery evidence, correct provider/configuration |
| P2 | p95 standard API latency exceeds 1,000 ms for 15 minutes; capture commit p95 exceeds 3,000 ms; queue oldest age exceeds 15 minutes; error rate exceeds 1% | Investigate capacity, indexes, provider status, and recent deployments during the business day |
| P2 | Daily backup is late by more than 30 hours or Sentry has stopped receiving heartbeat/test events | Restore monitoring coverage and record the gap |
| P3 | Noncritical lead/support notification retry, isolated client error, or activation-funnel anomaly | Triage in the next working session |

The p95 thresholds are internal pilot budgets, not contractual SLAs. Evaluate Appwrite provider incidents separately but keep customer communication ownership with KnowHow.

## Dashboard review

- Daily: readiness, Sentry regressions, Function failures, notification terminal failures, backup status, expiring pilots, overdue deletion approvals, support target breaches.
- Weekly: authorization denials, rate limiting, active users/creators, storage, activation times, extension versions/devices, audit continuity, restore evidence age, and residual-risk register.
- Before adding design partners two or three: confirm the first partner's previous week has no unresolved severe security, data-loss, or onboarding issue and solo support capacity remains acceptable.

## Telemetry verification

Before external access, send synthetic errors containing fake tokens, headers, form values, guide copy, screenshot-like data, and identifier-bearing URLs. Inspect the received Sentry event and prove each value is absent. Repeat after any Sentry SDK/configuration change. Keep screenshots of Sentry configuration and scrubbed event fields in the private release-evidence store, not the repository.
