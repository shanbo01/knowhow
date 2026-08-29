export {
  contextualCrop,
  projectClickToCrop,
  thumbnailGeometry,
} from "../core/presentation.js";

function imageRevision(step) {
  const blob = step?.imageBlob;
  if (!(blob instanceof Blob) && typeof step?.previewRevision === "string") {
    return step.previewRevision;
  }
  return [
    step?.updatedAt || step?.capturedAt || "",
    blob?.size || 0,
    blob?.type || "",
    step?.imageWidth || 0,
    step?.imageHeight || 0,
  ].join("|");
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function withoutPreviewBlob(step) {
  if (!(step?.imageBlob instanceof Blob)) return step;
  const metadata = { ...step };
  delete metadata.imageBlob;
  return {
    ...metadata,
    previewRevision: imageRevision(step),
  };
}

export function orderedSteps(steps = []) {
  return [...steps].sort((left, right) => {
    const orderDelta = Number(left?.order || 0) - Number(right?.order || 0);
    if (orderDelta) return orderDelta;
    return String(left?.capturedAt || "").localeCompare(
      String(right?.capturedAt || ""),
    );
  });
}

export function createRefreshGate() {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return token === latest;
    },
  };
}

export function liveFeedVisible(state) {
  return Boolean(state?.sessionId) &&
    ["recording", "paused"].includes(state.status);
}

export function createCapturedStepCache({
  getSteps,
  getStep,
  listSteps,
  maxBatchSize = 24,
  maxRetainedBlobs = 12,
  maxRetainedBlobBytes = 48 * 1024 * 1024,
}) {
  if (
    (typeof getSteps !== "function" && typeof getStep !== "function") ||
    typeof listSteps !== "function"
  ) {
    throw new TypeError("Step cache requires batch and legacy capture readers.");
  }
  const batchSize = positiveInteger(maxBatchSize, 24);
  const retainedBlobLimit = nonNegativeLimit(maxRetainedBlobs, 12);
  const retainedByteLimit = nonNegativeLimit(
    maxRetainedBlobBytes,
    48 * 1024 * 1024,
  );
  const readBatch =
    typeof getSteps === "function"
      ? getSteps
      : async (sessionId, stepIds) =>
          Promise.all(stepIds.map((stepId) => getStep(sessionId, stepId)));

  const sessions = new Map();

  function sessionCache(sessionId) {
    let cache = sessions.get(sessionId);
    if (!cache) {
      cache = {
        steps: new Map(),
        pending: new Map(),
        legacyPromise: null,
        batchTail: Promise.resolve(),
        previewOrder: [],
      };
      sessions.set(sessionId, cache);
    }
    return cache;
  }

  function enforcePreviewBudget(cache) {
    const retained = new Set();
    let retainedCount = 0;
    let retainedBytes = 0;
    for (const stepId of [...cache.previewOrder].reverse()) {
      const step = cache.steps.get(stepId);
      if (
        !step ||
        !(step.imageBlob instanceof Blob)
      ) {
        continue;
      }
      const size = Math.max(0, Number(step.imageBlob.size) || 0);
      if (
        retainedCount >= retainedBlobLimit ||
        retainedBytes + size > retainedByteLimit
      ) {
        continue;
      }
      retained.add(stepId);
      retainedCount += 1;
      retainedBytes += size;
    }
    for (const [stepId, step] of cache.steps) {
      if (step?.imageBlob instanceof Blob && !retained.has(stepId)) {
        cache.steps.set(stepId, withoutPreviewBlob(step));
      }
    }
  }

  function queueBatch(cache, sessionId, stepIds) {
    const run = cache.batchTail.then(async () => {
      const steps = await readBatch(sessionId, stepIds);
      for (const step of steps || []) {
        if (step?.id && stepIds.includes(step.id)) {
          cache.steps.set(step.id, step);
        }
      }
      enforcePreviewBudget(cache);
    });
    cache.batchTail = run.catch(() => undefined);
    for (const stepId of stepIds) {
      let pending;
      pending = run
        .then(() => cache.steps.get(stepId) || null)
        .finally(() => {
          if (cache.pending.get(stepId) === pending) {
            cache.pending.delete(stepId);
          }
        });
      cache.pending.set(stepId, pending);
    }
  }

  async function loadMissing(cache, sessionId, stepIds) {
    const missing = stepIds.filter(
      (stepId) => !cache.steps.has(stepId) && !cache.pending.has(stepId),
    );
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      queueBatch(cache, sessionId, missing.slice(offset, offset + batchSize));
    }
    await Promise.all(
      stepIds.map((stepId) =>
        cache.steps.has(stepId)
          ? cache.steps.get(stepId)
          : cache.pending.get(stepId),
      ),
    );
  }

  async function loadLegacy(cache, sessionId) {
    if (!cache.legacyPromise) {
      cache.legacyPromise = Promise.resolve(listSteps(sessionId)).then(
        (steps) => {
          for (const step of steps || []) {
            if (step?.id) cache.steps.set(step.id, step);
          }
          cache.previewOrder = orderedSteps(cache.steps.values()).map(
            (step) => step.id,
          );
          enforcePreviewBudget(cache);
        },
      ).catch((error) => {
        cache.legacyPromise = null;
        throw error;
      });
    }
    await cache.legacyPromise;
  }

  return {
    async load(state) {
      const sessionId = state?.sessionId;
      if (!sessionId) return [];
      const cache = sessionCache(sessionId);

      if (Array.isArray(state.stepIds)) {
        const stepIds = [
          ...new Set(
            state.stepIds.filter(
              (stepId) => typeof stepId === "string" && stepId,
            ),
          ),
        ];
        cache.previewOrder = stepIds;
        await loadMissing(cache, sessionId, stepIds);
        if (
          Number.isInteger(state.stepCount) &&
          state.stepCount !== stepIds.length
        ) {
          await loadLegacy(cache, sessionId);
          const ordered = orderedSteps(cache.steps.values());
          cache.previewOrder = ordered.map((step) => step.id);
          enforcePreviewBudget(cache);
          return ordered;
        }
        enforcePreviewBudget(cache);
        return stepIds
          .map((stepId) => cache.steps.get(stepId))
          .filter(Boolean);
      }

      await loadLegacy(cache, sessionId);
      const ordered = orderedSteps(cache.steps.values());
      cache.previewOrder = ordered.map((step) => step.id);
      enforcePreviewBudget(cache);
      return ordered;
    },

    stats(sessionId) {
      const cache = sessions.get(sessionId);
      if (!cache) {
        return { steps: 0, pending: 0, retainedBlobs: 0, retainedBlobBytes: 0 };
      }
      let retainedBlobs = 0;
      let retainedBlobBytes = 0;
      for (const step of cache.steps.values()) {
        if (!(step?.imageBlob instanceof Blob)) continue;
        retainedBlobs += 1;
        retainedBlobBytes += Math.max(0, Number(step.imageBlob.size) || 0);
      }
      return {
        steps: cache.steps.size,
        pending: cache.pending.size,
        retainedBlobs,
        retainedBlobBytes,
      };
    },

    clear(sessionId) {
      if (sessionId) sessions.delete(sessionId);
      else sessions.clear();
    },
  };
}

