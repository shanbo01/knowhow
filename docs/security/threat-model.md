# Threat model and security overview

Scope: the local KnowHow installation, including the Next.js server, local Appwrite Auth/TablesDB/private Storage, local worker processes, optional Sentry and Resend integrations, Mailpit, the Chromium extension, and the Windows-first Tauri 2 KnowHow Capture application. Review this model after material identity, authorization, capture, native API, signing/update, export, lifecycle, machine, network, backup, or provider changes.

## Assets and security objectives

- Customer guide text, revisions, audiences, redacted screenshots, exports, support messages, branding, and settings.
- Identity sessions, invitations, administrator appointments, MFA/recovery flows, extension access/refresh credentials, token keyrings, API keys, worker secrets, and deletion-receipt keys.
- Tenant membership/role assignments, exceptional-access grants, subscriptions/entitlements, lifecycle/deletion state, and audit-chain integrity.
- Availability of authentication, viewing, capture, publication, export, notifications, support, and recovery.

Objectives are default-deny confidentiality, tenant and audience isolation, authorized/transactional integrity, durable auditable lifecycle actions, and recoverability within stated pilot limits.

## Trust boundaries

1. Public browser to the Next.js Site: untrusted input, origin/CSRF/rate/size validation required.
2. Authenticated browser to the Site: HTTP-only Appwrite session cookie; browser cannot access server API keys or product stores.
3. Site/Functions to Appwrite: server API keys and resource scopes; all product authorization remains in KnowHow policy.
4. Appwrite project to external email/Sentry: metadata-minimized notifications and aggressively scrubbed telemetry.
5. Browser page to extension contexts: hostile web pages must not reach extension secrets or cause unauthorized capture.
6. Extension service worker to KnowHow API: short-lived device bearer token scoped to one user/workspace/device and explicit capture/media scopes.
7. Platform/support operators to customer tenants: metadata administration is separate from content membership; exceptional access is temporary, approved, reason-bound, MFA-reauthenticated, notified, and audited.
8. Lifecycle approval to purge worker: explicit reauthentication and typed confirmation precede an asynchronous idempotent purge with a frozen plan and content-free receipt.
9. Windows input/UIA/DXGI threads to the native reducer: OS events and frames are untrusted, asynchronous, and may disappear; input is observed without interception, source frames stay in memory, scope/protection checks fail closed, and only accepted semantic actions reach encrypted storage.
10. Tauri renderer to Rust commands: a local WebView is still untrusted UI. A minimal capability allowlist exposes typed recorder commands only; renderer network is blocked and no shell/filesystem/HTTP plugin is granted.
11. Windows device to `/api/desktop/v1`: browser-approved PKCE authorization yields five-minute scoped access and rotating device-bound refresh credentials; workspace, author, entitlement, source, and device kind are server-derived.
12. GitHub protected release to Windows endpoints: workload identity reaches a non-exportable Azure Artifact Signing profile; Authenticode and Tauri updater signatures, hashes, SBOM, Defender scan, and environment approval gate publication.

## Principal threats and controls

