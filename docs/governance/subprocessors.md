# Pilot subprocessor and third-party service list

Status: draft inventory. Legal/privacy must verify current legal entities, service terms, processing locations, transfer safeguards, and notification contacts before publishing or executing a DPA. Update this list before adding/changing a processor.

| Provider | Purpose | Intended data | Configured location / limitation |
| --- | --- | --- | --- |
| Appwrite Cloud | Authentication, TablesDB, private Storage, Functions, Sites, platform logs/backups | Accounts, tenant records, approved guide content, redacted media, exports, operational metadata | Separate Staging/Production projects in Frankfurt; Production Pro daily database backups |
| Resend, integrated with Appwrite Messaging/direct adapter where needed | Account, invitation, pilot/lifecycle, support, deletion, lead, and operational email | Recipient address, content-minimized template, delivery/idempotency metadata; short-lived invitation/appointment credential only when required | Sender/DNS verification required; confirm legal entity and processing locations in contract |
| Sentry | Error/performance monitoring and alerts | Scrubbed route shapes, error class/code, request ID, operation, status, aggregate timing; no intended user/content/header/body data | PII disabled and event scrubber enforced; confirm project region/contract/retention |

## Distribution platforms

Google Chrome Web Store and Microsoft Edge Add-ons distribute signed extension packages and update metadata. KnowHow does not intentionally send customer guide content, screenshots, Appwrite sessions, or extension device credentials to store operators. Counsel must decide whether and how to disclose these platforms as subprocessors or independent distribution providers.

## Development/operations services

GitHub may host source and CI artifacts, but production/customer data and secrets must not enter the repository, ordinary CI fixtures, issues, or build artifacts. If production evidence or customer-related support is later stored in another SaaS, add and approve that service before use.

## Change process

1. Security/privacy reviews purpose, data minimization, location, access, retention, deletion, breach terms, subprocessors, and transfer safeguards.
2. Legal approves the contract/DPA and Qatar-specific requirements.
3. Update this document and notify design partners under their executed notice/objection terms.
4. Configure and test with synthetic data; update threat model, privacy notice, retention, incident, and readiness evidence.
5. No provider receives pilot data before approval is complete.

Owner/version/effective date and last verification: `[pending]`
