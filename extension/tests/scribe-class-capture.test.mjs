import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sanitizeCaptureUrl } from "../src/core/policy.js";
import {
  clickEntryNeedsSettledFrame,
  lastClickCaptureEntry,
  initializeCaptureCoordinator,
  reserveCaptureEntry,
  shouldMintNavigationStep,
  updateCaptureEntry,
} from "../src/core/capture-coordinator.js";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

async function readSource(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "e2e") continue;
      files.push(...(await collectSourceFiles(absolute)));
      continue;
    }
    if (!/\.(js|mjs|css|html|json)$/.test(extname(entry.name))) continue;
    files.push(absolute);
  }
  return files;
}

test("same-tab SPA never mints Open; a delayed click still gets one extra frame", () => {
  assert.equal(shouldMintNavigationStep("navigation"), false);
  assert.equal(shouldMintNavigationStep("new-tab"), true);

  let state = initializeCaptureCoordinator({
    status: "recording",
    sessionId: "session-a",
    acceptingEvents: true,
  }, 1_000);
  state = reserveCaptureEntry(state, {
    id: "click-home",
    stepId: "step-click",
    sourceEvent: "click",
    tabId: 4,
  }, 1_100);
  assert.equal(lastClickCaptureEntry(state).id, "click-home");
  assert.equal(clickEntryNeedsSettledFrame(state, { tabId: 4 }), true);

  state = updateCaptureEntry(state, "click-home", {
    additionalFrameId: "settled-click-home",
  }, 8_000);
  assert.equal(
    state.captureEntries.some((entry) => entry.sourceEvent === "navigation"),
    false,
  );
  assert.equal(state.captureEntries.length, 1);
  assert.equal(
    lastClickCaptureEntry(state).additionalFrameId,
    "settled-click-home",
  );
});

test("Navigate labels keep origin, port, and route slugs without token redaction", () => {
  assert.equal(
    sanitizeCaptureUrl("http://localhost:3001/w/helpdesk-ac3fe?x=1#y"),
    "http://localhost:3001/w/helpdesk-ac3fe",
  );
  assert.equal(
    sanitizeCaptureUrl(
      "https://example.com/tokens/0123456789abcdef0123456789abcdef",
    ),
    "https://example.com/tokens/0123456789abcdef0123456789abcdef",
  );
});

test("capture hides live blur before click JPEGs and bakes ink-tight privacy samples", async () => {
  const [contentSource, backgroundSource, offscreenSource, geometrySource] =
    await Promise.all([
      readSource("../src/content/capture.js"),
      readSource("../src/background/index.js"),
      readSource("../src/offscreen/offscreen.js"),
      readSource("../src/content/blur-geometry.js"),
    ]);

  const hideSlice = contentSource.slice(
    contentSource.indexOf("function hideBlurPreviewForCapture"),
    contentSource.indexOf("function restoreBlurPreviewAfterCapture"),
  );
  assert.match(hideSlice, /blurPreviewRoot\.style\.visibility = "hidden"/);
  assert.doesNotMatch(hideSlice, /removeBlurPreview\(\)/);
  assert.doesNotMatch(hideSlice, /renderBlurPreview\(\{ reveal: false \}\)/);

  const restoreSlice = contentSource.slice(
    contentSource.indexOf("function restoreBlurPreviewAfterCapture"),
    contentSource.indexOf("function labelFor"),
  );
  assert.doesNotMatch(restoreSlice, /scheduleBlurPreview/);

  const stageSlice = contentSource.slice(
    contentSource.indexOf("function stageInteraction"),
    contentSource.indexOf("function commitStagedInteraction"),
  );
  assert.doesNotMatch(stageSlice, /collectMasks\(\)/);
  assert.match(stageSlice, /lastSerializableMasks/);
  assert.ok(
    stageSlice.indexOf("hideCaptureChrome()") <
      stageSlice.indexOf("STAGE_INTERACTION"),
    "the capturing card must be reserved without a mask walk",
  );

  const visibleSlice = backgroundSource.slice(
    backgroundSource.indexOf("async function captureVisiblePage"),
    backgroundSource.indexOf("async function captureStep"),
  );
  assert.ok(
    visibleSlice.indexOf("KNOWHOW_PREPARE_SCREENSHOT") <
      visibleSlice.indexOf("captureVisibleTab"),
    "live overlays must be hidden before captureVisibleTab",
  );
  assert.match(visibleSlice, /hideLiveBlur/);
  assert.match(backgroundSource, /hideLiveBlur: false/);

  const fallbackSlice = backgroundSource.slice(
    backgroundSource.indexOf("async function captureFallbackFrame"),
    backgroundSource.indexOf("async function finalizeInteractionEntry"),
  );
  assert.match(fallbackSlice, /deadlineMs = 1_200/);
  assert.match(fallbackSlice, /deadlineRequired: true/);
  assert.doesNotMatch(fallbackSlice, /visualEpoch !== entry\.visualEpoch/);
  assert.doesNotMatch(
    fallbackSlice,
    /No clean pre-action screenshot was ready\. Hover over the control/,
  );

  assert.match(offscreenSource, /geometry\.privacySampleSize/);
  assert.match(offscreenSource, /const halo = 0/);
  assert.match(geometrySource, /padding: 1/);
  assert.match(contentSource, /padding: 1/);
});

