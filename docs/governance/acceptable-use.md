# Acceptable use and pilot data classification

Status: operational policy draft; legal and security approval required before execution.

## Permitted pilot data

Only ordinary, low-sensitivity internal business-process information approved by the design partner and KnowHow may be entered. Examples include synthetic demonstrations, nonconfidential software-navigation steps, generic equipment setup, routine onboarding checklists, and internal procedures that contain no restricted fields.

The data owner must review each proposed workflow before capture. Where uncertainty exists, use synthetic values or do not capture it.

## Prohibited data and use

Do not enter, display during capture, upload, paste into support, or include in exports:

- Passwords, recovery codes, API keys, access tokens, private keys, connection strings, or other credentials/secrets.
- Payment-card/account data, banking details, financial authentication data, or live payment workflows.
- Health/medical information, biometric data, genetic data, or clinical workflows.
- National IDs, passport/residency numbers or images, civil records, or government identifiers.
- Sensitive/special-category personal data, children's data, precise location, criminal records, or highly confidential employee/customer records.
- Government-classified, export-controlled, safety-critical, legal-privilege, or production-security incident evidence.
- Malware, unlawful content, intellectual-property infringement, harassment, surveillance, tenant probing, credential testing, or attempts to bypass roles/limits.

The pilot must not be used for automated high-impact decisions, regulated recordkeeping, emergency/safety instructions where failure could cause harm, or as the sole authoritative copy of a process.

## Capture rules

1. Close unrelated tabs/windows and use synthetic accounts where possible.
2. Never capture password managers, authentication prompts, payment/health/government systems, browser internal pages, or excluded hosts.
3. Enable appropriate Smart Blur categories, but do not assume automation catches canvas, video, images, native UI, closed shadow roots, or every identifier.
4. Review every step, crop, click marker, title, description, and screenshot. Apply manual masking and remove unnecessary steps.
5. Complete the privacy review truthfully. If prohibited data may have been uploaded, stop publication and contact the administrator/support immediately.
6. Restrict the guide audience to the minimum necessary users/groups. Publication is not a substitute for data-owner approval.

For Windows desktop capture, also:

1. Capture only workflows the organization has authorized. Do not use KnowHow for covert surveillance, employee monitoring, keylogging, or collection unrelated to a guide the creator is intentionally recording.
2. Choose the narrowest scope that works. Window and application scope are preferred over monitor or all-displays capture.
3. Close password managers, private/incognito browser windows, Windows Security and credential dialogs, unrelated apps, notifications, and other confidential surfaces before recording. KnowHow blocks or masks known protected surfaces, but the creator remains responsible for the visible desktop.
4. “Capture typed text” may place exact non-password text in the private draft. Turn it off unless the wording is needed, and never rely on it to identify every secret-like value.
5. Pause before switching to unrelated or elevated work. Treat the HUD’s out-of-scope/protected status as a stop signal, not a reason to weaken operating-system protections.
6. Finish into the private web editor and complete the existing privacy review before sharing, export, review submission, or publication.

## Responsibilities

- Organization owners approve use cases, train users, maintain membership, and provide legal/security contacts.
- Workspace administrators enforce policies but do not gain content outside memberships/audiences.
- Creators verify data classification and redaction; reviewers/publishers independently check privacy and audience.
- KnowHow operates security, support, lifecycle, and incident controls within the signed pilot limits.

## Enforcement

KnowHow may pause capture, quarantine media, suspend access, revoke devices/sessions, or terminate the pilot to contain prohibited data, abuse, or security risk. Actions are scoped, audited, and communicated through approved contacts. Suspected prohibited-data exposure follows incident response and the executed DPA/terms.

Policy owner/version/effective date: `[pending]`
