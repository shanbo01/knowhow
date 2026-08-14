# Local backup and restore runbook

This runbook covers the operator-controlled local Appwrite installation. Exact volume names and commands depend on that installation and must be recorded beside the machine inventory, not guessed by application code.

## Backup

1. Stop the KnowHow worker loop and prevent new application writes.
2. Record the application revision, Appwrite version, project ID, database and bucket IDs, and UTC start time.
3. Use the local Appwrite installation's documented consistent-backup procedure to capture its database, Storage data, and required configuration/secrets.
4. Store the archive on encrypted media separate from the active data directory.
5. Record archive hashes, byte sizes, operator, completion time, and any errors. Do not place the archive or secrets in this repository.
6. Resume writes only after the archive and its metadata have been verified.

## Restore rehearsal

1. Create an isolated local Appwrite instance on different ports and networks. Do not point the active Next.js process at it.
2. Restore the captured database, Storage, and configuration into that instance.
3. Confirm the restored project, `knowhow_core`, both private buckets, users, and row counts are present.
4. Point a disposable checkout and environment file at the isolated instance.
5. Run manifest checks, the local contract smoke, authenticated tenant-boundary checks, media reads, audit-chain validation, and an export.
6. Confirm the active instance was not modified.
7. Destroy the isolated rehearsal only after the evidence has been reviewed.

## Acceptance

- The archive is encrypted, hash-verified, and stored separately from active data.
- A fresh isolated restore can authenticate a disposable user and read the expected tenant-scoped records and media.
- Cross-workspace access remains denied.
- The Appwrite schema matches the checked-in manifest.
- Recovery time and data-loss measurements are recorded as observations, not promises.

If restore integrity or isolation cannot be demonstrated, keep the application stopped and preserve both instances for investigation.
