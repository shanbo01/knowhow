import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backgroundUrl = new URL(
  "../src/background/index.js",
  import.meta.url,
);

async function backgroundSource() {
  return readFile(backgroundUrl, "utf8");
}

function functionSlice(source, startName, nextName) {
  return source.slice(
    source.indexOf("async function " + startName),
    source.indexOf("async function " + nextName),
  );
}

test("start remains preparing through remote setup and seeds step one before capture activates", async () => {
  const source = await backgroundSource();
  const start = functionSlice(source, "startCapture", "resumeCapture");

  assert.ok(start.indexOf("CaptureEvent.START") < start.indexOf("refreshWorkspaceContext()"));
  assert.ok(start.indexOf("beginRemoteCapture(prepared)") < start.indexOf("injectCaptureContent(prepared, policy)"));
  assert.ok(start.indexOf("injectCaptureContent(prepared, policy)") < start.indexOf("CaptureEvent.READY"));
  assert.ok(start.indexOf("CaptureEvent.READY") < start.indexOf("snapshotCaptureJob(recording"));
  const armBlur = start.indexOf("status: CaptureStatus.PAUSED");
  const seed = start.indexOf("captureStep(initialJob, reserveSlot)");
  const activate = start.indexOf("status: CaptureStatus.RECORDING");
  assert.ok(armBlur > -1 && seed > armBlur && activate > seed);
  assert.ok(start.indexOf("injectCaptureContent(prepared, policy)") < armBlur);
  const settle = start.indexOf("KNOWHOW_WAIT_PAGE_SETTLED");
  assert.ok(settle > armBlur && settle < seed);
  assert.match(start, /sourceEvent: "navigation"/);
  assert.match(start, /Navigate to /);
});

