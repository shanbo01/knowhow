import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSolidRedactionPlan,
  detectSensitiveRanges,
  mergeRects,
  normalizedRegionFromPoints,
  normalizeRect,
  sanitizeCapturedLabel,
  sanitizeCapturedText,
  scaleRect,
  scaleNormalizedRegion,
  isSensitivePathSegment,
} from "../src/core/redaction.js";

test("redaction rectangles are padded and clamped to the viewport", () => {
  assert.deepEqual(
    normalizeRect(
      { x: 2, y: 4, width: 20, height: 10, reason: "email" },
      { width: 100, height: 80 },
      5,
    ),
    {
      x: 0,
      y: 0,
      width: 27,
      height: 19,
      reason: "email",
    },
  );
});

test("touching rectangles merge into one irreversible mask", () => {
  const merged = mergeRects([
    { x: 10, y: 10, width: 10, height: 10, reason: "email" },
    { x: 22, y: 10, width: 8, height: 10, reason: "email" },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    x: 10,
    y: 10,
    width: 20,
    height: 10,
    reason: "email",
  });
});

test("viewport rectangles scale into screenshot pixels", () => {
  assert.deepEqual(
    scaleRect(
      { x: 25, y: 20, width: 50, height: 10, reason: "manual" },
      { width: 100, height: 50 },
      { width: 200, height: 100 },
    ),
    { x: 50, y: 40, width: 100, height: 20, reason: "manual" },
  );

  const plan = buildSolidRedactionPlan({
    rects: [{ x: 10, y: 10, width: 10, height: 10, reason: "password" }],
    viewport: { width: 100, height: 100 },
    bitmap: { width: 200, height: 200 },
    padding: 0,
  });
  assert.deepEqual(plan[0], {
    x: 20,
    y: 20,
    width: 20,
    height: 20,
    reason: "password",
  });
});

test("detectors return locations without exposing values in sanitized labels", () => {
  const input = "Email alice@example.com or call +974 5555 1234";
  const enabled = { redactEmails: true, redactPhoneNumbers: true };
  const ranges = detectSensitiveRanges(input, enabled);
  assert.ok(ranges.some((finding) => finding.reason === "email"));
  assert.ok(ranges.some((finding) => finding.reason === "phone"));
  const sanitized = sanitizeCapturedLabel(input, enabled);
  assert.equal(sanitized.includes("alice@example.com"), false);
  assert.match(sanitized, /\[redacted\]/);
});

test("no category is detected until the author enables it", () => {
  const input =
    "Email alice@example.com, call +974 5555 1234, ref AB-12345678, card 4111 1111 1111 1111";
  assert.deepEqual(detectSensitiveRanges(input), []);
  assert.equal(sanitizeCapturedLabel(input).includes("[redacted]"), false);
});

test("all-number masking stays opt-in", () => {
  const defaultFindings = detectSensitiveRanges("Choose step 2");
  assert.equal(defaultFindings.length, 0);
  const strictFindings = detectSensitiveRanges("Choose step 2", {
    redactAllNumbers: true,
  });
  assert.deepEqual(strictFindings, [
    { start: 12, end: 13, reason: "number" },
  ]);
});

test("captured metadata redacts formatted numbers and IDs, not leftover names", () => {
  const input = "Call +974 5555 1234 for Alice Example about AB-12345678";
  const sanitized = sanitizeCapturedText(
    input,
    {
      redactPhoneNumbers: true,
      redactIds: true,
      redactCommonNames: true,
    },
    500,
  );
  assert.equal(sanitized.includes("5555"), false);
  assert.equal(sanitized.includes("Alice Example"), true);
  assert.equal(sanitized.includes("AB-12345678"), false);
  assert.match(sanitized, /\[redacted\]/);
});

test("URL path segments keep route slugs, numeric IDs, and opaque tokens", () => {
  assert.equal(
    isSensitivePathSegment("helpdesk-ac3fe", { redactIds: true }),
    false,
  );
  assert.equal(
    isSensitivePathSegment("12345678", {
      redactIds: true,
      redactAllNumbers: true,
    }),
    false,
  );
  assert.equal(
    isSensitivePathSegment("alice@example.com", { redactEmails: true }),
    true,
  );
  assert.equal(
    isSensitivePathSegment("0123456789abcdef0123456789abcdef"),
    false,
  );
});

test("a normalized manual region scales consistently across screenshots", () => {
  const region = normalizedRegionFromPoints(
    { x: 20, y: 10 },
    { x: 60, y: 30 },
    { width: 100, height: 50 },
  );
  assert.deepEqual(region, { x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
  assert.deepEqual(scaleNormalizedRegion(region, { width: 500, height: 200 }), {
    x: 100,
    y: 40,
    width: 200,
    height: 80,
  });
});
