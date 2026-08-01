import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isAcceptedScreenshotType,
  isValidPairingCode,
  preparePrivateDraftSteps,
  submitPrivateDraft,
} from "../src/core/api-client.js";

test("private draft upload accepts JPEG and PNG but rejects WebP", () => {
  assert.equal(isAcceptedScreenshotType("image/jpeg"), true);
  assert.equal(isAcceptedScreenshotType("image/png"), true);
  assert.equal(isAcceptedScreenshotType("image/webp"), false);
  assert.equal(isAcceptedScreenshotType(""), false);
});

test("pairing codes require the server's 12-character minimum", () => {
  assert.equal(isValidPairingCode("ABCD2345EFGH"), true);
  assert.equal(isValidPairingCode("ABCD2345E"), false);
  assert.equal(isValidPairingCode("ABCD-2345-EFGH"), false);
});

test("private draft metadata is sanitized again at the upload boundary", () => {
  const [step] = preparePrivateDraftSteps(
    [
      {
        title: "Email alice@example.com",
        instructions: "Ask Alice Example about AB-12345678.",
      },
    ],
    { redactCommonNames: true },
  );
  assert.equal(step.title.includes("alice@example.com"), false);
  assert.equal(step.instructions.includes("Alice Example"), false);
  assert.equal(step.instructions.includes("AB-12345678"), false);
});

test("private draft submission rejects a WebP before any authenticated request", async () => {
  await assert.rejects(
    submitPrivateDraft({
      capture: { remoteCaptureId: "capture-1" },
      steps: [
        {
          id: "step-1",
          title: "Step",
          instructions: "Do the thing.",
          imageBlob: new Blob(["webp"], { type: "image/webp" }),
        },
      ],
      privacyReview: {},
    }),
    /only locally rasterized JPEG or PNG/i,
  );
});

test("privacy review is attested before redacted blobs upload and commit", async () => {
  const reviewSource = await readFile(
    new URL("../src/review/review.js", import.meta.url),
    "utf8",
  );
  const apiSource = await readFile(
    new URL("../src/core/api-client.js", import.meta.url),
    "utf8",
  );
  const beginUpload = reviewSource.indexOf('type: "BEGIN_DRAFT_UPLOAD"');
  const reviewedAt = reviewSource.indexOf("completedAt: new Date().toISOString()");
  const upload = reviewSource.indexOf("await submitPrivateDraft");
  const screenshotPath = apiSource.indexOf('"/steps/"');
  const commitPath = apiSource.indexOf('"/commit"');

  assert.ok(beginUpload >= 0 && beginUpload < reviewedAt);
  assert.ok(reviewedAt < upload);
  assert.ok(screenshotPath >= 0 && screenshotPath < commitPath);
});