test("screenshot capture rejects an A to B to A activation epoch", async () => {
  const source = await backgroundSource();
  const capture = functionSlice(source, "captureVisiblePage", "clickJobMayProceed");

  assert.match(source, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(capture, /windowActivationEpochs\.current\(state\.windowId\)/);
  assert.ok(capture.indexOf("validateActiveCaptureTab") < capture.indexOf("captureVisibleTab"));
  assert.match(
    capture.slice(capture.indexOf("captureVisibleTab")),
    /windowActivationEpochs\.current\(state\.windowId\) !== activationEpoch/,
  );
});

test("rapid clicks stay queued independently instead of dropping older interactions", async () => {
  const source = await backgroundSource();
  assert.match(source, /case "STAGE_INTERACTION"/);
  assert.match(source, /case "COMMIT_INTERACTION"/);
  assert.match(source, /reserveCaptureEntry\(current, \{/);
  assert.match(source, /id: message\.interactionId/);
  assert.match(source, /sequence: stagedEntry\.order/);
  assert.match(
    source,
    /masks: Array\.isArray\(message\.context\?\.masks\)/,
  );
  assert.match(source, /newestEligiblePreparedFrame\(/);
  assert.match(source, /persistTextNavigationStep/);
  assert.match(source, /warmDestinationPreparedFrame/);
  assert.doesNotMatch(
    source,
    /rapidInteractionsSkipped|clickJobIsLatest|clickJobMayProceed|interactionSequencer/,
  );
});

test("the capture rate limit is only spent on real screenshots", async () => {
  const source = await backgroundSource();
  const visible = functionSlice(source, "captureVisiblePage", "captureStep");
  const prepared = functionSlice(source, "processPreparedFrame", "prepareCaptureFrame");

  assert.match(visible, /if \(!\(await reserveSlot\(\)\)\) return null;/);
  assert.ok(
    visible.indexOf("await reserveSlot()") <
      visible.indexOf("validateActiveCaptureTab"),
  );
  assert.ok(
    visible.indexOf("KNOWHOW_PREPARE_SCREENSHOT") <
      visible.indexOf("captureVisibleTab"),
  );
  assert.match(prepared, /type: "KNOWHOW_PROCESS_CAPTURE_FRAME"/);
  assert.match(source, /hideLiveBlur: false/);
  assert.match(source, /deadlineMs: 1_600/);
  assert.match(source, /deadlineMs = 1_200/);
  assert.doesNotMatch(source, /PREFLIGHT_CAPTURE|commitPreflightStep/);
});

test("resume, exclusion, and startup recovery retain exact safe targets", async () => {
  const source = await backgroundSource();
  const resume = functionSlice(source, "resumeCapture", "finishCapture");
  const exclude = functionSlice(source, "excludeCurrentSite", "preparePageContext");

  assert.match(resume, /getOriginalActiveTab\(current, options\)/);
  assert.match(resume, /windowId: beforeResume\.tab\.windowId/);
  assert.match(exclude, /requireCaptureHostAccess\(\)/);
  assert.match(exclude, /getActiveTab\(options\)/);
  assert.match(source, /excludeCurrentSite\(message\.options\)/);
  assert.match(source, /state\.status === CaptureStatus\.PREPARING/);
  assert.match(source, /cleanupRemoteCapture\(state\.remoteCaptureId \|\| state\.sessionId\)/);
});

test("multi-tab capture waits for final URLs and deduplicates new-tab handoffs", async () => {
  const source = await backgroundSource();
  const opened = functionSlice(
    source,
    "followNewTabNavigation",
    "followActiveTabSwitch",
  );
  const switched = functionSlice(
    source,
    "followActiveTabSwitch",
    "captureNavigation",
  );

  assert.match(source, /chrome\.webNavigation\.onCreatedNavigationTarget\.addListener/);
  assert.match(source, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(opened, /latest\.tabId !== details\.sourceTabId/);
  assert.match(opened, /pendingNavigationTargets/);
  assert.doesNotMatch(opened, /chrome\.tabs\.update|chrome\.windows\.update/);
  assert.match(switched, /KNOWHOW_WAKE_SMART_BLUR/);
  assert.ok(
    switched.indexOf("KNOWHOW_WAKE_SMART_BLUR") <
      switched.indexOf("injectCaptureContent"),
  );
  assert.match(switched, /waitForTabComplete\(tabId\)/);
  assert.match(
    switched,
    /chrome\.tabs\.query\(\{\s*active: true,\s*windowId: targetWindowId,\s*\}\)/,
  );
  assert.match(switched, /recordNavigationDestination\(/);
  assert.match(switched, /titleMode: openedTarget \? "new-tab" : "switch"/);
  assert.match(source, /rememberNavigationKey\(latest, stableRecordKey\)/);
});

test("capture follows the author into tabs and windows they open themselves", async () => {
  const source = await backgroundSource();
  const follow = functionSlice(source, "followOwnNewTab", "captureNavigation");
  const navigation = functionSlice(source, "captureNavigation", "handleMessage");
  const transition = functionSlice(
    source,
    "commitNavigationTransition",
    "recordNavigationAttention",
  );
  const switched = functionSlice(source, "followActiveTabSwitch", "followOwnNewTab");

  // A tab opened with Ctrl+T has no opener to follow, so a completed load in the
  // frontmost tab hands the session over instead of being ignored.
  assert.match(navigation, /if \(state\.tabId !== details\.tabId\) \{\s*await followOwnNewTab\(details\.tabId\);/);
  assert.match(follow, /if \(tab\.active !== true\) return;/);
  assert.match(follow, /followActiveTabSwitch\(\{ tabId, windowId: tab\.windowId \}\)/);

  // Following works across windows, and switching sites inside one tab keeps
  // recording with the new origin instead of pausing for a manual resume.
  assert.doesNotMatch(switched, /state\.windowId !== windowId/);
  assert.doesNotMatch(source, /Resume explicitly to continue on the new site/);
  assert.match(transition, /origin: verdict\.origin/);

  // A job queued before the page moved on is dropped, not photographed against
  // the wrong site and not turned into a pause the author has to clear.
  const step = functionSlice(source, "captureStep", "waitForTabComplete");
  assert.match(step, /if \(verdict\.origin !== activeVerdict\.origin\) return false;/);
  assert.match(
    source,
    /if \(verdict\.sanitizedUrl !== expectedSanitizedUrl\) \{/,
  );
  assert.match(source, /chrome\.windows\.onFocusChanged\.addListener/);
  assert.match(source, /windowId === chrome\.windows\.WINDOW_ID_NONE/);

  // The panel names the site being recorded, so a hand-off renames the scope.
  assert.match(source, /function scopeLabelForHost\(state, hostname\)/);
  assert.match(switched, /scopeLabel: scopeLabelForHost\(latest, verdict\.hostname\)/);
  assert.match(transition, /scopeLabel: scopeLabelForHost\(latest, verdict\.hostname\)/);
  assert.match(source, /chrome\.webNavigation\.onCommitted\.addListener/);
  assert.match(source, /activeDocumentId: details\.documentId \|\| null/);
});

test("retry focuses the original tab and recaptures the current page", async () => {
  const source = await backgroundSource();
  const retry = functionSlice(
    source,
    "retryCaptureEntry",
    "deleteCaptureEntryFromFeed",
  );

  assert.match(retry, /chrome\.tabs\.get\(entry\.tabId\)/);
  assert.match(retry, /chrome\.tabs\.update\(entry\.tabId, \{ active: true \}\)/);
  assert.match(retry, /That tab was closed/);
  assert.match(retry, /hideLiveBlur: false/);
  assert.doesNotMatch(source, /newestSameTabPreparedFrame\(/);
  assert.match(source, /autoRetryNeedsAttentionOnTab\(tabId\)/);
  assert.doesNotMatch(
    retry,
    /Return to the original page before retrying/,
  );
  assert.doesNotMatch(
    retry,
    /activeNavigationKey !== entry\.navigationKey/,
  );
});
