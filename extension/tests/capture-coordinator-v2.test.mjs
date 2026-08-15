import assert from "node:assert/strict";
import test from "node:test";

import {
  CaptureEntryStatus,
  captureEntry,
  clickEntryNeedsSettledFrame,
  initializeCaptureCoordinator,
  lastClickCaptureEntry,
  markCaptureEntryFailed,
  markCaptureEntryReady,
  navigationKey,
  noteClickInteraction,
  recentHandoffMatches,
  recentSameTabDestination,
  recoverCaptureLedger,
  rememberNavigationKey,
  rememberRecordedDestination,
  reserveCaptureEntry,
  resetCaptureEntryForRetry,
  shouldAbsorbClickNavigation,
  shouldDropTrailingTabSwitch,
  shouldMintNavigationStep,
  switchNavigationCopy,
  updateCaptureEntry,
} from "../src/core/capture-coordinator.js";
import {
  newestEligiblePreparedFrame,
  newestSameTabPreparedFrame,
  preparedFrameEligible,
  retainPreparedFrameMetadata,
} from "../src/core/prepared-frame.js";

function recordingState() {
  return initializeCaptureCoordinator({
    status: "recording",
    sessionId: "session-a",
    acceptingEvents: true,
    stepIds: [],
    stepCount: 0,
  }, 1_000);
}

test("interaction reservations are idempotent and keep exactly-once sequence order", () => {
  const first = reserveCaptureEntry(recordingState(), {
    id: "interaction-a",
    stepId: "step-a",
    sourceEvent: "click",
  }, 1_100);
  const duplicate = reserveCaptureEntry(first, {
    id: "interaction-a",
    stepId: "different-step",
  }, 1_200);
  const second = reserveCaptureEntry(duplicate, {
    id: "interaction-b",
    stepId: "step-b",
    sourceEvent: "click",
  }, 1_300);

  assert.equal(second.captureEntries.length, 2);
  assert.equal(captureEntry(second, "interaction-a").stepId, "step-a");
  assert.deepEqual(second.captureEntries.map((entry) => entry.order), [0, 1]);
  assert.equal(second.nextEventSequence, 2);
});

test("ready entries derive ordered step IDs even when screenshots finish out of order", () => {
  let state = reserveCaptureEntry(recordingState(), {
    id: "first",
    stepId: "step-first",
  }, 1_100);
  state = reserveCaptureEntry(state, { id: "second", stepId: "step-second" }, 1_200);
  state = markCaptureEntryReady(state, "second", 1_300);
  assert.deepEqual(state.stepIds, ["step-second"]);
  state = markCaptureEntryReady(state, "first", 1_400);
  assert.deepEqual(state.stepIds, ["step-first", "step-second"]);
});

test("prepared frames require the same document, route, viewport, epoch, and age", () => {
  const frame = {
    id: "frame-a",
    sessionId: "session-a",
    tabId: 7,
    documentId: "document-a",
    navigationKey: "route-a",
    viewportKey: "1280:720:0:0:1.00",
    visualEpoch: 4,
    capturedAtMs: 5_000,
  };
  const candidate = { ...frame };
  assert.equal(
    preparedFrameEligible(frame, candidate, { now: 6_999, maxAgeMs: 2_000 }),
    true,
  );
  for (const [field, value] of [
    ["documentId", "document-b"],
    ["navigationKey", "route-b"],
    ["viewportKey", "1280:720:0:100:1.00"],
    ["visualEpoch", 5],
  ]) {
    assert.equal(
      preparedFrameEligible(frame, { ...candidate, [field]: value }, { now: 6_000 }),
      false,
      field,
    );
  }
  assert.equal(
    preparedFrameEligible(frame, candidate, { now: 7_001, maxAgeMs: 2_000 }),
    false,
  );
  assert.equal(
    preparedFrameEligible(
      frame,
      { ...candidate, visualEpoch: 5 },
      { now: 6_000, ignoreVisualEpoch: true },
    ),
    true,
  );
});

