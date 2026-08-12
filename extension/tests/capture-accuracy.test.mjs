import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizedClickTarget,
  normalizedFocusRegion,
} from "../src/offscreen/offscreen.js";
import { createInteractionSequencer } from "../src/core/interaction-sequence.js";

test("click points normalize independently of screenshot pixel density", () => {
  assert.deepEqual(
    normalizedClickTarget(
      { x: 320, y: 180 },
      {
        width: 1280,
        height: 720,
        devicePixelRatio: 2,
      },
      "#ef6f47",
    ),
    {
      x: 0.25,
      y: 0.25,
      radius: 0.035,
      color: "#ef6f47",
    },
  );
});

test("click targets clamp to the image boundary and reject invalid geometry", () => {
  assert.deepEqual(
    normalizedClickTarget(
      { x: -10, y: 900 },
      { width: 1000, height: 800 },
      "not-a-color",
    ),
    { x: 0, y: 1, radius: 0.035, color: "#d97706" },
  );
  assert.equal(
    normalizedClickTarget(
      { x: Number.NaN, y: 10 },
      { width: 100, height: 100 },
      "#ef6f47",
    ),
    null,
  );
});

test("clicked element bounds normalize into an editable focus region", () => {
  const centered = normalizedFocusRegion(
    { x: 100, y: 50, width: 200, height: 100 },
    { width: 1000, height: 500, devicePixelRatio: 2 },
  );
  assert.equal(centered.x, 0.1);
  assert.equal(centered.y, 0.1);
  assert.ok(Math.abs(centered.width - 0.2) < Number.EPSILON);
  assert.ok(Math.abs(centered.height - 0.2) < Number.EPSILON);
  assert.deepEqual(
    normalizedFocusRegion(
      { x: -50, y: 700, width: 150, height: 200 },
      { width: 1000, height: 800 },
    ),
    { x: 0, y: 0.875, width: 0.1, height: 0.125 },
  );
  assert.equal(
    normalizedFocusRegion(
      { x: 10, y: 10, width: 0, height: 10 },
      { width: 100, height: 100 },
    ),
    null,
  );
});

// The content script is injected as a classic script, so it cannot export its
// geometry. Evaluating the shipped mask-merging block lets these rules be tested
// as behaviour instead of as a regular expression over source text.
async function maskGeometry(viewport = { width: 1280, height: 800 }) {
  const source = await readFile(
    new URL("../src/content/capture.js", import.meta.url),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("  const MASK_PADDING"),
    source.indexOf("  function collectMasks"),
  );
  return new Function(
    "innerWidth",
    "innerHeight",
    block + "\nreturn { mergedMasks };",
  )(viewport.width, viewport.height);
}

test("live blur covers the detected text and nothing else", async () => {
  const { mergedMasks } = await maskGeometry();

  // Rectangles from one line of text join into a single calm panel.
  const line = mergedMasks([
    { x: 100, y: 100, width: 60, height: 16, reason: "email" },
    { x: 164, y: 100, width: 40, height: 16, reason: "email" },
  ]);
  assert.equal(line.length, 1);
  assert.equal(line[0].x, 97);
  assert.equal(line[0].width, 110);

  // Two short lines in a tall container stay separate: merging them would cover
  // the blank space to the right of the shorter line.
  const stacked = mergedMasks([
    { x: 100, y: 100, width: 180, height: 15, reason: "common-name" },
    { x: 100, y: 122, width: 40, height: 15, reason: "common-name" },
  ]);
  assert.equal(stacked.length, 2);
  assert.ok(stacked.every((mask) => mask.width <= 186));

  // Overlapping rectangles reported for the same control still collapse.
  const overlapping = mergedMasks([
    { x: 100, y: 100, width: 200, height: 30, reason: "form-field" },
    { x: 140, y: 104, width: 60, height: 22, reason: "form-field" },
  ]);
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].width, 206);

  // Slivers and rectangles scrolled out of the viewport never paint.
  assert.deepEqual(
    mergedMasks([
      { x: 10, y: 10, width: 0.5, height: 12, reason: "number" },
      { x: 10, y: 900, width: 120, height: 12, reason: "number" },
    ]),
    [],
  );
});

