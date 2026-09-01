import assert from "node:assert/strict";
import test from "node:test";

import { GuideContractError, type PublishedGuideRevision } from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import { GuideRendererError } from "./types";

function createValidPublishedRevision(): PublishedGuideRevision {
  return {
    schemaVersion: 1,
    guideId: "guide-123",
    revisionId: "rev-456",
    workspaceId: "ws-789",
    revisionNumber: 1,
    source: "manual",
    lifecycle: "published",
    title: "Test Published Guide",
    createdAt: "2025-01-01T00:00:00.000Z",
    createdBy: { userId: "user-1", displayName: "Author" },
    submittedAt: "2025-01-01T01:00:00.000Z",
    submittedBy: { userId: "user-1", displayName: "Author" },
    reviewedAt: "2025-01-01T02:00:00.000Z",
    reviewedBy: { userId: "user-2", displayName: "Reviewer" },
    publishedAt: "2025-01-01T03:00:00.000Z",
    publishedBy: { userId: "user-2", displayName: "Reviewer" },
    blocks: [
      {
        id: "block-1",
        type: "paragraph",
        text: "Sample paragraph",
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
  };
}

test("prepareGuideExport wraps GuideContractError in GuideRendererError with issue details", () => {
  const invalidCandidate = {} as PublishedGuideRevision;

  assert.throws(
    () => prepareGuideExport(invalidCandidate, "pdf"),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_REVISION");
      assert.equal(error.format, "pdf");
      assert.ok(error.cause instanceof GuideContractError);
      assert.ok(error.message.includes("Published guide revision is invalid."));
      assert.ok(error.message.includes("$.lifecycle: Unknown guide lifecycle state."));
      return true;
    },
  );
});

test("prepareGuideExport wraps non-GuideContractError in GuideRendererError with default message", () => {
  const genericErrorCandidate = new Proxy({} as PublishedGuideRevision, {
    get(_target, prop) {
      if (prop === "lifecycle") {
        throw new Error("Generic failure during revision validation");
      }
      return undefined;
    },
  });

  assert.throws(
    () => prepareGuideExport(genericErrorCandidate, "pdf"),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_REVISION");
      assert.equal(error.format, "pdf");
      assert.ok(error.cause instanceof Error);
      assert.equal((error.cause as Error).message, "Generic failure during revision validation");
      assert.equal(error.message, "The published guide revision is invalid.");
      return true;
    },
  );
});

test("prepareGuideExport throws FORMAT_DISABLED if requested format is not allowed", () => {
  const revision = createValidPublishedRevision();
  const restrictedRevision: PublishedGuideRevision = {
    ...revision,
    exportPolicy: {
      ...revision.exportPolicy,
      allowedFormats: ["pdf"],
    },
  };

  assert.throws(
    () => prepareGuideExport(restrictedRevision, "html"),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "FORMAT_DISABLED");
      assert.equal(error.format, "html");
      assert.equal(error.message, "HTML export is disabled for this guide.");
      return true;
    },
  );
});

test("prepareGuideExport throws RESTRICTED_EXPORT_DISABLED when restricted guide exports are disabled", () => {
  const revision = createValidPublishedRevision();
  const restrictedGuide: PublishedGuideRevision = {
    ...revision,
    audience: {
      mode: "restricted",
      workspaceId: "ws-789",
      targets: [{ type: "user", id: "user-123" }],
    },
    exportPolicy: {
      ...revision.exportPolicy,
      restrictedGuideExports: "disabled",
    },
  };

  assert.throws(
    () => prepareGuideExport(restrictedGuide, "pdf"),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "RESTRICTED_EXPORT_DISABLED");
      assert.equal(error.format, "pdf");
      assert.equal(error.message, "Exports are disabled for this restricted guide.");
      return true;
    },
  );
});

test("prepareGuideExport throws INVALID_OPTIONS when unknown render options are provided", () => {
  const revision = createValidPublishedRevision();

  assert.throws(
    () => prepareGuideExport(revision, "pdf", { unknownOption: 123 } as Record<string, unknown>),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.format, "pdf");
      assert.equal(error.message, "Unknown render option: unknownOption.");
      return true;
    },
  );
});

test("prepareGuideExport throws WATERMARK_REQUIRED when required watermark fields are missing", () => {
  const revision = createValidPublishedRevision();
  const requiredWatermarkRevision: PublishedGuideRevision = {
    ...revision,
    exportPolicy: {
      ...revision.exportPolicy,
      watermark: {
        mode: "required",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
  };

  assert.throws(
    () => prepareGuideExport(requiredWatermarkRevision, "pdf", { watermark: {} }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "WATERMARK_REQUIRED");
      assert.equal(error.format, "pdf");
      assert.equal(error.message, "This guide requires watermark viewer, date.");
      return true;
    },
  );
});

test("prepareGuideExport validates watermark option inputs", () => {
  const revision = createValidPublishedRevision();

  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        watermark: { invalidKey: "test" } as Record<string, unknown>,
      }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.message, "Unknown watermark option: invalidKey.");
      return true;
    },
  );

  assert.throws(
    () => prepareGuideExport(revision, "pdf", { watermark: { viewer: "  " } }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.message, "Watermark viewer must be a non-empty string.");
      return true;
    },
  );

  assert.throws(
    () => prepareGuideExport(revision, "pdf", { watermark: { exportedAt: "not-a-date" } }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.message, "Watermark exportedAt must be an ISO date or date-time string.");
      return true;
    },
  );
});

test("prepareGuideExport validates asset options and asset mapping", () => {
  const revision = createValidPublishedRevision();

  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [{ mediaId: "" } as unknown as { mediaId: string; mimeType: "image/png" }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.message, "Export assets require a mediaId.");
      return true;
    },
  );

  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [
          {
            mediaId: "m1",
            mimeType: "image/gif" as unknown as "image/png",
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.message, "Unsupported export asset type for m1.");
      return true;
    },
  );

  assert.throws(
    () =>
      prepareGuideExport(revision, "pdf", {
        assets: [
          { mediaId: "m1", mimeType: "image/png" },
          { mediaId: "m1", mimeType: "image/png" },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof GuideRendererError);
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.message, "Duplicate export asset: m1.");
      return true;
    },
  );
});

test("prepareGuideExport successfully prepares export for valid revision and options", () => {
  const revision = createValidPublishedRevision();
  const prepared = prepareGuideExport(revision, "pdf", {
    watermark: {
      viewer: "Alice",
      workspace: "Acme Workspace",
      exportedAt: "2025-01-01T12:00:00.000Z",
    },
  });

  assert.equal(prepared.revision.guideId, "guide-123");
  assert.equal(prepared.watermark?.viewer, "Alice");
  assert.equal(prepared.watermark?.workspace, "Acme Workspace");
  assert.equal(prepared.watermark?.exportedAt, "2025-01-01T12:00:00.000Z");
  assert.equal(prepared.assets.size, 0);
});
