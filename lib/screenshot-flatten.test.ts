import assert from "node:assert/strict";
import test from "node:test";
import type { EditorBlock } from "./knowhow-types";
import { needsFlattening } from "./screenshot-flatten";

function createBlock(overrides: Partial<EditorBlock> = {}): EditorBlock {
  return {
    id: "block-1",
    kind: "action",
    title: "Test Block",
    description: "Description",
    ...overrides,
  };
}

test("needsFlattening returns false for a standard block without crop or redactions", () => {
  const block = createBlock();
  assert.equal(needsFlattening(block), false);
});

test("needsFlattening returns false for a full-image crop and empty redactions", () => {
  const block = createBlock({
    crop: { x: 0, y: 0, width: 1, height: 1 },
    redactions: [],
  });
  assert.equal(needsFlattening(block), false);
});

test("needsFlattening returns false at exact tolerance boundary thresholds", () => {
  const block = createBlock({
    crop: { x: 0.001, y: 0.001, width: 0.999, height: 0.999 },
  });
  assert.equal(needsFlattening(block), false);
});

test("needsFlattening returns true when crop.x exceeds tolerance threshold", () => {
  const block = createBlock({
    crop: { x: 0.002, y: 0, width: 1, height: 1 },
  });
  assert.equal(needsFlattening(block), true);
});

test("needsFlattening returns true when crop.y exceeds tolerance threshold", () => {
  const block = createBlock({
    crop: { x: 0, y: 0.002, width: 1, height: 1 },
  });
  assert.equal(needsFlattening(block), true);
});

test("needsFlattening returns true when crop.width is below tolerance threshold", () => {
  const block = createBlock({
    crop: { x: 0, y: 0, width: 0.998, height: 1 },
  });
  assert.equal(needsFlattening(block), true);
});

test("needsFlattening returns true when crop.height is below tolerance threshold", () => {
  const block = createBlock({
    crop: { x: 0, y: 0, width: 1, height: 0.998 },
  });
  assert.equal(needsFlattening(block), true);
});

test("needsFlattening returns false when all redactions are already applied", () => {
  const block = createBlock({
    redactions: [
      { id: "red-1", x: 0.1, y: 0.1, width: 0.2, height: 0.2, applied: true },
      { id: "red-2", x: 0.4, y: 0.4, width: 0.1, height: 0.1, applied: true },
    ],
  });
  assert.equal(needsFlattening(block), false);
});

test("needsFlattening returns true when at least one redaction is not applied", () => {
  const block = createBlock({
    redactions: [
      { id: "red-1", x: 0.1, y: 0.1, width: 0.2, height: 0.2, applied: true },
      { id: "red-2", x: 0.4, y: 0.4, width: 0.1, height: 0.1, applied: false },
    ],
  });
  assert.equal(needsFlattening(block), true);
});

test("needsFlattening handles undefined redactions gracefully", () => {
  const block = createBlock({
    crop: { x: 0, y: 0, width: 1, height: 1 },
    redactions: undefined,
  });
  assert.equal(needsFlattening(block), false);
});

test("needsFlattening returns true when both crop and unapplied redaction are present", () => {
  const block = createBlock({
    crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    redactions: [
      { id: "red-1", x: 0.1, y: 0.1, width: 0.2, height: 0.2, applied: false },
    ],
  });
  assert.equal(needsFlattening(block), true);
});
