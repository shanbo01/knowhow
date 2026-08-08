import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { PDFDocument } from "pdf-lib";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
let outputDirectory;
let guide;

before(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), "knowhow-guide-contracts-"));
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: false,
      outDir: outputDirectory,
      target: "es2022",
      minify: false,
      lib: {
        entry: path.join(root, "lib", "exports", "index.ts"),
        formats: ["es"],
        fileName: () => "guide-exports.mjs",
      },
    },
  });
  guide = await import(
    `${pathToFileURL(path.join(outputDirectory, "guide-exports.mjs")).href}?test=${Date.now()}`
  );
});

after(async () => {
  if (outputDirectory) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

function actor(userId, displayName) {
  return { userId, displayName };
}

function publishedRevision() {
  return {
    schemaVersion: 1,
    guideId: "guide-onboarding",
    revisionId: "revision-3",
    workspaceId: "workspace-acme",
    entityId: "entity-finance",
    revisionNumber: 3,
    source: "manual",
    lifecycle: "published",
    title: "Approve a supplier <safely>",
    summary: "A deterministic guide.\n<script>alert('never execute')</script>",
    createdAt: "2026-07-28T08:00:00.000Z",
    createdBy: actor("user-author", "A. Author"),
    submittedAt: "2026-07-29T08:00:00.000Z",
    submittedBy: actor("user-author", "A. Author"),
    reviewedAt: "2026-07-30T08:00:00.000Z",
    reviewedBy: actor("user-reviewer", "R. Reviewer"),
    publishedAt: "2026-07-31T08:00:00.000Z",
    publishedBy: actor("user-publisher", "P. Publisher"),
    audience: {
      mode: "restricted",
      workspaceId: "workspace-acme",
      targets: [{ type: "group", id: "group-finance", label: "Finance" }],
    },
    privacyReview: {
      required: false,
      status: "not-required",
      originalMediaRetained: false,
    },
    branding: {
      workspaceId: "workspace-acme",
      workspaceName: "Acme & Co",
      accentColor: "#0d6b57",
      clickTargetColor: "#ff7a00",
      showKnowHowBranding: true,
    },
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown"],
      restrictedGuideExports: "allowed",
      watermark: {
        mode: "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
    blocks: [
      { id: "heading-1", type: "heading", level: 2, text: "Before you begin" },
      {
        id: "paragraph-1",
        type: "paragraph",
        text: "Confirm the request came from an authorized budget owner.",
      },
      {
        id: "callout-1",
        type: "callout",
        tone: "warning",
        title: "Stop if details differ",
        text: "Do not continue until Finance confirms the change.",
      },
      {
        id: "action-1",
        type: "action",
        title: "Open the supplier profile",
        instructions: "Choose Suppliers, then locate the pending profile.",
        expectedResult: "The pending supplier profile is visible.",
        requiresConfirmation: true,
        systemReference: {
          name: "Finance Portal",
          url: "https://finance.example.test/suppliers",
        },
        media: {
          mediaId: "media-sanitized-1",
          fileName: "supplier-profile.png",
          mimeType: "image/png",
          width: 1440,
          height: 900,
          altText: "Sanitized supplier profile screen",
          sanitized: true,
          sanitizedAt: "2026-07-28T08:01:00.000Z",
          annotations: [],
          redactions: [
            {
              id: "redaction-email",
              category: "email",
              mode: "blur",
              region: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
              detection: "automatic",
              applied: true,
            },
          ],
        },
      },
    ],
  };
}

test("validates and freezes an immutable published revision", () => {
  const revision = publishedRevision();
  const result = guide.validatePublishedGuideRevision(revision);
  assert.equal(result.success, true);
  const parsed = guide.parsePublishedGuideRevision(revision);
  assert.equal(parsed.lifecycle, "published");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.blocks), true);
  assert.equal(Object.isFrozen(parsed.blocks[3].media.redactions), true);
});

test("blocks captured publication until privacy review is approved", () => {
  const revision = publishedRevision();
  revision.source = "browser-capture";
  revision.privacyReview = {
    required: true,
    status: "pending",
    originalMediaRetained: false,
  };
  const result = guide.validatePublishedGuideRevision(revision);
  assert.equal(result.success, false);
  assert.match(
    result.issues.map((item) => `${item.path} ${item.message}`).join("\n"),
    /approved privacy review/i,
  );
});

test("rejects unsafe capture fields and unsanitized media", () => {
  const revision = publishedRevision();
  revision.blocks[3].media.sanitized = false;
  assert.equal(guide.validateGuideRevision(revision).success, false);

  const capture = {
    schemaVersion: 1,
    captureId: "capture-1",
    workspaceId: "workspace-acme",
    state: "paused",
    startedAt: "2026-08-01T08:00:00.000Z",
    scope: {
      origin: "https://example.test",
      startedUrl: "https://example.test/start",
      excludedOrigins: [],
    },
    privacyPolicy: {
      excludePasswordFields: true,
      captureRawKeystrokes: false,
      captureClipboard: false,
      captureIncognito: false,
      retainUnredactedScreenshots: false,
      autoRedactionCategories: ["email", "form-field"],
      assistedRedactionCategories: ["common-name", "long-text"],
    },
    pauses: [{ pausedAt: "2026-08-01T08:02:00.000Z" }],
    events: [
      {
        id: "form-1",
        type: "form-interaction",
        occurredAt: "2026-08-01T08:01:00.000Z",
        fieldType: "password",
        rawKeystrokes: "should-never-exist",
      },
    ],
    draftBlocks: [],
  };
  const result = guide.validateCaptureSession(capture);
  assert.equal(result.success, false);
  assert.match(
    result.issues.map((item) => `${item.path} ${item.message}`).join("\n"),
    /rawKeystrokes|fieldType/,
  );
});

test("enforces pause as a zero-capture interval", () => {
  const capture = {
    schemaVersion: 1,
    captureId: "capture-paused",
    workspaceId: "workspace-acme",
    state: "paused",
    startedAt: "2026-08-01T08:00:00.000Z",
    scope: {
      origin: "https://example.test",
      startedUrl: "https://example.test/start",
      excludedOrigins: [],
    },
    privacyPolicy: {
      excludePasswordFields: true,
      captureRawKeystrokes: false,
      captureClipboard: false,
      captureIncognito: false,
      retainUnredactedScreenshots: false,
      autoRedactionCategories: ["email", "form-field"],
      assistedRedactionCategories: ["common-name", "long-text"],
    },
    pauses: [{ pausedAt: "2026-08-01T08:02:00.000Z" }],
    events: [
      {
        id: "click-during-pause",
        type: "click",
        occurredAt: "2026-08-01T08:03:00.000Z",
        targetLabel: "Must not be collected",
      },
    ],
    draftBlocks: [],
  };
  const result = guide.validateCaptureSession(capture);
  assert.equal(result.success, false);
  assert.match(
    result.issues.map((item) => item.message).join("\n"),
    /Paused capture intervals must contain no events/i,
  );
});

test("validates lifecycle chronology and export receipts", () => {
  const revision = publishedRevision();
  revision.reviewedAt = "2026-08-02T08:00:00.000Z";
  assert.equal(guide.validatePublishedGuideRevision(revision).success, false);

  const completed = guide.validateGuideExportReceipt({
    schemaVersion: 1,
    exportId: "export-1",
    requestId: "request-1",
    workspaceId: "workspace-acme",
    guideId: "guide-onboarding",
    revisionId: "revision-3",
    format: "pdf",
    status: "completed",
    occurredAt: "2026-08-01T10:30:00.000Z",
    byteLength: 42_000,
  });
  assert.equal(completed.success, true);

  const failedWithoutCode = guide.validateGuideExportReceipt({
    schemaVersion: 1,
    exportId: "export-2",
    requestId: "request-2",
    workspaceId: "workspace-acme",
    guideId: "guide-onboarding",
    revisionId: "revision-3",
    format: "html",
    status: "failed",
    occurredAt: "2026-08-01T10:31:00.000Z",
  });
  assert.equal(failedWithoutCode.success, false);
});

test("renders deterministic, escaped Markdown and HTML with an optional watermark", () => {
  const revision = publishedRevision();
  const options = {
    watermark: {
      viewer: "Jane Technician",
      workspace: "Acme & Co",
      exportedAt: "2026-08-01T10:30:00.000Z",
    },
  };
  const markdownA = guide.renderGuideToMarkdown(revision, options);
  const markdownB = guide.renderGuideToMarkdown(revision, options);
  assert.equal(markdownA, markdownB);
  assert.match(markdownA, /Viewer: Jane Technician/);
  assert.match(markdownA, /Exported: 2026\\-08\\-01/);
  assert.doesNotMatch(markdownA, /password|vault|passphrase/i);

  const htmlA = guide.renderGuideToHtml(revision, options);
  const htmlB = guide.renderGuideToHtml(revision, options);
  assert.equal(htmlA, htmlB);
  assert.match(htmlA, /&lt;script&gt;alert\(&#39;never execute&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(htmlA, /<script>/i);
  assert.match(htmlA, /Viewer: Jane Technician/);
  assert.doesNotMatch(htmlA, /password|vault|passphrase/i);
});

test("renders cropped screenshots and escaped visual annotations", async () => {
  const revision = publishedRevision();
  revision.blocks[3].media.crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  revision.blocks[3].media.clickTarget = {
    point: { x: 0.5, y: 0.5 },
    color: "#ff7a00",
    radius: 0.035,
  };
  revision.blocks[3].media.annotations = [
    {
      id: "arrow-1",
      type: "arrow",
      region: { x: 0.25, y: 0.25, width: 0.2, height: 0.1 },
      color: "#0d6b57",
    },
    {
      id: "text-1",
      type: "text",
      region: { x: 0.3, y: 0.65, width: 0.25, height: 0.08 },
      color: "#0d6b57",
      text: "Check <owner>",
    },
  ];
  const mediaBytes = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const options = {
    assets: [
      {
        mediaId: "media-sanitized-1",
        mimeType: "image/png",
        bytes: mediaBytes,
      },
    ],
  };

  const html = guide.renderGuideToHtml(revision, options);
  assert.match(html, /class="media-frame"/);
  assert.match(html, /<circle/);
  assert.match(html, /<line/);
  assert.match(html, /Check &lt;owner&gt;/);
  assert.match(html, /left:-12\.5%/);

  const pdf = await guide.renderGuideToPdf(revision, options);
  const document = await PDFDocument.load(pdf);
  assert.ok(document.getPageCount() >= 1);
});

test("renders a deterministic, parseable, paginated PDF", async () => {
  const revision = publishedRevision();
  revision.blocks.splice(2, 0, {
    id: "long-paragraph",
    type: "paragraph",
    text: Array.from(
      { length: 150 },
      (_, index) => `Verification sentence ${index + 1} remains readable and deterministic.`,
    ).join(" "),
  });
  const options = {
    watermark: {
      viewer: "Jane Technician",
      workspace: "Acme & Co",
      exportedAt: "2026-08-01T10:30:00.000Z",
    },
  };
  const first = await guide.renderGuideToPdf(revision, options);
  const second = await guide.renderGuideToPdf(revision, options);
  assert.deepEqual(first, second);
  assert.equal(new TextDecoder().decode(first.slice(0, 5)), "%PDF-");

  const document = await PDFDocument.load(first);
  assert.ok(document.getPageCount() >= 2);
  assert.equal(document.getTitle(), revision.title.replace(/[<>]/g, (item) => item));
  assert.equal(document.getAuthor(), "Acme & Co");
});

test("enforces restricted export and required watermark policies", () => {
  const restricted = publishedRevision();
  restricted.exportPolicy.restrictedGuideExports = "disabled";
  assert.throws(
    () => guide.renderGuideToMarkdown(restricted),
    (error) => error.code === "RESTRICTED_EXPORT_DISABLED",
  );

  const watermarkRequired = publishedRevision();
  watermarkRequired.exportPolicy.watermark.mode = "required";
  assert.throws(
    () => guide.renderGuideToHtml(watermarkRequired),
    (error) => error.code === "WATERMARK_REQUIRED",
  );
});

test("forbids sensitive audit metadata keys", () => {
  const result = guide.validateGuideAuditEvent({
    schemaVersion: 1,
    eventId: "event-1",
    workspaceId: "workspace-acme",
    occurredAt: "2026-08-01T11:00:00.000Z",
    actor: actor("user-1", "Admin"),
    action: "guide.exported",
    guideId: "guide-onboarding",
    revisionId: "revision-3",
    summary: "Guide exported",
    metadata: { format: "pdf", vaultPassword: "must-not-be-here" },
  });
  assert.equal(result.success, false);
  assert.match(result.issues[0].message, /Sensitive fields are forbidden/i);
});
