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
  assert.equal(policyControls.length, 12);
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
  const policyFlow = source.slice(
    source.indexOf("async function flushPolicySave()"),
    source.indexOf("function setPairingFormVisible"),
  );

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

test("connection and pairing controls lock for the whole capture lifecycle", async () => {
  const source = await readFile(popupSourceUrl, "utf8");
  const lifecycle = source.slice(
    source.indexOf("function captureLifecycleLocksConnection()"),
    source.indexOf("function policySavePending()"),
  );
  for (const status of [
    "preparing",
    "recording",
    "paused",
    "reviewing",
    "uploading",
  ]) {
    assert.match(lifecycle, new RegExp(`"${status}"`));
  }

  const controls = source.slice(
    source.indexOf("function syncConnectionControls()"),
    source.indexOf("function beginCaptureAction()"),
  );
  assert.match(controls, /elements\.connectButton\.hidden = locked/);
  assert.match(controls, /elements\.connectButton\.disabled = locked \|\| pairingPending/);
  assert.match(controls, /if \(locked\) elements\.pairingForm\.hidden = true/);
  assert.match(source, /if \(captureLifecycleLocksConnection\(\) \|\| pairingPending\) return/);
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
