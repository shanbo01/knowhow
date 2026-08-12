import "server-only";

import { HttpError } from "./http-security";

const MAX_CLOCK_SKEW_MILLISECONDS = 5 * 60_000;

function workerSecret() {
  const value = process.env.KNOWHOW_EXPORT_WORKER_SECRET?.trim() ?? "";
  if (value.length < 32) {
    throw new HttpError(503, "EXPORT_WORKER_NOT_CONFIGURED", "Export processing is unavailable.", {
      expose: false,
    });
  }
  return value;
}

function hexadecimal(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(timestamp: string, jobId: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(workerSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hexadecimal(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${jobId}`),
      ),
    ),
  );
}

function constantEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function assertExportWorkerRequest(
  request: Request,
  jobId: string,
  now = Date.now(),
) {
  const timestamp = request.headers.get("x-knowhow-worker-timestamp") ?? "";
  const supplied = request.headers.get("x-knowhow-worker-signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new HttpError(401, "WORKER_AUTH_INVALID", "Worker authentication failed.");
  }
  const parsed = Number(timestamp);
  if (!Number.isSafeInteger(parsed) || Math.abs(now - parsed) > MAX_CLOCK_SKEW_MILLISECONDS) {
    throw new HttpError(401, "WORKER_AUTH_EXPIRED", "Worker authentication expired.");
  }
  const expected = await signature(timestamp, jobId);
  if (!constantEqual(supplied, expected)) {
    throw new HttpError(401, "WORKER_AUTH_INVALID", "Worker authentication failed.");
  }
}
