# Local target architecture

KnowHow has one supported runtime boundary: the browser talks to the local Next.js server, and only that server talks to the local Appwrite project.

```text
Browser / unpacked extension
          |
          v
Next.js at localhost:3001
          |
          v
Local Appwrite at localhost/v1
  - Auth
  - knowhow_core TablesDB
  - knowhow_private_media Storage
  - knowhow_exports Storage
```

Product tables and Storage buckets have empty client permissions. Server routes recover the HTTP-only Appwrite session, resolve workspace membership, and apply the default-deny policy layer before every read or mutation.

Private screenshots are raster-validated and stored in `knowhow_private_media`. Smart Blur pixels produced during browser capture are permanently rasterized locally before persistence and can never be revealed. Additional editor blur layers stay reversible only while a guide is a private draft, then are baked into the image before first review. Export artifacts are written to `knowhow_exports` and remain access-controlled.

The checked-in worker handlers run through `scripts/run-local-workers.mjs`. The full runner performs lifecycle, notification, reconciliation, cleanup, and export work and writes a content-free local readiness heartbeat. Mailpit is the only supported local mail sink.

The Appwrite manifest contains only the local database, tables, and buckets. The Next.js server and worker processes are started directly from this repository.
