import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureEvent,
  CaptureStatus,
  CaptureTransitionError,
  createWindowActivationEpochs,
  createIdleState,
  jobIsCurrent,
  snapshotCaptureJob,
  transitionCapture,
  withCapturedStep,
  withoutCapturedStep,
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

function startRecording(now = 1) {
  const preparing = transitionCapture(
    createIdleState(0),
    CaptureEvent.START,
    startPayload,
    now,
  );
  return transitionCapture(preparing, CaptureEvent.READY, {}, now + 1);
}

test("capture follows start, pause, resume, finish, upload and complete", () => {
  const idle = createIdleState(0);
  const preparing = transitionCapture(idle, CaptureEvent.START, startPayload, 1);
  assert.equal(preparing.status, CaptureStatus.PREPARING);
  assert.deepEqual(preparing.stepIds, []);
  assert.throws(
    () => snapshotCaptureJob(preparing, { sourceEvent: "navigation" }),
    CaptureTransitionError,
  );
  const recording = transitionCapture(preparing, CaptureEvent.READY, {}, 2);
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
  const recording = startRecording();
  const queuedGeneration = recording.generation;
  const paused = transitionCapture(recording, CaptureEvent.PAUSE, {}, 2);
  assert.equal(
    jobIsCurrent(paused, recording.sessionId, queuedGeneration),
    false,
  );
});

test("a queued pre-pause job stays invalid after resume", async () => {
  let state = startRecording();
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

test("only tasks that take a screenshot pay the capture interval", async () => {
  let clock = 10_000;
  const enqueue = createScreenshotQueue({
    minimumIntervalMs: 550,
    now: () => clock,
  });
  const startedAt = [];

  // A step that adopts an already-taken pre-click screenshot never reserves a
  // slot, so it must not push the next real capture into the future.
  await enqueue(async (reserveSlot) => {
    startedAt.push(await reserveSlot());
  });
  await enqueue(async () => startedAt.push("adopted-preflight"));
  clock += 600;
  await enqueue(async (reserveSlot) => {
    startedAt.push(await reserveSlot());
  });

  assert.deepEqual(startedAt, [true, "adopted-preflight", true]);

  // Inside the interval, a task that cannot wait past its deadline gives up
  // instead of returning a frame from the wrong moment.
  const abandoned = await enqueue(
    async (reserveSlot) => (await reserveSlot() ? "captured" : "abandoned"),
    { deadlineMs: 320 },
  );
  assert.equal(abandoned, "abandoned");

  const patient = enqueue(
    async (reserveSlot) => (await reserveSlot() ? "captured" : "abandoned"),
  );
  clock += 550;
  assert.equal(await patient, "captured");
});

test("invalid state transitions are rejected", () => {
  const idle = createIdleState(0);
  assert.throws(
    () => transitionCapture(idle, CaptureEvent.PAUSE),
    CaptureTransitionError,
  );
  const preparing = transitionCapture(idle, CaptureEvent.START, startPayload, 1);
  assert.throws(
    () => transitionCapture(preparing, CaptureEvent.START, startPayload),
    CaptureTransitionError,
  );
  const recording = transitionCapture(preparing, CaptureEvent.READY, {}, 2);
  assert.throws(
    () => transitionCapture(recording, CaptureEvent.COMPLETE),
    CaptureTransitionError,
  );
});

test("discard returns to idle and preserves an invalidating generation", () => {
  const recording = startRecording();
  const discarded = transitionCapture(recording, CaptureEvent.DISCARD, {}, 2);
  assert.equal(discarded.status, CaptureStatus.IDLE);
  assert.equal(discarded.discardedSessionId, "session-1");
  assert.ok(discarded.generation > recording.generation);
});

test("captured step commits preserve ordered IDs and legacy counts", () => {
  const recording = startRecording();
  const first = withCapturedStep(recording, "step-1", 3);
  const second = withCapturedStep(first, "step-2", 4);
  assert.deepEqual(second.stepIds, ["step-1", "step-2"]);
  assert.equal(second.stepCount, 2);
  assert.equal(withCapturedStep(second, "step-2", 5), second);

  const legacy = withCapturedStep(
    { ...recording, stepCount: 4, stepIds: undefined },
    "step-5",
    6,
  );
  assert.equal(legacy.stepCount, 5);
  assert.deepEqual(legacy.stepIds, ["step-5"]);
});

test("captured steps can be removed without reordering the remaining IDs", () => {
  const recording = withCapturedStep(
    withCapturedStep(withCapturedStep(startRecording(), "first", 3), "second", 4),
    "third",
    5,
  );
  const removed = withoutCapturedStep(recording, "second", 6);
  assert.deepEqual(removed.stepIds, ["first", "third"]);
  assert.equal(removed.stepCount, 2);
  assert.equal(withoutCapturedStep(removed, "missing", 7), removed);
});

test("window activation epochs reveal an A to B to A switch", () => {
  const epochs = createWindowActivationEpochs();
  const before = epochs.current(3);
  epochs.note(3);
  epochs.note(3);
  assert.notEqual(epochs.current(3), before);
  assert.equal(epochs.current(7), 0);
});
