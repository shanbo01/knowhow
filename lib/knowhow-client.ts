"use client";

import type { GuideSearchResult } from "./knowhow-types";

export class KnowHowApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    status: number,
    message: string,
    details: { code?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = "KnowHowApiError";
    this.status = status;
    this.code = details.code;
    this.requestId = details.requestId;
  }
}

let reauthenticationHandler: (() => Promise<void>) | null = null;
let reauthenticationInFlight: Promise<void> | null = null;

export function registerReauthenticationHandler(
  handler: (() => Promise<void>) | null,
) {
  reauthenticationHandler = handler;
  return () => {
    if (reauthenticationHandler === handler) reauthenticationHandler = null;
  };
}

async function reauthenticateOnce() {
  if (!reauthenticationHandler) return false;
  if (!reauthenticationInFlight) {
    reauthenticationInFlight = reauthenticationHandler().finally(() => {
      reauthenticationInFlight = null;
    });
  }
  await reauthenticationInFlight;
  return true;
}

export function clearApiCredential() {
  // Retained for callers during the session-cookie migration. Credentials are
  // HTTP-only now, so there is no browser token cache to clear.
}

function csrfToken() {
  if (typeof document === "undefined") return "";
  const prefix = "knowhow_csrf=";
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

export async function knowhowApi<T>(
  path: string,
  init: RequestInit = {},
  allowReauthentication = true,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())
        ? { "x-csrf-token": csrfToken() }
        : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    let requestId: string | undefined;
    try {
      const payload = (await response.json()) as {
        error?: string;
        code?: string;
        requestId?: string;
      };
      if (payload.error) message = payload.error;
      code = payload.code;
      requestId = payload.requestId;
    } catch {
      // Keep the status-based fallback for non-JSON infrastructure errors.
    }

    if (response.status === 401) clearApiCredential();
    if (
      allowReauthentication &&
      code === "TOTP_REAUTH_REQUIRED" &&
      (await reauthenticateOnce())
    ) {
      return knowhowApi<T>(path, init, false);
    }
    throw new KnowHowApiError(response.status, message, { code, requestId });
  }

  return (await response.json()) as T;
}

export function knowhowCommand<T>(action: string, payload: unknown = {}) {
  return knowhowApi<T>("/api/knowhow", {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ action, payload }),
  });
}

export function searchGuides(workspaceId: string, query: string) {
  const params = new URLSearchParams({
    workspaceId,
    q: query.slice(0, 300),
  });
  return knowhowApi<{ results: GuideSearchResult[] }>(`/api/knowhow/search?${params}`);
}

