import { CAPTURE_LIMITS } from "../core/config.js";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createScreenshotQueue({
  minimumIntervalMs = CAPTURE_LIMITS.minimumScreenshotIntervalMs,
} = {}) {
  let queue = Promise.resolve();
  let lastCaptureStartedAt = 0;

  return function enqueue(task) {
    const run = async () => {
      const elapsed = Date.now() - lastCaptureStartedAt;
      const remaining = minimumIntervalMs - elapsed;
      if (remaining > 0) await wait(remaining);
      lastCaptureStartedAt = Date.now();
      return task();
    };

    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };
}

export const enqueueScreenshot = createScreenshotQueue();