export function createThumbnailUrlCache(
  urlApi = URL,
  { maxEntries = 12, maxBlobBytes = 48 * 1024 * 1024 } = {},
) {
  const entries = new Map();
  const entryLimit = nonNegativeLimit(maxEntries, 12);
  const byteLimit = nonNegativeLimit(maxBlobBytes, 48 * 1024 * 1024);
  let retainedBytes = 0;

  function release(stepId) {
    const entry = entries.get(stepId);
    if (!entry) return;
    urlApi.revokeObjectURL(entry.url);
    retainedBytes -= entry.size;
    entries.delete(stepId);
  }

  function enforceLimits() {
    while (
      entries.size > entryLimit ||
      retainedBytes > byteLimit
    ) {
      const oldestStepId = entries.keys().next().value;
      if (oldestStepId === undefined) break;
      release(oldestStepId);
    }
  }

  return {
    get(step) {
      if (!step?.id || !(step.imageBlob instanceof Blob)) return null;
      const revision = imageRevision(step);
      const current = entries.get(step.id);
      if (current?.revision === revision) {
        entries.delete(step.id);
        entries.set(step.id, current);
        return current.url;
      }
      release(step.id);
      const size = Math.max(0, Number(step.imageBlob.size) || 0);
      if (entryLimit === 0 || size > byteLimit) return null;
      const url = urlApi.createObjectURL(step.imageBlob);
      entries.set(step.id, { revision, size, url });
      retainedBytes += size;
      enforceLimits();
      return entries.has(step.id) ? url : null;
    },

    prune(stepIds) {
      const retained = new Set(stepIds);
      for (const stepId of entries.keys()) {
        if (!retained.has(stepId)) release(stepId);
      }
      enforceLimits();
    },

    stats() {
      return { entries: entries.size, retainedBlobBytes: retainedBytes };
    },

    dispose() {
      for (const stepId of [...entries.keys()]) release(stepId);
    },
  };
}

