import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { PDFDocument } from "pdf-lib";
import type { PublishedGuideRevision } from "../guide-contracts";
import { renderGuideToPdf } from "./pdf";
import { GuideRendererError } from "./types";

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
