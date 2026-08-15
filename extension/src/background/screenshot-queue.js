import { CAPTURE_LIMITS } from "../core/config.js";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
 */
export function createScreenshotQueue({
  minimumIntervalMs = CAPTURE_LIMITS.minimumScreenshotIntervalMs,
  now = () => Date.now(),
  readLastCaptureStartedAt = async () => 0,
  writeLastCaptureStartedAt = async () => undefined,
} = {}) {
  let queue = Promise.resolve();
  let lastCaptureStartedAt = 0;

  return function enqueue(task, { deadlineMs = null } = {}) {
    const queuedAt = now();
    const run = async () => {
      let reserved = false;
      const reserveSlot = async () => {
        if (reserved) return true;
        const persisted = Number(await readLastCaptureStartedAt()) || 0;
        lastCaptureStartedAt = Math.max(lastCaptureStartedAt, persisted);
        const remaining = minimumIntervalMs - (now() - lastCaptureStartedAt);
        if (remaining > 0) {
          if (deadlineMs !== null && remaining + now() - queuedAt > deadlineMs) {
            return false;
          }
          await wait(remaining);
        }
        lastCaptureStartedAt = now();
        await writeLastCaptureStartedAt(lastCaptureStartedAt);
        reserved = true;
        return true;
      };
      return task(reserveSlot);
    };

    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };
}

export const enqueueScreenshot = createScreenshotQueue();
