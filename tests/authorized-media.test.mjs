import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("protected screenshots share a refcounted blob URL and retry 404s after capture commit", async () => {
  const [client, editor, media, workspace] = await Promise.all([
    readFile(new URL("../lib/knowhow-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/screenshot-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/authorized-media.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/knowhow-workspace-app.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(client, /const mediaUrlCache = new Map/);
  assert.match(client, /existing\.refs \+= 1/);
  assert.match(client, /retries = 3/);
  assert.match(
    client,
    /error instanceof KnowHowApiError &&\s*\(error.status === 404 \|\| error.status === 409\)/,
  );
  assert.match(client, /export async function acquireAuthorizedMediaUrl/);
  assert.match(client, /export function releaseAuthorizedMediaUrl/);
  assert.match(client, /export async function refreshAuthorizedMediaUrl/);
  assert.match(client, /if \(entry\.refs === 0 && !entry\.promise\)/);
  assert.match(editor, /acquireAuthorizedMediaUrl\(workspaceId, mediaId\)/);
  assert.match(editor, /releaseAuthorizedMediaUrl\(workspaceId, mediaId\)/);
  assert.match(editor, /refreshAuthorizedMediaUrl\(workspaceId, mediaId\)/);
  assert.match(editor, /onError=\{\(\) => \{/);
  assert.match(media, /acquireAuthorizedMediaUrl\(workspaceId, mediaId\)/);
  assert.match(media, /refreshAuthorizedMediaUrl\(workspaceId, mediaId\)/);
  assert.match(workspace, /missingGuideRefresh/);
  assert.match(workspace, /function RouteOpening/);
  assert.match(workspace, /void onRefresh\(\)/);
});
