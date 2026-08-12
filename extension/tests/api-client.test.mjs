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
    { redactEmails: true, redactIds: true, redactCommonNames: true },
  );
  assert.equal(step.title.includes("alice@example.com"), false);
  assert.equal(step.instructions.includes("Alice Example"), false);
  assert.equal(step.instructions.includes("AB-12345678"), false);
});

test("draft metadata keeps what the author chose not to cover", () => {
  const [step] = preparePrivateDraftSteps(
    [{ title: "Email alice@example.com", instructions: "Ask about AB-12345678." }],
    {},
  );
  assert.equal(step.title, "Email alice@example.com");
  assert.equal(step.instructions, "Ask about AB-12345678.");
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

test("screenshots upload only after irreversible local redaction and preserve presentation metadata", async () => {
  const apiSource = await readFile(
    new URL("../src/core/api-client.js", import.meta.url),
    "utf8",
  );
  const screenshotPath = apiSource.indexOf('"/steps/"');
  const commitPath = apiSource.indexOf('"/commit"');

  assert.ok(screenshotPath >= 0 && screenshotPath < commitPath);
  assert.match(apiSource, /"X-KnowHow-Redacted":\s*"true"/);
  assert.match(apiSource, /"X-KnowHow-Source-Rasterized":\s*"true"/);
  assert.match(apiSource, /\{ clickTarget: step\.clickTarget \}/);
  assert.match(apiSource, /\{ focusRegion: step\.focusRegion \}/);
  assert.match(apiSource, /\{ crop: step\.crop \}/);
  assert.match(apiSource, /redactions: Array\.isArray\(step\.pendingRedactions\)/);
  assert.doesNotMatch(apiSource, /attestation/);
});
