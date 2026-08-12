# Database backup and restore rehearsal

Status: execution pending owner-created Appwrite Pro Production. The database and restored-application verifiers, access boundary, and content-free HMAC evidence contracts are implemented locally, but they do not count as restore evidence until they pass against the real Frankfurt Production backup, isolated restoration, and disposable Site. The pilot target is database RPO up to 24 hours and best-effort RTO within one business day; the automated rehearsal enforces the stricter 24-hour elapsed boundary. These are internal targets, not a contractual SLA or full disaster-recovery guarantee.

[Appwrite Cloud backups](https://appwrite.io/docs/products/databases/backups) are encrypted, remotely stored hot backups and are available on Pro and higher plans. This rehearsal covers TablesDB. Independent disaster recovery for private media is deferred. Storage uses integrity hashes, soft deletion, quarantine, and orphan reconciliation, but the pilot must not promise that redacted screenshots can be recovered after a provider-level storage loss.

## Configure backups

1. Upgrade Production to Appwrite Pro before external access.
2. In `knowhow_core` Backups, create a database-bound daily policy and record its policy ID, UTC schedule, retention, and first successful archive ID. Project-wide or unbound policies do not satisfy the verifier.
3. Restrict backup/restore console access to named platform owners. Enable account MFA and retain console audit evidence.
4. Alert when no successful backup exists within 30 hours or a backup reports failure.
5. Before risky schema or release work, create a manual backup and record the backup ID.
6. Create a short-lived verifier key only for the rehearsal with read scopes for databases, tables, columns, indexes, rows, backup policies, archives, and restorations (`databases.read`, `tables.read`, `columns.read`, `indexes.read`, `rows.read`, `backups.policies.read`, `archives.read`, and `restorations.read`). Do not reuse the Site runtime key; revoke the verifier key after cleanup.

## Isolated restore rehearsal

Never restore over the active database during a rehearsal.

1. Create synthetic Production rehearsal data containing two verified, TOTP-enabled users; two organizations and workspaces; overlapping user names; workspace/public/restricted guides with a tenant-specific published search sentinel and private-media row in each workspace; audit segments; lifecycle state; support metadata; and deletion quarantine records. Each user is an administrator of only their own workspace. Give the first user an organization administrator role in the second organization without any membership, group, support grant, or guide/media access in the second workspace. Use no customer data. The private-media IDs support authorization probes only; database backup does not recover the Storage objects.
2. Record an incident-simulation UTC timestamp. Pause application mutations for the short evidence interval and set `KNOWHOW_BACKUP_SOURCE_FROZEN=1` only after verifying the pause. Appwrite performs hot backups; this additional pause binds the completed archive to an exact post-backup fingerprint.
3. Create a database-bound on-demand backup of `knowhow_core` and wait for `completed`. Keep the source frozen while capturing evidence.
4. In the approved secret runner, set the normal Production `APPWRITE_*`, `KNOWHOW_ENVIRONMENT=production`, `KNOWHOW_RELEASE`, the daily policy/archive IDs, the on-demand archive ID, a dedicated 32-byte-or-longer evidence HMAC key and key ID, `KNOWHOW_BACKUP_SYNTHETIC_ONLY=1`, and a unique `KNOWHOW_BACKUP_EVIDENCE_PATH` outside the repository or beneath ignored `.tmp/`. Run:

   ```text
   npm run appwrite:backup:capture
   ```

   The command refuses non-Frankfurt endpoints, unbound/disabled/non-daily policies, a latest policy archive older than 30 hours, incomplete/stale on-demand archives, commit-visible evidence paths, invalid audit chains, and schema drift. It records HMAC-sealed counts and SHA-256 fingerprints for every row in all 40 tables without emitting row bodies, user identifiers, email addresses, or customer content. Resume source mutations only after the file is sealed.
5. Restore that archive in the Appwrite Console to an explicitly new database ID in the same project, such as `knowhow_restore_<release>`. Never select `knowhow_core`. Leave the new database unreferenced by the deployed Site and Functions and record the restoration ID.
6. Point only the verifier's server API key at the new database ID. Set `KNOWHOW_RESTORE_RESTORATION_ID`, `KNOWHOW_RESTORE_INCIDENT_AT`, a unique `KNOWHOW_RESTORE_REPORT_PATH`, and the three attestations `KNOWHOW_RESTORE_ISOLATED=1`, `KNOWHOW_RESTORE_NOT_REFERENCED=1`, and `KNOWHOW_RESTORE_SYNTHETIC_ONLY=1`. Keep the same source evidence path, HMAC key, and key ID. Run:

   ```text
   npm run appwrite:restore:verify
   ```

   The command verifies the completed restoration is bound to the captured archive and destination database, refuses the active source database, recomputes the checked-in private schema, paginates every row with caching disabled, compares every per-table count/fingerprint, validates every audit event and workspace head, checks the overall database fingerprint, and enforces the 24-hour database RPO boundary. The sealed report explicitly leaves application-level RTO open.
7. Create a second, disposable Site in the same Production project from the exact verified release, using a distinct ID such as `knowhow_restore_web_<release>`. Never replace or reconfigure the stable `knowhow_web` Site or either Production Function. Give the disposable Site its own unguessable origin, short-lived runtime key, and temporary Appwrite Auth Web-platform hostname. Configure the normal Production variables and stable bucket IDs, but set `APPWRITE_DATABASE_ID` and `KNOWHOW_RESTORE_APPLICATION_DATABASE_ID` to the new `knowhow_restore_*` database and `KNOWHOW_RESTORE_APPLICATION_SITE_ID` to the disposable Site ID. Set the exact restoration ID, source project ID, active Production Site origin, exact 40-character release, and a new 32-byte-or-longer `KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN`. Then set:

   ```text
   KNOWHOW_RESTORE_APPLICATION_MODE=1
   KNOWHOW_RESTORE_APPLICATION_CONFIRM=production-isolated-restore-application
   KNOWHOW_RESTORE_APPLICATION_ISOLATED=1
   KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC=1
   KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_ONLY=1
   KNOWHOW_RESTORE_APPLICATION_EMAIL_DISABLED=1
   KNOWHOW_RESTORE_APPLICATION_EXCLUSIVE=1
   ```

   Restore mode is a separate fail-closed runtime contract: ordinary Staging and Production still require `knowhow_core`. The disposable Site becomes ready only for a distinct `knowhow_restore_*` database and `knowhow_restore_web_*` Site ID in the same Production project, distinct exact configured/source HTTPS origins, the exact release/restoration, all five attestations, and a valid access secret. Readiness exposes only domain-separated fingerprints for the restored database, restoration, disposable Site ID, and both origins. Its Next.js proxy revalidates the complete controlled configuration on every request, returns a no-store `404` for any invalid configuration or missing secret header, and removes that header before application code runs. Do not point a Function event or schedule at the restored database. The selected application operations do not queue notifications, and the export must remain queued because the Production export Function listens only to `knowhow_core`.
8. In the approved secret runner, set `KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN`, the expected Production project/release, the dedicated synthetic email domain, a unique private `KNOWHOW_RESTORE_APPLICATION_REPORT_PATH`, and `KNOWHOW_RESTORE_APPLICATION_ACTORS_JSON` with exactly two objects containing `label`, `email`, `password`, `totpSecret`, `userId`, `organizationId`, `workspaceId`, `publishedGuideId`, `privateMediaId`, and `searchQuery`. Retain the sealed database restore report path and its HMAC key/key ID. Run:

   ```text
   npm run appwrite:restore:application
   npm run appwrite:restore:application:evidence:verify
   ```

   The live gate first proves the entire Site denies requests without the restore secret. It then requires readiness to expose the exact environment, project, release, restored-database/restoration fingerprints, disposable Site-ID fingerprint, and configured/source-origin fingerprints; checks anonymous denial across product/media/export/audit/extension APIs; authenticates both exact verified MFA actors; proves own-tenant sentinel reads and mutual bootstrap/search/media denial; proves that the first actor sees second-organization metadata without second-workspace access; commits and idempotently replays one real transaction-backed completion; verifies the full audit chain and three exact sequence advances; creates and idempotently replays an export that remains isolated in `queued`; and revokes both sessions. It retains each pre-logout Appwrite session secret only in memory and requires a direct Frankfurt Auth request with that exact secret to return `401`, so cleared browser cookies alone cannot satisfy server-session revocation. The immutable report contains only HMAC actor/resource fingerprints, aggregate checks, timestamps, and a digest/count of response correlation IDs. It is cryptographically chained to the sealed database restore report and enforces full application verification within 24 elapsed hours of the incident-simulation timestamp. The offline command needs the evidence key and expected bindings, including the disposable Site ID, but not actor passwords, TOTP seeds, or the Site access token. The database verifier's elapsed time alone is not RTO proof.
9. A second operator must verify both seals and exact bindings, review the evidence, then delete the exact restored database and disposable Site. Remove the temporary Auth platform hostname, revoke the disposable Site runtime key, and destroy the restore access secret. Create a final short-lived read-only key with exactly `databases.read` and `sites.read`; it must have no deletion/write scope. Set `KNOWHOW_RESTORE_APPLICATION_SITE_ID`, a unique `KNOWHOW_RESTORE_CLEANUP_REPORT_PATH`, `KNOWHOW_RESTORE_CLEANUP_CONFIRM=production-isolated-restore-cleanup`, and all four cleanup attestations (`KNOWHOW_RESTORE_CLEANUP_SECOND_OPERATOR=1`, `KNOWHOW_RESTORE_CLEANUP_PLATFORM_REMOVED=1`, `KNOWHOW_RESTORE_CLEANUP_RUNTIME_KEY_REVOKED=1`, and `KNOWHOW_RESTORE_CLEANUP_ACCESS_SECRET_DESTROYED=1`). Retain the expected project/release/database/restoration/Site origins plus both prior report paths and HMAC configuration. Run:

   ```text
   npm run appwrite:restore:cleanup:verify
   npm run appwrite:restore:cleanup:evidence:verify
   ```

   The read-only gate requires `knowhow_core` and `knowhow_web` still to exist while the exact restored database and disposable Site both return Appwrite `404`. It HMAC-seals those results and chains them to both prior reports without retaining raw resource IDs. Revoke the cleanup verifier key immediately after the offline command, then record the approver, deletion operator, UTC time, and report fingerprints. Application mutation/export/audit rows remain confined to the disposable restored database until exact deletion; they must never be copied back to `knowhow_core`.

## Restore acceptance criteria

- Restore status is successful and no table is missing.
- HMAC-sealed counts and full-row fingerprints match for every table at the expected recovery point.
- Audit chains validate, tenant boundaries hold (including organization metadata without workspace data authority), and transaction-backed mutations still work and replay idempotently.
- RPO is at most 24 hours and RTO is within one business day for the rehearsal.
- The exact disposable Site ID/origin denies every request without its restore secret, its export remains queued, both synthetic Appwrite server sessions are directly proven revoked, and no notification is delivered.
- No customer data, backup export, credential, or screenshot appears in logs/evidence.
- A second operator verifies all three HMAC seals; the read-only cleanup gate proves the Production source database/Site remain present and the exact restored database/disposable Site are absent.
- Any discrepancy is a release blocker until explained, corrected, and retested.

## Emergency recovery

During an actual incident, the incident commander freezes mutations if safe, records the last known-good backup and current queue state, and restores into isolation first. Cutover requires explicit approval after integrity and authorization checks. Preserve the compromised/failed environment for forensics unless doing so increases exposure. Rotate application, Function, token, export-worker, deletion-receipt, email, and monitoring credentials when compromise is possible.

## Evidence record

Attach the following to the private readiness evidence:

- Pro subscription and daily policy screenshots/IDs.
- HMAC-sealed source and restored counts/hashes, key ID, and verifier release (never the key).
- Backup/restore IDs and UTC timestamps.
- RPO/RTO calculations and the HMAC-sealed restored-application report chained to the database report.
- Access-boundary, exact-readiness, two-user tenant/organization-isolation, transaction/idempotency, audit-sequence, queued-export, anonymous-denial, and session-revocation output.
- Operator and reviewer sign-offs.
- HMAC-sealed read-only cleanup proof, cleanup-key revocation confirmation, and residual limitations.
