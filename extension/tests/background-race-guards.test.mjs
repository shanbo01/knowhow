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

test("capture policy reads and mutations share one serialized queue", async () => {
  const source = await backgroundSource();
  const getLocal = functionSlice(
    source,
    "getLocalCapturePolicy",
    "getStoredWorkspaceContext",
  );
  const setPolicy = functionSlice(
    source,
    "setCapturePolicy",
    "addExcludedSite",
  );
  const addExclusion = functionSlice(
    source,
    "addExcludedSite",
    "updateCapturePolicy",
  );
  const exclude = functionSlice(
    source,
    "excludeCurrentSite",
    "preparePageContext",
  );

  assert.match(source, /let capturePolicyMutationQueue = Promise\.resolve\(\)/);
  assert.match(getLocal, /withCapturePolicyMutation/);
  assert.match(setPolicy, /withCapturePolicyMutation/);
  assert.match(setPolicy, /readLocalCapturePolicy\(\)/);
  assert.match(addExclusion, /withCapturePolicyMutation/);
  assert.match(addExclusion, /\.\.\.current\.excludedSites/);
  assert.match(exclude, /addExcludedSite\(hostname\)/);
  assert.doesNotMatch(exclude, /getLocalCapturePolicy\(\)/);
});

test("capture startup freezes policy under the state guard and updates reject active sessions", async () => {
  const source = await backgroundSource();
  const start = functionSlice(source, "startCapture", "resumeCapture");
  const update = functionSlice(
    source,
    "updateCapturePolicy",
    "safeCaptureText",
  );

  assert.ok(
    start.indexOf("const preparing = await withStateMutation") <
      start.indexOf("getCapturePolicy()"),
  );
  assert.match(update, /withStateMutation/);
  assert.ok(
    update.indexOf("connectableCaptureStatuses.has(state.status)") <
      update.indexOf("setCapturePolicy(patch)"),
  );
  assert.match(
    source.slice(source.indexOf('case "UPDATE_CAPTURE_POLICY"')),
    /updateCapturePolicy\(message\.policy \|\| \{\}\)/,
  );
});

test("pairing and discard honor capture lifecycle boundaries", async () => {
  const source = await backgroundSource();
  const connect = functionSlice(
    source,
    "connectRivet",
    "excludeCurrentSite",
  );
  const discard = functionSlice(
    source,
    "discardCapture",
    "connectRivet",
  );

  assert.match(
    source,
    /connectableCaptureStatuses = new Set\(\[\s*CaptureStatus\.IDLE,\s*CaptureStatus\.COMPLETED,\s*CaptureStatus\.ERROR,/,
  );
  assert.match(connect, /withStateMutation/);
  assert.ok(
    connect.indexOf("connectableCaptureStatuses.has(state.status)") <
      connect.indexOf("beginRivetPairing(code)"),
  );
  assert.match(discard, /current\.status === CaptureStatus\.UPLOADING/);
  assert.ok(
    discard.indexOf("current.status === CaptureStatus.UPLOADING") <
      discard.indexOf("CaptureEvent.DISCARD"),
  );
  assert.match(
    source,
    /state\.status === CaptureStatus\.UPLOADING[\s\S]*Browser startup interrupted the draft upload/,
  );
});

test("finish reuses and focuses an existing review tab for its session", async () => {
  const source = await backgroundSource();
  const openReview = functionSlice(
    source,
    "openOrFocusReviewTab",
    "finishCapture",
  );
  const finish = functionSlice(source, "finishCapture", "discardCapture");

  assert.match(openReview, /withReviewTabMutation/);
  assert.match(openReview, /chrome\.tabs\.query\(\{\}\)/);
  assert.match(openReview, /reviewTabHasSession/);
  assert.match(openReview, /chrome\.tabs\.update\(existing\.id/);
  assert.match(openReview, /chrome\.windows/);
  assert.match(openReview, /chrome\.tabs\.create\(\{ url \}\)/);
  assert.match(finish, /openOrFocusReviewTab\(reviewing\.sessionId\)/);
  assert.doesNotMatch(finish, /chrome\.tabs\.create/);
});
