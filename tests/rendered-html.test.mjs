import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the production build contains the governed Rivet application shell", async () => {
  const [layout, page, serverBundle] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../dist/server/index.js", import.meta.url), "utf8"),
  ]);
  const html = `${layout}\n${page}`;
  assert.match(
    html,
    /Rivet — SOPs captured, governed, and shared/i,
  );
  assert.match(html, /Opening Rivet/);
  assert.match(html, /Verifying Appwrite and restoring your secure session/);
  assert.doesNotMatch(html, /asset inventory|Import assets|Interactive prototype/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
  assert.match(serverBundle, /vinext|handler/i);
});

test("ships the trusted D1 and R2 architecture instead of browser-writable product data", async () => {
  const [
    page,
    appShell,
    api,
    exportRoute,
    extensionRoute,
    hosting,
    schema,
    records,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/rivet-workspace-app.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/api/rivet/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/rivet/export/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/extension/[[...path]]/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/records.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /await client\.ping\(\)/);
  assert.match(page, /emailVerification/);
  assert.doesNotMatch(appShell, /\bAssets\b|asset inventory|Import assets/i);
  assert.match(hosting, /"d1"\s*:\s*"DB"/);
  assert.match(hosting, /"r2"\s*:\s*"MEDIA"/);
  assert.match(api, /requireVerifiedIdentity/);
  assert.match(api, /executeAuditedMutation|audit\(/);
  assert.match(api, /working_draft_revision_id/);
  assert.match(exportRoute, /renderGuideToPdf/);
  assert.match(extensionRoute, /storeRedactedScreenshot/);
  assert.match(extensionRoute, /REDACTION_ATTESTATION_REQUIRED/);
  assert.match(extensionRoute, /function captureEditUrl/);
  assert.match(extensionRoute, /url\.searchParams\.set\("workspaceId", workspaceId\)/);
  assert.match(extensionRoute, /url\.searchParams\.set\("edit", "1"\)/);
  assert.doesNotMatch(extensionRoute, /editUrl:\s*`\/\?guide=/);
  assert.match(schema, /audit_events_reject_update/);
  assert.match(schema, /audit_events_reject_delete/);
  assert.match(schema, /guide_audiences_validate_insert/);
  assert.match(records, /Permission\.read/);
});

test("the extension manifest keeps high-risk browser capabilities out", async () => {
  const [manifestText, apiClient, captureSource] = await Promise.all([
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(
      new URL("../extension/src/core/api-client.js", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../extension/src/content/capture.js", import.meta.url),
      "utf8",
    ),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(!manifest.permissions.includes("clipboardRead"));
  assert.ok(!manifest.permissions.includes("desktopCapture"));
  assert.ok(!manifest.permissions.includes("tabCapture"));
  assert.ok(!manifest.host_permissions.includes("<all_urls>"));
  assert.match(apiClient, /X-Rivet-Redacted/);
  assert.match(apiClient, /one-time pairing code/i);
  assert.doesNotMatch(captureSource, /\.value\b/);
});

test("localhost bootstraps governed storage and the capture extension on one origin", async () => {
  const [
    packageText,
    localConfigText,
    viteConfig,
    workerEntry,
    consoleCompatibility,
    extensionConfig,
    manifestText,
  ] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.local.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../worker/console-task-compat.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../extension/src/core/config.js", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const localConfig = JSON.parse(localConfigText);
  const manifest = JSON.parse(manifestText);

  assert.match(packageJson.scripts.predev, /db:local/);
  assert.match(packageJson.scripts["db:local"], /migrations apply DB --local/);
  assert.match(packageJson.scripts.dev, /127\.0\.0\.1 -p 3001/);
  assert.equal(localConfig.d1_databases[0].binding, "DB");
  assert.equal(localConfig.d1_databases[0].migrations_dir, "./drizzle");
  assert.equal(localConfig.r2_buckets[0].binding, "MEDIA");
  assert.match(viteConfig, /configPath: "\.\/wrangler\.local\.jsonc"/);
  assert.match(viteConfig, /virtual:vinext-app-ssr-entry/);
  assert.match(workerEntry, /import "\.\/console-task-compat"/);
  assert.match(consoleCompatibility, /fallbackCreateTask/);
  assert.match(extensionConfig, /http:\/\/localhost:3001/);
  assert.deepEqual(manifest.host_permissions, ["http://localhost/*"]);
  assert.doesNotMatch(
    `${extensionConfig}\n${manifestText}`,
    /chatgpt\.site/i,
  );
});
