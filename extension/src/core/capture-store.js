const DATABASE_NAME = "knowhow-capture";
const DATABASE_VERSION = 2;
const STEP_STORE = "steps";
const FRAME_STORE = "captureFrames";

// One connection is shared by every read and write. Opening and closing a
// connection per operation cost several milliseconds each on the click path,
// and a close racing an in-flight open could block the next transaction
// outright. The handle is dropped whenever the browser closes or supersedes
// it, so the next call transparently reopens.
let databaseConnection = null;

function openDatabase() {
  if (databaseConnection) return databaseConnection;
  databaseConnection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STEP_STORE)) {
        const store = database.createObjectStore(STEP_STORE, {
          keyPath: ["sessionId", "id"],
        });
        store.createIndex("bySession", "sessionId", { unique: false });
      }
      if (!database.objectStoreNames.contains(FRAME_STORE)) {
        const store = database.createObjectStore(FRAME_STORE, {
          keyPath: ["sessionId", "id"],
        });
        store.createIndex("bySession", "sessionId", { unique: false });
        store.createIndex("byInteraction", ["sessionId", "interactionId"], {
          unique: false,
        });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        databaseConnection = null;
        database.close();
      };
      database.onclose = () => {
        databaseConnection = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databaseConnection = null;
      reject(request.error || new Error("Could not open capture storage."));
    };
    request.onblocked = () => {
      databaseConnection = null;
      reject(new Error("Capture storage is blocked by another connection."));
    };
  });
  return databaseConnection;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Capture storage request failed."));
  });
}

async function withStores(storeNames, mode, action) {
  let database = await openDatabase();
  let transaction;
  try {
    transaction = database.transaction(storeNames, mode);
  } catch (error) {
    // A connection the browser closed underneath us (profile eviction, a
    // version change from another context) throws InvalidStateError here.
    // Reopen once rather than surfacing a lost screenshot to the author.
    if (databaseConnection) databaseConnection = null;
    database = await openDatabase();
    if (!database) throw error;
    transaction = database.transaction(storeNames, mode);
  }
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("Capture storage failed."));
    transaction.onabort = () =>
      reject(transaction.error || new Error("Capture storage aborted."));
  });
  try {
    const result = await action(transaction);
    await completion;
    return result;
  } catch (error) {
    await completion.catch(() => undefined);
    throw error;
  }
}

async function withStore(mode, action) {
  return withStores([STEP_STORE], mode, (transaction) =>
    action(transaction.objectStore(STEP_STORE)),
  );
}

async function withFrameStore(mode, action) {
  return withStores([FRAME_STORE], mode, (transaction) =>
    action(transaction.objectStore(FRAME_STORE)),
  );
}

export async function putCapturedStep(step) {
  if (!step?.sessionId || !step?.id) {
    throw new TypeError("A captured step requires IDs.");
  }
  const textOnlyNavigation =
    step.sourceEvent === "navigation" && !(step.imageBlob instanceof Blob);
  if (!textOnlyNavigation && !(step.imageBlob instanceof Blob)) {
    throw new TypeError("A captured step requires IDs and a redacted image Blob.");
  }
  return withStore("readwrite", (store) => requestResult(store.put(step)));
}

export async function putCaptureFrame(frame) {
  if (!frame?.sessionId || !frame?.id || !(frame.imageBlob instanceof Blob)) {
    throw new TypeError("A prepared frame requires IDs and a redacted image Blob.");
  }
  return withFrameStore("readwrite", (store) => requestResult(store.put(frame)));
}

export async function getCaptureFrame(sessionId, frameId) {
  if (!sessionId || !frameId) return null;
  return withFrameStore("readonly", (store) =>
    requestResult(store.get([sessionId, frameId])),
  );
}

export async function getCaptureFrameForInteraction(sessionId, interactionId) {
  if (!sessionId || !interactionId) return null;
  return withFrameStore("readonly", async (store) => {
    const index = store.index("byInteraction");
    const frames = await requestResult(index.getAll([sessionId, interactionId]));
    return frames.sort(
      (left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0),
    )[0] || null;
  });
}

export async function deleteCaptureFrame(sessionId, frameId) {
  if (!sessionId || !frameId) return;
  return withFrameStore("readwrite", (store) =>
    requestResult(store.delete([sessionId, frameId])),
  );
}

