import assert from "node:assert/strict";
import test from "node:test";
import { prepareGuideExport } from "./policy";
import { GuideRendererError } from "./types";
import type { PublishedGuideRevision } from "../guide-contracts";

function createValidPublishedRevision(
  overrides: Partial<PublishedGuideRevision> = {},
): PublishedGuideRevision {
  return {
    schemaVersion: 1,
    guideId: "guide-123",
    revisionId: "rev-456",
    workspaceId: "ws-789",
    revisionNumber: 1,
    source: "manual",
    lifecycle: "published",
    title: "Test Guide Title",
    summary: "Test Guide Summary",
    createdAt: "2025-01-01T00:00:00.000Z",
    createdBy: { userId: "user-1", displayName: "Author User" },
    submittedAt: "2025-01-01T01:00:00.000Z",
    submittedBy: { userId: "user-1", displayName: "Author User" },
    reviewedAt: "2025-01-01T02:00:00.000Z",
    reviewedBy: { userId: "user-2", displayName: "Reviewer User" },
    publishedAt: "2025-01-01T03:00:00.000Z",
    publishedBy: { userId: "user-2", displayName: "Reviewer User" },
    blocks: [
      {
        id: "block-1",
        type: "paragraph",
        text: "Intro paragraph text.",
      },
      {
        id: "block-2",
        type: "action",
        title: "Perform action",
        instructions: "Click the main button.",
        media: {
          mediaId: "media-1",
          fileName: "step1.png",
          mimeType: "image/png",
          width: 800,
          height: 600,
          altText: "Step 1 screenshot",
          sanitized: true,
          sanitizedAt: "2025-01-01T01:30:00.000Z",
          annotations: [],
          redactions: [],
        },
      },
    ],
    audience: {
      mode: "workspace",
      workspaceId: "ws-789",
    },
    privacyReview: {
      required: false,
      status: "not-required",
      originalMediaRetained: false,
    },
    branding: {
      workspaceId: "ws-789",
      workspaceName: "Acme Corp",
      accentColor: "#0055ff",
      clickTargetColor: "#ff0000",
      showKnowHowBranding: true,
    },
    exportPolicy: {
      allowedFormats: ["pdf", "html", "markdown", "pptx"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
    ...overrides,
  };
}

test("prepareGuideExport returns prepared export for valid revision and options", () => {
  const revision = createValidPublishedRevision();
  const prepared = prepareGuideExport(revision, "pdf", {
    assets: [
      {
        mediaId: "media-1",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
        href: "https://example.com/step1.png",
      },
    ],
    watermark: {
      viewer: "Jane Doe",
      workspace: "Acme Corp",
      exportedAt: "2025-01-02T10:00:00.000Z",
    },
  });

  assert.equal(prepared.revision.guideId, "guide-123");
  assert.equal(prepared.assets.size, 1);
  assert.equal(prepared.assets.get("media-1")?.mediaId, "media-1");
  assert.deepEqual(prepared.watermark, {
    viewer: "Jane Doe",
    workspace: "Acme Corp",
    exportedAt: "2025-01-02T10:00:00.000Z",
  });
});

test("prepareGuideExport throws INVALID_REVISION when candidate is invalid", () => {
  const invalidCandidate = {
    ...createValidPublishedRevision(),
    lifecycle: "draft", // Not published
  } as unknown as PublishedGuideRevision;

  assert.throws(
    () => prepareGuideExport(invalidCandidate, "pdf"),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_REVISION");
      assert.equal(err.format, "pdf");
      return true;
    },
  );
});

test("prepareGuideExport throws FORMAT_DISABLED when format is not allowed by export policy", () => {
  const revision = createValidPublishedRevision({
    exportPolicy: {
      allowedFormats: ["html"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "none",
        includeViewer: false,
        includeWorkspace: false,
        includeDate: false,
      },
    },
  });

  assert.throws(
    () => prepareGuideExport(revision, "pdf"),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "FORMAT_DISABLED");
      assert.equal(err.format, "pdf");
      assert.match(err.message, /PDF export is disabled/);
      return true;
    },
  );
});

test("prepareGuideExport throws RESTRICTED_EXPORT_DISABLED when restricted guide exports are disabled", () => {
  const revision = createValidPublishedRevision({
    audience: {
      mode: "restricted",
      workspaceId: "ws-789",
      targets: [{ type: "user", id: "user-10" }],
    },
    exportPolicy: {
      allowedFormats: ["pdf", "html"],
      restrictedGuideExports: "disabled",
      watermark: {
        mode: "none",
        includeViewer: false,
        includeWorkspace: false,
        includeDate: false,
      },
    },
  });

  assert.throws(
    () => prepareGuideExport(revision, "pdf"),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "RESTRICTED_EXPORT_DISABLED");
      assert.equal(err.format, "pdf");
      return true;
    },
  );
});