test("the on-page panel labels workspace advice instead of acting on it", async () => {
  const contentSource = await readFile(
    new URL("../src/content/capture.js", import.meta.url),
    "utf8",
  );

  // Nothing is detected, covered, or rewritten unless the author switched that
  // category on: every read of a detector flag is an explicit true.
  for (const key of [
    "redactEmails",
    "redactPhoneNumbers",
    "redactFinancialNumbers",
    "redactIds",
    "redactFormFields",
    "redactImages",
    "redactTableRows",
    "redactLongText",
  ]) {
    assert.doesNotMatch(
      contentSource,
      new RegExp("policy\\." + key + " !== false"),
      key,
    );
  }
  assert.match(contentSource, /const RECOMMENDED_CATEGORY_BY_KEY = \{/);
  assert.match(contentSource, /function recommendedPolicyKey\(key\)/);
  assert.match(contentSource, /suggestion\.textContent = "Suggested"/);
  assert.match(
    contentSource,
    /input\.checked = state\.policy\[input\.dataset\.knowhowPolicy\] === true/,
  );
});

test("a mask never reaches past the ink it hides", async () => {
  const contentSource = await readFile(
    new URL("../src/content/capture.js", import.meta.url),
    "utf8",
  );

  // Selecting a text node's collapsed newlines and indentation makes the browser
  // report rectangles that run to the end of the line box.
  assert.match(contentSource, /function inkRange\(node, start, end\)/);
  assert.match(contentSource, /while \(from < to && \/\\s\/\.test\(value\[from\]\)\) from \+= 1;/);
  assert.match(contentSource, /const range = inkRange\(node, finding\.start, finding\.end\)/);
  assert.match(contentSource, /const range = inkRange\(node, 0, value\.length\)/);
  assert.doesNotMatch(contentSource, /selectNodeContents/);
});

test("capture uses primary pointer geometry and keeps the marker editable", async () => {
  const [contentSource, backgroundSource, offscreenSource] = await Promise.all([
    readFile(new URL("../src/content/capture.js", import.meta.url), "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
    readFile(new URL("../src/offscreen/offscreen.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    contentSource,
    /addEventListener\("pointerdown", onPointerDown, true\)/,
  );
  assert.match(
    contentSource,
    /addEventListener\("pointermove", onPointerMove, true\)/,
  );
  assert.match(
    contentSource,
    /addEventListener\("pointercancel", onPointerCancel, true\)/,
  );
  assert.match(contentSource, /addEventListener\("click", onClick, true\)/);
  assert.match(contentSource, /event\.isPrimary === false \|\| event\.button !== 0/);
  assert.match(contentSource, /x: event\.clientX/);
  assert.match(contentSource, /y: event\.clientY/);
  assert.match(contentSource, /Math\.hypot\(/);
  assert.match(contentSource, /if \(event\.detail === 0\)/);
  assert.match(contentSource, /targetRect\.x \+ targetRect\.width \/ 2/);
  assert.match(
    contentSource,
    /scheduleSingleClick\(staged\.element, staged\.context\)/,
  );
  assert.match(contentSource, /addEventListener\("dblclick", onDoubleClick, true\)/);
  assert.match(contentSource, /sourceEvent: "dblclick"/);
  const interactionContextSource = contentSource.slice(
    contentSource.indexOf("function targetContext"),
    contentSource.indexOf("function pageContext"),
  );
  assert.doesNotMatch(interactionContextSource, /collectMasks\(/);
  assert.match(backgroundSource, /\{ documentId: request\.documentId \}/);
  assert.match(backgroundSource, /type: "KNOWHOW_VERIFY_DOCUMENT"/);
  assert.match(backgroundSource, /clickPoint: context\.clickPoint/);
  assert.doesNotMatch(
    backgroundSource,
    /function clickJobIsLatest\(request\)|clickJobMayProceed|rapidInteractionsSkipped/,
  );
  assert.match(backgroundSource, /interactionSequencer\.confirm\(state\.sessionId/);
  assert.match(
    backgroundSource,
    /interactionViewport:\s*context\.interactionViewport \|\| request\.viewport \|\| context\.viewport/,
  );
  assert.match(
    offscreenSource,
    /message\.interactionViewport \|\| message\.viewport/,
  );
  assert.doesNotMatch(offscreenSource, /strokeRect\(/);
  assert.match(offscreenSource, /\{ clickTarget \}/);
});

test("capture photographs the page as it looked when the pointer went down", async () => {
  const [contentSource, backgroundSource] = await Promise.all([
    readFile(new URL("../src/content/capture.js", import.meta.url), "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
  ]);

  // The screenshot is taken early, but the click itself is never intercepted,
  // cancelled, or replayed: dropdowns and menus behave exactly as they would
  // without KnowHow attached.
  assert.doesNotMatch(contentSource, /event\.preventDefault\(\)/);
  assert.doesNotMatch(contentSource, /event\.stopImmediatePropagation\(\)/);
  assert.doesNotMatch(contentSource, /\.element\.click\(\)/);
  assert.match(contentSource, /type: "PREFLIGHT_CAPTURE"/);
  assert.match(
    contentSource,
    /requestPreflightCapture\(element, context\);\s*\}/,
  );
  assert.match(contentSource, /function claimPreflight\(element\)/);
  assert.match(
    contentSource,
    /function emitInteraction\(element, context, options = \{\}\) \{\s+if \(claimPreflight\(element\)\)/,
  );
  // Anything that turns out not to be a click releases the reserved frame.
  const drag = contentSource.slice(
    contentSource.indexOf("function onPointerMove"),
    contentSource.indexOf("function onContextMenu"),
  );
  assert.match(drag, /discardPreflight\(\)/);
  assert.match(contentSource, /type: "PREFLIGHT_DISCARD"/);
  assert.match(backgroundSource, /if \(request\.preflight === true\)/);
  assert.match(backgroundSource, /stash\.generation === generation/);
  // Without a usable pre-click frame the step still lands, photographed after
  // the page paints instead of being dropped.
  assert.match(contentSource, /function emitAfterPaint\(context, options = \{\}\)/);
  assert.match(contentSource, /waitForPagePaint\(\)\.then/);
  assert.match(contentSource, /DOUBLE_CLICK_WINDOW_MS = 260/);
  assert.match(contentSource, /function scheduleSingleClick\(element, context\)/);
  assert.match(contentSource, /function flushPendingSingleClick/);
  assert.match(
    contentSource,
    /pendingSingleClick && pendingSingleClick\.element !== element[\s\S]*flushPendingSingleClick\(\)/,
  );
  assert.match(contentSource, /function onDoubleClick\(event\)/);
  assert.match(contentSource, /title: "Double-click " \+ name/);
  assert.match(contentSource, /function targetName\(element\)/);
  assert.match(contentSource, /const quoted = '"' \+ label\.replace/);
  assert.match(
    backgroundSource,
    /sourceEvent: \["contextmenu", "dblclick"\]\.includes\(message\.sourceEvent\)/,
  );
});

test("the recording flash never leaks into a screenshot and can be turned off", async () => {
  const source = await readFile(
    new URL("../src/content/capture.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /function showRecordingFlash\(label\)/);
  assert.match(
    source,
    /if \(state\.policy\.showRecordingIndicator === false\) return;/,
  );
  assert.match(source, /pointer-events:none/);
  assert.match(
    source,
    /function waitForPagePaint\(\) \{\s+return new Promise\(\(resolve\) =>\s+requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/,
  );
  // The flash is force-removed at every point that immediately precedes a
  // real screenshot, so it can never appear in captured pixels.
  const prepareSlice = source.slice(
    source.indexOf('message?.type === "KNOWHOW_PREPARE_SCREENSHOT"'),
    source.indexOf('message?.type === "KNOWHOW_PREPARE_SCREENSHOT"') + 200,
  );
  assert.match(prepareSlice, /removeRecordingFlash\(\)/);
  const pageContextSlice = source.slice(
    source.indexOf('message?.type === "KNOWHOW_GET_PAGE_CONTEXT"'),
    source.indexOf('message?.type === "KNOWHOW_GET_PAGE_CONTEXT"') + 240,
  );
  assert.match(pageContextSlice, /removeRecordingFlash\(\)/);
  assert.match(prepareSlice, /hideBlurPreviewForCapture\(\)/);
  assert.match(source, /message\?\.type === "KNOWHOW_RESTORE_PRIVACY_PREVIEW"/);
  assert.match(source, /restoreBlurPreviewAfterCapture\(\)/);
  assert.match(source, /let blurPreviewSuspended = false/);
  assert.match(source, /if \(blurPreviewSuspended\) return/);
  assert.match(source, /blurPreviewRestoreTimer = setTimeout/);
});

test("every confirmed rapid click remains eligible for its queued capture job", () => {
  const sequencer = createInteractionSequencer();
  const firstSequence = sequencer.reserve();
  const secondSequence = sequencer.reserve();

  sequencer.confirm("session-a", secondSequence);
  sequencer.confirm("session-a", firstSequence);

  assert.equal(
    sequencer.isLatest({
      sourceEvent: "click",
      sessionId: "session-a",
      interactionSequence: firstSequence,
    }),
    true,
  );
  assert.equal(
    sequencer.isLatest({
      sourceEvent: "click",
      sessionId: "session-a",
      interactionSequence: secondSequence,
    }),
    true,
  );
  assert.equal(
    sequencer.isLatest({ sourceEvent: "navigation", sessionId: "session-a" }),
    true,
  );
});

test("interaction geometry stays normalized to its original viewport", () => {
  const interactionViewport = { width: 800, height: 600 };
  assert.deepEqual(
    normalizedClickTarget(
      { x: 400, y: 150 },
      interactionViewport,
      "#ef6f47",
    ),
    { x: 0.5, y: 0.25, radius: 0.035, color: "#ef6f47" },
  );
  const focusRegion = normalizedFocusRegion(
    { x: 200, y: 120, width: 400, height: 300 },
    interactionViewport,
  );
  assert.equal(focusRegion.x, 0.25);
  assert.equal(focusRegion.y, 0.2);
  assert.equal(focusRegion.width, 0.5);
  assert.ok(Math.abs(focusRegion.height - 0.5) < Number.EPSILON);
});

test("manifest key derives the exact development extension allowlist", async () => {
  const [manifestText, nextSource] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../../next.config.ts", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32);
  const extensionId = Array.from(digest, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  ).join("");

  assert.equal(extensionId, "phbofjenfnnnnndghhinoldlfbpaedpo");
  assert.deepEqual(manifest.externally_connectable, {
    matches: ["http://localhost/*"],
  });
  assert.ok(nextSource.includes('allowedDevOrigins: ["' + extensionId + '"]'));
  assert.doesNotMatch(nextSource, /mdljijkdccpjhbfalkcgpnooffhcnjbb/);
});

test("extension action is configured to open the side panel", async () => {
  const backgroundSource = await readFile(
    new URL("../src/background/index.js", import.meta.url),
    "utf8",
  );
  assert.match(
    backgroundSource,
    /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/,
  );
});
