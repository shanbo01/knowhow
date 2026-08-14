# Data processing addendum — working template

Status: non-executable structure for Qatar-focused counsel. Complete bracketed fields, reconcile with the pilot agreement/privacy notice/subprocessor contracts, and obtain signatures before real customer data.

## 1. Parties, roles, and scope

This DPA forms part of `[pilot agreement]` between `[customer/controller]` and `[KnowHow legal entity/processor]`. It covers personal data in invited accounts, customer workspaces/guides/redacted media/support, and service operations for the signed pilot. The parties must identify any processing where KnowHow acts as an independent controller (for example contract administration and essential security records) separately.

## 2. Documented instructions

KnowHow processes customer personal data only to provide, secure, support, measure content-free adoption, export, retain, and delete the service under the agreement and customer's documented configuration/instructions. KnowHow informs the customer if an instruction appears unlawful, subject to counsel-approved language, and does not sell data, advertise against it, or use customer content to train general models.

## 3. Processing details (Annex A)

- Subject matter/duration: invitation-only 30-day pilot plus grace, retention, deletion, backup, and legally required periods.
- Nature/purpose: authentication, membership/authorization, SOP capture/edit/review/publication/view/completion, private storage/export, support, notification, security/audit, lifecycle/deletion, and content-free usage measurement.
- Data subjects: authorized customer personnel and limited individuals incidentally visible in approved ordinary business-process material.
- Data: name/work email, account/security state, memberships/roles, organization/workspace settings, approved guide content, locally redacted screenshots, reviews/completions, support messages, audit/security/notification metadata.
- Prohibited categories: credentials/secrets, payment data, health data, national IDs, sensitive/special-category data, children's data, and all categories excluded by the acceptable-use policy.

## 4. Confidentiality and personnel

KnowHow limits access to authorized personnel with confidentiality obligations, MFA, least privilege, role separation, and training. Organization/platform metadata access does not confer customer-content access. Exceptional support access requires customer approval, current TOTP, reason, short expiry, notice, and audit.

## 5. Security measures (Annex B)

- Operator-controlled local Appwrite with server-only product tables/files and empty client permissions.
- Verified email; secure HTTP-only sessions; administrator TOTP and recovery controls; exact origins, CSRF, rate/size limits, and security headers.
- Default-deny policy with separate platform, organization, workspace, vault, audience, support, and subscription checks.
- Private encrypted Storage; local screenshot rasterization/redaction; no raw/form/clipboard/key capture; human privacy review.
- Short-lived scoped extension access, rotating refresh credentials, device inventory/revocation, minimum versions, narrow MV3 permissions.
- Transactions for one-use/last-admin/idempotency/audit/lifecycle/deletion invariants; append-only hash-chained audit.
- Versioned key rotation; context-bound encrypted notification credentials; secrets outside source/logs.
- Scrubbed telemetry, content-free logs/analytics/notifications, dependency and secret scanning, CI/security testing.
- Operator-owned encrypted backups, isolated local restore rehearsal, integrity hashes, media quarantine/reconciliation, and incident response.

Independent media DR, contractual SLA, third-party penetration test, and enterprise identity are expressly not included in this pilot.

## 6. Subprocessors and transfers

Customer authorizes enabled third-party services in the approved `subprocessors.md` under the final notice/change mechanism. KnowHow remains responsible for required service-provider obligations and provides advance notice of material changes for `[period/remedy to be approved]`. The application data stays on the documented local infrastructure; optional email or telemetry may involve other locations. Counsel must approve transfer safeguards and Qatar-specific provisions.

## 7. Data-subject and authority requests

Customer is the primary contact for customer-content requests. KnowHow promptly forwards requests it receives and provides reasonable technical assistance for access, correction, restriction, export, objection, deletion, and authority inquiries, considering the processing and law. KnowHow does not respond on the customer's behalf unless authorized or legally required.

## 8. Security incidents

KnowHow notifies the customer without undue delay after confirming a personal-data incident and provides known nature, affected data/subjects, likely consequences, containment/remediation, and contact information, subject to ongoing updates. Final contractual hours, legal thresholds, regulator/data-subject responsibilities, and cooperation costs require counsel. Notice is not an admission of fault.

## 9. Return and deletion

Customer may request authorized exports before deletion. The lifecycle provides grace, suspension, notices, 90-day eligibility from original expiry, explicit approval with TOTP/typed confirmation, asynchronous purge, and content-free receipt. Legal holds or mandatory retention are documented. Database backup remnants expire under provider policy; independent media recovery is not promised.

## 10. Audit and assistance

KnowHow provides the security overview, test/readiness evidence, subprocessor/retention information, and reasonable questionnaire assistance. Any additional audit must protect other tenants, credentials, and security, use qualified independent reviewers, follow notice/frequency limits, and allocate costs as counsel agrees. No customer receives direct Appwrite or other tenant access.

## 11. Liability, precedence, and law

Counsel must align liability, indemnity, governing law, termination, priority, and mandatory provisions with the pilot agreement. Do not execute this placeholder.

Signatures and effective date: `[pending]`
