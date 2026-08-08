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
  assert.ok(start.indexOf("captureStep(initialJob)") < start.indexOf('type: "KNOWHOW_SET_STATUS"'));
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

test("rapid-click freshness ends after the visible screenshot is known safe", async () => {
  const source = await backgroundSource();
  const capture = functionSlice(source, "captureStep", "captureNavigation");
  const safelyCapturedAt = capture.indexOf("const captured = await captureVisiblePage(");
  const processingTail = capture.slice(safelyCapturedAt);

  assert.ok(safelyCapturedAt > 0);
  assert.doesNotMatch(processingTail, /clickJobMayProceed/);
  assert.match(processingTail, /withCapturedStep\(latest, stepId\)/);
  assert.match(source, /rapidInteractionsSkipped/);
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
