# Production synthetic-tenant cleanup

Status: implementation and local contract tests pass; execution remains pending the owner-created Frankfurt Pro Production project and final two-user rehearsal.

This procedure is only for the final synthetic Production rehearsal. It is not permission to bypass the 90-day lifecycle, owner approval, recent TOTP reauthentication, exact typed confirmation, legal hold review, or incident controls for customer data.

## What the worker deletes

The approved lifecycle case freezes exact table-row and Storage-file targets before deleting anything. Plan version 3 is HMAC-bound to the deletion case, organization, workspace, complete row/file manifests, and candidate-user set; a missing, altered, or transplanted stored plan fails before deletion. The manifest includes the workspace root, subscriptions, all workspace data, organization-only data, and—when this is the final workspace—the organization root. Current targets may disappear on retry, but a new target, changed file reference, newly introduced workspace after final-organization approval, workspace/organization mismatch, or more than 50,000 rows in a scanned table fails closed for review.

The worker deletes roots rather than changing them to `deleted` tombstones. It retains the approved lifecycle case only after clearing its raw organization, workspace, user, subject, email, request, schedule, and deletion fields. Its payload then contains only timestamps, HMAC organization/workspace/approving-actor hashes, and deletion counts; the transient target manifest and typed confirmation are removed.

Candidate Appwrite Auth users are deleted only after all tenant targets are gone and a full table scan proves no surviving `user_id`, `created_by`, or `updated_by` reference. A platform-role holder or user referenced by another organization is preserved. For the isolated two-user Production rehearsal, both users must be removed automatically. `knowhow_ops` alone has `users.write` for this guarded step.

## Execute the approved purge

1. Confirm the journey used exactly two synthetic accounts and no customer or prohibited data. Record the release ID, user IDs, organization ID, workspace ID(s), deletion-case ID(s), and reviewer in the approved secret/evidence system—not the repository.
2. Exercise expiry, read-only grace, suspension, retention notices, and deletion eligibility with the controlled synthetic dates. Confirm the case is `awaiting_approval`; do not edit the database to skip lifecycle controls.
3. A platform owner reauthenticates with TOTP, enters the exact confirmation text, and approves the case through the product control plane. Preserve the request ID and content-free audit evidence.
4. Let the scheduled `knowhow_ops` deployment process the case. A storage error returns the case to `approved` with a delayed retry before any row deletion. Any scope-drift, cross-tenant, user-cleanup, or residue error is P1: stop, preserve Function logs/request IDs, investigate, and never broaden or falsify the frozen plan.
5. Confirm the case reaches `completed`. Do not manually mark it completed and do not delete the receipt.

## Run the read-only clean-state gate

Create a short-lived key on the final Production project with exactly `rows.read`, `files.read`, and `users.read`, following Appwrite's current [scope catalog](https://appwrite.io/docs/partners/project/api-keys). It must not have any write, key-management, database-definition, table-definition, bucket-management, Messaging, Function, or Site scope. Keep the deletion receipt pepper and release-evidence HMAC key in the approved secret runner.

Set the standard Appwrite variables plus:

```text
KNOWHOW_ENVIRONMENT=production
KNOWHOW_RELEASE=<immutable-release-id>
KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID=<reviewed-production-project-id>
KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID=<distinct-reviewed-staging-project-id>
KNOWHOW_CLEANUP_EXPECTED_RELEASE=<exact-40-character-deployed-sha>
KNOWHOW_CLEANUP_TARGETS_JSON=[{"caseId":"<case-id>","organizationId":"<organization-id>","workspaceId":"<workspace-id>","organizationDeleted":true}]
KNOWHOW_CLEANUP_USER_IDS_JSON=["<synthetic-owner-user-id>","<synthetic-member-user-id>"]
KNOWHOW_CLEANUP_EVIDENCE_PATH=<private-unique-path>
KNOWHOW_CLEANUP_SYNTHETIC_ONLY=1
KNOWHOW_CLEANUP_FINAL_PRODUCTION=1
```

For a multi-workspace rehearsal, list every receipt mapping and set `organizationDeleted: true` only on the receipt that removed the final organization root. Then run:

```text
npm run appwrite:production:cleanup:verify
```

The verifier is read-only and accepts only `https://fra.cloud.appwrite.io/v1`. It requires the credential's project to equal the reviewed Production project, differ from the forbidden Staging project, and use the exact deployed release, `knowhow_core`, `knowhow_private_media`, and `knowhow_exports`. It requires:

- every declared organization and workspace row to be absent;
- the complete set of completed deletion receipts to be declared, scalar-scrubbed, field-allowlisted, HMAC-bound to the approved targets, and free of failed-file counts;
- all 40 tables to contain no customer-scoped row and no raw rehearsal organization, workspace, case, or user identifier, including embedded strings and JSON keys/values;
- exactly the two rehearsal Appwrite Auth users to return `404`;
- both `knowhow_private_media` and `knowhow_exports` to contain zero files;
- receipts to prove exactly two automatic user removals and no preservation at final-organization deletion; an earlier non-final workspace receipt may record temporary preservation while the users still belong to the organization or another workspace.

The output contains only counts, HMAC fingerprints, timestamps, stable resource names, and a project fingerprint. It is sealed with HMAC-SHA-256, written with exclusive-create semantics, and may be stored only outside the repository or under ignored `.tmp/`. Preserve it in the private release-evidence store, have the independent reviewer verify the command result and provider console, then revoke the short-lived key.

With the same private evidence path, evidence HMAC key, and key ID—but no Appwrite credential—the reviewer can independently check the immutable file:

```text
npm run appwrite:production:cleanup:evidence:verify
```

This offline command needs the expected/forbidden project IDs and expected release, but no Appwrite credential. It recomputes the HMAC with constant-time comparison and rejects a different key ID, any altered byte of structured evidence, missing or unexpected report fields, a different project/release/database, a non-Production report, nonzero residue, or missing controlled attestations.

The gate fails rather than cleaning anything. Investigate any failure under the incident runbook; rerun to a new evidence path only after the underlying state is corrected through an authorized workflow.
