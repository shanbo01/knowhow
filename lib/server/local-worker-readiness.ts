import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppwriteServerConfig } from "./appwrite-config";

const HEARTBEAT_PATH = resolve(".tmp/local-workers-heartbeat.json");
const HEARTBEAT_MAX_AGE_MS = 6 * 60_000;
const HEARTBEAT_MAX_FUTURE_SKEW_MS = 60_000;

type WorkerHeartbeat = {
  version?: unknown;
  mode?: unknown;
  ok?: unknown;
  generatedAt?: unknown;
  projectFingerprint?: unknown;
  operations?: { ok?: unknown; notificationFailures?: unknown };
  exports?: { ok?: unknown; failures?: unknown };
  queue?: { due?: unknown; terminalFailed?: unknown };
};

export type LocalWorkerReadiness = {
  enabled: boolean;
  ready: boolean;
  state: "disabled" | "invalid" | "missing" | "stale" | "failed" | "ready";
  ageMs?: number;
};

function expectedProjectFingerprint(projectId: string) {
  return createHash("sha256")
    .update(`project\0${projectId}`)
    .digest("hex");
}

function exactLocalEndpoint(raw: string) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.pathname.replace(/\/$/, "") === "/v1" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function localWorkerReadiness(
  config: AppwriteServerConfig,
  now = new Date(),
): Promise<LocalWorkerReadiness> {
  const requested = process.env.KNOWHOW_LOCAL_WORKER_MODE === "emulated";
  if (!requested || config.environment !== "development") {
    return { enabled: false, ready: true, state: "disabled" };
  }
  if (
    config.projectId !== "knowhow-local" ||
    config.databaseId !== "knowhow_core" ||
    !exactLocalEndpoint(config.endpoint)
  ) {
    return { enabled: true, ready: false, state: "invalid" };
  }
  let parsed: WorkerHeartbeat;
  try {
    parsed = JSON.parse(await readFile(HEARTBEAT_PATH, "utf8")) as WorkerHeartbeat;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      enabled: true,
      ready: false,
      state: code === "ENOENT" ? "missing" : "invalid",
    };
  }
  const generatedAt =
    typeof parsed.generatedAt === "string" ? Date.parse(parsed.generatedAt) : NaN;
  const ageMs = now.getTime() - generatedAt;
  if (
    parsed.version !== 1 ||
    parsed.mode !== "full" ||
    parsed.projectFingerprint !== expectedProjectFingerprint(config.projectId) ||
    !Number.isFinite(ageMs)
  ) {
    return { enabled: true, ready: false, state: "invalid" };
  }
  if (ageMs > HEARTBEAT_MAX_AGE_MS || ageMs < -HEARTBEAT_MAX_FUTURE_SKEW_MS) {
    return { enabled: true, ready: false, state: "stale", ageMs };
  }
  const ready =
    parsed.ok === true &&
    parsed.operations?.ok === true &&
    parsed.operations.notificationFailures === 0 &&
    parsed.exports?.ok === true &&
    parsed.exports.failures === 0 &&
    parsed.queue?.due === 0 &&
    parsed.queue.terminalFailed === 0;
  return {
    enabled: true,
    ready,
    state: ready ? "ready" : "failed",
    ageMs,
  };
}

export { HEARTBEAT_MAX_AGE_MS, HEARTBEAT_PATH, exactLocalEndpoint };
