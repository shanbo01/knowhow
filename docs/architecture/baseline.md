# Verified delivery baseline

Checkpoint: `74f3729` (`fix: apply annotated app and extension feedback`)

Branches:

- `codex/extension-feedback` preserves the verified UI and extension checkpoint.
- `codex/appwrite-pilot-readiness` is the delivery branch created from that exact checkpoint.

Verification at the checkpoint:

- Application production build: passed with Vinext.
- Application tests: 63 passed.
- Extension tests: 85 passed.
- Extension privacy-guarded deterministic build: passed.

## Behaviour that must survive the backend migration

- Workspace routes and direct links remain scoped to exactly one workspace.
- Roles and audiences remain independent. A broad organization role never grants guide access.
- Published revisions remain immutable while a separate working draft is edited.
- Captured guides require review approval and a completed privacy review before publication.
- Screenshots stay private, raster-validated, and redacted before publication.
- Extension capture remains workspace-scoped, revocable, pause-safe, and free of Appwrite credentials.
- Temporary support access remains explicit, expiring, reason-bound, separately approved, and audited.
- Audit history remains append-only and excludes secrets, guide content, screenshots, and captured values.
- Tenant identifiers are checked at every read and mutation boundary; missing access is indistinguishable from a missing resource.

## Legacy boundary being removed

At this checkpoint, the server still depends on Vinext, a Cloudflare Worker entry point, D1 SQL/Drizzle migrations, R2 bindings, Wrangler, browser-generated Appwrite JWT forwarding, environment-based platform-owner promotion, and legacy `rivet` resource identifiers. None of those components are an approved production dependency for the external pilot.

The old Appwrite Cloud project's configuration-only inventory is preserved in `docs/architecture/legacy-appwrite-snapshot.md`. It records no customer/demo content and is explicitly forbidden as a source for target rows, users, files, credentials, permissions, or environment bindings. After that read-only snapshot, the owner authorized permanent deletion of the demo project; it was removed without exporting or migrating anything.