| Threat | Primary controls | Residual risk / verification |
| --- | --- | --- |
| Unauthorized signup, reused beta code, or forged invitation | Server registration mode fails closed; private-beta codes are high-entropy and hash-only, optionally exact-email bound, expiring, revocable, and atomically reserved/consumed; signed invitation/appointment validation remains independent; domain join is rejected | Credential delivery mailbox compromise; test one-use concurrency, compensation, and notification secrecy |
| Session theft/fixation | Server-created Appwrite session, secure HTTP-only same-site cookies, exact origins, CSRF token, session revocation, HSTS | Compromised endpoint/browser; exercise session limits and revocation in controlled environments |
| Administrator account takeover | Verified email, TOTP required for platform/workspace admins, current TOTP for exceptional actions, one-time recovery codes | Recovery-code theft and social engineering; require secure storage and audit regeneration |
| Cross-tenant IDOR/query leakage | Scalar tenant IDs, indexed filters, server revalidation, default-deny policy, not-found equivalence, no client table/file permissions | Service regression; unit, integration, load, and two-tenant tests are release gates |
| Organization admin reads content | Organization roles authorize metadata only; workspace membership and audiences separately govern guides/media | Accidental UI hydration; test organization-admin metadata access without content access |
| Platform/support abuse | Explicit platform roles only; no environment promotion; no permanent operator membership; exceptional grant approval/reason/expiry/notification/audit | Solo-operator concentration; review grants daily and obtain customer approval |
| Raw or sensitive screenshot persistence | Visible-tab only, no form-value/raw-key/clipboard capture, password/iframe masking, opt-in and manually chosen masks, privacy-rasterized pre-action frames, immediate destruction of the raw data URL/canvas, redacted-only IndexedDB, attestation, magic/dimension/size validation, privacy review | Canvas/video/native UI and human review gaps; prohibited-data policy remains essential |
| Malicious captured page attacks extension | MV3 CSP, no remote code, no static content scripts, isolated service worker credential, active regular HTTP(S) tab checks, incognito block, excluded hosts, optional host grant | Browser/platform vulnerabilities; current browser versions and store updates required |
| Extension token replay/theft | Five-minute access tokens, rotating refresh credentials, previous-token reuse revokes device, workspace/user/device binding, inventory/revoke/min-version checks | Compromised browser profile until detection; revoke devices and rotate keys |
| Desktop credential theft/replay | No cookie/password/custom-protocol transfer; ten-minute browser approval with S256 verifier; DPAPI-protected rotating 30-day refresh credential; five-minute access token; device/workspace/user/scope binding; previous-token reuse revokes the device; membership/entitlement/min-version checks on use | Malware in the signed-in Windows user context may act as that user; revoke the device, investigate the endpoint, rotate token signing keys if needed |
| Password/secret capture through native UI | Password UIA state fails closed; password values are never read; clipboard and raw scan codes are never persisted; Windows Security, credential/password-manager, secure desktop, lock screen, known private-browser, protected/elevated, excluded KnowHow, and intersecting excluded windows are blocked or raster-masked before persistence | Incomplete third-party UIA providers and unknown confidential apps; coordinate fallback cannot include exact text, creators must choose narrow scope and review every private draft |
| Raw desktop frame or crash/log disclosure | DXGI frame rings are bounded GPU/RAM state; only processed masked JPEGs persist; encrypted SQLite uses per-session AES-GCM keys wrapped by DPAPI; crash/support/telemetry paths exclude screenshots/text/tokens; key erasure on discard/success/expiry/uninstall | Live endpoint memory compromise and OS/GPU driver defects; endpoint hardening and incident response remain required |
| Native event ordering, duplicates, or input interference | Dedicated Raw Input message thread observes without blocking/replaying; timestamped monitor frame rings; deterministic reducer/deduplication; finish stops acceptance then drains up to ten seconds; idempotent server uploads | Extreme device/UIA/DXGI contention may mark a step for retry/delete; 100-action soak and device-loss tests are release gates |
| Malicious or downgraded desktop update | Exact compiled HTTPS endpoint, no redirects, Tauri signature verification, minimum-version enforcement, active-capture deferral, Authenticode with Azure Artifact Signing, protected release environment, hashes/SBOM/Defender gates | Compromise of CI identity, signing roles, or updater private key; protect environment approvers, use federated credentials, rotate/revoke keys, and publish a higher-version recovery build |
| Stored XSS/content injection | React escaping, HTML export escaping, raster-only images, restrictive media CSP/nosniff, input limits | Renderer regressions; test hostile guide/export input and never render arbitrary uploaded HTML |
| CSRF/cross-origin mutation | Exact origin validation, same-site cookie, double-submit CSRF for cookie mutations, no wildcard controlled origins | Misconfigured proxy/origin; readiness configuration fails closed |
| Brute force/abuse/DoS | App and provider rate limits, hashed fingerprint with secret pepper, request-size/media/step limits, pagination caps | Distributed attacks/provider exhaustion; monitor 429/5xx and adjust without logging identifiers |
| Export disclosure | Authorization rechecked at request and worker boundaries, restricted-export policy, watermark, private bucket, expiring job/artifact, random IDs | Shared downloaded file outside service; customer handling policy and watermark apply |
| Notification credential/log leakage | Credentials encrypted at rest with context-bound AES-GCM, decrypted only for delivery, scrubbed after success/terminal failure; content-free templates/logs | Email mailbox/provider exposure; minimize recipients and verify templates/provider settings |
| Sentry/privacy leakage | No default PII, scrubbed URL shapes, removed headers/cookies/body/query/user, allowlisted tags/extras, sanitized exception values/breadcrumbs | SDK/config regression; synthetic canary inspection required before release |
| Audit tampering/races | Append-only hash chain, per-workspace sequence, transaction-backed ordering, no content/secrets in audit metadata | Server-key compromise; alert on chain mismatch and preserve provider audit logs |
| Last-admin or entitlement race | Appwrite transactions for invitation redemption, final-admin guards, capture idempotency, audit sequencing, subscription/deletion transitions | Platform transaction semantics/config drift; concurrency tests and Appwrite integration smoke |
| Premature/partial deletion | 90-day eligibility from original expiry, overdue escalation, explicit approval with TOTP/typed confirmation, case/org/workspace-bound HMAC-sealed target plan, cross-tenant/scope-drift refusal, delete-not-tombstone roots, guarded unreferenced-user cleanup, idempotent 404 handling, quarantine, scalar-scrubbed HMAC-bound receipt, read-only clean-state verifier | Provider partial failure or a new post-approval row/workspace; P1 alert and worker/manual review; never broaden a frozen plan or manually falsify completion |
| Backup loss or false recovery claims | Operator-owned encrypted backups; recorded archive hashes; isolated local restore rehearsal covering database, Auth, private media, tenant boundaries, and audit continuity; observed recovery measurements labeled noncontractual | A backup is not accepted until an isolated restore passes; pilot terms prohibit stronger claims |
| Supply-chain/secret compromise | Lockfiles, `npm ci`, dependency audit, Gitleaks plus local secret scan, GitHub read-only token, no runtime remote extension code | Unknown upstream flaws; patch cadence, Sentry monitoring, incident response |

