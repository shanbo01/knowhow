import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyEditorCommand,
  blurAtPoint,
  commitEditor,
  createEditorDocument,
  createEditorHistory,
  normalizedRect,
  panCrop,
  pointFromClient,
  redoEditor,
  rectFromPoints,
  serializeEditorState,
  undoEditor,
  zoomCrop,
} from "../src/review/editor-state.js";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function capturedStep(overrides = {}) {
  return {
    sessionId: "session-1",
    id: "step-1",
    order: 0,
    title: "Select Settings",
    instructions: "Select Settings.",
    imageBlob: new Blob(["redacted"], { type: "image/jpeg" }),
    imageWidth: 1200,
    imageHeight: 800,
    automaticMaskCount: 3,
    manualMaskCount: 0,
    clickTarget: { x: 0.9, y: 0.48, radius: 0.035, color: "#ef6f47" },
    focusRegion: { x: 0.84, y: 0.4, width: 0.14, height: 0.16 },
    ...overrides,
  };
}

test("context framing includes a focus region at the screenshot edge", () => {
  const step = createEditorDocument([capturedStep()]).steps[0];
  const crop = step.editorState.crop;
  assert.ok(crop.x <= step.clickTarget.x);
  assert.ok(crop.x + crop.width >= step.clickTarget.x);
  assert.ok(crop.x <= step.focusRegion.x);
  assert.ok(crop.x + crop.width >= step.focusRegion.x + step.focusRegion.width);
  assert.ok(crop.width < 1, "click captures start context-zoomed");
});

test("rectangle normalization shifts a wide crop instead of shrinking it", () => {
  assert.deepEqual(
    normalizedRect({ x: 0.65, y: 0.2, width: 0.52, height: 0.5 }),
    { x: 0.48, y: 0.2, width: 0.52, height: 0.5 },
  );
});

test("manual blur, drawing, and click edits undo and redo as one command each", () => {
  const base = createEditorDocument([capturedStep()]);
  let history = createEditorHistory(base);
  const blur = { id: "blur-1", x: 0.2, y: 0.2, width: 0.2, height: 0.1, strength: 0.6 };
  history = commitEditor(history, {
    type: "update-step",
    stepId: "step-1",
    editorPatch: { manualBlurs: [blur] },
  });
  history = commitEditor(history, {
    type: "update-step",
    stepId: "step-1",
    editorPatch: {
      drawings: [{
        id: "draw-1",
        points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }],
        color: "#356fe5",
        width: 0.006,
      }],
    },
  });
  assert.equal(history.present.steps[0].editorState.manualBlurs.length, 1);
  assert.equal(history.present.steps[0].editorState.drawings.length, 1);
  history = undoEditor(history);
  assert.equal(history.present.steps[0].editorState.drawings.length, 0);
  assert.equal(history.present.steps[0].editorState.manualBlurs.length, 1);
  history = undoEditor(history);
  assert.equal(history.present.steps[0].editorState.manualBlurs.length, 0);
  history = redoEditor(history);
  assert.equal(history.present.steps[0].editorState.manualBlurs.length, 1);
});

test("step removal and reordering remain reversible without deleting base blobs", () => {
  const first = capturedStep();
  const second = capturedStep({ id: "step-2", order: 1, title: "Confirm" });
  let history = createEditorHistory(createEditorDocument([first, second]));
  history = commitEditor(history, {
    type: "move-step",
    stepId: "step-2",
    toIndex: 0,
  });
  assert.deepEqual(history.present.steps.map((step) => step.id), ["step-2", "step-1"]);
  history = commitEditor(history, { type: "remove-step", stepId: "step-2" });
  assert.deepEqual(history.present.steps.map((step) => step.id), ["step-1"]);
  assert.equal(history.present.steps[0].imageBlob, first.imageBlob);
  history = undoEditor(history);
  assert.equal(history.present.steps[0].imageBlob, second.imageBlob);
});

test("pointer, crop, pan, and zoom geometry stays normalized", () => {
  const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.5 };
  assert.deepEqual(
    pointFromClient(300, 250, { left: 100, top: 50, width: 400, height: 400 }, crop),
    { x: 0.45, y: 0.5 },
  );
  assert.deepEqual(
    rectFromPoints({ x: 0.2, y: 0.4 }, { x: 0.6, y: 0.1 }),
    { x: 0.2, y: 0.1, width: 0.39999999999999997, height: 0.30000000000000004 },
  );
  const panned = panCrop(crop, 0.8, -0.8);
  assert.deepEqual(panned, { x: 0.5, y: 0, width: 0.5, height: 0.5 });
  const zoomed = zoomCrop(crop, 2, { x: 0.45, y: 0.5 });
  assert.equal(zoomed.width, 0.25);
  assert.equal(zoomed.height, 0.25);
  assert.ok(zoomed.x >= 0 && zoomed.x + zoomed.width <= 1);
});

test("only manual masks can be unblurred and serialization preserves locked counts", () => {
  const source = capturedStep({ manualMaskCount: 2 });
  const document = createEditorDocument([source]);
  const blur = { id: "blur-1", x: 0.1, y: 0.1, width: 0.2, height: 0.2, strength: 0.6 };
  const edited = applyEditorCommand(document, {
    type: "update-step",
    stepId: "step-1",
    editorPatch: { manualBlurs: [blur] },
  }).steps[0];
  assert.equal(blurAtPoint(edited.editorState.manualBlurs, { x: 0.15, y: 0.15 }).id, "blur-1");
  assert.equal(blurAtPoint(edited.editorState.manualBlurs, { x: 0.8, y: 0.8 }), null);
  const serialized = serializeEditorState(edited);
  assert.equal(serialized.editorState.legacyManualMaskCount, 2);
  assert.equal(serialized.manualMaskCount, 3);
  assert.equal(edited.imageBlob, source.imageBlob, "editor commands never replace the redacted base");
});

test("review markup and controller keep the three-pane editor contract aligned", async () => {
  const [html, source, styles] = await Promise.all([
    readFile(path.join(extensionRoot, "src/review/review.html"), "utf8"),
    readFile(path.join(extensionRoot, "src/review/review.js"), "utf8"),
    readFile(path.join(extensionRoot, "src/review/review.css"), "utf8"),
  ]);
  for (const id of [
    "step-list",
    "editor-canvas",
    "tool-group",
    "blur-list",
    "undo-button",
    "submit-button",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /role="listbox"/);
  assert.match(source, /from "\.\/editor-state\.js"/);
  assert.match(source, /finishTextTransaction\(\);\s+if \(event\.shiftKey\) redo\(\)/);
  assert.match(source, /submissionSteps\.push\(await flattenStep\(step\)\)/);
  assert.match(styles, /@media \(max-width: 760px\)/);
});
