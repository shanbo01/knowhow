"use client";

import { account } from "./appwrite";

let cachedJwt: { value: string; expiresAt: number } | null = null;

export function clearApiCredential() {
  cachedJwt = null;
}

async function getJwt() {
  const now = Date.now();
  if (cachedJwt && cachedJwt.expiresAt > now + 30_000) return cachedJwt.value;

  const result = await account.createJWT();
  cachedJwt = { value: result.jwt, expiresAt: now + 11 * 60_000 };
  return result.jwt;
}

export async function rivetApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const jwt = await getJwt();
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${jwt}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the status-based fallback for non-JSON infrastructure errors.
    }

    if (response.status === 401) clearApiCredential();
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function rivetCommand<T>(action: string, payload: unknown = {}) {
  return rivetApi<T>("/api/rivet", {
    method: "POST",
    body: JSON.stringify({ action, payload }),
  });
}

export async function downloadAuthorizedExport(
  workspaceId: string,
  guideId: string,
  format: "pdf" | "html" | "markdown",
) {
  const jwt = await getJwt();
  const params = new URLSearchParams({ workspaceId, guideId, format });
  const response = await fetch(`/api/rivet/export?${params}`, {
    headers: { authorization: `Bearer ${jwt}` },
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
      ?.match(/filename="([^"]+)"/)?.[1] ?? `rivet-guide.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function downloadAuditCsv(
  workspaceId: string,
  filters: { action?: string; from?: string; to?: string } = {},
) {
  const jwt = await getJwt();
  const params = new URLSearchParams({ workspaceId });
  if (filters.action) params.set("action", filters.action);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);

  const response = await fetch(`/api/rivet/audit?${params}`, {
    headers: { authorization: `Bearer ${jwt}` },
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
      ?.match(/filename="([^"]+)"/)?.[1] ?? "rivet-audit.csv";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function authorizedBlob(path: string, init: RequestInit = {}) {
  const jwt = await getJwt();
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) clearApiCredential();
    throw new Error(payload.error ?? `Media request failed (${response.status})`);
  }
  return response.blob();
}

export async function loadAuthorizedMediaUrl(
  workspaceId: string,
  mediaId: string,
) {
  const params = new URLSearchParams({ workspaceId, mediaId });
  const blob = await authorizedBlob(`/api/rivet/media?${params}`);
  return URL.createObjectURL(blob);
}

export async function uploadWorkspaceLogo(workspaceId: string, file: File) {
  const jwt = await getJwt();
  const params = new URLSearchParams({ workspaceId, kind: "logo" });
  const response = await fetch(`/api/rivet/media?${params}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": file.type,
      "x-rivet-file-name": encodeURIComponent(file.name),
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

export async function removeWorkspaceLogo(workspaceId: string) {
  const jwt = await getJwt();
  const params = new URLSearchParams({ workspaceId, kind: "logo" });
  const response = await fetch(`/api/rivet/media?${params}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${jwt}` },
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
}) {
  const jwt = await getJwt();
  const params = new URLSearchParams({
    kind: "screenshot",
    workspaceId: input.workspaceId,
    guideId: input.guideId,
    revisionId: input.revisionId,
    stepId: input.stepId,
  });
  const response = await fetch(`/api/rivet/media?${params}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": input.bytes.type,
      "x-rivet-redacted": "true",
      "x-rivet-source-rasterized": "true",
      "x-rivet-image-width": String(input.width),
      "x-rivet-image-height": String(input.height),
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