test("same-tab prepared frames can ignore route, viewport, document, and epoch drift", () => {
  const frame = {
    id: "frame-a",
    sessionId: "session-a",
    tabId: 7,
    documentId: "document-a",
    navigationKey: "route-a",
    viewportKey: "1280:720:0:0:1.00",
    visualEpoch: 4,
    capturedAtMs: 5_000,
  };
  const drifted = {
    sessionId: "session-a",
    tabId: 7,
    documentId: "document-b",
    navigationKey: "route-b",
    viewportKey: "1280:720:0:400:1.00",
    visualEpoch: 9,
  };
  assert.equal(
    preparedFrameEligible(frame, drifted, {
      now: 10_000,
      maxAgeMs: 12_000,
      ignoreVisualEpoch: true,
      ignoreNavigationKey: true,
      ignoreViewportKey: true,
      ignoreDocumentId: true,
    }),
    true,
  );
  assert.equal(
    newestSameTabPreparedFrame(
      [
        { ...frame, id: "older", capturedAtMs: 4_000 },
        frame,
        { ...frame, sessionId: "other", id: "wrong-session" },
        { ...frame, tabId: 8, id: "wrong-tab" },
      ],
      drifted,
      { now: 10_000, maxAgeMs: 12_000 },
    ).id,
    "frame-a",
  );
});

test("the newest eligible frame wins and cleanup retains two unclaimed plus pins", () => {
  const base = {
    sessionId: "session-a",
    tabId: 1,
    documentId: "document-a",
    navigationKey: "route-a",
    viewportKey: "viewport-a",
    visualEpoch: 2,
  };
  const frames = [
    { ...base, id: "old", capturedAtMs: 1_000 },
    { ...base, id: "middle", capturedAtMs: 2_000 },
    { ...base, id: "new", capturedAtMs: 3_000 },
    { ...base, id: "pinned", capturedAtMs: 100 },
  ];
  assert.equal(
    newestEligiblePreparedFrame(frames, base, { now: 3_500, maxAgeMs: 3_000 }).id,
    "new",
  );
  assert.deepEqual(
    retainPreparedFrameMetadata(frames, {
      now: 4_000,
      retentionMs: 3_500,
      maximumUnclaimed: 2,
      pinnedIds: ["pinned"],
    }).map((frame) => frame.id),
    ["pinned", "middle", "new"],
  );
});

test("failed screenshots retry in place without consuming another sequence", () => {
  let state = reserveCaptureEntry(recordingState(), {
    id: "interaction-a",
    stepId: "step-a",
    committed: true,
  }, 1_100);
  state = markCaptureEntryFailed(state, "interaction-a", "capture failed", 1_200);
  const nextSequence = state.nextEventSequence;
  state = resetCaptureEntryForRetry(state, "interaction-a", {
    visualEpoch: 9,
    viewportKey: "retry-viewport",
  }, 1_300);
  const entry = captureEntry(state, "interaction-a");
  assert.equal(entry.status, CaptureEntryStatus.CAPTURING);
  assert.equal(entry.error, null);
  assert.equal(entry.committed, true);
  assert.equal(entry.visualEpoch, 9);
  assert.equal(state.nextEventSequence, nextSequence);
});

test("worker recovery preserves framed work, flags missing committed work, and removes abandoned stages", () => {
  let state = reserveCaptureEntry(recordingState(), {
    id: "framed",
    stepId: "step-framed",
    frameId: "frame-a",
    committed: true,
  }, 1_000);
  state = reserveCaptureEntry(state, {
    id: "missing",
    stepId: "step-missing",
    committed: true,
    capturePending: true,
  }, 1_100);
  state = reserveCaptureEntry(state, {
    id: "abandoned",
    stepId: "step-abandoned",
    committed: false,
  }, 1_200);
  const recovered = recoverCaptureLedger(state, {
    availableFrameIds: ["frame-a"],
    now: 20_000,
  });
  assert.equal(captureEntry(recovered, "framed").status, CaptureEntryStatus.CAPTURING);
  assert.equal(captureEntry(recovered, "missing").status, CaptureEntryStatus.NEEDS_ATTENTION);
  assert.equal(captureEntry(recovered, "abandoned"), null);
});

test("navigation keys distinguish transitions while duplicate callbacks deduplicate", () => {
  const firstKey = navigationKey({
    tabId: 1,
    documentId: "document-a",
    transitionId: 3,
    sanitizedUrl: "https://example.test/page",
  });
  const secondKey = navigationKey({
    tabId: 1,
    documentId: "document-a",
    transitionId: 4,
    sanitizedUrl: "https://example.test/page",
  });
  assert.notEqual(firstKey, secondKey);
  const remembered = rememberNavigationKey(recordingState(), firstKey, 1_100);
  assert.equal(remembered.duplicate, false);
  assert.equal(rememberNavigationKey(remembered.state, firstKey, 1_200).duplicate, true);
});

