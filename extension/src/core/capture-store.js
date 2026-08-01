const DATABASE_NAME = "rivet-capture";
const DATABASE_VERSION = 1;
const STEP_STORE = "steps";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STEP_STORE)) {
        const store = database.createObjectStore(STEP_STORE, {
          keyPath: ["sessionId", "id"],
        });
        store.createIndex("bySession", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open capture storage."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Capture storage request failed."));
  });
}

async function withStore(mode, action) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STEP_STORE, mode);
    const store = transaction.objectStore(STEP_STORE);
    const completion = new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error || new Error("Capture storage failed."));
      transaction.onabort = () =>
        reject(transaction.error || new Error("Capture storage aborted."));
    });
    try {
      const result = await action(store);
      await completion;
      return result;
    } catch (error) {
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function putCapturedStep(step) {
  if (!step?.sessionId || !step?.id || !(step.imageBlob instanceof Blob)) {
    throw new TypeError("A captured step requires IDs and a redacted image Blob.");
  }
  return withStore("readwrite", (store) => requestResult(store.put(step)));
}

export async function listCapturedSteps(sessionId) {
  if (!sessionId) return [];
  return withStore("readonly", async (store) => {
    const index = store.index("bySession");
    const steps = await requestResult(index.getAll(sessionId));
    return steps.sort((left, right) => left.order - right.order);
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

export async function deleteCaptureSession(sessionId) {
  if (!sessionId) return;
  return withStore("readwrite", async (store) => {
    const index = store.index("bySession");
    const keys = await requestResult(index.getAllKeys(sessionId));
    await Promise.all(keys.map((key) => requestResult(store.delete(key))));
  });
}

export async function clearAllCapturedSteps() {
  return withStore("readwrite", (store) => requestResult(store.clear()));
}
