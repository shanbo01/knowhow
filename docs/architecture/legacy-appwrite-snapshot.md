# Legacy Appwrite configuration snapshot

Snapshot date: 2026-08-11  
Source: read-only inspection of the signed-in Appwrite Cloud console  
Purpose: preserve configuration context only; this is not a migration source

## Safety boundary

The snapshot inspection opened only configuration and resource-list surfaces. It did not inspect Auth users, API or development keys, row contents, files, message contents, secrets, browser storage, or session material. Nothing was created, updated, exported, or copied during that inspection.

After the snapshot was captured, the owner explicitly authorized permanent deletion of the demo project and confirmed that its users and resources were disposable. `SOP Inventory` was deleted from Appwrite Cloud on 2026-08-11, including its users and all project resources. The deletion is not recoverable through that project; no legacy data was exported or migrated first.

Two empty replacements were then created in Frankfurt: `KnowHow Staging` (`6a7b532a0033dd811cb4`) and `KnowHow Production` (`6a7b534f00071e3d3014`). They must be provisioned independently from the checked-in `appwrite.config.json` and `infrastructure/appwrite/` manifest. No legacy database row, Auth user, file, key, session, hostname, permission, provider, or identifier may be migrated.

## Project

| Setting | Observed value |
| --- | --- |
| Organization | `Personal projects` |
| Plan | Free |
| Project name | `SOP Inventory` |
| Project ID | `6a6a53ac002ca43c7ea4` |
| Region | Singapore |
| API endpoint | `https://sgp.cloud.appwrite.io/v1` |
| Web platforms | One: `Next.js app`, type Web, hostname `localhost` |
| Protocols | REST, GraphQL, and WebSocket enabled |
| Client services | Account, Avatars, Databases, Functions, Locale, Messaging, Migrations, Project, Sites, Storage, TablesDB, Teams, and Users enabled |
| Git installations | None |
| Global variables | None |
| Custom API domains | None |
| Webhooks | None |
| Custom SMTP | Unavailable on the Free plan; not configured |
| Status after snapshot | Permanently deleted with explicit owner authorization on 2026-08-11 |

API keys and Auth/user configuration were intentionally not opened. They are neither needed nor approved for migration.

## TablesDB

The project contains one enabled TablesDB database:

| Setting | Observed value |
| --- | --- |
| Database ID | `rivet` |
| Database name | `Rivet` |
| Tables | One |
| Backup policies | None |
| Created/updated | 2026-07-29 22:38 as displayed by the console |

The database contains one enabled table, ID `records`, name `Records`. The console showed no rows. Its table-level permissions grant the Appwrite `Users` role create permission only; read, update, and delete were not checked. Row security is enabled.

The table has these eight application columns in addition to Appwrite's `$id`, `$createdAt`, and `$updatedAt` system columns:

| Column | Type | Required | Default | Indexed signal |
| --- | --- | --- | --- | --- |
| `teamId` | text | Yes | None | Yes |
| `kind` | text | Yes | None | No |
| `clientId` | text | No | `NULL` | No |
| `title` | text | Yes | None | No |
| `searchText` | text | No | `NULL` | No |
| `payload` | text | Yes | None | No |
| `sortKey` | text | No | `NULL` | No |
| `archived` | boolean | Yes | None | No |

One index was visible: key `teamId_idx`, type `key`, column `teamId`, length `64`.

## Other resources

| Resource | Observed state |
| --- | --- |
| Storage buckets | None |
| Functions | None |
| Sites | None |
| Messaging providers | None |
| Database backup policies | None |

## Migration decision

This snapshot documents why the new architecture is a clean replacement rather than an in-place evolution. The legacy single-table shape, broad client-service surface, user-create table permission, Singapore region, Free plan, missing backups, and absence of operational resources did not satisfy the external-pilot target. The demo project was deleted without migration. Target resources use only the stable `knowhow_*` identifiers generated from the checked-in Frankfurt manifest.
