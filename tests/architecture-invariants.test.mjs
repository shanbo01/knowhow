import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  ORGANIZATION_PURGE_TABLES,
  USER_REFERENCE_TABLES,
} from "../functions/operations/src/main.js";
import { expectedTableIds } from "../infrastructure/appwrite/schema.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const json = async (path) => JSON.parse(await read(path));

test("the deployable runtime is standard Next.js on Appwrite only", async () => {
  const packageJson = await json("package.json");

  assert.equal(packageJson.scripts.dev, "next dev --hostname localhost --port 3001");
  assert.equal(packageJson.scripts.build, "next build");
  assert.equal(packageJson.scripts.start, "next start --hostname 0.0.0.0 --port 3000");

  const directPackages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const legacyPackage of [
    "@cloudflare/vite-plugin",
    "@vitejs/plugin-react",
    "@vitejs/plugin-rsc",
    "drizzle-kit",
    "drizzle-orm",
    "vinext",
    "vite",
    "wrangler",
  ]) {
    assert.equal(directPackages[legacyPackage], undefined, legacyPackage);
  }

  for (const legacyPath of [
    "db/index.ts",
    "drizzle/0000_zippy_spacker_dave.sql",
    "worker/index.ts",
    "cloudflare-env.d.ts",
    "drizzle.config.ts",
    "vite.config.ts",
    "wrangler.local.jsonc",
    "lib/appwrite.ts",
    "lib/records.ts",
    "lib/server/d1.ts",
    "lib/server/repository.ts",
  ]) {
    await assert.rejects(access(new URL(legacyPath, root)), { code: "ENOENT" });
  }
});

test("Appwrite resources are stable, Frankfurt-hosted, and private", async () => {
  const [config, databases, tables, buckets] = await Promise.all([
    json("appwrite.config.json"),
    json("infrastructure/appwrite/databases.json"),
    json("infrastructure/appwrite/tables.json"),
    json("infrastructure/appwrite/buckets.json"),
  ]);

  assert.equal(config.endpoint, "https://fra.cloud.appwrite.io/v1");
  assert.deepEqual(databases.map((database) => database.$id), ["knowhow_core"]);
  assert.deepEqual(
    config.functions.map((fn) => fn.$id).sort(),
    ["knowhow_export", "knowhow_ops"],
  );
  assert.ok(config.functions.every((fn) => fn.runtime === "node-22"));
  assert.ok(config.functions.every((fn) => fn.execute.length === 0));
  assert.deepEqual(
    config.functions.find((fn) => fn.$id === "knowhow_ops").scopes,
    [
      "rows.read",
      "rows.write",
      "files.read",
      "files.write",
      "messages.write",
      "users.read",
      "users.write",
    ],
  );
  assert.deepEqual(
    config.functions.find((fn) => fn.$id === "knowhow_export").scopes,
    ["rows.read"],
  );
  assert.deepEqual(config.sites.map((site) => site.$id), ["knowhow_web"]);
  assert.equal(config.sites[0].framework, "nextjs");
  assert.equal(config.sites[0].adapter, "ssr");
  assert.equal(
    config.sites[0].buildCommand,
    "node --max-old-space-size=640 node_modules/next/dist/bin/next build",
  );

  assert.ok(tables.length >= 40);
  assert.equal(new Set(tables.map((table) => table.$id)).size, tables.length);
  assert.ok(tables.every((table) => table.databaseId === "knowhow_core"));
  assert.ok(tables.every((table) => Array.isArray(table.$permissions)));
  assert.ok(tables.every((table) => table.$permissions.length === 0));

  assert.deepEqual(
    buckets.map((bucket) => bucket.$id).sort(),
    ["knowhow_exports", "knowhow_private_media"],
  );
  assert.ok(buckets.every((bucket) => bucket.$permissions.length === 0));
  assert.ok(buckets.every((bucket) => bucket.fileSecurity === true));
  assert.ok(buckets.every((bucket) => bucket.encryption === true));
  assert.ok(buckets.every((bucket) => bucket.antivirus === true));
});

