import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getCapturedSteps } from "../src/core/capture-store.js";

import {
  createCapturedStepCache,
  createRefreshGate,
  createThumbnailUrlCache,
  feedRevision,
  liveFeedVisible,
  orderedSteps,
  stepCopy,
  thumbnailGeometry,
} from "../src/popup/step-feed.js";

function createFakeIndexedDb(records) {
  const activity = { transactions: 0, keys: [] };
  const database = {
    transaction() {
      activity.transactions += 1;
      let pending = 0;
      const transaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            get(key) {
              activity.keys.push(key);
              pending += 1;
              const request = {};
              setImmediate(() => {
                request.result = records.get(key.join("|"));
                request.onsuccess?.();
                pending -= 1;
                if (pending === 0) {
                  setImmediate(() => transaction.oncomplete?.());
                }
              });
              return request;
            },
          };
        },
      };
      return transaction;
    },
    close() {},
  };
  return {
    activity,
    open() {
      const request = {};
      setImmediate(() => {
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test("batch capture reader uses one readonly transaction and requested order", async () => {
  const fake = createFakeIndexedDb(
    new Map([
      ["session-1|first", { id: "first", order: 0 }],
      ["session-1|second", { id: "second", order: 1 }],
    ]),
  );
  const originalIndexedDb = globalThis.indexedDB;
  globalThis.indexedDB = fake;
  try {
    const steps = await getCapturedSteps("session-1", [
      "second",
      "first",
      "second",
      "missing",
    ]);
    assert.deepEqual(steps.map((step) => step.id), ["second", "first"]);
    assert.equal(fake.activity.transactions, 1);
    assert.deepEqual(fake.activity.keys, [
      ["session-1", "second"],
      ["session-1", "first"],
      ["session-1", "missing"],
    ]);
  } finally {
    if (originalIndexedDb === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDb;
  }
});

test("live feed is scoped to recording and paused capture states", () => {
  assert.equal(
    liveFeedVisible({ status: "recording", sessionId: "session-1" }),
    true,
  );
  assert.equal(
    liveFeedVisible({ status: "paused", sessionId: "session-1" }),
    true,
  );
  for (const status of ["preparing", "reviewing", "uploading", "completed"])
    assert.equal(liveFeedVisible({ status, sessionId: "session-1" }), false);
});

test("step cache batch-loads only newly announced IDs in capture order", async () => {
  const reads = [];
  let legacyReads = 0;
  const stored = new Map([
    ["first", { id: "first", order: 10, title: "First" }],
    ["second", { id: "second", order: 0, title: "Second" }],
  ]);
  const cache = createCapturedStepCache({
    async getSteps(sessionId, stepIds) {
      reads.push([sessionId, stepIds]);
      return stepIds.map((stepId) => stored.get(stepId)).filter(Boolean);
    },
    async listSteps() {
      legacyReads += 1;
      return [...stored.values()];
    },
  });

  assert.deepEqual(
    (await cache.load({
      sessionId: "session-1",
      stepCount: 1,
      stepIds: ["first"],
    })).map((step) => step.id),
    ["first"],
  );
  assert.deepEqual(
    (await cache.load({
      sessionId: "session-1",
      stepCount: 2,
      stepIds: ["first", "second", "second"],
    })).map((step) => step.id),
    ["first", "second"],
  );
  assert.deepEqual(reads, [
    ["session-1", ["first"]],
    ["session-1", ["second"]],
  ]);
  assert.equal(legacyReads, 0);
});

test("step cache bounds batch work and keeps only recent screenshot Blobs", async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `step-${index}`);
  const stored = new Map(
    ids.map((id, order) => [
      id,
      {
        id,
        order,
        title: `Card ${order + 1}`,
        sourceEvent: order === 0 ? "navigation" : "click",
        imageBlob: new Blob(["blob"], { type: "image/jpeg" }),
      },
    ]),
  );
  const batches = [];
  let activeReads = 0;
  let maximumActiveReads = 0;
  const cache = createCapturedStepCache({
    maxBatchSize: 2,
    maxRetainedBlobs: 2,
    maxRetainedBlobBytes: 8,
    async getSteps(sessionId, stepIds) {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      batches.push([sessionId, [...stepIds]]);
      await new Promise((resolve) => setImmediate(resolve));
      activeReads -= 1;
      return stepIds.map((stepId) => stored.get(stepId));
    },
    async listSteps() {
      return [...stored.values()];
    },
  });

  const loaded = await cache.load({
    sessionId: "bounded-session",
    stepCount: ids.length,
    stepIds: ids,
  });
  assert.deepEqual(loaded.map((step) => step.id), ids);
  assert.deepEqual(loaded.map((step) => step.title), ids.map((_, i) => `Card ${i + 1}`));
  assert.deepEqual(
    batches.map(([, stepIds]) => stepIds),
    [["step-0", "step-1"], ["step-2", "step-3"], ["step-4", "step-5"], ["step-6"]],
  );
  assert.equal(maximumActiveReads, 1);
  assert.deepEqual(
    loaded.filter((step) => step.imageBlob instanceof Blob).map((step) => step.id),
    ["step-5", "step-6"],
  );
  assert.deepEqual(cache.stats("bounded-session"), {
    steps: 7,
    pending: 0,
    retainedBlobs: 2,
    retainedBlobBytes: 8,
  });

  const loadedAgain = await cache.load({
    sessionId: "bounded-session",
    stepCount: ids.length,
    stepIds: ids,
  });
  assert.deepEqual(loadedAgain.map((step) => step.id), ids);
  assert.equal(batches.length, 4);
  cache.clear("bounded-session");
  assert.deepEqual(cache.stats("bounded-session"), {
    steps: 0,
    pending: 0,
    retainedBlobs: 0,
    retainedBlobBytes: 0,
  });
});

test("partial and legacy state use one list fallback and merge point reads", async () => {
  let legacyReads = 0;
  const cache = createCapturedStepCache({
    async getStep(_sessionId, stepId) {
      return { id: stepId, order: 2 };
    },
    async listSteps() {
      legacyReads += 1;
      return [
        { id: "legacy-1", order: 0 },
        { id: "legacy-2", order: 1 },
      ];
    },
  });

  const partial = await cache.load({
    sessionId: "legacy-session",
    stepCount: 3,
    stepIds: ["new-step"],
  });
  assert.deepEqual(
    partial.map((step) => step.id),
    ["legacy-1", "legacy-2", "new-step"],
  );
  await cache.load({ sessionId: "legacy-session", stepCount: 4, stepIds: [] });
  await cache.load({ sessionId: "legacy-session" });
  assert.equal(legacyReads, 1);
});

test("live step cards keep capture order and navigation copy", () => {
  const steps = orderedSteps([
    { id: "later", order: 2, title: "Select Flash" },
    {
      id: "navigation",
      order: 0,
      sourceEvent: "navigation",
      sanitizedUrl: "https://gemini.google.com/app",
    },
    { id: "first-click", order: 1, title: "Select New chat" },
  ]);

  assert.deepEqual(
    steps.map((step) => step.id),
    ["navigation", "first-click", "later"],
  );
  assert.deepEqual(stepCopy(steps[0]), {
    title: "Navigate to https://gemini.google.com/app",
    detail: "",
  });
  assert.equal(stepCopy(steps[1]).title, "Select New chat");
});

test("live thumbnails use a contextual 16:9 crop and project the click ring", () => {
  const geometry = thumbnailGeometry({
    id: "step-1",
    imageWidth: 1920,
    imageHeight: 1080,
    focusRegion: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
    clickTarget: { x: 0.5, y: 0.4, color: "#ef6f47" },
  });

  assert.ok(Math.abs(geometry.crop.x - 0.23) < 0.001);
  assert.ok(Math.abs(geometry.crop.y - 0.13) < 0.001);
  assert.ok(Math.abs(geometry.crop.width - 0.54) < 0.001);
  assert.ok(Math.abs(geometry.crop.height - 0.54) < 0.001);
  assert.ok(Math.abs(geometry.image.left + 42.593) < 0.01);
  assert.ok(Math.abs(geometry.image.top + 24.074) < 0.01);
  assert.ok(Math.abs(geometry.image.width - 185.185) < 0.01);
  assert.equal(Object.hasOwn(geometry.image, "height"), false);
  assert.ok(Math.abs(geometry.aspectRatio - 1920 / 1080) < 0.001);
  assert.ok(Math.abs(geometry.clickTarget.x - 0.5) < 0.001);
  assert.ok(Math.abs(geometry.clickTarget.y - 0.5) < 0.001);
  assert.ok(Math.abs(geometry.clickTarget.radius - 0.035 / 0.54) < 0.001);
  assert.equal(geometry.clickTarget.color, "#ef6f47");
});

test("a small control is zoomed to the maximum, never past it", () => {
  const tiny = thumbnailGeometry({
    id: "tiny",
    imageWidth: 1600,
    imageHeight: 900,
    focusRegion: { x: 0.5, y: 0.5, width: 0.02, height: 0.02 },
    clickTarget: { x: 0.51, y: 0.51 },
  });
  const wide = thumbnailGeometry({
    id: "wide",
    imageWidth: 1600,
    imageHeight: 900,
    focusRegion: { x: 0.1, y: 0.4, width: 0.75, height: 0.06 },
    clickTarget: { x: 0.8, y: 0.43 },
  });

  assert.ok(Math.abs(tiny.crop.width - 1 / 2.6) < 0.001);
  assert.ok(tiny.crop.width < wide.crop.width);
  // A wide control still fits inside its frame, even though the click that
  // opened it sits near the right edge.
  assert.ok(wide.crop.x <= 0.1 + 0.0001);
  assert.ok(wide.crop.x + wide.crop.width >= 0.85 - 0.0001);
});

test("pending blur regions are clipped to the visible crop", () => {
  const geometry = thumbnailGeometry({
    id: "step-2",
    imageWidth: 1600,
    imageHeight: 900,
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    clickTarget: { x: 0.5, y: 0.5 },
    pendingRedactions: [
      { id: "inside", x: 0.3, y: 0.3, width: 0.1, height: 0.1 },
      { id: "straddling", x: 0.2, y: 0.3, width: 0.1, height: 0.1 },
      { id: "outside", x: 0.85, y: 0.85, width: 0.1, height: 0.1 },
      { id: "applied", x: 0.3, y: 0.6, width: 0.1, height: 0.1, applied: true },
    ],
  });

  assert.equal(geometry.redactions.length, 2);
  assert.ok(Math.abs(geometry.redactions[0].x - 0.1) < 0.001);
  assert.ok(Math.abs(geometry.redactions[0].width - 0.2) < 0.001);
  assert.equal(geometry.redactions[1].x, 0);
  assert.ok(Math.abs(geometry.redactions[1].width - 0.1) < 0.001);
});

test("redacted thumbnail URLs are reused, replaced, pruned, and disposed", () => {
  let created = 0;
  const revoked = [];
  const cache = createThumbnailUrlCache({
    createObjectURL(blob) {
      created += 1;
      return `blob:test-${created}-${blob.size}`;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  });
  const original = {
    id: "step-1",
    updatedAt: "2026-08-01T12:00:00.000Z",
    imageWidth: 100,
    imageHeight: 50,
    imageBlob: new Blob(["redacted"], { type: "image/jpeg" }),
  };

  const firstUrl = cache.get(original);
  const clonedUrl = cache.get({
    ...original,
    imageBlob: new Blob(["redacted"], { type: "image/jpeg" }),
  });
  assert.equal(clonedUrl, firstUrl);
  assert.equal(created, 1);

  const replacementUrl = cache.get({
    ...original,
    updatedAt: "2026-08-01T12:00:01.000Z",
    imageBlob: new Blob(["new-redacted"], { type: "image/jpeg" }),
  });
  assert.notEqual(replacementUrl, firstUrl);
  assert.deepEqual(revoked, [firstUrl]);

  cache.prune([]);
  assert.deepEqual(revoked, [firstUrl, replacementUrl]);
  cache.dispose();
  assert.equal(revoked.length, 2);
});

test("thumbnail cache evicts least-recent previews by count and bytes", () => {
  let created = 0;
  const revoked = [];
  const cache = createThumbnailUrlCache(
    {
      createObjectURL() {
        created += 1;
        return `blob:bounded-${created}`;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    { maxEntries: 2, maxBlobBytes: 8 },
  );
  const step = (id) => ({
    id,
    imageBlob: new Blob(["blob"], { type: "image/jpeg" }),
  });

  const first = cache.get(step("first"));
  const second = cache.get(step("second"));
  assert.equal(cache.get(step("first")), first);
  const third = cache.get(step("third"));

  assert.ok(third);
  assert.deepEqual(revoked, [second]);
  assert.deepEqual(cache.stats(), { entries: 2, retainedBlobBytes: 8 });

  assert.equal(
    cache.get({
      id: "oversized",
      imageBlob: new Blob(["too-large"], { type: "image/jpeg" }),
    }),
    null,
  );
  assert.equal(created, 3);
  cache.dispose();
  assert.equal(revoked.length, 3);
});

test("only the newest asynchronous capture refresh may render", () => {
  const gate = createRefreshGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("feed revisions change when a stored redacted step changes", () => {
  const step = {
    id: "step-1",
    order: 0,
    updatedAt: "one",
    imageBlob: new Blob(["redacted"], { type: "image/jpeg" }),
  };
  const before = feedRevision("session-1", [step]);
  const after = feedRevision("session-1", [{ ...step, updatedAt: "two" }]);
  assert.notEqual(before, after);
});

test("the native side panel wires the local live feed and bottom dock", async () => {
  const [html, css, source, storeSource] = await Promise.all([
    readFile(new URL("../src/popup/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../src/popup/popup.css", import.meta.url), "utf8"),
    readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8"),
    readFile(new URL("../src/core/capture-store.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="step-feed"/);
  assert.ok(html.indexOf('id="step-feed"') < html.indexOf('id="capture-actions"'));
  assert.doesNotMatch(html, /id="status-card"/);
  assert.match(html, /class="record-button-dot"/);
  assert.match(css, /\.record-button-dot \{/);
  assert.match(css, /\.step-feed-scroll[\s\S]*overflow:\s*auto/);
  assert.match(source, /capturedSteps\.load\(capture\.state\)/);
  assert.match(source, /getSteps: getCapturedSteps/);
  assert.match(source, /capturedSteps\.clear\(renderedFeedSessionId\)/);
  assert.doesNotMatch(source, /listCapturedSteps\(capture\.state\.sessionId\)/);
  assert.match(
    source,
    /const thumbnailUrl = thumbnailUrls\.get\(step\)/,
  );
  assert.match(source, /type: "RETRY_CAPTURE_ENTRY"/);
  assert.match(source, /type: "DELETE_CAPTURE_ENTRY"/);
  assert.match(source, /captureFeedSteps\(state, rawSteps\)/);
  assert.match(source, /const preparing = state\.status === "preparing"/);
  assert.match(source, /STORAGE_KEYS\.captureState/);
  assert.match(source, /thumbnailUrls\.dispose\(\)/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(
    storeSource,
    /export async function getCapturedSteps\(sessionId, stepIds\)[\s\S]*Promise\.all\([\s\S]*store\.get\(\[sessionId, stepId\]\)/,
  );
  assert.match(
    storeSource,
    /export async function deleteCapturedStepAndCompact[\s\S]*remainingIds\.entries\(\)[\s\S]*store\.put/,
  );
});

test("captured steps and guide steps share one illustrated presentation", async () => {
  const [css, source, backgroundSource, apiClient] = await Promise.all([
    readFile(new URL("../src/popup/popup.css", import.meta.url), "utf8"),
    readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
    readFile(new URL("../src/core/api-client.js", import.meta.url), "utf8"),
  ]);

  // One painter draws the crop, the pending blurs, and the click ring, so a
  // step cannot look different in the live feed and in the guide reader.
  assert.match(source, /function paintStepFigure\(figure, geometry, source\)/);
  assert.match(source, /paintStepFigure\(thumbnail, thumbnailGeometry\(step\), thumbnailUrl\)/);
  assert.match(source, /blur\.className = "step-blur"/);
  assert.match(source, /geometry\.clickTarget\.radius \* 200/);
  assert.match(css, /\.step-blur \{[^}]*backdrop-filter/);

  // Guide screenshots are private: the panel asks the worker, which holds the
  // device credential, and only for steps scrolled into view.
  assert.match(source, /type: "GET_GUIDE_MEDIA"/);
  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /root: elements\.guidesPanel/);
  assert.match(source, /guideStepGeometry\(pending, result\)/);
  assert.match(source, /step\.media\?\.mediaId && currentConnection\?\.connected/);
  assert.match(backgroundSource, /case "GET_GUIDE_MEDIA":/);
  assert.match(backgroundSource, /media: normalizeCompanionMedia\(step\?\.media\)/);
  assert.match(backgroundSource, /\.filter\(\(region\) => region\?\.applied !== true\)/);
  assert.match(apiClient, /export async function fetchGuideMedia\(mediaId\)/);
  assert.match(apiClient, /\/media\/" \+ encodeURIComponent\(id\)/);
  assert.match(apiClient, /isAcceptedScreenshotType\(contentType\)/);
  assert.match(apiClient, /export async function fetchCompanionLibrary\(\)/);
  assert.match(apiClient, /authorizedFetch\("\/library"\)/);
  assert.match(backgroundSource, /case "REFRESH_LIBRARY":/);
  assert.match(backgroundSource, /dropCompanionGuideByMedia/);
  assert.match(backgroundSource, /error\?\.status === 404/);
  assert.match(source, /type: "REFRESH_LIBRARY"/);
  assert.match(source, /refreshCompanion\(\{ pull: true \}\)/);
  assert.match(source, /function applyStoredCompanion\(\)/);
  assert.doesNotMatch(source, /Open KnowHow once to sync/);
});

test("the whole guide panel scrolls while the walkthrough action dock stays sticky", async () => {
  const [css, source] = await Promise.all([
    readFile(new URL("../src/popup/popup.css", import.meta.url), "utf8"),
    readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8"),
  ]);

  function rule(selector) {
    const match = css.match(
      new RegExp("^\\" + selector + " \\{([^}]*)\\}", "m"),
    );
    assert.ok(match, selector + " is missing");
    return match[1];
  }

  assert.match(rule(".guide-library"), /overflow: auto/);
  assert.match(rule(".guide-results"), /overflow: visible/);
  assert.match(rule(".guide-follow"), /flex: 0 0 auto/);
  assert.match(rule(".guide-follow"), /overflow: visible/);
  assert.match(rule(".guide-follow-steps"), /overflow: visible/);
  assert.match(rule(".guide-follow-steps"), /grid-auto-rows: max-content/);
  assert.match(rule(".guide-follow-steps"), /gap: 11px/);
  assert.match(rule(".guide-follow-step"), /border-radius: 14px/);
  assert.match(rule(".guide-follow-actions"), /position: sticky/);
  assert.match(rule(".guide-follow-actions"), /bottom: -12px/);
  assert.match(rule(".guide-follow-actions"), /flex: 0 0 auto/);
  assert.match(rule(".guide-follow-actions"), /box-shadow/);

  // Guide steps reuse the Capture card anatomy and keep the full-width
  // screenshot below the copy row.
  assert.doesNotMatch(rule(".guide-step-figure"), /grid-column/);
  assert.match(source, /item\.className = "guide-follow-step step-card"/);
  assert.match(source, /button\.className = "guide-step-select step-card-copy"/);
  assert.match(source, /copy\.className = "step-card-text"/);
  assert.match(source, /number\.className = "step-number"/);
  assert.match(source, /if \(figure\) item\.append\(figure\)/);
  assert.match(rule(".guide-step-figure"), /width: calc\(100% - 18px\)/);

  // Walking with Next keeps the current step in sight, and opening or leaving a
  // guide starts at the top of the panel.
  assert.match(source, /renderGuideFollow\(\{ reveal: true \}\)/);
  assert.match(source, /children\[activeGuideStep\]\?\.scrollIntoView/);
  assert.match(source, /elements\.guidesPanel\.scrollTop = 0/);
});
