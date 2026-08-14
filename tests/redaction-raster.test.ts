import assert from "node:assert/strict";
import test from "node:test";
import { redactionSampleDimensions } from "../lib/redaction-raster";

test("redaction raster retains only a small fraction of the source samples", () => {
  assert.deepEqual(redactionSampleDimensions(320, 160, 16), {
    width: 20,
    height: 10,
  });
  assert.deepEqual(redactionSampleDimensions(12, 8, 16), {
    width: 2,
    height: 2,
  });
});

test("redaction raster dimensions stay valid for degenerate geometry", () => {
  assert.deepEqual(redactionSampleDimensions(0, Number.NaN, 0), {
    width: 1,
    height: 1,
  });
});
