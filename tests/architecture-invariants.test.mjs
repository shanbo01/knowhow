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

  assert.equal(
    packageJson.scripts.dev,
    "next dev --hostname localhost --port 3001",
  );
  assert.equal(packageJson.scripts.build, "next build");
  assert.equal(
    packageJson.scripts.start,
    "next start --hostname 0.0.0.0 --port 3000",
  );

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
test("Appwrite resources are stable, local-only, and private", async () => {
  const [config, databases, tables, buckets] = await Promise.all([
    json("appwrite.config.json"),
    json("infrastructure/appwrite/databases.json"),
    json("infrastructure/appwrite/tables.json"),
    json("infrastructure/appwrite/buckets.json"),
  ]);

  assert.equal(config.endpoint, "http://localhost/v1");
  assert.equal(config.projectId, "knowhow-local");
  assert.deepEqual(Object.keys(config).sort(), [
    "endpoint",
    "includes",
    "projectId",
  ]);
  assert.deepEqual(
    databases.map((database) => database.$id),
    ["knowhow_core"],
  );
  assert.ok(tables.length >= 40);
  assert.equal(new Set(tables.map((table) => table.$id)).size, tables.length);
  assert.ok(tables.every((table) => table.databaseId === "knowhow_core"));
  assert.ok(tables.every((table) => Array.isArray(table.$permissions)));
  assert.ok(tables.every((table) => table.$permissions.length === 0));

  assert.deepEqual(buckets.map((bucket) => bucket.$id).sort(), [
    "knowhow_exports",
    "knowhow_private_media",
  ]);
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
    "beta_access_grants",
    "beta_access_events",
    "user_preferences",
  ]);
  assert.deepEqual(
    [...ORGANIZATION_PURGE_TABLES].sort(),
    expectedTableIds.filter((tableId) => !globalTables.has(tableId)).sort(),
  );
  assert.deepEqual(
    [...USER_REFERENCE_TABLES].sort(),
    expectedTableIds.filter((tableId) => tableId !== "user_preferences").sort(),
  );
});

