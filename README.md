# KnowHow

KnowHow is a privacy-first SOP workspace for capturing browser workflows as governed, versioned guides. The supported installation keeps the web app, Appwrite project, private media, exports, and background workers on the local machine.

## Local architecture

- Next.js serves the public pages, account flows, product routes under `/w`, and platform controls under `/platform`.
- Local Appwrite provides Auth, the `knowhow_core` TablesDB database, and the private `knowhow_private_media` and `knowhow_exports` Storage buckets.
- Product tables and files have no browser permissions. Every product request passes through the server-side policy layer.
- `npm run workers:local:watch` runs the operations and export handlers against the local project. Mailpit receives local notification email.
- The Chromium extension uses short-lived, workspace-scoped device tokens and never receives an Appwrite API key or session.

The canonical resource definition is [appwrite.config.json](./appwrite.config.json), with generated database, table, and bucket manifests in `infrastructure/appwrite`.

## Requirements

- Node.js 22.13 or newer
- npm
- A local Appwrite installation and a project named `knowhow-local`
- Mailpit on `http://127.0.0.1:8025` when notification delivery is required
- Current Chrome or Edge for extension and browser tests

## Set up the local project

1. Copy `.env.example` to `.env.local` and replace every secret placeholder. Keep `.env.local` untracked.
2. Configure the Appwrite CLI for `http://localhost/v1` and project `knowhow-local`.
3. Push the checked-in resources:

   ```text
   npx appwrite push tables --force
   npx appwrite push buckets --force
   ```

4. Bootstrap the local owner and, when using private-beta registration, create a local beta grant:

   ```text
   npm run appwrite:local:owner
   npm run appwrite:local:beta
   ```

5. Start the worker loop and web app in separate terminals:

   ```text
   npm run workers:local:watch
   npm run dev
   ```

The app listens at `http://localhost:3001`. Appwrite treats `localhost` and `127.0.0.1` as different origins, so use the exact values from `.env.example`.

## Verification

```text
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

Useful focused commands:

- `npm run appwrite:generate` regenerates the checked-in Appwrite manifests.
- `npm run appwrite:check` detects manifest or query-index drift.
- `npm run appwrite:smoke:local` verifies the local database, tables, private buckets, Auth session flow, transactions, and exact cleanup of disposable fixtures.
- `npm run workers:local:once` runs both local worker handlers once and records a readiness heartbeat.
- `npm run workers:local:notifications` drains only the local notification queue.
- `npm run load:pilot` verifies the configured pilot-size boundary without contacting a remote service.
- `npm run extension:build` builds the unpacked local extension under `outputs/extension`.
- `npm run security:secrets` and `npm run security:audit` run the security gates.

`npm test` runs type checking, linting, a production build, unit tests, worker syntax checks, extension tests and build, Appwrite manifest checks, secret scanning, and the dependency audit.

## Data boundary

Use ordinary internal process information only. Do not capture credentials, secrets, payment information, health information, national IDs, or other sensitive data.

Screenshots are rasterized locally. Blur regions remain editable in a private draft, then are baked into the image before review. The application does not intentionally persist captured form values, clipboard data, raw keystrokes, or full captured URLs.

## Browser extension

Run `npm --prefix extension test` and `npm run extension:build`, then load `outputs/extension` as an unpacked extension from `chrome://extensions` or `edge://extensions`. The package is served to authorized local administrators through the in-app installation flow.

See [extension/README.md](./extension/README.md) and [extension distribution](./docs/operations/extension-distribution.md).

## Operations and governance

- [Local deployment](./docs/operations/deployment.md)
- [Local backup and restore](./docs/operations/backup-restore.md)
- [Local Appwrite smoke](./docs/operations/self-host-smoke.md)
- [Monitoring](./docs/operations/monitoring.md)
- [Incident response](./docs/operations/incident-response.md)
- [Threat model](./docs/security/threat-model.md)
- [Retention schedule](./docs/governance/retention-schedule.md)
- [Privacy notice draft](./docs/governance/privacy-notice.md)
- [Third-party service list](./docs/governance/subprocessors.md)
- [Readiness report](./docs/readiness-report.md)

The governance documents are drafts and not legal advice. Local passing tests do not authorize sensitive or regulated data.
