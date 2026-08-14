# Local installation and update runbook

## Install

1. Install the pinned Appwrite version on the local machine and create project `knowhow-local`.
2. Copy `.env.example` to `.env.local`, generate the required secrets, and keep that file untracked.
3. Configure the Appwrite CLI for `http://localhost/v1` and the local project.
4. Provision the checked-in resources:

   ```text
   npm ci
   npm run appwrite:check
   npx appwrite push tables --force
   npx appwrite push buckets --force
   ```

5. Bootstrap the first local owner with `npm run appwrite:local:owner`.
6. Start Mailpit when local email is needed.
7. Start `npm run workers:local:watch` and `npm run dev` in separate terminals.

## Verify

Run:

```text
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run appwrite:smoke:local
```

Check `/api/health`, then run `npm run workers:local:once` and check `/api/health?ready=1`. Complete a disposable sign-in, guide upload/redaction, review, publication, notification, and export journey before retaining data.

## Update

1. Back up the local Appwrite data and configuration using `backup-restore.md`.
2. Stop the Next.js and worker processes.
3. Install the candidate dependencies and regenerate the manifest.
4. Review manifest drift before pushing schema changes.
5. Start the services and repeat the full verification list.

Never apply a destructive schema downgrade. If an update fails, stop writes, restore the captured local backup into an isolated local instance, and verify it before replacing the active instance.
