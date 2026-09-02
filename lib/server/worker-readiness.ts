import "server-only";

import { Query } from "node-appwrite";
import type { Functions } from "node-appwrite";
import type { AppwriteServerConfig } from "./appwrite-config";
import { localWorkerReadiness } from "./local-worker-readiness";

export type WorkerReadiness = {
  enabled: boolean;
  ready: boolean;
  mode: "disabled" | "local" | "remote" | "scheduled";
  state:
    | "disabled"
    | "invalid"
    | "missing"
    | "stale"
    | "failed"
    | "ready";
  ageMs?: number;
};

export const OPERATIONS_FUNCTION_ID = "knowhow-operations";

/**
 * How long the operations function may go without a completed run before the
 * deployment is considered stale. It is scheduled every five minutes, so this
 * tolerates three consecutive misses — long enough that one slow or requeued
 * execution does not take the deployment out of rotation, short enough that a
 * genuinely stopped worker is caught within a quarter of an hour.
 */
const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

function configuredMaxAgeMs() {
  const raw = Number(process.env.KNOWHOW_WORKER_MAX_AGE_MS?.trim());
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_MAX_AGE_MS;
}

function remoteHealthUrl(raw: string) {
  if (raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.pathname === "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ["localhost", "127.0.0.1"].includes(url.hostname) ||
      raw !== url.toString()
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Readiness from Appwrite's own execution history.
 *
 * The workers are Appwrite Functions on a schedule, so Appwrite already records
 * whether each run happened and whether it succeeded. Reading that is more
 * truthful than a heartbeat the worker writes about itself — a worker wedged
 * mid-run cannot report its own failure, but a missing execution is visible
 * from outside.
 */
async function scheduledWorkerReadiness(
  functions: Pick<Functions, "listExecutions">,
  now: Date,
): Promise<WorkerReadiness> {
  const functionId =
    process.env.KNOWHOW_OPERATIONS_FUNCTION_ID?.trim() || OPERATIONS_FUNCTION_ID;
  let executions;
  try {
    executions = await functions.listExecutions({
      functionId,
      queries: [
        Query.equal("trigger", ["schedule"]),
        Query.orderDesc("$createdAt"),
        Query.limit(1),
      ],
      total: false,
    });
  } catch {
    // A missing function, a revoked key, or an unreachable Appwrite are all
    // indistinguishable here and all mean the same thing: readiness cannot be
    // established, so the deployment must not claim to be ready.
    return { enabled: true, ready: false, mode: "scheduled", state: "invalid" };
  }

  const latest = executions.executions?.[0];
  if (!latest) {
    return { enabled: true, ready: false, mode: "scheduled", state: "missing" };
  }

  const startedAt = Date.parse(latest.$createdAt);
  if (!Number.isFinite(startedAt)) {
    return { enabled: true, ready: false, mode: "scheduled", state: "invalid" };
  }
  const ageMs = now.getTime() - startedAt;
  if (ageMs > configuredMaxAgeMs() || ageMs < -MAX_FUTURE_SKEW_MS) {
    return { enabled: true, ready: false, mode: "scheduled", state: "stale", ageMs };
  }
  if (latest.status === "failed") {
    return { enabled: true, ready: false, mode: "scheduled", state: "failed", ageMs };
  }
  // `waiting` and `processing` are a run in flight, not a fault. The age check
  // above is what catches one that never finishes.
  return { enabled: true, ready: true, mode: "scheduled", state: "ready", ageMs };
}

export async function workerReadiness(
  config: AppwriteServerConfig,
  options: {
    fetcher?: typeof fetch;
    now?: Date;
    functions?: Pick<Functions, "listExecutions">;
  } = {},
): Promise<WorkerReadiness> {
  const now = options.now ?? new Date();
  if (config.environment === "development" || config.environment === "test") {
    const local = await localWorkerReadiness(config, now);
    return {
      ...local,
      mode: local.enabled ? "local" : "disabled",
    };
  }

  // An external worker service stays supported for a deployment that runs the
  // handlers somewhere other than Appwrite Functions; configuring it opts out
  // of the execution-history path entirely.
  const configuredHealthUrl = process.env.KNOWHOW_WORKER_HEALTH_URL?.trim() ?? "";
  const token = process.env.KNOWHOW_WORKER_HEALTH_TOKEN?.trim() ?? "";
  if (!configuredHealthUrl && !token) {
    if (!options.functions) {
      return { enabled: true, ready: false, mode: "scheduled", state: "invalid" };
    }
    return scheduledWorkerReadiness(options.functions, now);
  }

  const healthUrl = remoteHealthUrl(configuredHealthUrl);
  if (!healthUrl || token.length < 32) {
    return {
      enabled: true,
      ready: false,
      mode: "remote",
      state: "invalid",
    };
  }

  try {
    const response = await (options.fetcher ?? fetch)(healthUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return { enabled: true, ready: false, mode: "remote", state: "failed" };
    }
    const payload = (await response.json()) as {
      status?: unknown;
      release?: unknown;
    };
    const expectedRelease = process.env.KNOWHOW_RELEASE?.trim();
    const releaseMatches =
      typeof payload.release !== "string" ||
      !expectedRelease ||
      payload.release === expectedRelease;
    const ready = payload.status === "ready" && releaseMatches;
    return {
      enabled: true,
      ready,
      mode: "remote",
      state: ready ? "ready" : "failed",
    };
  } catch {
    return { enabled: true, ready: false, mode: "remote", state: "failed" };
  }
}

export { remoteHealthUrl, configuredMaxAgeMs, DEFAULT_MAX_AGE_MS };
