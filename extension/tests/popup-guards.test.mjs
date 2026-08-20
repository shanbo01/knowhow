import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const popupSourceUrl = new URL("../src/popup/popup.js", import.meta.url);
const popupHtmlUrl = new URL("../src/popup/popup.html", import.meta.url);

test("capture cannot start before connection, state, and policy initialization", async () => {
  const [source, html] = await Promise.all([
    readFile(popupSourceUrl, "utf8"),
    readFile(popupHtmlUrl, "utf8"),
  ]);
  const controls = source.slice(
    source.indexOf("function syncCaptureActionControls()"),
    source.indexOf("function syncConnectionControls()"),
  );

  assert.match(html, /id="start-button"[^>]*disabled/);
  const policyControls = [...html.matchAll(/<input[^>]*data-policy(?:=|-color)[^>]*>/g)];
  assert.equal(policyControls.length, 13);
  assert.ok(policyControls.every(([input]) => /\bdisabled\b/.test(input)));
  assert.match(controls, /!captureInitialized/);
  assert.match(controls, /!connectionInitialized/);
  assert.match(controls, /!currentPolicy/);
  assert.match(controls, /policySavePending\(\)/);
  assert.match(source, /captureInitialized = true;[\s\S]*renderState\(capture\.state, capture\.policy\)/);
  assert.match(source, /connectionInitialized = true;[\s\S]*renderConnection\(\)/);
});

test("privacy saves are debounced, serialized, and rolled back after failure", async () => {
  const source = await readFile(popupSourceUrl, "utf8");
  const policyFlow = source.slice(source.indexOf("async function flushPolicySave()"));

  assert.match(policyFlow, /if \(policySaveInFlight \|\| !policySaveDraft\) return/);
  assert.match(policyFlow, /policySaveInFlight = true/);
  assert.match(policyFlow, /type: "UPDATE_CAPTURE_POLICY"/);
  assert.match(policyFlow, /if \(policySaveDraft\) \{\s*await flushPolicySave\(\)/);
  assert.match(policyFlow, /setTimeout\([\s\S]*flushPolicySave\(\)[\s\S]*140/);
  assert.match(policyFlow, /if \(policySaveTimer\) clearTimeout\(policySaveTimer\)/);
  assert.match(policyFlow, /await refreshCapture\(\)/);
  assert.match(policyFlow, /applyPolicyControls\(currentPolicy \|\| \{\}\)/);
  assert.match(policyFlow, /previous settings were restored/i);
});

test("the side panel uses the signed-in app companion instead of a pairing-code form", async () => {
  const [source, html, background, manifestText] = await Promise.all([
    readFile(popupSourceUrl, "utf8"),
    readFile(popupHtmlUrl, "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.doesNotMatch(html, /pairing-code|pairing-form/i);
  assert.match(source, /chrome\.tabs\.create\(\{ url: KNOWHOW_ORIGIN \}\)/);
  assert.match(source, /STORAGE_KEYS\.companion/);
  assert.match(source, /function applySharedTheme\(\)/);
  assert.match(source, /currentCompanion\?\.theme/);
  assert.match(background, /chrome\.runtime\.onMessageExternal\.addListener/);
  assert.match(background, /case "KNOWHOW_WEB_CONNECT":/);
  assert.match(background, /case "KNOWHOW_WEB_SYNC":/);
  assert.deepEqual(manifest.externally_connectable.matches, ["http://localhost/*"]);
});

test("guide follow mode, search, Smart Blur, and per-step deletion are wired", async () => {
  const [source, html] = await Promise.all([
    readFile(popupSourceUrl, "utf8"),
    readFile(popupHtmlUrl, "utf8"),
  ]);

  assert.match(html, /id="guide-search"/);
  assert.match(html, /id="guide-follow"/);
  assert.match(html, /data-policy="smartBlurEnabled"/);
  assert.match(source, /function renderGuideLibrary\(\)/);
  assert.match(source, /searchable\.includes\(query\)/);
  assert.match(source, /type: "DELETE_CAPTURED_STEP"/);
  assert.match(source, /className = "step-delete"/);
  assert.match(html, /id="blur-panel-button"/);
  assert.match(source, /elements\.privacySettings\.hidden = true/);
  assert.match(source, /type: "TOGGLE_SMART_BLUR_PANEL"/);
});

test("the feedback preview mirrors the updated header and provides navigable sample guides", async () => {
  const [source, html, css, background, bridge] = await Promise.all([
    readFile(popupSourceUrl, "utf8"),
    readFile(popupHtmlUrl, "utf8"),
    readFile(new URL("../src/popup/popup.css", import.meta.url), "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
    readFile(new URL("../../lib/extension-bridge.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(html, /id="status-card"/);
  assert.match(html, /id="connect-button" class="brand brand-button"/);
  assert.match(html, /id="user-name"/);
  assert.match(html, /class="record-button-dot"/);
  assert.match(css, /\.start-button \{[^}]*font-size: 14px/);
  assert.match(css, /\.record-button-dot \{[^}]*background: #ef4444/);
  assert.match(css, /--background: #f5f4f0/);
  assert.match(css, /:root\[data-theme="dark"\] \{[\s\S]*--background: #0e0e0c;[\s\S]*--card: #171714/);
  assert.match(source, /function previewCompanion\(\)/);
  assert.match(source, /function previewScreenshotSvg\(/);
  assert.match(source, /function previewCapturedSteps\(\)/);
  assert.match(source, /previewDataUrl: previewScreenshotDataUrl/);
  assert.match(source, /renderStepFeed\(previewState, previewCapturedSteps\(\)\)/);
  assert.match(source, /function initializePreview\(\)/);
  assert.match(source, /userName: "Jordan Lee"/);
  assert.match(source, /setActivePanel\("capture"\)/);
  assert.match(source, /if \(!extensionRuntimeAvailable\) \{\s*renderState\(\s*\{ \.\.\.currentState, status: resuming \? "recording" : "paused" \}/);
  assert.match(source, /smartBlurEnabled: currentPolicy\?\.smartBlurEnabled !== true/);
  assert.match(source, /if \(!extensionRuntimeAvailable\) \{\s*renderState\(\{ \.\.\.currentState, status: "reviewing" \}/);
  assert.match(background, /const userName = boundedCompanionText\(value\?\.userName, 240\)/);
  assert.match(bridge, /userName: string/);
});

test("uploading locks destructive review actions", async () => {
  const source = await readFile(popupSourceUrl, "utf8");
  const controls = source.slice(
    source.indexOf("function syncCaptureActionControls()"),
    source.indexOf("function syncConnectionControls()"),
  );

  assert.match(controls, /elements\.reviewDiscardButton\.disabled =\s*captureActionPending \|\| status !== "reviewing"/);
  assert.match(controls, /elements\.openReviewButton\.disabled =\s*captureActionPending \|\| status !== "reviewing"/);
});

test("retry upload only fires while reviewing (a failed upload) and delegates to the background service worker", async () => {
  const source = await readFile(popupSourceUrl, "utf8");
  const retry = source.slice(
    source.indexOf('elements.openReviewButton.addEventListener("click"'),
    source.indexOf('elements.excludeButton.addEventListener("click"'),
  );

  assert.match(retry, /currentState\?\.status !== "reviewing"/);
  assert.match(retry, /type: "RETRY_DRAFT_UPLOAD"/);
  assert.doesNotMatch(source, /openOrFocusReview\(/);
  assert.doesNotMatch(source, /review\.html/);
});
