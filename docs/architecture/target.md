# Appwrite external-pilot architecture

KnowHow runs as one standard Next.js application per environment on Appwrite Sites. Public pages live at `/`; invitation-only product routes live under `/app` and `/w`.

The browser talks to Appwrite only through KnowHow authentication endpoints. Those endpoints use the Appwrite Server SDK and store the returned session secret in a secure, HTTP-only, same-site cookie. Every product request resolves that cookie to a verified Appwrite identity on the server. No Appwrite JWT, API key, TablesDB row, or Storage object is exposed directly to browser code.

All product authorization lives in the KnowHow policy layer. Appwrite TablesDB tables and Storage buckets have no client permissions. Scalar `organization_id` and `workspace_id` columns are indexed and revalidated by services before data is hydrated. Organization administration controls metadata and policy but does not imply workspace content membership.

Invariant-sensitive changes use Appwrite transactions, including invitation redemption, last-administrator checks, capture idempotency, audit sequencing, subscription state transitions, and deletion workflows. Mutations accept an idempotency key, return a request ID, and use one versioned error envelope.

Private redacted media is stored in `knowhow_private_media`; asynchronous export artifacts are stored in `knowhow_exports`. The application stores no raw screenshots, form values, credentials, or sensitive captured metadata.

`knowhow_ops` runs lifecycle, notification, usage-rollup, reconciliation, and approved-deletion work on a schedule. Approved deletion freezes exact targets, removes tenant roots instead of keeping customer tombstones, retains only an identifier-scrubbed HMAC-bound receipt, and uses its isolated `users.write` scope only for users proven unreferenced and non-platform. `knowhow_export` creates exports asynchronously. Both functions are idempotent and use server-only scopes.

The checked-in Appwrite resource manifest is endpoint-portable. Frankfurt Staging and Production use separate project IDs and secrets supplied by their deployment environments. The same schema can be pushed to a local self-hosted Appwrite instance for contract smoke tests.

Production Pro uses a database-bound daily backup policy. Restore rehearsals target a new database ID that no deployed runtime references; HMAC-sealed evidence compares the checked-in schema, every table row fingerprint, and every audit-chain head before disposable application and tenant-isolation checks. This database control does not claim independent recovery for private Storage media.
