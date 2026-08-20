# Backup and restore runbook

This runbook defines the acceptance contract. Exact volume names, managed-service APIs, retention settings, and commands depend on the selected QHost/provider topology and must be recorded in the private infrastructure inventory, not guessed by application code.

## Backup

1. Stop the KnowHow worker loop and prevent new application writes.
2. Record the application revision, Appwrite version, project ID, database and bucket IDs, and UTC start time.
3. Use the selected Appwrite deployment's documented consistent-backup procedure to capture its database, Storage data, and required configuration/secrets.
4. Store the archive on encrypted media separate from the active data directory.
5. Record archive hashes, byte sizes, operator, completion time, and any errors. Do not place the archive or secrets in this repository.
6. Resume writes only after the archive and its metadata have been verified.

## Restore rehearsal

1. Create an isolated Appwrite restore target on a separate project, credentials, and network boundary. Do not point the active Next.js process at it.
2. Restore the captured database, Storage, and configuration into that instance.
3. Confirm the restored project, `knowhow_core`, both private buckets, users, and row counts are present.
4. Point a disposable checkout and environment profile at the isolated instance.
5. Run manifest checks, the appropriate local or controlled contract smoke, authenticated tenant-boundary checks, media reads, audit-chain validation, and an export.
6. Confirm the active instance was not modified.
7. Destroy the isolated rehearsal only after the evidence has been reviewed.

## Acceptance

- The archive is encrypted, hash-verified, and stored separately from active data.
- A fresh isolated restore can authenticate a disposable user and read the expected tenant-scoped records and media.
- Cross-workspace access remains denied.
- The Appwrite schema matches the checked-in manifest.
- Recovery time and data-loss measurements are recorded as observations, not promises.

If restore integrity or isolation cannot be demonstrated, keep the application stopped and preserve both instances for investigation.