## Authorization model

- Platform: owner, operations, support, billing, auditor.
- Organization: owner, administrator, billing, security auditor.
- Workspace: administrator, creator, reviewer, publisher, viewer, with a separate vault capability.
- Guide audience: workspace, group, or named user, evaluated independently from roles.

Every action has an explicit policy operation and facts. Absence of a grant denies. Subscription state can further limit an otherwise authorized action (active, read-only grace, suspended, deletion pending). No Appwrite label or Team grants product authority.

## Data minimization

- Tables store typed scalar routing/index fields plus versioned JSON payloads; service validation enforces cross-table ownership.
- Storage contains approved organization logos, redacted screenshots, and expiring exports only.
- Analytics contains event kinds, IDs, counts, and timestamps, never guide text/screenshots.
- Logs/audit/notifications use labels and summaries that exclude captured/customer content and credentials.
- Full paths, queries, fragments, form values, raw keystrokes, clipboard content, and unredacted captures are not persisted.

## Deferred controls and accepted pilot limitations

- No independent media disaster recovery or contractual recovery guarantee.
- No third-party penetration test in this goal.
- No SAML/SCIM, customer-managed keys, customer-ready self-hosting, enterprise procurement package, or contractual SLA.
- No regulated, sensitive, special-category, credential, secret, payment, health, or national-ID data.
- Legal/privacy documents require Qatar-focused review before execution.

These are explicit scope limits, not silent exceptions. A design partner requiring any deferred control cannot enter this pilot.

## Required evidence

- Policy/tenant/concurrency tests, Appwrite contract smoke, anonymous/CSRF/rate/token/export/Sentry/email tests, load results, and Playwright critical journeys.
- Resource drift output proving private permissions and correct indexes.
- Store manifest/hash and device revoke/minimum-version rehearsal.
- Daily-backup and isolated-restore evidence.
- Two-user Staging and Production journeys, followed by clean Production purge.
- Review of residual risks with no unresolved P0/P1 findings.
