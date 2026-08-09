export const KNOWHOW_ORIGIN =
  "http://localhost:3001";

export const API_PREFIX = "/api/extension";
export const CONTENT_SCRIPT_PATH = "src/content/capture.js";
export const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";

export const STORAGE_KEYS = Object.freeze({
  captureState: "knowhow.capture.state",
  capturePolicy: "knowhow.capture.policy",
  workspaceContext: "knowhow.capture.workspace-context",
  pendingRemoteDiscards: "knowhow.capture.pending-remote-discards",
  auth: "knowhow.capture.auth",
  companion: "knowhow.capture.companion",
});

export const CAPTURE_LIMITS = Object.freeze({
  maxSteps: 100,
  minimumScreenshotIntervalMs: 550,
  maxScreenshotBytes: 2_000_000,
  maxLabelCharacters: 100,
});
