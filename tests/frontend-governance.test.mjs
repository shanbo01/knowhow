import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("workspace navigation and direct links remain workspace-scoped", async () => {
  const [page, shell, routes, editor, deleteDialog, navigationGuard, workspacePage, platformPage] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/components/knowhow-workspace-app.tsx"),
    source("../lib/workspace-routes.ts"),
    source("../app/components/guide-editor.tsx"),
    source("../app/components/guide-delete-dialog.tsx"),
    source("../lib/navigation-guard.ts"),
    source("../app/w/[workspaceSlug]/[[...segments]]/page.tsx"),
    source("../app/platform/page.tsx"),
  ]);

  assert.doesNotMatch(shell, /visibleNav\.push\(/);
  assert.match(routes, /workspaceHref\(workspaceSlug/);
  assert.match(routes, /newGuideHref\(workspaceSlug/);
  assert.match(routes, /guideEditorHref\(workspaceSlug: string, guideId: string\)/);
  assert.match(routes, /revision=\$\{revision\}/);
  assert.match(routes, /kind: "guide-view"/);
  assert.match(shell, /guideHref\(workspace\.slug/);
  assert.match(shell, /newGuideHref\(workspace\.slug/);
  assert.doesNotMatch(shell, /window\.location\.reload\(\)/);
  assert.match(shell, /RouteUnavailable/);
  assert.match(shell, /recordGuideView/);
  assert.match(shell, /recordGuideCompletion/);
  assert.match(editor, /guide-editor-page/);
  assert.match(editor, /beforeunload/);
  assert.match(editor, /Leave without saving\?/);
  assert.match(editor, /onRegisterNavigationGuard/);
  assert.match(editor, /Delete guide/);
  assert.match(editor, /aria-controls="guide-editor-inspector"/);
  assert.match(editor, /Add a step after step/);
  assert.match(editor, /editor-save-state/);
  assert.match(editor, /Guide title/);
  assert.match(editor, /step-insert-menu/);
  assert.match(editor, /editor-insert-slot[\s\S]*Add a step after step/);
  assert.match(editor, /aria-expanded=\{insertAfterId === step\.id\}/);
  assert.match(editor, /dismissInsertMenu/);
  assert.match(editor, /window\.addEventListener\("pointerdown", dismissInsertMenu\)/);
  assert.doesNotMatch(editor, /step-description-input/);
  assert.match(shell, /GuideDeleteDialog/);
  assert.match(shell, /guide\.canDelete/);
  assert.match(shell, /document-header card/);
  assert.doesNotMatch(shell, /step\.description \? <p>/);
  assert.match(deleteDialog, /Type <strong>\{title\}<\/strong> to confirm/);
  assert.match(deleteDialog, /disabled=\{busy \|\| !confirmed\}/);
  assert.doesNotMatch(editor, /window\.confirm\(/);
  assert.match(navigationGuard, /shouldBlock/);
  assert.match(navigationGuard, /requestConfirmation/);
  assert.match(page, /WorkspaceRecovery/);
  assert.match(page, /parseAppRoute/);
  assert.match(page, /bootstrap\.workspaces\.filter/);
  assert.match(page, /routeWorkspaceSlug/);
  assert.doesNotMatch(page, /requestedWorkspaceFromLocation/);
  assert.match(page, /platform=\{bootstrap\.platform\}/);
  assert.match(page, /<PlatformView/);
  assert.match(page, /onSetWorkspaceStatus=\{setPlatformWorkspaceStatus\}/);
  assert.match(page, /key=\{activeWorkspaceId\}/);
  assert.match(page, /canCreateWorkspace=\{bootstrap\.viewer\.platformAdministrator\}/);
  assert.match(page, /guard\.requestConfirmation/);
  assert.match(page, /Browser back\/forward/);
  assert.match(page, /Ask a workspace administrator for a signed invitation link/);
  assert.match(workspacePage, /KnowHowApp/);
  assert.match(platformPage, /KnowHowApp/);
  assert.doesNotMatch(shell, /guide\.canReview[^\n]*reviewedAt/);
});

test("interactive dropdowns use the themed accessible menu instead of native selects", async () => {
  const [shell, editor, menu, styles] = await Promise.all([
    source("../app/components/knowhow-workspace-app.tsx"),
    source("../app/components/guide-editor.tsx"),
    source("../app/components/select-menu.tsx"),
    source("../app/globals.css"),
  ]);

  assert.doesNotMatch(`${shell}\n${editor}`, /<select\b/i);
  assert.match(menu, /aria-haspopup="listbox"/);
  assert.match(menu, /role="option"/);
  assert.match(menu, /ArrowDown/);
  assert.match(menu, /closeOnOutsideInteraction/);
  assert.match(styles, /\.select-menu-option\[aria-selected="true"\]/);
  assert.match(styles, /\.workspace-menu \.select-menu-options/);
  assert.match(styles, /\.theme-menu \.select-menu-trigger/);
  assert.match(styles, /step-insert-menu-in/);
});

test("protected screenshots use authenticated media and non-destructive in-app redaction", async () => {
  const [client, media, editor, screenshotEditor, flatten] = await Promise.all([
    source("../lib/knowhow-client.ts"),
    source("../app/components/authorized-media.tsx"),
    source("../app/components/guide-editor.tsx"),
    source("../app/components/screenshot-editor.tsx"),
    source("../lib/screenshot-flatten.ts"),
  ]);

  assert.match(client, /authorization: `Bearer \$\{jwt\}`/);
  assert.match(client, /x-knowhow-redacted["']?: /i);
  assert.match(client, /x-knowhow-source-rasterized["']?: "true"/i);
  assert.match(client, /x-knowhow-image-width/);
  assert.match(client, /x-knowhow-image-height/);
  assert.match(media, /URL\.revokeObjectURL/);
  assert.match(editor, /createImageBitmap/);
  assert.match(editor, /canvas\.toBlob/);
  assert.match(editor, /setPrivacyReviewed\(false\)/);
  assert.match(editor, /import \{ ScreenshotEditor \} from "\.\/screenshot-editor"/);
  assert.match(editor, /ScreenshotAnnotationPreview/);
  assert.match(editor, /needsFlattening/);
  assert.match(editor, /screenshotsLockedAt/);
  assert.match(screenshotEditor, /loadAuthorizedMediaUrl/);
  assert.match(screenshotEditor, /data-marker-kind/);
  assert.match(screenshotEditor, /shot-canvas-pen/);
  assert.match(screenshotEditor, /shot-history-controls/);
  assert.match(screenshotEditor, /shot-text-inline-input/);
  assert.match(screenshotEditor, /shot-resize-handle edge/);
  assert.match(screenshotEditor, /point\.x - cx/);
  assert.doesNotMatch(screenshotEditor, /fixedX/);
  assert.match(screenshotEditor, /ZOOM_INCREMENT = 0\.15/);
  assert.match(screenshotEditor, /Zoom in by 15 percent/);
  assert.match(screenshotEditor, /zoom \+ ZOOM_INCREMENT/);
  assert.doesNotMatch(screenshotEditor, /shot-toolbar/);
  assert.match(flatten, /context\.filter = `blur\(/);
  assert.match(media, /authorized-media-overlay/);
  assert.match(editor, /annotation-preview-crop/);
});

test("published screenshots are cloned into a revision-scoped working draft", async () => {
  const route = await source("../app/api/knowhow/route.ts");

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
    source("../lib/knowhow-client.ts"),
    source("../app/components/knowhow-workspace-app.tsx"),
    source("../app/api/knowhow/route.ts"),
  ]);

  assert.match(client, /\/api\/knowhow\/audit\?\$\{params\}/);
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
