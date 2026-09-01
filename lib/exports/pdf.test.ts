import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { PDFDocument } from "pdf-lib";
import type { PublishedGuideRevision } from "../guide-contracts";
import { renderGuideToPdf } from "./pdf";
import { GuideRendererError } from "./types";

// --- broad rendering coverage ---

function createMinimalPngBytes(): Uint8Array {
  // 1x1 transparent PNG file
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
    0, 0, 1, 8, 6, 0, 0, 0, 31, 213, 196, 203, 0, 0, 0, 13, 73, 68, 65, 84, 120,
    156, 99, 96, 248, 15, 0, 1, 5, 1, 2, 210, 221, 141, 186, 0, 0, 0, 0, 73, 69,
    78, 68, 174, 66, 96, 130,
  ]);
}


function baseGuide(): PublishedGuideRevision {
  const publishedAt = "2025-01-15T12:00:00.000Z";
  return {
    schemaVersion: 1,
    guideId: "guide-123",
    revisionId: "rev-1",
    workspaceId: "ws-1",
    revisionNumber: 1,
    source: "manual",
    lifecycle: "published",
    title: "Test Guide Title",
    summary: "This is a summary of the test guide.",
    createdAt: "2025-01-10T10:00:00.000Z",
    createdBy: { userId: "user-1", displayName: "Author User" },
    submittedAt: "2025-01-12T10:00:00.000Z",
    submittedBy: { userId: "user-1", displayName: "Author User" },
    reviewedAt: "2025-01-14T10:00:00.000Z",
    reviewedBy: { userId: "user-2", displayName: "Reviewer User" },
    publishedAt,
    publishedBy: { userId: "user-2", displayName: "Publisher User" },
    audience: { mode: "workspace", workspaceId: "ws-1" },
    privacyReview: {
      required: false,
      status: "not-required",
      originalMediaRetained: false,
    },
    branding: {
      workspaceId: "ws-1",
      workspaceName: "Acme Corp",
      accentColor: "#0066cc",
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
    blocks: [
      {
        id: "b-1",
        type: "paragraph",
        text: "Introductory paragraph explaining the guide.",
      },
    ],
  };
}

test("renderGuideToPdf renders a minimal guide to a valid PDF Document", async () => {
  const guide = baseGuide();
  const pdfBytes = await renderGuideToPdf(guide);

  assert.ok(pdfBytes instanceof Uint8Array);
  assert.ok(pdfBytes.length > 0);

  const doc = await PDFDocument.load(pdfBytes);
  assert.equal(doc.getTitle(), "Test Guide Title");
  assert.equal(doc.getAuthor(), "Acme Corp");
  assert.equal(doc.getCreator(), "KnowHow");
  assert.equal(doc.getPageCount(), 1);
});

test("renderGuideToPdf handles all block types and callout tones", async () => {
  const guide: PublishedGuideRevision = {
    ...baseGuide(),
    blocks: [
      { id: "b-h2", type: "heading", level: 2, text: "Section 1" },
      { id: "b-h3", type: "heading", level: 3, text: "Subsection 1.1" },
      { id: "b-p", type: "paragraph", text: "Paragraph text." },
      {
        id: "b-callout-note",
        type: "callout",
        tone: "note",
        title: "Custom Note Title",
        text: "Note content",
      },
      {
        id: "b-callout-warn",
        type: "callout",
        tone: "warning",
        text: "Warning content default title",
      },
      {
        id: "b-callout-success",
        type: "callout",
        tone: "success",
        text: "Success content default title",
      },
      {
        id: "b-action-1",
        type: "action",
        title: "Perform action 1",
        instructions: "Do step 1 carefully.",
        expectedResult: "Action 1 succeeded.",
        requiresConfirmation: true,
        systemReference: { name: "Billing Portal", url: "https://billing.example.com" },
      },
    ],
  };

  const pdfBytes = await renderGuideToPdf(guide);
  const doc = await PDFDocument.load(pdfBytes);
  assert.ok(doc.getPageCount() >= 1);
});

test("renderGuideToPdf generates a Contents section when heading/action blocks > 2", async () => {
  const guide: PublishedGuideRevision = {
    ...baseGuide(),
    blocks: [
      { id: "b-h2", type: "heading", level: 2, text: "Section 1" },
      { id: "b-act-1", type: "action", title: "Step 1", instructions: "Instructions 1" },
      { id: "b-act-2", type: "action", title: "Step 2", instructions: "Instructions 2" },
    ],
  };

  const pdfBytes = await renderGuideToPdf(guide);
  const doc = await PDFDocument.load(pdfBytes);
  // Contents page forces a multi-page PDF output
  assert.ok(doc.getPageCount() > 1);
});

test("renderGuideToPdf embeds images, click targets, annotations, and logo", async () => {
  const pngBytes = createMinimalPngBytes();

  const guide: PublishedGuideRevision = {
    ...baseGuide(),
    branding: {
      ...baseGuide().branding,
      logoMediaId: "logo-asset",
    },
    blocks: [
      {
        id: "b-act-img",
        type: "action",
        title: "Illustrated Step",
        instructions: "Follow screenshot instructions.",
        media: {
          mediaId: "screen-asset",
          fileName: "screen.png",
          mimeType: "image/png",
          width: 100,
          height: 100,
          altText: "Screenshot alt",
          sanitized: true,
          sanitizedAt: "2025-01-14T10:00:00.000Z",
          crop: { x: 0, y: 0, width: 1, height: 1 },
          clickTarget: {
            point: { x: 0.5, y: 0.5 },
            color: "#ff0000",
            radius: 0.05,
          },
          annotations: [
            {
              id: "a-1",
              type: "arrow",
              region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
              color: "#ff0000",
            },
            {
              id: "a-2",
              type: "highlight",
              region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
              color: "#ffff00",
            },
            {
              id: "a-3",
              type: "text",
              region: { x: 0.5, y: 0.5, width: 0.3, height: 0.1 },
              color: "#000000",
              text: "Annotation Label",
            },
            {
              id: "a-4",
              type: "rectangle",
              region: { x: 0.1, y: 0.7, width: 0.2, height: 0.2 },
              color: "#00ff00",
            },
          ],
          redactions: [],
        },
      },
      {
        id: "b-act-png2",
        type: "action",
        title: "JPEG Step",
        instructions: "Follow JPEG screenshot.",
        media: {
          mediaId: "png2-asset",
          fileName: "photo.png",
          mimeType: "image/png",
          width: 100,
          height: 100,
          altText: "PNG photo",
          sanitized: true,
          sanitizedAt: "2025-01-14T10:00:00.000Z",
          annotations: [],
          redactions: [],
        },
      },
    ],
  };

  const options = {
    assets: [
      { mediaId: "logo-asset", mimeType: "image/png" as const, bytes: pngBytes },
      { mediaId: "screen-asset", mimeType: "image/png" as const, bytes: pngBytes },
      { mediaId: "png2-asset", mimeType: "image/png" as const, bytes: pngBytes },
    ],
  };

  const pdfBytes = await renderGuideToPdf(guide, options);
  const doc = await PDFDocument.load(pdfBytes);
  assert.ok(doc.getPageCount() >= 1);
});

test("renderGuideToPdf handles missing media gracefully with fallback placeholder", async () => {
  const guide: PublishedGuideRevision = {
    ...baseGuide(),
    blocks: [
      {
        id: "b-act-missing",
        type: "action",
        title: "Step with Missing Image",
        instructions: "Instructions for step without asset.",
        media: {
          mediaId: "missing-asset",
          fileName: "screen.png",
          mimeType: "image/png",
          width: 100,
          height: 100,
          altText: "Missing media",
          sanitized: true,
          sanitizedAt: "2025-01-14T10:00:00.000Z",
          annotations: [],
          redactions: [],
        },
      },
    ],
  };

  // Do not provide assets in options
  const pdfBytes = await renderGuideToPdf(guide, {});
  const doc = await PDFDocument.load(pdfBytes);
  assert.ok(doc.getPageCount() >= 1);
});

test("renderGuideToPdf applies watermarks when option provided", async () => {
  const guide = baseGuide();
  const options = {
    watermark: {
      viewer: "John Viewer",
      workspace: "Acme Corp",
      exportedAt: "2025-01-16T00:00:00.000Z",
    },
  };

  const pdfBytes = await renderGuideToPdf(guide, options);
  const doc = await PDFDocument.load(pdfBytes);
  assert.equal(doc.getPageCount(), 1);
});

test("renderGuideToPdf throws GuideRendererError on invalid revision", async () => {
  const invalidGuide = { ...baseGuide(), schemaVersion: 999 } as unknown as PublishedGuideRevision;

  await assert.rejects(
    async () => {
      await renderGuideToPdf(invalidGuide);
    },
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_REVISION");
      return true;
    },
  );
});

