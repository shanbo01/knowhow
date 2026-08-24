# KnowHow

KnowHow is a private process-knowledge workspace backed by Appwrite. This repository contains only the retained product surfaces and the infrastructure needed to run them.

## Retained product

- Landing and authentication pages
- Workspace dashboard
- Browser and Windows capture
- Groups and people management
- Guide library, reader, and editor
- Workspace settings and support
- Browser extension
- Windows desktop app
- Appwrite schema, functions, and local worker tooling

Workspace pages are served through `/w/{workspaceSlug}`:

| Surface | Route |
| --- | --- |
| Dashboard | `/w/{workspaceSlug}` |
| Guides | `/w/{workspaceSlug}/guides` |
| Editor | `/w/{workspaceSlug}/guides/new` or `/w/{workspaceSlug}/guides/{guideId}/edit` |
| Capture | `/w/{workspaceSlug}/capture` |
| Groups | `/w/{workspaceSlug}/groups` |
| People | `/w/{workspaceSlug}/members` |
| Support | `/w/{workspaceSlug}/support` |
| Settings | `/w/{workspaceSlug}/settings` |

## Run locally

Requirements: Node.js 22.13 or newer, Appwrite, and Rust 1.89 or newer for the Windows app.

```powershell
npm ci
npm ci --prefix desktop
npm run dev
```

The web app starts at `http://localhost:3001`.

## Verification

```powershell
npm test
npm run desktop:check
```

## Appwrite

Appwrite resources live in `infrastructure/appwrite`, while deployable functions live in `functions`.

```powershell
npm run appwrite:generate
npm run appwrite:check
npm run appwrite:local:owner
npm run workers:local:watch
```

Copy `.env.example` to `.env.local` and supply the local or hosted Appwrite values before starting the web app or workers. Never commit `.env.local`.

## Companion builds

```powershell
npm run extension:build
npm run desktop:build
```

Generated output is intentionally ignored and should not be committed.
