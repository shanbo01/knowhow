# Local readiness report

Status: **local development and disposable private-beta rehearsal only**.

## Supported runtime

- Next.js runs on `http://localhost:3001`.
- Appwrite runs on the local machine at `http://localhost/v1` in project `knowhow-local`.
- TablesDB uses `knowhow_core`; private media and exports use the two checked-in private buckets.
- Operations, notifications, lifecycle work, and exports run through the local worker runner.
- Mailpit is the local notification sink.

The runtime rejects non-local Appwrite endpoints. No remote deployment manifests, release gates, or provider-specific recovery tooling are part of the supported system.

## Verification boundary

The repository provides type checking, linting, a production Next.js build, unit tests, extension tests and build, Appwrite manifest drift checks, a local contract smoke, secret scanning, and browser journeys. These checks verify application behavior and the checked-in local resource contract; they do not establish an SLA or authorize sensitive data.

## Before a local rehearsal

1. Start the pinned local Appwrite installation and confirm the project ID and resource IDs match `.env.example`.
2. Run `npm run appwrite:check`.
3. Run `npm run workers:local:once` and confirm `GET /api/health?ready=1` returns `ready`.
4. Run `npm run appwrite:smoke:local` with Next.js running.
5. Run the automated test suite and the relevant browser journey.
6. Confirm Mailpit, screenshot redaction, invitation, review, publication, export, and deletion behavior with disposable data.

## Open operational work

- Record and rehearse a local backup/restore procedure for the exact Appwrite installation and its private media volumes.
- Define machine ownership, disk encryption, patching, local network exposure, log retention, and recovery responsibilities.
- Complete legal review before accepting any real customer or regulated data.
- Re-run the checks after every Appwrite, Node.js, browser, extension, or schema upgrade.

Local passing tests are an engineering checkpoint, not a production certification.
