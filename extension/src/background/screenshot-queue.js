import { CAPTURE_LIMITS } from "../core/config.js";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Priority band for queued screenshot work.
 *
 * Chrome caps `chrome.tabs.captureVisibleTab` at two calls per second, so the
 * queue is the scarcest resource in the whole capture path. Speculative work
 * (pre-warming a frame the author may never click on) must never make the
 * author wait for the screenshot that belongs to a click they actually made.
 */
export const ScreenshotPriority = Object.freeze({
  INTERACTION: 0,
  NAVIGATION: 1,
  PREPARED: 2,
});

/**
 * Serializes screenshot work and spaces out the calls that actually reach
 * `chrome.tabs.captureVisibleTab`, which Chrome caps at two per second.
 *
 * Tasks receive a `reserveSlot()` callback and must await it immediately
 * before capturing. Work that ends up not capturing — a step that adopts an
 * already-taken pre-click screenshot, or one that bails out during validation
 * — never pays the interval, so it cannot push the next real capture past the
 * moment it was supposed to photograph.
 *
 * `reserveSlot()` resolves to false when the wait would exceed `deadlineMs`.
 * Callers that need a frame from a specific moment (pre-click screenshots)
 * pass a deadline and give up instead of storing a stale frame.
 *
 * Work is dispatched by priority rather than strictly in arrival order. A
 * click that lands while a speculative pre-warm is still waiting for its slot
 * takes the next slot instead of queueing behind it, and pending speculative
 * work is discarded as soon as newer speculative work supersedes it.
 */
export function createScreenshotQueue({
  minimumIntervalMs = CAPTURE_LIMITS.minimumScreenshotIntervalMs,
  now = () => Date.now(),
  readLastCaptureStartedAt = async () => 0,
  writeLastCaptureStartedAt = async () => undefined,
} = {}) {
  const pending = [];
  let draining = false;
  let lastCaptureStartedAt = 0;
  let sequence = 0;
  let hydrated = false;

  function takeNext() {
    let bestIndex = -1;
    for (const [index, item] of pending.entries()) {
      if (
        bestIndex === -1 ||
        item.priority < pending[bestIndex].priority ||
        (item.priority === pending[bestIndex].priority &&
          item.sequence < pending[bestIndex].sequence)
      ) {
        bestIndex = index;
      }
    }
    return bestIndex === -1 ? null : pending.splice(bestIndex, 1)[0];
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      let item;
      while ((item = takeNext())) {
        if (item.abandoned) {
          item.resolve(null);
          continue;
        }
        let reserved = false;
        const reserveSlot = async () => {
          if (reserved) return true;
          if (!hydrated) {
            hydrated = true;
            const persisted = Number(await readLastCaptureStartedAt()) || 0;
            lastCaptureStartedAt = Math.max(lastCaptureStartedAt, persisted);
          }
          const remaining = minimumIntervalMs - (now() - lastCaptureStartedAt);
          if (remaining > 0) {
            if (
              item.deadlineMs !== null &&
              remaining + now() - item.queuedAt > item.deadlineMs
            ) {
              return false;
            }
            await wait(remaining);
          }
          lastCaptureStartedAt = now();
          // Persisting the timestamp keeps the interval honest across service
          // worker restarts, but the capture itself must not wait on storage:
          // the in-memory value already paces this worker on its own.
          void Promise.resolve(writeLastCaptureStartedAt(lastCaptureStartedAt)).catch(
            () => undefined,
          );
          reserved = true;
          return true;
        };
        try {
          item.resolve(await item.task(reserveSlot));
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      draining = false;
      if (pending.length) void drain();
    }
  }

  function enqueue(
    task,
    { deadlineMs = null, priority = ScreenshotPriority.INTERACTION, supersedes = null } = {},
  ) {
    if (supersedes) {
      for (const item of pending) {
        if (item.supersedes === supersedes) item.abandoned = true;
      }
    }
    sequence += 1;
    let resolve;
    let reject;
    const promise = new Promise((resolveTask, rejectTask) => {
      resolve = resolveTask;
      reject = rejectTask;
    });
    pending.push({
      task,
      deadlineMs,
      priority,
      supersedes,
      sequence,
      queuedAt: now(),
      abandoned: false,
      resolve,
      reject,
    });
    void drain();
    return promise;
  }

  return enqueue;
}

export const enqueueScreenshot = createScreenshotQueue();
