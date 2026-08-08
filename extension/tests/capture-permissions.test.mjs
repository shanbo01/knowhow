import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("website capture access is optional and requested from Start", async () => {
  const [manifestText, popupSource] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.deepEqual(manifest.host_permissions, ["http://localhost/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
  assert.match(
    popupSource,
    /chrome\.permissions\.request\(captureAccess\)/,
  );
  assert.match(popupSource, /if \(!granted\)/);
  assert.match(popupSource, /select Allow in Chrome/i);

  const startHandler = popupSource.slice(
    popupSource.indexOf('elements.startForm.addEventListener("submit"'),
    popupSource.indexOf('elements.pauseButton.addEventListener("click"'),
  );
  assert.ok(startHandler.indexOf("await requestCaptureAccess()") >= 0);
  assert.ok(
    startHandler.indexOf("beginCaptureAction()") <
      startHandler.indexOf("await requestCaptureAccess()"),
  );
  assert.ok(
    startHandler.indexOf("await requestCaptureAccess()") <
      startHandler.indexOf('type: "START_CAPTURE"'),
  );
  assert.match(startHandler, /const captureTarget = await getSelectedContentTab\(\)/);
  assert.match(startHandler, /\.\.\.captureTarget/);
  assert.match(startHandler, /finally \{\s*endCaptureAction\(\);/);
});

test("Resume renews access and pins capture to the selected tab", async () => {
  const popupSource = await readFile(
    new URL("../src/popup/popup.js", import.meta.url),
    "utf8",
  );
  const resumeHandler = popupSource.slice(
    popupSource.indexOf('elements.pauseButton.addEventListener("click"'),
    popupSource.indexOf('elements.finishButton.addEventListener("click"'),
  );

  assert.match(resumeHandler, /if \(resuming\) \{/);
  assert.match(resumeHandler, /await requestCaptureAccess\(\)/);
  assert.match(resumeHandler, /await getSelectedContentTab\(\)/);
  assert.match(resumeHandler, /options: captureTarget/);
  assert.match(resumeHandler, /finally \{\s*endCaptureAction\(\);/);
});

test("Exclude requests access from its click and locks the exact selected tab", async () => {
  const popupSource = await readFile(
    new URL("../src/popup/popup.js", import.meta.url),
    "utf8",
  );
  const excludeHandler = popupSource.slice(
    popupSource.indexOf('elements.excludeButton.addEventListener("click"'),
    popupSource.indexOf("async function savePolicy"),
  );

  const lock = excludeHandler.indexOf("beginCaptureAction()");
  const permission = excludeHandler.indexOf("await requestCaptureAccess()");
  const selectedTab = excludeHandler.indexOf("await getSelectedContentTab()");
  const excludeRequest = excludeHandler.indexOf('type: "EXCLUDE_CURRENT_SITE"');
  assert.ok(lock >= 0 && lock < permission);
  assert.ok(permission < selectedTab && selectedTab < excludeRequest);
  assert.match(excludeHandler, /options: captureTarget/);
  assert.match(excludeHandler, /finally \{\s*endCaptureAction\(\);/);
});

test("one synchronous lock disables every conflicting capture action", async () => {
  const popupSource = await readFile(
    new URL("../src/popup/popup.js", import.meta.url),
    "utf8",
  );
  const controls = popupSource.slice(
    popupSource.indexOf("function syncCaptureActionControls()"),
    popupSource.indexOf("async function refreshCapture()"),
  );

  for (const control of [
    "startButton",
    "pauseButton",
    "finishButton",
    "discardButton",
    "reviewDiscardButton",
  ]) {
    assert.match(controls, new RegExp(`elements\\.${control}\\.disabled`));
  }
  assert.match(
    controls,
    /function beginCaptureAction\(\)[\s\S]*captureActionPending = true;[\s\S]*syncCaptureActionControls\(\);/,
  );

  for (const marker of [
    'elements.startForm.addEventListener("submit"',
    'elements.pauseButton.addEventListener("click"',
    'elements.finishButton.addEventListener("click"',
    "async function discard()",
  ]) {
    const handler = popupSource.slice(
      popupSource.indexOf(marker),
      popupSource.indexOf("\n});", popupSource.indexOf(marker)) + 4,
    );
    assert.match(handler, /if \(!beginCaptureAction\(\)\) return;/);
  }
});

test("background validates access, tab identity, and readable HTTP URLs", async () => {
  const backgroundSource = await readFile(
    new URL("../src/background/index.js", import.meta.url),
    "utf8",
  );

  assert.match(
    backgroundSource,
    /chrome\.permissions\.contains\(captureHostAccess\)/,
  );
  assert.match(backgroundSource, /chrome\.tabs\.get\(target\.tabId\)/);
  assert.match(backgroundSource, /tab\.windowId !== target\.windowId \|\| !tab\.active/);
  assert.match(backgroundSource, /could not read this page's URL/i);
  assert.match(backgroundSource, /regular HTTP and HTTPS websites only/i);
  assert.match(
    backgroundSource,
    /resumeCapture\(message\.options\)/,
  );
  assert.match(backgroundSource, /Chrome removed KnowHow's website access/i);
});

test("build permits only an optional all-sites capture grant", async () => {
  const buildSource = await readFile(
    new URL("../scripts/build.mjs", import.meta.url),
    "utf8",
  );

  assert.match(buildSource, /manifest\.host_permissions\?\.includes\("<all_urls>"\)/);
  assert.match(
    buildSource,
    /manifest\.optional_host_permissions \|\| \[\]/,
  );
  assert.match(buildSource, /Static <all_urls> content injection is prohibited/);
});