/**
 * The instruction line is a full sentence and the title is the same phrase
 * without its full stop, so a plain inequality let every card print `Click
 * "Support"` directly above `Click "Support".` Comparing without the trailing
 * punctuation keeps the second line for instructions that actually say
 * something the title does not.
 */
function saysTheSameThing(left, right) {
  const bare = (value) =>
    String(value || "")
      .replace(/[.!?\s]+$/, "")
      .toLowerCase();
  return bare(left) === bare(right);
}

export function stepCopy(step) {
  if (step?.captureStatus === "capturing" && step?.textOnly !== true) {
    return {
      title: "Saving screenshot…",
      detail: String(step?.title || "Capturing the pre-action view.").trim(),
    };
  }
  if (step?.captureStatus === "needs_attention") {
    return {
      title: "Screenshot needs attention",
      detail: String(
        step?.error || "Retry this screenshot, or delete this step.",
      ).trim(),
    };
  }
  if (step?.sourceEvent === "navigation") {
    const url = String(step.sanitizedUrl || "").trim();
    const title = String(step?.title || "").trim();
    const instructions = String(step?.instructions || "").trim();
    return {
      title: title || (url ? "Navigate to " + url : "Navigate to the next page"),
      detail:
        instructions && !saysTheSameThing(instructions, title)
          ? instructions
          : "",
    };
  }

  const title = String(step?.title || "Captured action").trim();
  const instructions = String(step?.instructions || "").trim();
  return {
    title,
    detail:
        instructions && !saysTheSameThing(instructions, title)
          ? instructions
          : "",
  };
}

export function captureFeedSteps(state, storedSteps = []) {
  const entries = Array.isArray(state?.captureEntries)
    ? [...state.captureEntries].sort(
        (left, right) => Number(left.order || 0) - Number(right.order || 0),
      )
    : [];
  if (!entries.length) return orderedSteps(storedSteps);
  const storedById = new Map(storedSteps.map((step) => [step.id, step]));
  const announced = new Set(entries.map((entry) => entry.stepId));
  const feed = entries.map((entry) => {
    const stored = storedById.get(entry.stepId);
    // A note carries its whole self on the entry — a sentence, no image — so it
    // renders without waiting on the stored copy. Requiring that copy meant a
    // step with nothing left to do could still sit under "Saving screenshot…".
    if (entry.textOnly === true) {
      return {
        ...(stored || {}),
        id: entry.stepId || `entry:${entry.id}`,
        entryId: entry.id,
        order: entry.order,
        sourceEvent: entry.sourceEvent || "type",
        captureStatus: "ready",
        textOnly: true,
        title: stored?.title || entry.context?.title || "",
        instructions: stored?.instructions || entry.context?.instructions || "",
        sanitizedUrl:
          stored?.sanitizedUrl || entry.context?.sanitizedUrl || "",
      };
    }
    if (entry.status === "ready" && stored) {
      return {
        ...stored,
        entryId: entry.id,
        captureStatus: "ready",
        ...(entry.textOnly === true ? { textOnly: true } : {}),
        ...(entry.showsResultOfAction === true
          ? { showsResultOfAction: true }
          : {}),
      };
    }
    return {
      id: entry.stepId || `entry:${entry.id}`,
      entryId: entry.id,
      order: entry.order,
      sourceEvent: entry.sourceEvent || entry.kind || "click",
      captureStatus:
        entry.status === "needs_attention" ? "needs_attention" : "capturing",
      title: entry.context?.title || "Capturing the pre-action view",
      instructions: entry.context?.instructions || "",
      sanitizedUrl: entry.context?.sanitizedUrl || "",
      error: entry.error || "",
      ...(Array.isArray(entry.context?.keys) && entry.context.keys.length
        ? { keys: entry.context.keys }
        : {}),
      ...(entry.textOnly === true ? { textOnly: true } : {}),
      ...(entry.screenshotMissing === true ? { screenshotMissing: true } : {}),
      ...(entry.showsResultOfAction === true
        ? { showsResultOfAction: true }
        : {}),
    };
  });
  for (const step of storedSteps) {
    if (!announced.has(step.id)) feed.push(step);
  }
  return orderedSteps(feed);
}

export function feedRevision(sessionId, steps) {
  return [
    sessionId || "",
    ...steps.map((step) =>
      [
        step.id,
        step.order,
        step.sourceEvent,
        step.title,
        step.instructions,
        step.sanitizedUrl,
        step.captureStatus,
        step.entryId,
        step.error,
        imageRevision(step),
      ].join(":"),
    ),
  ].join("|");
}