test("approved purge manifests cover every tenant and user-reference table", () => {
  const globalTables = new Set([
    "catalog_items",
    "leads",
    "platform_roles",
    "user_preferences",
  ]);
  assert.deepEqual(
    [...ORGANIZATION_PURGE_TABLES].sort(),
    expectedTableIds.filter((tableId) => !globalTables.has(tableId)).sort(),
  );
  assert.deepEqual(
    [...USER_REFERENCE_TABLES].sort(),
    expectedTableIds
      .filter((tableId) => tableId !== "user_preferences")
      .sort(),
  );
});

test("Production cleanup has an immutable read-only evidence gate", async () => {
  const [packageJson, verifier, operations, environment, runbook] =
    await Promise.all([
    json("package.json"),
    read("scripts/appwrite-production-cleanup-evidence.mjs"),
    read("functions/operations/src/main.js"),
    read(".env.example"),
    read("docs/operations/deployment.md"),
  ]);
  assert.equal(
    packageJson.scripts["appwrite:production:cleanup:verify"],
    "node scripts/appwrite-production-cleanup-evidence.mjs",
  );
  assert.equal(
    packageJson.scripts["appwrite:production:cleanup:evidence:verify"],
    "node scripts/appwrite-production-cleanup-evidence.mjs verify",
  );
  assert.match(verifier, /KNOWHOW_CLEANUP_FINAL_PRODUCTION/);
  assert.match(verifier, /validateCleanupReceipt\(row, target, receiptPepper\)/);
  assert.match(verifier, /expectUserAbsent\(services\.users, userId\)/);
  assert.match(verifier, /flag: "wx"/);
  assert.match(verifier, /HMAC-SHA-256/);
  assert.match(verifier, /timingSafeEqual\(actual, expected\)/);
  assert.match(verifier, /KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID/);
  assert.match(verifier, /KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID/);
  assert.match(verifier, /KNOWHOW_CLEANUP_EXPECTED_RELEASE/);
  assert.match(verifier, /databaseId === "knowhow_core"/);
  assert.match(verifier, /ttl: 0/);
  assert.match(verifier, /privateBucketId === "knowhow_private_media"/);
  assert.match(operations, /req\?\.headers\?\.\["x-appwrite-key"\]/);
  assert.match(environment, /KNOWHOW_CLEANUP_TARGETS_JSON=\[\]/);
  assert.match(environment, /KNOWHOW_CLEANUP_USER_IDS_JSON=\[\]/);
  assert.match(environment, /KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID=/);
  assert.match(runbook, /npm run appwrite:production:cleanup:verify/);
});

