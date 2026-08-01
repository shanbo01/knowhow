import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureEvent,
  CaptureStatus,
  CaptureTransitionError,
  createIdleState,
  jobIsCurrent,
  snapshotCaptureJob,
  transitionCapture,
  withStepCount,
} from "../src/core/state-machine.js";
import { createScreenshotQueue } from "../src/background/screenshot-queue.js";

const startPayload = {
  sessionId: "session-1",
  tabId: 7,
  windowId: 3,
  origin: "https://example.com",
  sanitizedUrl: "https://example.com/start",
  title: "Test capture",
};

test("capture follows start, pause, resume, finish, upload and complete", () => {
  const idle = createIdleState(0);
  const recording = transitionCapture(idle, CaptureEvent.START, startPayload, 1);
  assert.equal(recording.status, CaptureStatus.RECORDING);
  assert.equal(recording.stepCount, 0);

  const withStep = withStepCount(recording, 1, 2);
  assert.equal(withStep.stepCount, 1);
  assert.equal(
    jobIsCurrent(withStep, withStep.sessionId, withStep.generation),
    true,
  );

  const paused = transitionCapture(
    withStep,
    CaptureEvent.PAUSE,
    { reason: "User paused" },
    3,
  );
  assert.equal(paused.status, CaptureStatus.PAUSED);
  assert.equal(paused.pausedReason, "User paused");
  assert.equal(
    jobIsCurrent(paused, withStep.sessionId, withStep.generation),
    false,
  );

  const resumed = transitionCapture(
    paused,
    CaptureEvent.RESUME,
    { origin: "https://example.org" },
    4,
  );
  assert.equal(resumed.status, CaptureStatus.RECORDING);
  assert.equal(resumed.origin, "https://example.org");
  assert.equal(resumed.generation, paused.generation + 1);

  const reviewing = transitionCapture(
    resumed,
    CaptureEvent.FINISH,
    {},
    5,
  );
  const uploading = transitionCapture(
    reviewing,
    CaptureEvent.BEGIN_UPLOAD,
    {},
    6,
  );
  const complete = transitionCapture(
    uploading,
    CaptureEvent.COMPLETE,
    { guideId: "guide-1", editUrl: "https://example.test/guides/guide-1" },
    7,
  );
  assert.equal(complete.status, CaptureStatus.COMPLETED);
  assert.equal(complete.guideId, "guide-1");
});

test("pause invalidates a queued screenshot generation", () => {
  const recording = transitionCapture(
    createIdleState(0),
    CaptureEvent.START,
    startPayload,
    1,
  );
  const queuedGeneration = recording.generation;
  const paused = transitionCapture(recording, CaptureEvent.PAUSE, {}, 2);
  assert.equal(
    jobIsCurrent(paused, recording.sessionId, queuedGeneration),
    false,
  );
});

test("a queued pre-pause job stays invalid after resume", async () => {
  let state = transitionCapture(
    createIdleState(0),
    CaptureEvent.START,
    startPayload,
    1,
  );
  const queuedJob = snapshotCaptureJob(state, { sourceEvent: "click" });
  const enqueue = createScreenshotQueue({ minimumIntervalMs: 0 });
  let releaseBlocker;
  const gate = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  const blocker = enqueue(() => gate);
  let captured = false;
  const queued = enqueue(() => {
    if (!jobIsCurrent(state, queuedJob.sessionId, queuedJob.generation)) {
      return "discarded";
    }
    captured = true;
    return "captured";
  });

  state = transitionCapture(state, CaptureEvent.PAUSE, {}, 2);
  state = transitionCapture(state, CaptureEvent.RESUME, {}, 3);
  releaseBlocker();

  await blocker;
  assert.equal(await queued, "discarded");
  assert.equal(captured, false);
});

test("invalid state transitions are rejected", () => {
  const idle = createIdleState(0);
  assert.throws(
    () => transitionCapture(idle, CaptureEvent.PAUSE),
    CaptureTransitionError,
  );
  const recording = transitionCapture(
    idle,
    CaptureEvent.START,
    startPayload,
    1,
  );
  assert.throws(
    () => transitionCapture(recording, CaptureEvent.START, startPayload),
    CaptureTransitionError,
  );
  assert.throws(
    () => transitionCapture(recording, CaptureEvent.COMPLETE),
    CaptureTransitionError,
  );
});

test("discard returns to idle and preserves an invalidating generation", () => {
  const recording = transitionCapture(
    createIdleState(0),
    CaptureEvent.START,
    startPayload,
    1,
  );
  const discarded = transitionCapture(recording, CaptureEvent.DISCARD, {}, 2);
  assert.equal(discarded.status, CaptureStatus.IDLE);
  assert.equal(discarded.discardedSessionId, "session-1");
  assert.ok(discarded.generation > recording.generation);
});
