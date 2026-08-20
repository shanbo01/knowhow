# Privacy notice — controlled pilot draft

Status: draft for Qatar-focused legal review. Replace every bracketed field, align it with the executed pilot agreement/DPA, publish an approved version, and record effective/version dates before accepting real customer data. This draft is not legal advice and is not yet an operative notice.

## 1. Operator and contact

KnowHow is operated by `[legal company name, Qatar registration and address]` (`KnowHow`, `we`, `us`). Privacy contact: `[name/title/email/postal address]`. The pilot organization's executed documents determine when KnowHow acts as processor/service provider and when it acts as controller for its own account, security, support, lead, and contract administration data.

## 2. Pilot scope

KnowHow is an invitation-only SOP service offered to selected design partners for a signed 30-day pilot, normally one department and no more than 100 users per organization. The service is not approved for credentials, secrets, payment information, health information, national IDs, or other sensitive or special-category data. Users must stop capture and contact their administrator if prohibited data may be present.

## 3. Information processed

- Account: name, work email, verification/MFA/session status, memberships, roles, paired Windows device name/architecture/version/last-used state, and security events.
- Organization/workspace: legal/display details, contacts, branding, policy, subscription/pilot dates, entitlements, usage counts, and administrator-issued invitations.
- Customer content: guide titles/text, revisions, audiences, reviews, completions, approved support messages, private locally redacted screenshots, and—only when the creator enables it and workspace policy permits it—exact text derived from before/after changes in non-password desktop controls.
- Operations: content-free audit records, request/correlation IDs, error codes, lifecycle/deletion state, notification delivery metadata, support cases, backup/restore evidence, and private expiring exports.
- Leads: information voluntarily submitted through demo/pilot/contact forms and related follow-up status.

The Windows recorder keeps source frames in GPU/RAM only. Before local persistence it permanently rasterizes password, protected-surface, excluded-window, and enabled Smart Blur masks, then encrypts the processed screenshot and step metadata with a per-session key protected by Windows DPAPI. KnowHow is designed not to retain source frames, password values, clipboard content, raw scan codes/keystrokes, full captured paths/query strings/fragments, or customer content in logs, crash reports, analytics, or telemetry.

## 4. Purposes

We process information to authenticate users; provide and secure workspaces; enforce roles/audiences/subscription state; capture, review, publish, view, export, and measure SOP adoption; provide support; deliver operational notices; prevent abuse; maintain audit/integrity records; administer pilots/contracts; respond to rights and incidents; and comply with applicable obligations.

The final notice must state the legally reviewed basis for each controller purpose. Customer content is processed under the pilot organization's documented instructions and the DPA, except where law requires otherwise.

## 5. Access and sharing

Product content is accessible only through workspace membership and guide audiences. Organization administrators do not receive guide or screenshot access automatically. Exceptional support access requires customer approval, current TOTP reauthentication, a reason, short expiry, notification, and audit; platform operators do not become permanent workspace members.

We use the subprocessors listed in `subprocessors.md`. We do not sell customer data or use customer content for advertising. `[State the reviewed position on AI/model training; the intended pilot position is that customer content is not used to train general models.]`

## 6. Location and transfers

The application database and private storage run on operator-controlled local infrastructure. Optional email and error-monitoring providers may process minimized operational data only when enabled and approved as described in the service list and contracts. The final notice/DPA must describe the machine location, any backup locations, enabled integrations, and legally required transfer safeguards.

## 7. Retention and deletion

The approved retention schedule controls. At pilot/trial expiry, KnowHow provides a configurable grace period, suspension, reminders, and a 90-day deletion-eligibility point measured from original expiry. Nothing is purged without explicit authorized approval, TOTP reauthentication, and typed confirmation. The asynchronous purge creates a content-free receipt. Legal holds, security evidence, and statutory/contractual requirements may alter a specific period and must be documented.

Backup frequency, observed recovery time, and media coverage must be stated from the operator's tested local procedure. KnowHow does not promise a contractual RPO, RTO, or SLA during the pilot.

## 8. Security

Controls include verified email, administrator TOTP, secure HTTP-only sessions, exact origin/CSRF checks, rate and size limits, server-only product data, default-deny authorization, private Storage, short-lived rotating browser and Windows device credentials with reuse revocation, local screenshot redaction and privacy review, Windows UI Automation password fail-closed behavior, DPAPI-wrapped per-session encryption, signed updates/installers, transaction-backed invariants, hash-chained audits, optional scrubbed telemetry, versioned key rotation, operator-owned encrypted backups, and incident response.

No system is risk-free. Pilot users must follow the acceptable-use/data-classification policy and report suspected incidents promptly.

## 9. Choices and rights

Users may contact the privacy address about access, correction, deletion, restriction, objection, portability, consent withdrawal where relevant, or complaints. The pilot organization ordinarily handles requests about customer content; KnowHow assists under the DPA. Identity must be verified, and applicable exceptions/retention duties may apply. The final legally reviewed notice must describe Qatar-specific rights, response periods, regulator contact, and appeal/complaint routes.

## 10. Changes

Material changes require version/effective dates and notice through approved pilot contacts before they take effect, unless urgent security or legal action requires otherwise. The executed agreement controls conflicts.

Approved by: `[legal]`, `[security/privacy]`, `[company signatory]`  
Version/effective date: `[pending]`