test("renderGuideToPdf throws GuideRendererError when PDF format is disabled in policy", async () => {
  const guide: PublishedGuideRevision = {
    ...baseGuide(),
    exportPolicy: {
      ...baseGuide().exportPolicy,
      allowedFormats: ["html"],
    },
  };

  await assert.rejects(
    async () => {
      await renderGuideToPdf(guide);
    },
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "FORMAT_DISABLED");
      return true;
    },
  );
});

test("renderGuideToPdf throws GuideRendererError when image asset is corrupted", async () => {
  const corruptBytes = new Uint8Array([1, 2, 3, 4, 5]);

  const guide: PublishedGuideRevision = {
    ...baseGuide(),
    blocks: [
      {
        id: "b-act-corrupt",
        type: "action",
        title: "Corrupt Image Step",
        instructions: "Step with corrupt image asset.",
        media: {
          mediaId: "corrupt-asset",
          fileName: "corrupt.png",
          mimeType: "image/png",
          width: 100,
          height: 100,
          altText: "Corrupt asset",
          sanitized: true,
          sanitizedAt: "2025-01-14T10:00:00.000Z",
          annotations: [],
          redactions: [],
        },
      },
    ],
  };

  const options = {
    assets: [{ mediaId: "corrupt-asset", mimeType: "image/png" as const, bytes: corruptBytes }],
  };

  await assert.rejects(
    async () => {
      await renderGuideToPdf(guide, options);
    },
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_MEDIA");
      return true;
    },
  );
});

