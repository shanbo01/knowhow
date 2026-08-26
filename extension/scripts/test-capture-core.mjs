// Pure-logic regression tests for the parts of capture that decide whether an
// author's click is recorded at all. Everything under test here is free of
// `chrome.*` APIs, so it runs under plain Node.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createScreenshotQueue,
  ScreenshotPriority,
} from "../src/background/screenshot-queue.js";
import {
  CaptureEntryStatus,
  initializeCaptureCoordinator,
  reserveCaptureEntry,
  unconfirmedClickEntryAt,
  updateCaptureEntry,
} from "../src/core/capture-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolveTask) => {
    resolve = resolveTask;
  });
  return { promise, resolve };
}

test("a click takes the next screenshot slot ahead of speculative pre-warming", async () => {
  const started = [];
  const queue = createScreenshotQueue({ minimumIntervalMs: 0 });
  const blocker = deferred();

  // Occupy the queue so the next two tasks are both waiting when the click lands.
  const held = queue(
    async (reserveSlot) => {
      started.push("held");
      await reserveSlot();
      await blocker.promise;
      return "held";
    },
    { priority: ScreenshotPriority.PREPARED },
  );
  const prepared = queue(
    async (reserveSlot) => {
      started.push("prepared");
      await reserveSlot();
      return "prepared";
    },
    { priority: ScreenshotPriority.PREPARED },
  );
  const navigation = queue(
    async (reserveSlot) => {
      started.push("navigation");
      await reserveSlot();
      return "navigation";
    },
    { priority: ScreenshotPriority.NAVIGATION },
  );
  const interaction = queue(
    async (reserveSlot) => {
      started.push("interaction");
      await reserveSlot();
      return "interaction";
    },
    { priority: ScreenshotPriority.INTERACTION },
  );

  blocker.resolve();
  await Promise.all([held, prepared, navigation, interaction]);
  assert.deepEqual(started, ["held", "interaction", "navigation", "prepared"]);
});

test("superseded pre-warming is abandoned instead of photographing a stale page", async () => {
  const started = [];
  const queue = createScreenshotQueue({ minimumIntervalMs: 0 });
  const blocker = deferred();

  const held = queue(async (reserveSlot) => {
    await reserveSlot();
    await blocker.promise;
    return "held";
  });
  const stale = queue(
    async () => {
      started.push("stale");
      return "stale";
    },
    { priority: ScreenshotPriority.PREPARED, supersedes: "prepared:7" },
  );
  const fresh = queue(
    async () => {
      started.push("fresh");
      return "fresh";
    },
    { priority: ScreenshotPriority.PREPARED, supersedes: "prepared:7" },
  );
  // A pre-warm for a different tab is untouched by the newer one.
  const other = queue(
    async () => {
      started.push("other");
      return "other";
    },
    { priority: ScreenshotPriority.PREPARED, supersedes: "prepared:9" },
  );

  blocker.resolve();
  await held;
  assert.equal(await stale, null, "the superseded pre-warm must not capture");
  assert.equal(await fresh, "fresh");
  assert.equal(await other, "other");
  assert.deepEqual(started, ["fresh", "other"]);
});

test("work that would miss its deadline gives up rather than storing a stale frame", async () => {
  const queue = createScreenshotQueue({ minimumIntervalMs: 500 });
  const first = await queue(async (reserveSlot) => reserveSlot());
  assert.equal(first, true);
  const second = await queue(async (reserveSlot) => reserveSlot(), {
    deadlineMs: 50,
  });
  assert.equal(second, false, "a frame that arrives too late is not worth taking");
});

test("a click that navigates before its commit lands is still recoverable", () => {
  const now = 10_000;
  let state = initializeCaptureCoordinator(
    { sessionId: "session", captureEntries: [] },
    now,
  );
  state = reserveCaptureEntry(
    state,
    {
      id: "interaction-1",
      stepId: "step-1",
      kind: "click",
      sourceEvent: "click",
      tabId: 42,
    },
    now,
  );

  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 42, now: now + 200 })?.id,
    "interaction-1",
  );
  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 43, now: now + 200 }),
    null,
    "another tab's navigation must not adopt this click",
  );
  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 42, now: now + 30_000 }),
    null,
    "a long-abandoned pointer press is not a click",
  );

  const committed = updateCaptureEntry(state, "interaction-1", {
    committed: true,
  });
  assert.equal(
    unconfirmedClickEntryAt(committed, { tabId: 42, now: now + 200 }),
    null,
    "a click that already committed must not be adopted twice",
  );

  const ready = updateCaptureEntry(state, "interaction-1", {
    status: CaptureEntryStatus.READY,
  });
  assert.equal(
    unconfirmedClickEntryAt(ready, { tabId: 42, now: now + 200 }),
    null,
  );
});