test("pointerdown stages without a hover frame and same-tab nav attaches an extra JPEG", async () => {
  const [contentSource, backgroundSource] = await Promise.all([
    readSource("../src/content/capture.js"),
    readSource("../src/background/index.js"),
  ]);

  const pointerSlice = contentSource.slice(
    contentSource.indexOf("function onPointerDown"),
    contentSource.indexOf("function onPointerMove"),
  );
  assert.match(pointerSlice, /stageInteraction\(element, context, sourceEvent\)/);

  const recordSlice = backgroundSource.slice(
    backgroundSource.indexOf("async function recordNavigationDestination"),
    backgroundSource.indexOf("async function captureNavigation"),
  );
  assert.match(recordSlice, /shouldMintNavigationStep\(titleMode\)/);
  assert.match(recordSlice, /attachSettledFrameToLastClick\(details\)/);
  assert.match(recordSlice, /shouldDropTrailingTabSwitch/);
  assert.match(recordSlice, /Open \$\{pageTitle\} in a new tab/);
  assert.match(recordSlice, /persistTextNavigationStep/);
  assert.match(recordSlice, /warmDestinationPreparedFrame/);
  assert.match(recordSlice, /switchNavigationCopy\(pageTitle\)/);
  assert.doesNotMatch(
    recordSlice,
    /shouldAbsorbClickNavigation/,
  );

  assert.match(backgroundSource, /additionalFrameId: frameId/);
  assert.match(contentSource, /KNOWHOW_CAPTURE_SETTLED_FRAME/);
  assert.match(contentSource, /__KNOWHOW_PAGE_SETTLED__/);
  assert.match(backgroundSource, /CONTENT_SETTLED_PATH/);
});

test("step copy uses named quotes, nameless kinds, and select upgrades", async () => {
  const [contentSource, backgroundSource] = await Promise.all([
    readSource("../src/content/capture.js"),
    readSource("../src/background/index.js"),
  ]);

  assert.match(contentSource, /return "this button"/);
  assert.match(contentSource, /return "this link"/);
  assert.match(contentSource, /return "here"/);
  assert.match(contentSource, /Select the " \+ quoted \+ " option/);
  assert.match(contentSource, /sourceEvent: "select"/);
  assert.match(backgroundSource, /message\.sourceEvent === "select"/);
  assert.doesNotMatch(contentSource, /the highlighted /);
});

test("the tree does not import Scribe internals", async () => {
  const files = await collectSourceFiles(join(extensionRoot, "src"));
  files.push(join(extensionRoot, "manifest.json"));
  const forbidden = /data-scribe-|html2canvas|@medv\/finder|surroundContents/;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, forbidden, file);
  }
});