// --- image/logo decode failures ---

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

// --- error wrapping ---

function createValidRevision(): PublishedGuideRevision {
  return {
    schemaVersion: 1,
    guideId: "guide_1",
    revisionId: "rev_1",
    workspaceId: "ws_1",
    revisionNumber: 1,
    source: "manual",
    title: "Test Guide",
    summary: "Test summary",
    createdAt: "2025-01-01T00:00:00Z",
    createdBy: { userId: "user_1", displayName: "Test User" },
    blocks: [
      {
        id: "block_1",
        type: "paragraph",
        text: "Hello world",
      },
    ],
    audience: { mode: "workspace", workspaceId: "ws_1" },
    privacyReview: {
      required: false,
      status: "not-required",
      originalMediaRetained: false,
    },
    branding: {
      workspaceId: "ws_1",
      workspaceName: "Test Workspace",
      accentColor: "#0070f3",
      clickTargetColor: "#0070f3",
      showKnowHowBranding: true,
    },
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown", "pptx"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
    lifecycle: "published",
    submittedAt: "2025-01-01T00:00:00Z",
    submittedBy: { userId: "user_1", displayName: "Test User" },
    reviewedAt: "2025-01-01T00:00:00Z",
    reviewedBy: { userId: "user_1", displayName: "Test User" },
    publishedAt: "2025-01-01T00:00:00Z",
    publishedBy: { userId: "user_1", displayName: "Test User" },
  };
}

test("renderGuideToPdf renders a valid guide revision to PDF Uint8Array", async () => {
  const revision = createValidRevision();
  const result = await renderGuideToPdf(revision);
  assert.ok(result instanceof Uint8Array);
  assert.ok(result.byteLength > 0);
});

test("renderGuideToPdf wraps unexpected errors in a GuideRendererError", async () => {
  const revision = createValidRevision();
  const unexpectedError = new Error("Failed to create document");

  mock.method(PDFDocument, "create", () => {
    throw unexpectedError;
  });

  try {
    await renderGuideToPdf(revision);
    assert.fail("renderGuideToPdf should have thrown an error");
  } catch (error) {
    assert.ok(error instanceof GuideRendererError);
    assert.equal(error.code, "RENDER_FAILED");
    assert.equal(error.message, "KnowHow could not render the PDF.");
    assert.equal(error.format, "pdf");
    assert.equal(error.cause, unexpectedError);
  } finally {
    mock.reset();
  }
});

test("renderGuideToPdf rethrows existing GuideRendererError without rewrapping", async () => {
  const revision = createValidRevision();
  const customError = new GuideRendererError(
    "INVALID_MEDIA",
    "KnowHow could not decode media media_1.",
    { format: "pdf" },
  );

  mock.method(PDFDocument, "create", () => {
    throw customError;
  });

  try {
    await renderGuideToPdf(revision);
    assert.fail("renderGuideToPdf should have thrown an error");
  } catch (error) {
    assert.equal(error, customError);
  } finally {
    mock.reset();
  }
});