export async function pruneCaptureFrames(
  sessionId,
  { retainIds = [], olderThan = Number.POSITIVE_INFINITY } = {},
) {
  if (!sessionId) return [];
  const retained = new Set(retainIds.filter(Boolean));
  return withFrameStore("readwrite", async (store) => {
    const index = store.index("bySession");
    const frames = await requestResult(index.getAll(sessionId));
    const deleted = [];
    for (const frame of frames) {
      if (retained.has(frame.id)) continue;
      if (Number(frame.createdAtMs || 0) > olderThan) continue;
      await requestResult(store.delete([sessionId, frame.id]));
      deleted.push(frame.id);
    }
    return deleted;
  });
}

export async function promoteCaptureFrame(sessionId, frameId, step) {
  if (!sessionId || !frameId || !step?.id) {
    throw new TypeError("Promoting a prepared frame requires frame and step IDs.");
  }
  return withStores([FRAME_STORE, STEP_STORE], "readwrite", async (transaction) => {
    const frames = transaction.objectStore(FRAME_STORE);
    const steps = transaction.objectStore(STEP_STORE);
    const frame = await requestResult(frames.get([sessionId, frameId]));
    if (!frame?.imageBlob) throw new Error("The prepared screenshot is no longer available.");
    const capturedStep = {
      ...step,
      sessionId,
      imageBlob: frame.imageBlob,
      imageWidth: frame.imageWidth,
      imageHeight: frame.imageHeight,
      pendingRedactions: frame.pendingRedactions || [],
      automaticMaskCount: Number(frame.automaticMaskCount || 0),
      manualMaskCount: Number(frame.manualMaskCount || 0),
      updatedAt: new Date().toISOString(),
    };
    await requestResult(steps.put(capturedStep));
    await requestResult(frames.delete([sessionId, frameId]));
    return capturedStep;
  });
}

export async function listCapturedSteps(sessionId) {
  if (!sessionId) return [];
  return withStore("readonly", async (store) => {
    const index = store.index("bySession");
    const steps = await requestResult(index.getAll(sessionId));
    return steps.sort((left, right) => left.order - right.order);
  });
}

export async function getCapturedStep(sessionId, stepId) {
  if (!sessionId || !stepId) return null;
  const [step] = await getCapturedSteps(sessionId, [stepId]);
  return step || null;
}

export async function getCapturedSteps(sessionId, stepIds) {
  if (!sessionId || !Array.isArray(stepIds) || !stepIds.length) return [];
  const requestedIds = [
    ...new Set(
      stepIds.filter((stepId) => typeof stepId === "string" && stepId),
    ),
  ];
  if (!requestedIds.length) return [];

  return withStore("readonly", async (store) => {
    const steps = await Promise.all(
      requestedIds.map((stepId) =>
        requestResult(store.get([sessionId, stepId])),
      ),
    );
    return steps.filter(Boolean);
  });
}

export async function updateCapturedStep(sessionId, stepId, updates) {
  return withStore("readwrite", async (store) => {
    const current = await requestResult(store.get([sessionId, stepId]));
    if (!current) throw new Error("Captured step was not found.");
    const next = {
      ...current,
      ...updates,
      sessionId,
      id: stepId,
      updatedAt: new Date().toISOString(),
    };
    await requestResult(store.put(next));
    return next;
  });
}

export async function deleteCapturedStep(sessionId, stepId) {
  return withStore("readwrite", (store) =>
    requestResult(store.delete([sessionId, stepId])),
  );
}

export async function deleteCapturedStepAndCompact(
  sessionId,
  stepId,
  orderedStepIds,
) {
  if (!sessionId || !stepId) return;
  const remainingIds = Array.isArray(orderedStepIds)
    ? [...new Set(orderedStepIds.filter(Boolean))]
    : [];
  return withStore("readwrite", async (store) => {
    await requestResult(store.delete([sessionId, stepId]));
    for (const [order, remainingId] of remainingIds.entries()) {
      const current = await requestResult(store.get([sessionId, remainingId]));
      if (!current || current.order === order) continue;
      await requestResult(
        store.put({
          ...current,
          order,
          updatedAt: new Date().toISOString(),
        }),
      );
    }
  });
}

export async function deleteCaptureSession(sessionId) {
  if (!sessionId) return;
  return withStores([STEP_STORE, FRAME_STORE], "readwrite", async (transaction) => {
    for (const storeName of [STEP_STORE, FRAME_STORE]) {
      const store = transaction.objectStore(storeName);
      const index = store.index("bySession");
      const keys = await requestResult(index.getAllKeys(sessionId));
      for (const key of keys) await requestResult(store.delete(key));
    }
  });
}

export async function clearAllCapturedSteps() {
  return withStores([STEP_STORE, FRAME_STORE], "readwrite", async (transaction) => {
    await requestResult(transaction.objectStore(STEP_STORE).clear());
    await requestResult(transaction.objectStore(FRAME_STORE).clear());
  });
}
