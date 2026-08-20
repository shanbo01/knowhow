import "server-only";

import type { AppwriteServerConfig } from "./appwrite-config";
import { localWorkerReadiness } from "./local-worker-readiness";

export type WorkerReadiness = {
  enabled: boolean;
  ready: boolean;
  mode: "disabled" | "local" | "remote";
  state:
    | "disabled"
    | "invalid"
    | "missing"
    | "stale"
    | "failed"
    | "ready";
  ageMs?: number;
};

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

export async function workerReadiness(
  config: AppwriteServerConfig,
  options: {
    fetcher?: typeof fetch;
    now?: Date;
  } = {},
): Promise<WorkerReadiness> {
  if (config.environment === "development" || config.environment === "test") {
    const local = await localWorkerReadiness(config, options.now);
    return {
      ...local,
      mode: local.enabled ? "local" : "disabled",
    };
  }

  const healthUrl = remoteHealthUrl(
    process.env.KNOWHOW_WORKER_HEALTH_URL?.trim() ?? "",
  );
  const token = process.env.KNOWHOW_WORKER_HEALTH_TOKEN?.trim() ?? "";
  if (!healthUrl || token.length < 32) {
    return {
      enabled: true,
      ready: false,
      mode: "remote",
      state: healthUrl || token ? "invalid" : "missing",
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

export { remoteHealthUrl };
