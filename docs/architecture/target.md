# Appwrite external-pilot architecture

KnowHow runs as one standard Next.js application per environment on Appwrite Sites. Public pages live at `/`; invitation-only product routes live under `/app` and `/w`.

The browser talks to Appwrite only through KnowHow authentication endpoints. Those endpoints use the Appwrite Server SDK and store the returned session secret in a secure, HTTP-only, same-site cookie. Every product request resolves that cookie to a verified Appwrite identity on the server. No Appwrite JWT, API key, TablesDB row, or Storage object is exposed directly to browser code.

All product authorization lives in the KnowHow policy layer. Appwrite TablesDB tables and Storage buckets have no client permissions. Scalar `organization_id` and `workspace_id` columns are indexed and revalidated by services before data is hydrated. Organization administration controls metadata and policy but does not imply workspace content membership.

Invariant-sensitive changes use Appwrite transactions, including invitation redemption, last-administrator checks, capture idempotency, audit sequencing, subscription state transitions, and deletion workflows. Mutations accept an idempotency key, return a request ID, and use one versioned error envelope.

Private redacted media is stored in `knowhow_private_media`; asynchronous export artifacts are stored in `knowhow_exports`. The application stores no raw screenshots, form values, credentials, or sensitive captured metadata.

`knowhow_ops` runs lifecycle, notification, usage-rollup, reconciliation, and approved-deletion work on a schedule. Approved deletion freezes exact targets, removes tenant roots instead of keeping customer tombstones, retains only an identifier-scrubbed HMAC-bound receipt, and uses its isolated `users.write` scope only for users proven unreferenced and non-platform. `knowhow_export` creates exports asynchronously. Both functions are idempotent and use server-only scopes.

The checked-in Appwrite resource manifest is endpoint-portable. The intended control plane is self-hosted Appwrite 1.9.6 on the Bicep-managed Azure Qatar Central VM. Production and Staging use separate project IDs, keys, users, database rows, Storage objects, Sites, and Function deployments. Appwrite Cloud Frankfurt is retained only as a synthetic/non-sensitive fallback until Qatar parity, backup, restore, and journey gates pass; it is then removed from runtime configuration.

The Qatar platform has two recovery layers. Azure Backup retains daily locally redundant VM recovery points, while the application timer stops the Compose stack briefly, captures every Appwrite Docker volume plus a logical MongoDB dump and exact configuration, encrypts the payload with age, and uploads it by managed identity to a private versioned zone-redundant Qatar Blob container. Restore rehearsals always target a fresh isolated VM; HMAC-sealed application evidence still compares the checked-in schema, every table fingerprint, audit-chain heads, and tenant boundaries before cutover. The single-VM control plane is an accepted private-beta availability limit, not an SLA.
