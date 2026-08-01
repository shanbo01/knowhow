import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("workspace navigation and direct links remain workspace-scoped", async () => {
  const [page, shell] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/components/rivet-workspace-app.tsx"),
  ]);

  assert.doesNotMatch(shell, /visibleNav\.push\(/);
  assert.match(shell, /new URLSearchParams\(\{ workspaceId, guide: guide\.id \}\)/);
  assert.match(shell, /recordGuideView/);
  assert.match(shell, /recordGuideCompletion/);
  assert.match(page, /WorkspaceRecovery/);
  assert.match(page, /platform=\{bootstrap\.platform\}/);
  assert.match(page, /<PlatformView/);
  assert.match(page, /onSetWorkspaceStatus=\{setPlatformWorkspaceStatus\}/);
  assert.match(page, /key=\{activeWorkspaceId\}/);
  assert.match(page, /canCreateWorkspace=\{bootstrap\.viewer\.platformAdministrator\}/);
  assert.match(page, /Ask a workspace administrator for a signed invitation link/);
  assert.doesNotMatch(shell, /guide\.canReview[^\n]*reviewedAt/);
});

test("protected screenshots use authenticated media and redacted raster uploads", async () => {
  const [client, media, editor] = await Promise.all([
    source("../lib/rivet-client.ts"),
    source("../app/components/authorized-media.tsx"),
    source("../app/components/guide-editor.tsx"),
  ]);

  assert.match(client, /authorization: `Bearer \$\{jwt\}`/);
  assert.match(client, /x-rivet-redacted["']?: "true"/i);
  assert.match(client, /x-rivet-source-rasterized["']?: "true"/i);
  assert.match(client, /x-rivet-image-width/);
  assert.match(client, /x-rivet-image-height/);
  assert.match(media, /URL\.revokeObjectURL/);
  assert.match(editor, /createImageBitmap/);
  assert.match(editor, /canvas\.toBlob/);
  assert.match(editor, /setPrivacyReviewed\(false\)/);
  assert.match(editor, /x: step\.crop\.x \/ 100/);
  assert.match(editor, /ANNOTATION_KINDS = \["click", "arrow", "box", "text"\]/);
  assert.match(editor, /ScreenshotAnnotationPreview/);
  assert.match(editor, /Number\(event\.target\.value\) \/ 100/);
  assert.match(media, /authorized-media-overlay/);
  assert.match(editor, /annotation-preview-crop/);
});

test("published screenshots are cloned into a revision-scoped working draft", async () => {
  const route = await source("../app/api/rivet/route.ts");

  assert.match(route, /SCREENSHOT_REFERENCE_INVALID/);
  assert.match(route, /existing\.current_published_revision_id/);
  assert.match(route, /clonePrivateMedia\(bucket, \{/);
  assert.match(route, /blocks = blocks\.map\(\(block\) => \{/);
  assert.match(route, /INSERT INTO guide_media/);
  assert.match(route, /cleanupInheritedMedia/);
  assert.match(route, /clonedMediaCount: inheritedMedia\.length/);
});

test("admin audit exports and vault operations stay on trusted boundaries", async () => {
  const [client, shell, route] = await Promise.all([
    source("../lib/rivet-client.ts"),
    source("../app/components/rivet-workspace-app.tsx"),
    source("../app/api/rivet/route.ts"),
  ]);

  assert.match(client, /\/api\/rivet\/audit\?\$\{params\}/);
  assert.match(shell, /downloadAuditCsv/);
  assert.doesNotMatch(shell, /new Blob\(\["\\uFEFF", lines\]/);
  assert.match(shell, /encryptSecretValue/);
  assert.match(shell, /decryptSecretValue/);
  assert.match(shell, /encryptedEnvelopeJson/);
  assert.match(shell, /status === "active" \? <button[^\n]*onRevoke\(invite\.id\)/);
  assert.match(shell, /revokeCaptureDevices/);
  assert.match(route, /capture\.devices-revoked/);
  assert.match(route, /SET revoked_at = CURRENT_TIMESTAMP/);
});
