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

test("click points project through the visual viewport when present", () => {
  assert.deepEqual(
    normalizedClickTarget(
      { x: 200, y: 140 },
      {
        width: 1280,
        height: 720,
        visualViewport: {
          offsetX: 80,
          offsetY: 40,
          width: 640,
          height: 360,
          scale: 2,
        },
      },
      "#ef6f47",
    ),
    {
      x: 120 / 640,
      y: 100 / 360,
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
  await import("../src/content/blur-geometry.js");
  const geometry = globalThis.__KNOWHOW_BLUR_GEOMETRY__;
  return {
    mergedMasks: (masks) => geometry.normalizeAndMergeMasks(masks, viewport),
  };
}

test("live blur covers the detected text and nothing else", async () => {
  const { mergedMasks } = await maskGeometry();

  // Rectangles from one line of text join into a single calm panel.
  const line = mergedMasks([
    { x: 100, y: 100, width: 60, height: 16, reason: "email" },
    { x: 164, y: 100, width: 40, height: 16, reason: "email" },
  ]);
  assert.equal(line.length, 1);
  assert.equal(line[0].x, 99);
  assert.equal(line[0].width, 106);

  // Two short lines in a tall container stay separate: merging them would cover
  // the blank space to the right of the shorter line.
  const stacked = mergedMasks([
    { x: 100, y: 100, width: 180, height: 15, reason: "common-name" },
    { x: 100, y: 122, width: 40, height: 15, reason: "common-name" },
  ]);
  assert.equal(stacked.length, 2);
  assert.ok(stacked.every((mask) => mask.width <= 192));

  // Overlapping rectangles reported for the same control still collapse.
  const overlapping = mergedMasks([
    { x: 100, y: 100, width: 200, height: 30, reason: "form-field" },
    { x: 140, y: 104, width: 60, height: 22, reason: "form-field" },
  ]);
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].width, 202);

  const splitHosts = mergedMasks([
    { x: 100, y: 100, width: 60, height: 16, reason: "email", host: "span-a" },
    { x: 164, y: 100, width: 40, height: 16, reason: "email", host: "span-b" },
  ]);
  assert.equal(splitHosts.length, 2);

  const sameHost = mergedMasks([
    { x: 100, y: 100, width: 60, height: 16, reason: "email", host: "span-a" },
    { x: 150, y: 100, width: 40, height: 16, reason: "email", host: "span-a" },
  ]);
  assert.equal(sameHost.length, 1);
  assert.equal(sameHost[0].host, "span-a");

  // Slivers and hostless rectangles scrolled out of the viewport never paint.
  assert.deepEqual(
    mergedMasks([
      { x: 10, y: 10, width: 0.5, height: 12, reason: "number" },
      { x: 10, y: 900, width: 120, height: 12, reason: "number" },
    ]),
    [],
  );

  const belowFoldHost = mergedMasks([
    {
      x: 20,
      y: 1200,
      width: 180,
      height: 16,
      reason: "common-name",
      host: "span-offscreen",
    },
  ]);
  assert.equal(belowFoldHost.length, 1);
  assert.equal(belowFoldHost[0].host, "span-offscreen");
  assert.ok(belowFoldHost[0].y > 800);
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
    /input\.checked = policySwitchIsOn\(input\.dataset\.knowhowPolicy\)/,
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
  assert.match(contentSource, /event\.isPrimary === false \|\| !\[0, 2\]\.includes\(event\.button\)/);
  assert.match(contentSource, /x: event\.clientX/);
  assert.match(contentSource, /y: event\.clientY/);
  assert.match(contentSource, /Math\.hypot\(/);
  assert.match(contentSource, /if \(event\.detail === 0\)/);
  assert.match(contentSource, /targetRect\.x \+ targetRect\.width \/ 2/);
  assert.match(
    contentSource,
    /commitStagedInteraction\(staged\)/,
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
  assert.match(backgroundSource, /reserveCaptureEntry\(current, \{/);
  assert.match(backgroundSource, /case "UPGRADE_INTERACTION"/);
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

test("capture reserves a prepared pre-action frame without delaying the click", async () => {
  const [contentSource, backgroundSource] = await Promise.all([
    readFile(new URL("../src/content/capture.js", import.meta.url), "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
  ]);

  // Ordinary recording never replays a click. Preventing page actions is scoped
  // to the explicit element-picker branch.
  assert.doesNotMatch(contentSource, /\.element\.click\(\)/);
  assert.match(contentSource, /function claimPreparedFrame\(\)/);
  assert.match(contentSource, /type: "STAGE_INTERACTION"/);
  assert.match(contentSource, /frameId = claimPreparedFrame\(\)/);
  assert.match(contentSource, /lastSerializableMasks/);
  const stageSource = contentSource.slice(
    contentSource.indexOf("function stageInteraction"),
    contentSource.indexOf("function commitStagedInteraction"),
  );
  assert.doesNotMatch(stageSource, /collectMasks\(\)/);
  assert.match(stageSource, /lastSerializableMasks/);
  assert.ok(
    stageSource.indexOf("hideCaptureChrome()") <
      stageSource.indexOf("STAGE_INTERACTION"),
    "live overlays hide before STAGE, but STAGE must not wait on collectMasks",
  );
  assert.match(contentSource, /type: "COMMIT_INTERACTION"/);
  const commitSource = contentSource.slice(
    contentSource.indexOf("function commitStagedInteraction"),
    contentSource.indexOf("function cancelStagedInteraction"),
  );
  assert.ok(
    commitSource.indexOf("void send(commit)") <
      commitSource.indexOf("staged.stagePromise.then"),
    "COMMIT must leave the trusted click handler before STAGE acknowledgement",
  );
  assert.match(commitSource, /return send\(commit\)/);
  // Anything that turns out not to be a click releases the reserved frame.
  const drag = contentSource.slice(
    contentSource.indexOf("function onPointerMove"),
    contentSource.indexOf("function onContextMenu"),
  );
  assert.match(drag, /cancelStagedInteraction\(active\)/);
  assert.match(contentSource, /type: "CANCEL_INTERACTION"/);
  assert.match(backgroundSource, /deadlineRequired: false/);
  assert.doesNotMatch(backgroundSource, /deadlineRequired: true/);
  assert.doesNotMatch(backgroundSource, /verified\.visualEpoch !== visualEpoch/);
  assert.match(backgroundSource, /keepOnNavigation: true/);
  assert.match(backgroundSource, /ignoreVisualEpoch: Boolean\(message\.frameId\)/);
  assert.match(backgroundSource, /if \(entry\.frameId\) return/);
  assert.match(backgroundSource, /markCaptureEntryFailed/);
  assert.match(contentSource, /function refreshLiveBlur\(\)/);
  assert.match(contentSource, /function frameIsClaimable\(/);
  assert.match(
    contentSource,
    /find\(\(candidate\) => frameIsEligible\(candidate\)\)/,
  );
  assert.match(
    contentSource,
    /find\(\(candidate\) => frameIsClaimable\(candidate\)\)/,
  );
  assert.match(
    contentSource,
    /else if \(pageChanged\) \{\s*scheduleBlurPreview\(liveOverlayScrolling \? 80 : 48\);/,
  );
  assert.match(contentSource, /redactIds: false/);
  assert.match(contentSource, /redactAllNumbers: false/);
  assert.match(contentSource, /redactCommonNames: false/);
  assert.match(contentSource, /DOUBLE_CLICK_WINDOW_MS = 420/);
  assert.doesNotMatch(contentSource, /scheduleSingleClick|flushPendingSingleClick/);
  assert.match(contentSource, /function onDoubleClick\(event\)/);
  assert.match(contentSource, /title: "Double-click " \+ name/);
  assert.match(contentSource, /function targetName\(element\)/);
  assert.match(contentSource, /const quoted = '"' \+ label\.replace/);
  assert.match(contentSource, /return "this button"/);
  assert.match(contentSource, /Select the " \+ quoted \+ " option/);
  assert.match(
    backgroundSource,
    /case "UPGRADE_INTERACTION"/,
  );
  assert.doesNotMatch(contentSource, /PREFLIGHT_CAPTURE|PREFLIGHT_DISCARD/);
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
  assert.match(source, /requestAnimationFrame\(\(\) => requestAnimationFrame\(finish\)\)/);
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
  const preparePrivateSlice = source.slice(
    source.indexOf("async function preparePrivateFrame()"),
    source.indexOf("function startBlurPreviewTracking()"),
  );
  assert.match(preparePrivateSlice, /removeRecordingFlash\(\)/);
  assert.doesNotMatch(preparePrivateSlice, /hideBlurPreviewForCapture\(\)/);
  assert.match(preparePrivateSlice, /waitForPagePaint\(\)/);
  assert.doesNotMatch(preparePrivateSlice, /restoreBlurPreviewAfterCapture\(\)/);
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