test("prepareGuideExport throws INVALID_OPTIONS when unknown option key is provided", () => {
  const revision = createValidPublishedRevision();
  const invalidOptions = {
    unknownKey: "invalid",
  } as unknown as Parameters<typeof prepareGuideExport>[2];

  assert.throws(
    () => prepareGuideExport(revision, "pdf", invalidOptions),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.equal(err.format, "pdf");
      assert.match(err.message, /Unknown render option: unknownKey/);
      return true;
    },
  );
});

test("prepareGuideExport validates watermark options and formats", () => {
  const revision = createValidPublishedRevision({
    exportPolicy: {
      allowedFormats: ["pdf"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
  });

  // Unknown watermark key
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        watermark: { unknownWatermarkKey: "val" } as unknown,
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Unknown watermark option: unknownWatermarkKey/);
      return true;
    },
  );

  // Empty string watermark viewer
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        watermark: { viewer: "   " },
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Watermark viewer must be a non-empty string/);
      return true;
    },
  );

  // Exceeds 500 characters
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        watermark: { viewer: "a".repeat(501) },
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Watermark viewer must not exceed 500 characters/);
      return true;
    },
  );

  // Invalid date string
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        watermark: { exportedAt: "not-a-date" },
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Watermark exportedAt must be an ISO date/);
      return true;
    },
  );
});

test("prepareGuideExport throws WATERMARK_REQUIRED when policy mode is required and fields are missing", () => {
  const revision = createValidPublishedRevision({
    exportPolicy: {
      allowedFormats: ["pdf"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "required",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
  });

  // missing viewer and date (workspace defaults to revision.branding.workspaceName if not provided)
  assert.throws(
    () => prepareGuideExport(revision, "pdf", { watermark: {} }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "WATERMARK_REQUIRED");
      assert.match(err.message, /This guide requires watermark viewer, date/);
      return true;
    },
  );
});

test("prepareGuideExport handles watermark policy mode 'none'", () => {
  const revision = createValidPublishedRevision({
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
  });

  const prepared = prepareGuideExport(revision, "pdf", {
    watermark: { viewer: "Ignored User" },
  });

  assert.equal(prepared.watermark, undefined);
});

test("prepareGuideExport validates asset options and detects media mismatches", () => {
  const revision = createValidPublishedRevision();

  // Unknown asset key
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "media-1", mimeType: "image/png", extra: 123 } as unknown],
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Unknown export asset option: extra/);
      return true;
    },
  );

  // Missing mediaId
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "", mimeType: "image/png" }],
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Export assets require a mediaId/);
      return true;
    },
  );

  // Unsupported mimeType
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "media-1", mimeType: "image/svg+xml" as unknown }],
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Unsupported export asset type/);
      return true;
    },
  );

  // Invalid bytes (not Uint8Array)
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "media-1", mimeType: "image/png", bytes: [1, 2, 3] as unknown }],
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /bytes must be a Uint8Array/);
      return true;
    },
  );

  // Unsafe href
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "media-1", mimeType: "image/png", href: "javascript:alert(1)" }],
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /has an unsafe href/);
      return true;
    },
  );

  // Duplicate asset mediaId
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [
          { mediaId: "media-1", mimeType: "image/png" },
          { mediaId: "media-1", mimeType: "image/png" },
        ],
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_OPTIONS");
      assert.match(err.message, /Duplicate export asset: media-1/);
      return true;
    },
  );

  // Media type mismatch between block media and supplied asset
  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "media-1", mimeType: "image/jpeg" }], // block-2 is image/png
      }),
    (err: unknown) => {
      assert(err instanceof GuideRendererError);
      assert.equal(err.code, "INVALID_MEDIA");
      assert.match(err.message, /Media type mismatch for media-1/);
      return true;
    },
  );
});

test("prepareGuideExport checks workspace logo media type", () => {
  const revision = createValidPublishedRevision({
    branding: {
      workspaceId: "ws-789",
      workspaceName: "Acme Corp",
      logoMediaId: "logo-media-1",
      accentColor: "#0055ff",
      clickTargetColor: "#ff0000",
      showKnowHowBranding: true,
    },
  });

  // Supplied logo asset with unsupported/non-image mimeType
  // Note: validateAsset will throw INVALID_OPTIONS if mimeType is not image/png or image/jpeg,
  // but if logo asset is provided as image/png/jpeg, assetMap accepts it.
  const prepared = prepareGuideExport(revision, "pdf", {
    assets: [{ mediaId: "logo-media-1", mimeType: "image/png" }],
  });

  assert.equal(prepared.assets.get("logo-media-1")?.mimeType, "image/png");
});
