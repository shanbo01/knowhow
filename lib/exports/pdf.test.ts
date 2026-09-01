import assert from "node:assert/strict";
import test from "node:test";
import type { PublishedGuideRevision } from "../guide-contracts";
import { renderGuideToPdf } from "./pdf";
import { GuideRendererError } from "./types";

const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0,
  0, 1, 8, 6, 0, 0, 0, 31, 213, 196, 203, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156,
  99, 96, 4, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66,
  96, 130,
]);

function createTestRevision(overrides: Partial<PublishedGuideRevision> = {}): PublishedGuideRevision {
  return {
    schemaVersion: 1,
    guideId: "guide_123",
    revisionId: "rev_123",
    workspaceId: "ws_123",
    revisionNumber: 1,
    source: "manual",
    lifecycle: "published",
    title: "Test Guide Title",
    summary: "Test Summary",
    createdAt: "2025-01-01T00:00:00.000Z",
    createdBy: { userId: "user_1" },
    submittedAt: "2025-01-01T01:00:00.000Z",
    submittedBy: { userId: "user_1" },
    reviewedAt: "2025-01-01T02:00:00.000Z",
    reviewedBy: { userId: "user_2" },
    publishedAt: "2025-01-01T03:00:00.000Z",
    publishedBy: { userId: "user_2" },
    blocks: [
      {
        id: "block_1",
        type: "action",
        title: "Step 1",
        instructions: "Do action 1",
        media: {
          mediaId: "media_test",
          fileName: "test.png",
          mimeType: "image/png",
          width: 100,
          height: 100,
          altText: "Test Media",
          sanitized: true,
          sanitizedAt: "2025-01-01T02:30:00.000Z",
          annotations: [],
          redactions: [],
        },
      },
    ],
    audience: {
      mode: "workspace",
      workspaceId: "ws_123",
    },
    privacyReview: {
      required: false,
      status: "not-required",
      originalMediaRetained: false,
    },
    branding: {
      workspaceId: "ws_123",
      workspaceName: "Test Workspace",
      accentColor: "#0055ff",
      clickTargetColor: "#ff0000",
      showKnowHowBranding: true,
    },
    exportPolicy: {
      allowedFormats: ["pdf"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "none",
        includeViewer: false,
        includeWorkspace: false,
        includeDate: false,
      },
    },
    ...overrides,
  };
}

test("throws GuideRendererError with INVALID_MEDIA when PNG image asset decoding fails", async () => {
  const revision = createTestRevision();
  const invalidAsset = {
    mediaId: "media_test",
    mimeType: "image/png" as const,
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
  };

  await assert.rejects(
    async () => {
      await renderGuideToPdf(revision, { assets: [invalidAsset] });
    },
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_MEDIA");
      assert.equal(error.format, "pdf");
      assert.equal(
        error.message,
        "KnowHow could not decode media media_test.",
      );
      assert.notEqual(error.cause, undefined);
      return true;
    },
  );
});

test("throws GuideRendererError with INVALID_MEDIA when JPEG image asset decoding fails", async () => {
  const revision = createTestRevision({
    blocks: [
      {
        id: "block_1",
        type: "action",
        title: "Step 1",
        instructions: "Do action 1",
        media: {
          mediaId: "media_jpg",
          fileName: "test.jpg",
          mimeType: "image/jpeg",
          width: 100,
          height: 100,
          altText: "Test JPEG Media",
          sanitized: true,
          sanitizedAt: "2025-01-01T02:30:00.000Z",
          annotations: [],
          redactions: [],
        },
      },
    ],
  });
  const invalidAsset = {
    mediaId: "media_jpg",
    mimeType: "image/jpeg" as const,
    bytes: new Uint8Array([255, 216, 0, 0, 0]),
  };

  await assert.rejects(
    async () => {
      await renderGuideToPdf(revision, { assets: [invalidAsset] });
    },
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_MEDIA");
      assert.equal(error.format, "pdf");
      assert.equal(
        error.message,
        "KnowHow could not decode media media_jpg.",
      );
      assert.notEqual(error.cause, undefined);
      return true;
    },
  );
});

test("throws GuideRendererError with INVALID_MEDIA when workspace logo image decoding fails", async () => {
  const revision = createTestRevision({
    branding: {
      workspaceId: "ws_123",
      workspaceName: "Test Workspace",
      logoMediaId: "logo_media",
      accentColor: "#0055ff",
      clickTargetColor: "#ff0000",
      showKnowHowBranding: true,
    },
  });
  const invalidLogoAsset = {
    mediaId: "logo_media",
    mimeType: "image/png" as const,
    bytes: new Uint8Array([0, 0, 0, 0]),
  };

  await assert.rejects(
    async () => {
      await renderGuideToPdf(revision, { assets: [invalidLogoAsset] });
    },
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_MEDIA");
      assert.equal(error.format, "pdf");
      assert.equal(
        error.message,
        "KnowHow could not decode media logo_media.",
      );
      assert.notEqual(error.cause, undefined);
      return true;
    },
  );
});

test("renders PDF successfully when asset has no bytes provided", async () => {
  const revision = createTestRevision();
  const assetWithoutBytes = {
    mediaId: "media_test",
    mimeType: "image/png" as const,
  };

  const pdfBytes = await renderGuideToPdf(revision, {
    assets: [assetWithoutBytes],
  });
  assert.ok(pdfBytes instanceof Uint8Array);
  assert.ok(pdfBytes.length > 0);
});

test("renders PDF successfully when valid PNG asset is provided", async () => {
  const revision = createTestRevision();
  const validAsset = {
    mediaId: "media_test",
    mimeType: "image/png" as const,
    bytes: TINY_PNG,
  };

  const pdfBytes = await renderGuideToPdf(revision, {
    assets: [validAsset],
  });
  assert.ok(pdfBytes instanceof Uint8Array);
  assert.ok(pdfBytes.length > 0);
});