test("server mutations and portability evidence use real TablesDB transactions", async () => {
  const [recordStore, commandService, smoke] = await Promise.all([
    read("lib/server/appwrite-record-store.ts"),
    read("lib/server/command-service.ts"),
    read("scripts/appwrite-contract-smoke.mjs"),
  ]);

  assert.match(recordStore, /createTransaction\(\{ ttl: 60 \}\)/);
  assert.match(recordStore, /transactionId: this\.transactionId/);
  assert.match(
    recordStore,
    /updateTransaction\(\{ transactionId: transaction\.\$id, commit: true \}\)/,
  );
  assert.match(
    recordStore,
    /updateTransaction\(\{ transactionId: transaction\.\$id, rollback: true \}\)/,
  );
  assert.match(
    commandService,
    /return await this\.store\.transaction\(async \(transaction\) =>/,
  );
  assert.match(
    commandService,
    /const scoped = new CommandService\(transaction, this\.objects\)/,
  );
  assert.match(commandService, /error instanceof RecordConflictError/);
  assert.match(commandService, /const committed = await this\.store\.get\(/);
  assert.match(commandService, /if \(committed\?\.status === "completed"\)/);
  assert.match(smoke, /"tables_transactions"/);
  assert.match(
    smoke,
    /error instanceof AppwriteException && error\.code === 409/,
  );
  assert.match(smoke, /tables\s*\.deleteTransaction\(\{ transactionId \}\)/);
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
    platformPage,
  ] = await Promise.all([
    read("app/app/page.tsx"),
    read("app/w/[workspaceSlug]/[[...segments]]/page.tsx"),
    read("app/page.tsx"),
    read("app/components/knowhow-app.tsx"),
    read("app/components/knowhow-workspace-app.tsx"),
    read("lib/workspace-routes.ts"),
    read("app/api/knowhow/audit/route.ts"),
    read("app/platform/[[...segments]]/page.tsx"),
  ]);

  assert.match(appPage, /<KnowHowApp\s*\/>/);
  assert.match(workspacePage, /<KnowHowApp\s*\/>/);
  assert.match(marketingPage, /href="\/start-trial"/);
  assert.match(marketingPage, /href="\/contact"/);
  assert.doesNotMatch(marketingPage, /href="\/request-pilot"/);
  assert.match(marketingPage, /Start free trial/);
  assert.doesNotMatch(marketingPage, /Start private beta/i);

  assert.doesNotMatch(
    shell,
    /eligibleWorkspaces|requestDomainJoin|onRequestJoin/,
  );
  assert.doesNotMatch(
    workspaceShell,
    /resolveJoinRequest|Domain join requests/,
  );
  assert.doesNotMatch(workspaceShell, /`\$\{origin\}\/\?invite=/);
  assert.doesNotMatch(
    workspaceShell,
    /window\.location\.origin\}\/\?(?:invite|appointment)=/,
  );
  assert.match(workspaceShell, /\/app\?invite=/);
  assert.match(workspaceShell, /\/app\?appointment=/);
  assert.doesNotMatch(workspaceShell, /<select\b/i);
  assert.doesNotMatch(
    `${shell}\n${workspaceShell}`,
    /window\.location\.reload/,
  );
  assert.match(workspaceShell, /function RouteUnavailable/);
  assert.match(workspaceShell, /import \{ GuideDeleteDialog \}/);
  assert.doesNotMatch(workspaceShell, /export function ActivityView/);
  assert.doesNotMatch(workspaceRoutes, /["']activity["']/);
  assert.match(platformPage, /<KnowHowApp\s*\/>/);
  assert.match(workspaceRoutes, /"ops"/);
  assert.match(workspaceRoutes, /\/platform\/\$\{section\}/);
  assert.match(workspaceShell, /PLATFORM_NAV/);
  assert.doesNotMatch(workspaceShell, /Approved email domains/);
  assert.doesNotMatch(workspaceShell, /<h2>Capture policy<\/h2>/);
  assert.doesNotMatch(workspaceShell, /Approved organization domains/);
  assert.match(auditRoute, /requireAuthorized\("workspace\.audit\.read"/);
  assert.match(auditRoute, /AUDIT_CHAIN_INVALID/);
});

test("browser identity stays cookie-backed while registration admission fails closed", async () => {
  const [authClient, authRoute, commandService, resources, environment] =
    await Promise.all([
      read("lib/auth-client.ts"),
      read("app/api/auth/[[...path]]/route.ts"),
      read("lib/server/command-service.ts"),
      read("lib/server/appwrite-resources.ts"),
      read(".env.example"),
    ]);

  assert.match(authClient, /credentials: "same-origin"/);
  assert.match(authClient, /export function signUp/);
  assert.doesNotMatch(
    authClient,
    /localStorage|sessionStorage|setJWT|createJWT/,
  );
  assert.match(authRoute, /HttpOnly; SameSite=Strict/);
  assert.match(authRoute, /SameSite=Strict/);
  assert.match(authRoute, /registrationMode\(\)/);
  assert.match(authRoute, /signupAdmission\(/);
  assert.match(authRoute, /betaAccess\.reserve/);
  assert.match(authRoute, /betaAccess\.consume/);
  assert.match(authRoute, /betaAccess[\s\S]*?\.release/);
  assert.match(authRoute, /users\.delete/);
  assert.doesNotMatch(authRoute, /KNOWHOW_PUBLIC_SIGNUP_ENABLED/);
  assert.match(authRoute, /admission === "signed_credential"/);
  assert.match(resources, /betaAccessGrants: "beta_access_grants"/);
  assert.match(resources, /betaAccessEvents: "beta_access_events"/);
  assert.match(environment, /KNOWHOW_REGISTRATION_MODE=open/);
  assert.match(environment, /NEXT_PUBLIC_KNOWHOW_REGISTRATION_MODE=open/);
  assert.match(
    commandService,
    /action === "requestDomainJoin" \|\| action === "resolveJoinRequest"/,
  );
  assert.match(commandService, /"INVITATION_ONLY"/);
  assert.doesNotMatch(commandService, /updateAllowedDomains/);
  assert.doesNotMatch(commandService, /updateOrganizationDomains/);
  assert.doesNotMatch(commandService, /INVITATION_DOMAIN_DENIED/);
  assert.doesNotMatch(resources, /organization_domains/);
});

test("extension permissions and application headers stay narrow", async () => {
  const [
    manifest,
    nextConfig,
    extensionBuild,
    workspaceShell,
    extensionBridge,
    installInstructions,
    extensionPackageRoute,
    extensionPackageAccess,
    extensionPackageBuilder,
  ] = await Promise.all([
    json("extension/manifest.json"),
    read("next.config.ts"),
    read("extension/scripts/build.mjs"),
    read("app/components/knowhow-workspace-app.tsx"),
    read("lib/extension-bridge.ts"),
    read("app/components/extension-install-instructions.tsx"),
    read("app/api/extension-package/route.ts"),
    read("lib/extension-package-path.ts"),
    read("lib/server/extension-package.ts"),
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
  assert.doesNotMatch(installInstructions, /npm run extension:build/);
  assert.match(installInstructions, /EXTENSION_PACKAGE_PATH/);
  assert.match(extensionPackageAccess, /\/api\/extension-package/);
  assert.match(extensionPackageRoute, /buildDevelopmentExtensionPackage/);
  assert.match(extensionPackageAccess, /environment !== "production"/);
  assert.match(extensionPackageBuilder, /pathToFileURL/);
  assert.match(extensionPackageBuilder, /return import\(href\)/);
  assert.match(extensionBridge, /NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL/);
  assert.match(extensionBridge, /NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL/);
});