test("controlled release gates bind project, environment, release, and live deployments", async () => {
  const [
    packageJson,
    smoke,
    guards,
    workflow,
    controlledWorkflow,
    rehearsal,
    health,
    environment,
    browserConfig,
  ] = await Promise.all([
    json("package.json"),
    read("scripts/appwrite-contract-smoke.mjs"),
    read("scripts/appwrite-contract-guards.mjs"),
    read(".github/workflows/ci.yml"),
    read(".github/workflows/controlled-release-gates.yml"),
    read("e2e/controlled-rehearsal.spec.ts"),
    read("app/api/health/route.ts"),
    read(".env.example"),
    read("playwright.config.ts"),
  ]);
  assert.equal(
    packageJson.scripts["appwrite:smoke:production"],
    "node scripts/appwrite-contract-smoke.mjs --allow-production",
  );
  assert.match(smoke, /assertControlledMutationBinding\(\{/);
  assert.match(smoke, /assertFunctionContract\(/);
  assert.match(smoke, /assertSiteContract\(/);
  assert.match(smoke, /cleanupFailures/);
  assert.match(guards, /`\$\{environment\}-transient-fixtures`/);
  assert.match(guards, /latestDeploymentStatus === "ready"/);
  assert.match(workflow, /KNOWHOW_SMOKE_EXPECTED_PROJECT_ID/);
  assert.match(workflow, /KNOWHOW_SMOKE_FORBIDDEN_PROJECT_ID/);
  assert.match(workflow, /KNOWHOW_SMOKE_EXPECTED_RELEASE/);
  assert.match(controlledWorkflow, /workflow_dispatch:/);
  assert.match(controlledWorkflow, /environment: \$\{\{ inputs\.target \}\}/);
  assert.match(controlledWorkflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(controlledWorkflow, /npm run appwrite:smoke:production/);
  assert.match(controlledWorkflow, /KNOWHOW_SMOKE_FINAL_PRODUCTION:/);
  assert.match(controlledWorkflow, /KNOWHOW_REQUIRE_CONTROLLED_REHEARSAL: "1"/);
  assert.match(
    controlledWorkflow,
    /--project=chrome --project=edge --workers=1/,
  );
  assert.match(workflow, /playwright install --with-deps chromium chrome msedge/);
  assert.doesNotMatch(controlledWorkflow, /pending repository secrets/);
  assert.match(browserConfig, /name: "chrome"/);
  assert.match(browserConfig, /channel: "chrome"/);
  assert.match(browserConfig, /name: "edge"/);
  assert.match(browserConfig, /channel: "msedge"/);
  assert.match(rehearsal, /KNOWHOW_E2E_EXPECTED_ENVIRONMENT/);
  assert.match(rehearsal, /KNOWHOW_E2E_EXPECTED_PROJECT_ID/);
  assert.match(rehearsal, /KNOWHOW_E2E_EXPECTED_RELEASE/);
  assert.match(rehearsal, /did not require a fresh MFA challenge/);
  assert.match(rehearsal, /controlled Appwrite server session revocation/);
  assert.match(rehearsal, /\.setSession\(decodeURIComponent\(encodedSession\)\)/);
  assert.match(health, /projectFingerprint/);
  assert.match(environment, /KNOWHOW_SMOKE_FINAL_PRODUCTION=0/);
});

test("controlled network load is tenant-bound, revocable, and HMAC sealed", async () => {
  const [packageJson, load, guards, workflow, environment, runbook] =
    await Promise.all([
      json("package.json"),
      read("scripts/load-controlled-network.mjs"),
      read("scripts/controlled-network-load-guards.mjs"),
      read(".github/workflows/controlled-release-gates.yml"),
      read(".env.example"),
      read("docs/operations/deployment.md"),
    ]);
  assert.equal(
    packageJson.scripts["load:controlled"],
    "node scripts/load-controlled-network.mjs",
  );
  assert.equal(
    packageJson.scripts["load:controlled:evidence:verify"],
    "node scripts/load-controlled-network.mjs verify",
  );
  assert.match(load, /assertDeployment\(runtimes\[0\]\)/);
  assert.match(load, /expectedStatuses: \[403, 404\]/);
  assert.match(load, /x-knowhow-redacted": "true"/);
  assert.match(load, /capturePipelinesDiscarded/);
  assert.match(load, /revokeCaptureDevices/);
  assert.match(load, /serverSessionsRevoked/);
  assert.match(load, /SERVER_SESSION_NOT_REVOKED/);
  assert.match(load, /\.setSession\(session\)/);
  assert.match(load, /signIn\.payload\.mfaRequired/);
  assert.match(guards, /target === "staging" \? 3 : 2/);
  assert.match(guards, /exactControlledAppwriteEndpoint/);
  assert.match(guards, /KNOWHOW_APPWRITE_RESIDENCY/);
  assert.match(guards, /readersPerTenant \+ actors\.length <= 120/);
  assert.match(guards, /timingSafeEqual\(actual, expected\)/);
  assert.match(guards, /exactKeys\(payload/);
  assert.match(guards, /ignored \.tmp directory/);
  assert.match(workflow, /KNOWHOW_NETWORK_LOAD_ACTORS_JSON/);
  assert.match(workflow, /npm run load:controlled/);
  assert.match(workflow, /npm run load:controlled:evidence:verify/);
  assert.match(environment, /KNOWHOW_NETWORK_LOAD_FINAL_PRODUCTION=0/);
  assert.match(runbook, /exactly three dedicated Staging load workspaces/);
  assert.match(runbook, /same two .*synthetic Auth accounts/);
});

test("server mutations and portability evidence use real TablesDB transactions", async () => {
  const [recordStore, commandService, smoke] = await Promise.all([
    read("lib/server/appwrite-record-store.ts"),
    read("lib/server/command-service.ts"),
    read("scripts/appwrite-contract-smoke.mjs"),
  ]);

  assert.match(recordStore, /createTransaction\(\{ ttl: 60 \}\)/);
  assert.match(recordStore, /transactionId: this\.transactionId/);
  assert.match(recordStore, /updateTransaction\(\{ transactionId: transaction\.\$id, commit: true \}\)/);
  assert.match(recordStore, /updateTransaction\(\{ transactionId: transaction\.\$id, rollback: true \}\)/);
  assert.match(commandService, /return await this\.store\.transaction\(async \(transaction\) =>/);
  assert.match(commandService, /const scoped = new CommandService\(transaction, this\.objects\)/);
  assert.match(commandService, /error instanceof RecordConflictError/);
  assert.match(commandService, /const committed = await this\.store\.get\(/);
  assert.match(commandService, /if \(committed\?\.status === "completed"\)/);
  assert.match(smoke, /"tables_transactions"/);
  assert.match(smoke, /error instanceof AppwriteException && error\.code === 409/);
  assert.match(smoke, /tables\s*\.deleteTransaction\(\{ transactionId \}\)/);
});

test("backup evidence is sealed, database-bound, and isolated from Production runtime", async () => {
  const [packageJson, verifier, runbook, environment] = await Promise.all([
    json("package.json"),
    read("scripts/appwrite-restore-evidence.mjs"),
    read("docs/operations/backup-restore.md"),
    read(".env.example"),
  ]);

  assert.equal(
    packageJson.scripts["appwrite:backup:capture"],
    "node scripts/appwrite-restore-evidence.mjs capture",
  );
  assert.equal(
    packageJson.scripts["appwrite:restore:verify"],
    "node scripts/appwrite-restore-evidence.mjs verify",
  );
  assert.match(verifier, /exactControlledAppwriteEndpoint/);
  assert.match(verifier, /KNOWHOW_APPWRITE_RESIDENCY/);
  assert.match(verifier, /record\.resourceId === databaseId/);
  assert.match(verifier, /KNOWHOW_BACKUP_SOURCE_FROZEN/);
  assert.match(verifier, /KNOWHOW_RESTORE_NOT_REFERENCED/);
  assert.match(verifier, /RESTORE_TARGET_NOT_ISOLATED/);
  assert.match(verifier, /HMAC-SHA-256/);
  assert.match(verifier, /validateAuditState\(auditRows, workspaceRows\)/);
  assert.match(verifier, /ttl: 0/);
  assert.match(runbook, /npm run appwrite:backup:capture/);
  assert.match(runbook, /npm run appwrite:restore:verify/);
  assert.match(runbook, /database verifier's elapsed time alone is not RTO proof/i);
  assert.match(environment, /KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY=/);
  assert.match(environment, /KNOWHOW_RESTORE_ISOLATED=0/);
});

test("restored application evidence is access-controlled, database-bound, and HMAC sealed", async () => {
  const [
    packageJson,
    config,
    proxy,
    health,
    auth,
    runner,
    guards,
    runbook,
    environment,
  ] = await Promise.all([
    json("package.json"),
    read("lib/server/appwrite-config.ts"),
    read("proxy.ts"),
    read("app/api/health/route.ts"),
    read("app/api/auth/[[...path]]/route.ts"),
    read("scripts/verify-restored-application.mjs"),
    read("scripts/restore-application-guards.mjs"),
    read("docs/operations/backup-restore.md"),
    read(".env.example"),
  ]);
  assert.equal(
    packageJson.scripts["appwrite:restore:application"],
    "node scripts/verify-restored-application.mjs capture",
  );
  assert.equal(
    packageJson.scripts["appwrite:restore:application:evidence:verify"],
    "node scripts/verify-restored-application.mjs verify",
  );
  assert.equal(
    packageJson.scripts["appwrite:restore:cleanup:verify"],
    "node scripts/verify-restored-application.mjs cleanup",
  );
  assert.equal(
    packageJson.scripts["appwrite:restore:cleanup:evidence:verify"],
    "node scripts/verify-restored-application.mjs cleanup-verify",
  );
  assert.match(config, /production-isolated-restore-application/);
  assert.match(config, /RESTORE_DATABASE_ID/);
  assert.match(config, /KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC/);
  assert.match(proxy, /timingSafeEqual/);
  assert.match(proxy, /x-knowhow-restore-access/);
  assert.match(proxy, /deploymentConfigurationIssues\(config\)\.length === 0/);
  assert.match(proxy, /headers\.delete\(RESTORE_ACCESS_HEADER\)/);
  assert.match(health, /databaseFingerprint/);
  assert.match(health, /restorationFingerprint/);
  assert.match(health, /disposableSiteFingerprint/);
  assert.match(health, /sourceSiteOriginFingerprint/);
  assert.match(auth, /const requestId = correlationId\(request\)/);
  assert.match(auth, /SIGN_OUT_INCOMPLETE/);
  assert.doesNotMatch(auth, /deleteSession\([^)]*\)\.catch\(\(\) => undefined\)/);
  assert.match(runner, /recordGuideCompletion/);
  assert.match(runner, /guide\.completed/);
  assert.match(runner, /audit\.exported/);
  assert.match(runner, /guide\.export-requested/);
  assert.match(runner, /status === "queued"/);
  assert.match(runner, /serverSessionsRevoked/);
  assert.match(runner, /SERVER_SESSION_NOT_REVOKED/);
  assert.match(runner, /\.setSession\(session\)/);
  assert.match(runner, /SOURCE_DATABASE_MISSING/);
  assert.match(runner, /RESTORED_DATABASE_STILL_PRESENT/);
  assert.match(runner, /DISPOSABLE_SITE_STILL_PRESENT/);
  assert.match(guards, /knowhow-restored-application-evidence/);
  assert.match(guards, /RESTORE_REPORT_FIELDS_INVALID/);
  assert.match(guards, /databaseVerificationSeconds ===/);
  assert.match(guards, /applicationRtoSeconds <= RTO_TARGET_SECONDS/);
  assert.match(guards, /verifyEvidenceSeal/);
  assert.match(runbook, /npm run appwrite:restore:application/);
  assert.match(runbook, /npm run appwrite:restore:application:evidence:verify/);
  assert.match(runbook, /npm run appwrite:restore:cleanup:verify/);
  assert.match(runbook, /npm run appwrite:restore:cleanup:evidence:verify/);
  assert.match(environment, /KNOWHOW_RESTORE_APPLICATION_MODE=0/);
  assert.match(environment, /KNOWHOW_RESTORE_APPLICATION_EXCLUSIVE=0/);
  assert.match(environment, /KNOWHOW_RESTORE_CLEANUP_SECOND_OPERATOR=0/);
});

test("product routes share the guarded app while marketing stays public", async () => {
  const [
    appPage,
    workspacePage,
    marketingPage,
    shell,
    workspaceShell,
    workspaceRoutes,
    auditRoute,
  ] =
    await Promise.all([
      read("app/app/page.tsx"),
      read("app/w/[workspaceSlug]/[[...segments]]/page.tsx"),
      read("app/page.tsx"),
      read("app/components/knowhow-app.tsx"),
      read("app/components/knowhow-workspace-app.tsx"),
      read("lib/workspace-routes.ts"),
      read("app/api/knowhow/audit/route.ts"),
    ]);

  assert.match(appPage, /<KnowHowApp\s*\/>/);
  assert.match(workspacePage, /<KnowHowApp\s*\/>/);
  assert.match(marketingPage, /href="\/app"/);
  assert.match(marketingPage, /href="\/request-pilot"/);
  assert.match(marketingPage, /invitation-only/i);

  assert.doesNotMatch(shell, /eligibleWorkspaces|requestDomainJoin|onRequestJoin/);
  assert.doesNotMatch(workspaceShell, /resolveJoinRequest|Domain join requests/);
  assert.doesNotMatch(workspaceShell, /`\$\{origin\}\/\?invite=/);
  assert.doesNotMatch(workspaceShell, /window\.location\.origin\}\/\?(?:invite|appointment)=/);
  assert.match(workspaceShell, /\/app\?invite=/);
  assert.match(workspaceShell, /\/app\?appointment=/);
  assert.doesNotMatch(workspaceShell, /<select\b/i);
  assert.doesNotMatch(`${shell}\n${workspaceShell}`, /window\.location\.reload/);
  assert.match(workspaceShell, /function RouteUnavailable/);
  assert.match(workspaceShell, /import \{ GuideDeleteDialog \}/);
  assert.doesNotMatch(workspaceShell, /export function ActivityView/);
  assert.doesNotMatch(workspaceRoutes, /["']activity["']/);
  assert.match(auditRoute, /requireAuthorized\("workspace\.audit\.read"/);
  assert.match(auditRoute, /AUDIT_CHAIN_INVALID/);
});

test("browser identity remains cookie-backed and invitation-only", async () => {
  const [authClient, authRoute, commandService] = await Promise.all([
    read("lib/auth-client.ts"),
    read("app/api/auth/[[...path]]/route.ts"),
    read("lib/server/command-service.ts"),
  ]);

  assert.match(authClient, /credentials: "same-origin"/);
  assert.match(authClient, /signUpWithCredential/);
  assert.doesNotMatch(authClient, /localStorage|sessionStorage|setJWT|createJWT/);
  assert.match(authRoute, /HttpOnly; SameSite=Strict/);
  assert.match(authRoute, /SameSite=Strict/);
  assert.match(commandService, /action === "requestDomainJoin" \|\| action === "resolveJoinRequest"/);
  assert.match(commandService, /"INVITATION_ONLY"/);
});

test("extension permissions and application headers stay narrow", async () => {
  const [manifest, nextConfig, extensionBuild, workspaceShell] = await Promise.all([
    json("extension/manifest.json"),
    read("next.config.ts"),
    read("extension/scripts/build.mjs"),
    read("app/components/knowhow-workspace-app.tsx"),
  ]);
  const prohibited = new Set([
    "bookmarks",
    "clipboardRead",
    "clipboardWrite",
    "contentSettings",
    "cookies",
    "debugger",
    "desktopCapture",
    "downloads",
    "geolocation",
    "history",
    "management",
    "nativeMessaging",
    "tabs",
    "webRequest",
    "webRequestBlocking",
  ]);

  assert.deepEqual(
    manifest.permissions.filter((permission) => prohibited.has(permission)),
    [],
  );
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'",
  );
  assert.match(nextConfig, /frame-ancestors 'none'/);
  assert.match(nextConfig, /X-Content-Type-Options/);
  assert.match(nextConfig, /Strict-Transport-Security/);
  assert.match(nextConfig, /payment=\(\)/);
  await assert.rejects(access(new URL("public/knowhow-extension.zip", root)), {
    code: "ENOENT",
  });
  assert.match(extensionBuild, /process\.argv\.includes\("--store"\)/);
  assert.match(extensionBuild, /Store builds require an HTTPS KnowHow origin/);
  assert.match(extensionBuild, /outputs", "extension/);
  assert.doesNotMatch(workspaceShell, /href="\/knowhow-extension\.zip"/);
  assert.match(workspaceShell, /NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL/);
  assert.match(workspaceShell, /NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL/);
});
