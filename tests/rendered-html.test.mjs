import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Rivet technician workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Rivet — IT operations, documented<\/title>/i);
  assert.match(html, /Opening Rivet/);
  assert.match(html, /Verifying Appwrite and restoring your session/);
  assert.doesNotMatch(html, /Reset GlobalProtect MFA for a user/);
  assert.doesNotMatch(html, /Interactive prototype|fictional demo record/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("ships the real Appwrite-backed MVP without fixture fallbacks", async () => {
  const [page, layout, packageJson, appwriteClient, records] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/appwrite.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/records.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview/);
  assert.doesNotMatch(page, /Reset GlobalProtect MFA for a user|Interactive prototype/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"appwrite"/);
  assert.match(layout, /og\.png/);
  assert.match(page, /await client\.ping\(\)/);
  assert.match(appwriteClient, /https:\/\/sgp\.cloud\.appwrite\.io\/v1/);
  assert.match(appwriteClient, /6a6a53ac002ca43c7ea4/);
  assert.match(records, /Permission\.read\(team\)/);
  assert.match(records, /Role\.team\(teamId, "editor"\)/);
  assert.match(records, /Role\.team\(teamId, "vault"\)/);
  assert.match(records, /Permission\.update\(editor\)/);
  assert.match(records, /Permission\.delete\(vault\)/);
});
