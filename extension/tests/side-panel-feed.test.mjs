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

test("live thumbnails show the full screenshot with the click ring at its true position", () => {
  const geometry = thumbnailGeometry({
    id: "step-1",
    imageWidth: 1920,
    imageHeight: 1080,
    focusRegion: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
    clickTarget: { x: 0.5, y: 0.4, color: "#ef6f47" },
  });

  assert.deepEqual(geometry.crop, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(geometry.image, { left: 0, top: 0, width: 100, height: 100 });
  assert.ok(Math.abs(geometry.aspectRatio - 1920 / 1080) < 0.001);
  assert.ok(Math.abs(geometry.clickTarget.x - 0.5) < 0.001);
  assert.ok(Math.abs(geometry.clickTarget.y - 0.4) < 0.001);
  assert.equal(geometry.clickTarget.color, "#ef6f47");
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
  assert.match(css, /body\[data-capture-mode="active"\]/);
  assert.match(css, /\.step-feed-scroll[\s\S]*overflow-y:\s*auto/);
  assert.match(source, /capturedSteps\.load\(capture\.state\)/);
  assert.match(source, /getSteps: getCapturedSteps/);
  assert.match(source, /capturedSteps\.clear\(renderedFeedSessionId\)/);
  assert.doesNotMatch(source, /listCapturedSteps\(capture\.state\.sessionId\)/);
  assert.match(
    source,
    /step\.sourceEvent === "navigation" \? null : thumbnailUrls\.get\(step\)/,
  );
  assert.match(source, /case "preparing":/);
  assert.match(source, /state\.captureWarning \|\|/);
  assert.match(source, /STORAGE_KEYS\.captureState/);
  assert.match(source, /thumbnailUrls\.dispose\(\)/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(
    storeSource,
    /export async function getCapturedSteps\(sessionId, stepIds\)[\s\S]*Promise\.all\([\s\S]*store\.get\(\[sessionId, stepId\]\)/,
  );
});
