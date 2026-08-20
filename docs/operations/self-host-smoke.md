# Appwrite contract smoke

The contract smoke creates disposable rows, a private file, a user, a session, and transactions, then proves that each fixture is removed. Local mode is the default. Controlled mode must run only against an isolated staging project because it exercises real create/update/delete paths.

## Prepare

- Start the local Appwrite installation.
- Confirm `APPWRITE_ENDPOINT=http://localhost/v1` and `APPWRITE_PROJECT_ID=knowhow-local`.
- Push the checked-in tables and buckets.
- Start Next.js and the local workers when API readiness should be included.

## Run

```text
npm run appwrite:smoke:local
```

The smoke verifies:

- Appwrite health and the exact database/table/column/index contract.
- Empty client permissions on every table and private bucket.
- Anonymous TablesDB denial.
- Row create, read, update, delete, read-your-writes, commit, rollback, and conflict rejection.
- Private PNG upload/download byte integrity.
- User creation, server-session authentication, and revocation.
- Optional Mailpit/provider visibility and local Next.js readiness.
- Exact cleanup of every smoke-owned row, file, user, session, and transaction.

Local mode refuses a non-local endpoint or any project other than `knowhow-local`.

## Controlled staging

Populate the controlled environment profile, including `KNOWHOW_SMOKE_MODE=controlled`, `KNOWHOW_APPWRITE_HOSTS`, a non-local project ID, and `KNOWHOW_SMOKE_SITE_ORIGIN`, then run:

```text
npm run appwrite:smoke:controlled
```

Controlled mode accepts only an exact allowlisted HTTPS Appwrite `/v1` endpoint and an exact non-local HTTPS Site origin. It refuses `knowhow-local`, requires a real API key, and uses the same exact-cleanup proof. Never run it against production customer data.
