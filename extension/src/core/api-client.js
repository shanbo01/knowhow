import { API_PREFIX, KNOWHOW_ORIGIN, STORAGE_KEYS } from "./config.js";
import { sanitizeCapturedText } from "./redaction.js";

function randomBase64Url(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function apiUrl(path) {
  return new URL(API_PREFIX + path, KNOWHOW_ORIGIN).href;
}

async function readAuth() {
  const local = await chrome.storage.local.get(STORAGE_KEYS.auth);
  const session = await chrome.storage.session.get(STORAGE_KEYS.auth);
  return {
    ...(local[STORAGE_KEYS.auth] || {}),
    ...(session[STORAGE_KEYS.auth] || {}),
  };
}

async function storeAuth(auth) {
  await Promise.all([
    chrome.storage.local.set({
      [STORAGE_KEYS.auth]: {
        refreshToken: auth.refreshToken || null,
        workspaceId: auth.workspaceId || null,
        connectedAt: new Date().toISOString(),
      },
    }),
    chrome.storage.session.set({
      [STORAGE_KEYS.auth]: {
        accessToken: auth.accessToken,
        expiresAt: auth.expiresAt,
      },
    }),
  ]);
}

async function parseResponse(response) {
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    throw new Error(
      body.error ||
        body.message ||
        "KnowHow API returned HTTP " + String(response.status) + ".",
    );
  }
  return body;
}

async function forgetAuth() {
  await Promise.all([
    chrome.storage.local.remove(STORAGE_KEYS.auth),
    chrome.storage.session.remove(STORAGE_KEYS.auth),
  ]);
}

async function toolbarPinned() {
  try {
    if (typeof chrome === "undefined" || !chrome.action?.getUserSettings) {
      return undefined;
    }
    const settings = await chrome.action.getUserSettings();
    return Boolean(settings?.isOnToolbar);
  } catch {
    return undefined;
  }
}

async function refreshAccessToken(auth) {
  if (!auth.refreshToken) {
    throw new Error("Open KnowHow while signed in to connect this browser.");
  }
  const pinned = await toolbarPinned();
  const response = await fetch(apiUrl("/token/refresh"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refreshToken: auth.refreshToken,
      ...(pinned === true ? { toolbarPinned: true } : {}),
    }),
  });
  // A revoked or expired credential is dropped rather than retried forever:
  // once it is gone, opening KnowHow reconnects this browser automatically.
  if (response.status === 401 || response.status === 403) {
    await forgetAuth();
    throw new Error(
      "This browser's KnowHow access ended. Open KnowHow to reconnect it.",
    );
  }
  const next = await parseResponse(response);
  await storeAuth({ ...auth, ...next });
  return { ...auth, ...next };
}

async function authorizedFetch(path, init = {}) {
  let auth = await readAuth();
  const expiresAt = Date.parse(auth.expiresAt || "");
  if (
    !auth.accessToken ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() + 30_000
  ) {
    auth = await refreshAccessToken(auth);
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...init.headers,
      Authorization: "Bearer " + auth.accessToken,
    },
  });
  return parseResponse(response);
}

const MAX_GUIDE_MEDIA_BYTES = 6 * 1024 * 1024;

function bytesToDataUrl(bytes, contentType) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return "data:" + contentType + ";base64," + btoa(binary);
}

/**
 * Reads a guide screenshot with the paired device credential and returns it as
 * a data URL. The side panel cannot fetch KnowHow media directly — the objects
 * are private and the popup has no session cookie — and blob URLs minted in the
 * service worker are not readable from the panel document, so the bytes travel
 * inline.
 */
export async function fetchGuideMedia(mediaId) {
  const id = String(mediaId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error("KnowHow could not read this step screenshot.");
  }
  let auth = await readAuth();
  const expiresAt = Date.parse(auth.expiresAt || "");
  if (
    !auth.accessToken ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() + 30_000
  ) {
    auth = await refreshAccessToken(auth);
  }
  const response = await fetch(apiUrl("/media/" + encodeURIComponent(id)), {
    headers: { Authorization: "Bearer " + auth.accessToken },
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 404
        ? "This step screenshot is no longer available."
        : "KnowHow returned HTTP " + String(response.status) + " for a screenshot.",
    );
    error.status = response.status;
    throw error;
  }
  const contentType = (response.headers.get("content-type") || "").split(";")[0];
  if (!isAcceptedScreenshotType(contentType)) {
    throw new Error("KnowHow returned an unsupported screenshot format.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_GUIDE_MEDIA_BYTES) {
    throw new Error("This step screenshot is too large to preview.");
  }
  return {
    dataUrl: bytesToDataUrl(new Uint8Array(buffer), contentType),
    contentType,
  };
}

export function isValidPairingCode(value) {
  return /^[A-HJ-NP-Z2-9]{12,20}$/.test(
    String(value || "").trim().toUpperCase(),
  );
}

export async function beginKnowHowPairing(code) {
  const pairingCode = String(code || "").trim().toUpperCase();
  if (!isValidPairingCode(pairingCode)) {
    throw new Error("Enter the 12-character one-time pairing code shown in KnowHow.");
  }
  const local = await chrome.storage.local.get("knowhow.capture.device-id");
  const deviceId =
    local["knowhow.capture.device-id"] || "browser-" + randomBase64Url(18);
  await chrome.storage.local.set({ "knowhow.capture.device-id": deviceId });

  const tokenResponse = await fetch(apiUrl("/pair"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pairingCode,
      deviceId,
      extensionVersion: chrome.runtime.getManifest().version,
    }),
  });
  const auth = await parseResponse(tokenResponse);
  await storeAuth(auth);
  return auth;
}

