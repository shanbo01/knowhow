# Local Appwrite contract smoke

The contract smoke is intentionally restricted to the local project. It creates disposable rows, a private file, a user, a session, and transactions, then proves that each fixture is removed.

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

The command refuses a non-local endpoint or any project other than `knowhow-local`.