test("a completed new-tab handoff absorbs the matching load callback only", () => {
  const state = {
    lastNavigationHandoff: {
      tabId: 9,
      documentId: "document-b",
      sanitizedUrl: "https://example.test/destination",
      recordedAtMs: 5_000,
    },
  };
  assert.equal(
    recentHandoffMatches(
      state,
      {
        tabId: 9,
        documentId: "document-b",
        sanitizedUrl: "https://example.test/destination",
      },
      { now: 5_500 },
    ),
    true,
  );
  assert.equal(
    recentHandoffMatches(
      state,
      {
        tabId: 9,
        documentId: "document-c",
        sanitizedUrl: "https://example.test/destination",
      },
      { now: 5_500 },
    ),
    false,
  );
  assert.equal(
    recentHandoffMatches(
      state,
      {
        tabId: 9,
        documentId: "document-b",
        sanitizedUrl: "https://example.test/destination",
      },
      { now: 15_001, maxAgeMs: 10_000 },
    ),
    false,
  );
});

test("a double-click upgrade changes one accepted entry instead of adding another", () => {
  let state = reserveCaptureEntry(recordingState(), {
    id: "interaction-a",
    stepId: "step-a",
    sourceEvent: "click",
  }, 1_100);
  state = updateCaptureEntry(state, "interaction-a", {
    sourceEvent: "dblclick",
    context: { title: "Double-click the control" },
  }, 1_200);
  assert.equal(state.captureEntries.length, 1);
  assert.equal(captureEntry(state, "interaction-a").sourceEvent, "dblclick");
});

test("a same-tab SPA navigation after a click is absorbed and a duplicate Open is dropped", () => {
  let state = noteClickInteraction(recordingState(), { tabId: 4, now: 5_000 });
  assert.equal(
    shouldAbsorbClickNavigation(
      state,
      { tabId: 4 },
      { now: 6_200, titleMode: "navigation" },
    ),
    true,
  );
  assert.equal(
    shouldAbsorbClickNavigation(
      state,
      { tabId: 9 },
      { now: 6_200, titleMode: "navigation" },
    ),
    false,
  );
  assert.equal(
    shouldAbsorbClickNavigation(
      state,
      { tabId: 4 },
      { now: 6_200, titleMode: "new-tab" },
    ),
    false,
  );
  assert.equal(
    shouldAbsorbClickNavigation(
      state,
      { tabId: 4 },
      { now: 6_600, titleMode: "navigation" },
    ),
    false,
  );

  state = rememberRecordedDestination(
    state,
    "http://localhost:3001/w/helpdesk-ac3fe",
    6_000,
  );
  assert.equal(
    recentSameTabDestination(
      state,
      "http://localhost:3001/w/helpdesk-ac3fe",
      { now: 7_500 },
    ),
    true,
  );
  assert.equal(
    recentSameTabDestination(
      state,
      "http://localhost:3001/w/helpdesk-ac3fe",
      { now: 8_100 },
    ),
    false,
  );
});

test("tab-switch copy names the site and keeps a Google query in the subtitle", () => {
  assert.deepEqual(switchNavigationCopy("centri - Google Search"), {
    title: "Switch to Google Search",
    instructions: 'Results for "centri".',
  });
  assert.equal(switchNavigationCopy("Inbox").title, "Switch to Inbox");
});

test("same-tab SPA navigation never mints a step even after the absorb window", () => {
  assert.equal(shouldMintNavigationStep("navigation"), false);
  assert.equal(shouldMintNavigationStep("new-tab"), true);
  assert.equal(shouldMintNavigationStep("switch"), true);

  let state = reserveCaptureEntry(recordingState(), {
    id: "click-a",
    stepId: "step-click",
    sourceEvent: "click",
    tabId: 4,
  }, 1_100);
  assert.equal(lastClickCaptureEntry(state).id, "click-a");
  assert.equal(clickEntryNeedsSettledFrame(state, { tabId: 4 }), true);
  assert.equal(clickEntryNeedsSettledFrame(state, { tabId: 9 }), false);

  state = updateCaptureEntry(state, "click-a", { additionalFrameId: "settled-a" });
  assert.equal(clickEntryNeedsSettledFrame(state, { tabId: 4 }), false);

  const switched = reserveCaptureEntry(recordingState(), {
    id: "open-b",
    stepId: "step-open",
    sourceEvent: "navigation",
    tabId: 8,
  }, 1_100);
  assert.equal(
    shouldDropTrailingTabSwitch(switched, { tabId: 8 }, { titleMode: "switch" }),
    true,
  );
  assert.equal(
    shouldDropTrailingTabSwitch(switched, { tabId: 9 }, { titleMode: "switch" }),
    false,
  );
  assert.equal(
    shouldDropTrailingTabSwitch(switched, { tabId: 8 }, { titleMode: "new-tab" }),
    false,
  );
});