export async function downloadAuthorizedExport(
  workspaceId: string,
  guideId: string,
  format: "pdf" | "html" | "markdown",
) {
  const queued = await knowhowApi<{
    jobId: string;
    status: string;
    pollAfterMs: number;
  }>("/api/knowhow/export", {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ workspaceId, guideId, format }),
  });
  const deadline = Date.now() + 150_000;
  let status = queued.status;
  let failure = "";
  while (status !== "ready" && Date.now() < deadline) {
    if (status === "failed" || status === "expired") break;
    await new Promise((resolve) =>
      window.setTimeout(resolve, Math.max(500, queued.pollAfterMs || 750)),
    );
    const state = await knowhowApi<{ status: string; error?: string }>(
      `/api/knowhow/export?${new URLSearchParams({ jobId: queued.jobId })}`,
    );
    status = state.status;
    failure = state.error ?? "";
  }
  if (status !== "ready") {
    throw new Error(
      failure ||
        (status === "expired"
          ? "The export expired before it was downloaded."
          : status === "failed"
            ? "The export could not be created."
            : "The export is still processing. Try again in a moment."),
    );
  }
  const params = new URLSearchParams({ jobId: queued.jobId, download: "1" });
  const response = await fetch(`/api/knowhow/export?${params}`, {
    credentials: "same-origin",
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error ?? `Export failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] ?? `knowhow-guide.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function downloadAuditCsv(
  workspaceId: string,
  filters: { action?: string; from?: string; to?: string } = {},
) {
  const params = new URLSearchParams({ workspaceId });
  if (filters.action) params.set("action", filters.action);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);

  const response = await fetch(`/api/knowhow/audit?${params}`, {
    credentials: "same-origin",
    headers: { accept: "text/csv" },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) clearApiCredential();
    throw new Error(payload.error ?? `Audit export failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] ?? "knowhow-audit.csv";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function authorizedBlob(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())
        ? { "x-csrf-token": csrfToken() }
        : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) clearApiCredential();
    throw new KnowHowApiError(
      response.status,
      payload.error ?? `Media request failed (${response.status})`,
    );
  }
  return response.blob();
}

type MediaCacheEntry = {
  url: string;
  refs: number;
  promise?: Promise<string>;
};

const mediaUrlCache = new Map<string, MediaCacheEntry>();

function mediaCacheKey(workspaceId: string, mediaId: string) {
  return `${workspaceId}:${mediaId}`;
}

async function fetchAuthorizedMediaUrl(
  workspaceId: string,
  mediaId: string,
  retries = 3,
) {
  const params = new URLSearchParams({ workspaceId, mediaId });
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
      const blob = await authorizedBlob(`/api/knowhow/media?${params}`);
      return URL.createObjectURL(blob);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof KnowHowApiError &&
        (error.status === 404 || error.status === 409);
      if (!retryable || attempt === retries) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The protected screenshot could not be loaded.");
}

export async function acquireAuthorizedMediaUrl(
  workspaceId: string,
  mediaId: string,
) {
  const key = mediaCacheKey(workspaceId, mediaId);
  const existing = mediaUrlCache.get(key);
  if (existing?.url) {
    existing.refs += 1;
    return existing.url;
  }
  if (existing?.promise) {
    existing.refs += 1;
    return existing.promise;
  }
  const entry: MediaCacheEntry = { url: "", refs: 1 };
  const promise = fetchAuthorizedMediaUrl(workspaceId, mediaId)
    .then((url) => {
      entry.url = url;
      entry.promise = undefined;
      if (entry.refs <= 0) {
        URL.revokeObjectURL(url);
        mediaUrlCache.delete(key);
        throw new Error("The protected screenshot is no longer in use.");
      }
      return url;
    })
    .catch((error) => {
      entry.promise = undefined;
      if (entry.refs <= 0 || !entry.url) mediaUrlCache.delete(key);
      throw error;
    });
  entry.promise = promise;
  mediaUrlCache.set(key, entry);
  return promise;
}

export function releaseAuthorizedMediaUrl(workspaceId: string, mediaId: string) {
  const key = mediaCacheKey(workspaceId, mediaId);
  const entry = mediaUrlCache.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.promise) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    mediaUrlCache.delete(key);
  }
}

export async function refreshAuthorizedMediaUrl(
  workspaceId: string,
  mediaId: string,
) {
  const key = mediaCacheKey(workspaceId, mediaId);
  const existing = mediaUrlCache.get(key);
  const previousUrl = existing?.url || "";
  const url = await fetchAuthorizedMediaUrl(workspaceId, mediaId);
  const entry = mediaUrlCache.get(key) ?? { url: "", refs: 1 };
  entry.url = url;
  entry.promise = undefined;
  mediaUrlCache.set(key, entry);
  if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
  return url;
}

export async function loadAuthorizedMediaUrl(
  workspaceId: string,
  mediaId: string,
) {
  return fetchAuthorizedMediaUrl(workspaceId, mediaId);
}

/** Loads the current workspace logo through the existing private media boundary. */
export async function loadAuthorizedWorkspaceLogoUrl(workspaceId: string) {
  const params = new URLSearchParams({ workspaceId, kind: "logo" });
  const blob = await authorizedBlob(`/api/knowhow/media?${params}`);
  return URL.createObjectURL(blob);
}

export async function uploadWorkspaceLogo(workspaceId: string, file: File) {
  const params = new URLSearchParams({ workspaceId, kind: "logo" });
  const response = await fetch(`/api/knowhow/media?${params}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": file.type,
      "x-knowhow-file-name": encodeURIComponent(file.name),
      "x-csrf-token": csrfToken(),
    },
    body: file,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) clearApiCredential();
    throw new Error(payload.error ?? `Logo upload failed (${response.status})`);
  }
  return (await response.json()) as { configured: true };
}

export async function uploadProvisioningLogo(runId: string, file: File) {
  const params = new URLSearchParams({ kind: "provisioning-logo", runId });
  const response = await fetch(`/api/knowhow/media?${params}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": file.type,
      "x-knowhow-file-name": encodeURIComponent(file.name),
      "x-csrf-token": csrfToken(),
    },
    body: file,
  });
  const body = (await response.json().catch(() => ({}))) as { mediaId?: string; error?: string };
  if (!response.ok || !body.mediaId) throw new Error(body.error ?? "Logo upload failed.");
  return body.mediaId;
}

export async function removeWorkspaceLogo(workspaceId: string) {
  const params = new URLSearchParams({ workspaceId, kind: "logo" });
  const response = await fetch(`/api/knowhow/media?${params}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken() },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) clearApiCredential();
    throw new Error(payload.error ?? `Logo removal failed (${response.status})`);
  }
}

export async function replaceDraftScreenshot(input: {
  workspaceId: string;
  guideId: string;
  revisionId: string;
  stepId: string;
  bytes: Blob;
  width: number;
  height: number;
  /**
   * "redacted" (default) attests these bytes are final and may never change
   * again for any redaction region they contain. Pass "pending" only for a
   * fresh manual upload with no baked-in redactions yet.
   */
  redactionState?: "pending" | "redacted";
}) {
  const params = new URLSearchParams({
    kind: "screenshot",
    workspaceId: input.workspaceId,
    guideId: input.guideId,
    revisionId: input.revisionId,
    stepId: input.stepId,
  });
  const response = await fetch(`/api/knowhow/media?${params}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": input.bytes.type,
      "x-csrf-token": csrfToken(),
      "x-knowhow-redacted": input.redactionState === "pending" ? "false" : "true",
      "x-knowhow-source-rasterized": "true",
      "x-knowhow-image-width": String(input.width),
      "x-knowhow-image-height": String(input.height),
    },
    body: input.bytes,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) clearApiCredential();
    throw new Error(payload.error ?? `Screenshot replacement failed (${response.status})`);
  }
  return (await response.json()) as { mediaId: string };
}
