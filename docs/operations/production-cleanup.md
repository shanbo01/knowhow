# Local data cleanup runbook

KnowHow's lifecycle worker deletes approved tenant data from the local Appwrite project. Cleanup is deliberate because it can remove rows, private screenshots, exports, invitations, devices, and unreferenced Auth users.

## Procedure

1. Use disposable data for rehearsals.
2. Confirm the lifecycle case identifies the exact organization and workspace and has the required approval and typed confirmation.
3. Run the full local worker once and retain its content-free summary and request IDs.
4. Verify the organization/workspace roots are absent, no tenant-scoped rows remain, and both private buckets contain no files for the deleted workspace.
5. Confirm an Auth user was removed only when no surviving table row or platform role references that user.
6. Keep only the scrubbed lifecycle receipt and audit evidence required by the retention policy.

Any partial deletion, scope mismatch, cross-tenant result, or Storage error is a stop condition. Do not broaden API-key scopes or manually delete unrelated rows to make a check pass.