export async function getConnectionState() {
  const auth = await readAuth();
  return {
    connected: Boolean(auth.accessToken || auth.refreshToken),
    workspaceId: auth.workspaceId || null,
  };
}

export async function getKnowHowContext() {
  return authorizedFetch("/context");
}

export async function fetchCompanionLibrary() {
  return authorizedFetch("/library");
}

export async function beginRemoteCapture(capture) {
  return authorizedFetch("/captures", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": capture.sessionId,
    },
    body: JSON.stringify({
      sessionId: capture.sessionId,
      title: capture.title,
      workspaceId: capture.workspaceId,
      policyVersion: capture.policyVersion,
      sanitizedUrl: capture.sanitizedUrl,
      stepCount: 0,
    }),
  });
}

export function isAcceptedScreenshotType(value) {
  return value === "image/jpeg" || value === "image/png";
}

export async function setRemoteExpectedSteps(captureId, expectedSteps) {
  return authorizedFetch(
    "/captures/" + encodeURIComponent(captureId),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedSteps }),
    },
  );
}

export function pauseRemoteCapture(captureId) {
  return authorizedFetch(
    "/captures/" + encodeURIComponent(captureId) + "/pause",
    { method: "POST" },
  );
}

export function resumeRemoteCapture(captureId) {
  return authorizedFetch(
    "/captures/" + encodeURIComponent(captureId) + "/resume",
    { method: "POST" },
  );
}

export function discardRemoteCapture(captureId) {
  return authorizedFetch("/captures/" + encodeURIComponent(captureId), {
    method: "DELETE",
  });
}

export function preparePrivateDraftSteps(steps, policy = {}) {
  return steps.map((step) => ({
    ...step,
    title:
      sanitizeCapturedText(step.title, policy, 200) || "Captured step",
    instructions:
      sanitizeCapturedText(step.instructions, policy, 2_000) ||
      "Follow the highlighted action.",
  }));
}

export async function submitPrivateDraft({ capture, steps, policy = {} }) {
  const preparedSteps = preparePrivateDraftSteps(steps, policy);
  let created = { captureId: capture.remoteCaptureId };
  if (!created.captureId) {
    created = await beginRemoteCapture(capture);
    await setRemoteExpectedSteps(created.captureId, preparedSteps.length);
    await resumeRemoteCapture(created.captureId);
  }

  for (const step of preparedSteps) {
    if (step.sourceEvent === "navigation" && !(step.imageBlob instanceof Blob)) {
      continue;
    }
    const imageType = step.imageBlob?.type || "";
    if (!isAcceptedScreenshotType(imageType)) {
      throw new Error("KnowHow accepts only locally rasterized JPEG or PNG screenshots.");
    }
    const path =
      "/captures/" +
      encodeURIComponent(created.captureId) +
      "/steps/" +
      encodeURIComponent(step.id) +
      "/screenshot";
    await authorizedFetch(path, {
      method: "PUT",
      headers: {
        "Content-Type": imageType,
        "X-KnowHow-Redacted": "true",
        "X-KnowHow-Source-Rasterized": "true",
        "X-KnowHow-Image-Width": String(step.imageWidth || 1),
        "X-KnowHow-Image-Height": String(step.imageHeight || 1),
        "Idempotency-Key": capture.sessionId + ":" + step.id,
        "X-KnowHow-Step-Title": encodeURIComponent(step.title.slice(0, 100)),
      },
      body: step.imageBlob,
    });
  }

  return authorizedFetch(
    "/captures/" + encodeURIComponent(created.captureId) + "/commit",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": capture.sessionId + ":commit",
      },
      body: JSON.stringify({
        steps: preparedSteps.map((step, index) => ({
          id: step.id,
          order: index,
          title: step.title,
          instructions: step.instructions,
          sanitizedUrl: step.sanitizedUrl,
          sourceEvent: step.sourceEvent,
          ...(step.clickTarget ? { clickTarget: step.clickTarget } : {}),
          ...(step.focusRegion ? { focusRegion: step.focusRegion } : {}),
          ...(step.crop ? { crop: step.crop } : {}),
          automaticMaskCount: step.automaticMaskCount || 0,
          manualMaskCount: step.manualMaskCount || 0,
          redactions: Array.isArray(step.pendingRedactions)
            ? step.pendingRedactions
            : [],
        })),
        privacyReview: {
          completedAt: new Date().toISOString(),
          policyVersion: capture.policyVersion,
          automaticMaskCount: preparedSteps.reduce(
            (total, step) => total + (Number(step.automaticMaskCount) || 0),
            0,
          ),
          manualMaskCount: preparedSteps.reduce(
            (total, step) => total + (Number(step.manualMaskCount) || 0),
            0,
          ),
        },
      }),
    },
  );
}
