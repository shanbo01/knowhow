# KnowHow

KnowHow is a privacy-first SOP platform for capturing, reviewing, publishing, and sharing step-by-step guides inside governed workspaces.

## MVP capabilities

- Multi-tenant entities and workspaces with server-enforced isolation
- Platform administration for aggregate metrics, workspace status, and administrator assignment
- Workspace roles for administrators, creators, reviewers, publishers, and viewers
- Groups and workspace, group, or named-user guide audiences
- Immutable Draft → Review → Published → Archived revision history
- Signed invitations, verified-email onboarding, and exact allowed-domain join requests
- Manual and Chromium-extension capture in the same guide editor
- Local Smart Blur, mandatory privacy review, and private redacted screenshot storage
- Light, dark, and system themes
- Workspace branding and PDF, HTML, and Markdown exports
- Append-only, hash-chained audit history with CSV export

Asset inventory is intentionally not part of the product.

## Architecture

- `app/`: Vinext/Next application and authenticated API routes
- `db/schema.ts` and `drizzle/`: Cloudflare D1 schema and baseline migration
- `lib/server/`: Appwrite identity verification, authorization policy, repositories, media controls, and signed credentials
- `lib/guide-contracts.ts`: canonical guide and revision contracts
- `lib/exports/`: policy-aware PDF, HTML, and Markdown renderers
- `extension/`: Manifest V3 Chrome/Edge capture extension
- `public/knowhow-extension.zip`: installable extension package produced from the validated build

Appwrite provides browser authentication and verified identities. The application exchanges the browser session for a short-lived Appwrite JWT and validates it on the server. D1 is the canonical store for tenants, memberships, roles, guides, invitations, and audit records. Private R2 contains only locally redacted and rasterized screenshots. The signed-in website hands the extension a revocable, workspace-scoped device token through an internal one-time exchange; users never copy or enter a pairing code, and the extension never receives Appwrite credentials.

The earlier Appwrite `knowhow/records` collection is not used by the MVP runtime. Keep it read-only until any desired historical migration is complete.

## Prerequisites

- Node.js 22.13 or newer
- An Appwrite project with email/password authentication enabled and `localhost` added as a Web platform
- No Cloudflare account is required for localhost; Wrangler emulates D1 and private R2 on disk

## Configuration

Copy `.dev.vars.example` to `.dev.vars`, then set:

- `KNOWHOW_TOKEN_SIGNING_KEY` — secret random value of at least 32 bytes; signs invite and extension device credentials
- `KNOWHOW_PLATFORM_OWNER_EMAILS` — comma-separated, lowercase verified emails allowed to bootstrap platform administration
- `APPWRITE_ENDPOINT` — optional server override; defaults to `https://sgp.cloud.appwrite.io/v1`
- `APPWRITE_PROJECT_ID` — optional server override; defaults to the project currently configured in `lib/appwrite.ts`

The public Appwrite endpoint and project ID used by the browser live in `lib/appwrite.ts`. If you change Appwrite projects, update that public configuration and the matching optional server values together. Add `localhost` to the Appwrite project’s Web platform allowlist and configure the email-verification callback as `http://localhost:3001/verify`; use `http://localhost:3001` locally rather than `127.0.0.1`, because Appwrite treats them as different web origins. KnowHow does not grant workspace access until Appwrite reports a verified email.

The development extension is pinned to `http://localhost:3001` in `extension/src/core/config.js` and to the exact `http://localhost/*` manifest host permission. Change both values and rebuild the package when a production origin is selected.

## Development and verification

```bash
npm install
npm run dev
```

`npm run dev` applies any pending local D1 migrations and starts KnowHow at [http://localhost:3001](http://localhost:3001). D1 and R2 state persist under the ignored `.wrangler/` directory. `npm start` intentionally launches the same workerd-backed localhost server; the Node-only Vinext production runner cannot provide Cloudflare bindings.

Run the complete verification suite before handing off a change:

```bash
npm run lint
npx tsc --noEmit
npm test
```

`npm test` runs the production build, guide-contract/export/security tests, D1 tenant and audit-trigger tests, extension state/privacy tests, and the extension privacy-guarded build.

Useful commands:

- `npm run db:local` — apply pending migrations to the persisted local D1 database
- `npm run dev` — migrate and start the local Vinext/workerd server on port 3001
- `npm run build` — production application build
- `npm run test:unit` — application unit and policy tests
- `npm run extension:build` — validated unpacked extension build
- `npm run db:generate` — regenerate Drizzle migrations after an intentional schema change

## Guide governance

- Drafts are visible only to workspace administrators, their authorized creator, and assigned workflow actors.
- Submitting a draft creates reviewer assignments and moves the revision to review.
- Publishing requires an approved review. Captured revisions also require an explicit privacy review.
- Editing a new draft never replaces the current live revision. Publication atomically archives the previous live revision and promotes the approved revision.
- Audiences control who can read a published revision. Roles control who can create, review, publish, or administer; these concepts are deliberately separate.
- Restoring history always creates a new draft instead of mutating an old revision.

## Extension

Build and test the extension with:

```bash
npm --prefix extension test
npm --prefix extension run build
```

Then load `extension/dist` as an unpacked extension in `chrome://extensions` or `edge://extensions`, or install the packaged `public/knowhow-extension.zip` through an appropriate enterprise/developer workflow.

From a signed-in KnowHow workspace, choose Connect extension; the website performs the secure workspace handoff directly with no code to copy or type. On the first Start, Chrome asks for optional website access so its visible-tab screenshot API can work reliably from the persistent panel. The side panel shares the website theme, searches the viewer's authorized guides, and can keep one open as a split-screen checklist. During recording, Smart Blur is off by default and exposes a live on-page preview when enabled. Numbered contextual previews include immediate step deletion, native dropdown interactions remain untouched, rapid clicks are queued, double-clicks are distinct actions, and capture follows policy-allowed foreground tab switches in the same window. Smart Blur regions are stored as private, reversible metadata and rendered immediately in previews and guide views; crop, blur, drawing, and click-target layers remain editable until the first review submission flattens them into the private raster. A human privacy review is mandatory before a captured draft can be published.

See `extension/README.md` for capture behavior, privacy guarantees, and MVP limits.

## Production hosting boundary

No production deployment is attached to this checkout. The current server adapter targets Cloudflare Worker APIs for D1 and private R2, which Wrangler emulates on localhost. A future Cloudflare deployment can use those bindings directly. Hosting on AWS or Azure will require replacing the D1/R2 adapter with equivalent transactional database and private-object-storage services while preserving the authorization, audit, redaction, and signed-token boundaries.

Before any production launch, run the full verification suite; configure production secrets and the platform-owner allowlist; migrate the production database; update the Appwrite allowlist, verification callback, and extension origin; then verify anonymous API denial, signup and verification, workspace creation, invite/domain onboarding, restricted publication, export policy, and extension pairing against the selected origin.
