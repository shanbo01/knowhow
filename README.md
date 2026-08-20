# KnowHow

KnowHow is a privacy-first SOP workspace for capturing browser and Windows workflows as governed, versioned guides. Local development keeps the web app, Appwrite project, private media, exports, and background workers on one machine. Staging and production profiles require exact HTTPS origins, an allowlisted Appwrite service, external workers, email delivery, monitoring, and an immutable release identity.

## Architecture

- Next.js serves the public pages, account flows, product routes under `/w`, and platform controls under `/platform`.
- Appwrite provides Auth, the `knowhow_core` TablesDB database, and the private `knowhow_private_media` and `knowhow_exports` Storage buckets. Development accepts only local endpoints; controlled profiles accept only explicitly allowlisted HTTPS hosts.
- Product tables and files have no browser permissions. Every product request passes through the server-side policy layer.
- `npm run workers:local:watch` runs the operations and export handlers against the local project. Mailpit receives local notification email.
- The Chromium extension uses short-lived, workspace-scoped device tokens and never receives an Appwrite API key or session.
- `desktop/` is the Windows-first Tauri 2 recorder: a React 19 local-only WebView and Rust engine using Raw Input, UI Automation, DXGI Desktop Duplication, DPAPI, AES-GCM, and SQLite. It produces screenshot guides only and hands private drafts to the existing web editor.

The canonical resource definition is [appwrite.config.json](./appwrite.config.json), with generated database, table, and bucket manifests in `infrastructure/appwrite`.

## Requirements

- Node.js 22.13 or newer
- npm
- A local Appwrite installation and a project named `knowhow-local`
- Mailpit on `http://127.0.0.1:8025` when notification delivery is required
- Current Chrome or Edge for extension and browser tests
- Rust stable, Visual Studio 2022 C++ build tools, WebView2, and the Windows 10/11 SDK for the desktop recorder

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
- `npm run load:boundary` verifies the configured size boundary without contacting a remote service.
- `npm run extension:build` builds the unpacked local extension under `outputs/extension`.
- `npm run desktop:check` type-checks/tests/builds the recorder UI and runs the native Rust tests.
- `npm run desktop:dev` starts the Tauri recorder against the local KnowHow origin.
- `npm run desktop:build` creates local unsigned development installers; production artifacts come only from the protected desktop release workflow.
- `npm run security:secrets` and `npm run security:audit` run the security gates.

`npm test` runs type checking, linting, a production build, unit tests, worker syntax checks, extension tests and build, Appwrite manifest checks, secret scanning, and the dependency audit.

`npm run release:check` adds the complete Playwright browser matrix and the configured load boundary. An isolated controlled Appwrite deployment can then be checked with `KNOWHOW_SMOKE_MODE=controlled npm run appwrite:smoke:controlled`; this is destructive only to fixtures created by that invocation and refuses non-HTTPS or non-allowlisted endpoints.

## Data boundary

Use ordinary internal process information only. Do not capture credentials, secrets, payment information, health information, national IDs, or other sensitive data.

Screenshots are rasterized locally. Blur regions remain editable in a private draft, then are baked into the image before review. The application does not intentionally persist captured form values, clipboard data, raw keystrokes, or full captured URLs.

## Browser extension

Run `npm --prefix extension test` and `npm run extension:build`, then load `outputs/extension` as an unpacked extension from `chrome://extensions` or `edge://extensions`. The package is served to authorized local administrators through the in-app installation flow.

See [extension/README.md](./extension/README.md) and [extension distribution](./docs/operations/extension-distribution.md).

## Windows desktop capture

Install desktop dependencies with `npm ci --prefix desktop`, then run `npm run desktop:check`. Local debug builds connect to `http://localhost:3001`; release builds refuse to start without a compiled HTTPS KnowHow origin and use a separately compiled signed-update endpoint.

The app supports application, window (including owned dialogs), monitor, and all-display scopes. Exact non-password text capture is explicit and policy-controlled. Source frames remain in memory; only masked/compressed screenshots and semantic step metadata enter the per-session encrypted recovery store. Browser approval pairs a named device without copying passwords, cookies, or codes.

See the [Windows release runbook](./docs/operations/desktop-capture-release.md) for x64/ARM64 signing, updater, SBOM, malware scan, test, and rollback gates.

## Operations and governance

- [Deployment](./docs/operations/deployment.md)
- [Backup and restore](./docs/operations/backup-restore.md)
- [Appwrite contract smoke](./docs/operations/self-host-smoke.md)
- [Monitoring](./docs/operations/monitoring.md)
- [Incident response](./docs/operations/incident-response.md)
- [Threat model](./docs/security/threat-model.md)
- [Windows desktop release](./docs/operations/desktop-capture-release.md)
- [Retention schedule](./docs/governance/retention-schedule.md)
- [Privacy notice draft](./docs/governance/privacy-notice.md)
- [Third-party service list](./docs/governance/subprocessors.md)
- [Readiness report](./docs/readiness-report.md)

The governance documents are drafts and not legal advice. Local passing tests do not authorize sensitive or regulated data.
