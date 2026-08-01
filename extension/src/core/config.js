export const RIVET_ORIGIN =
  "http://localhost:3001";

export const API_PREFIX = "/api/extension";
export const CONTENT_SCRIPT_PATH = "src/content/capture.js";
export const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";
export const REVIEW_PAGE_PATH = "src/review/review.html";

export const STORAGE_KEYS = Object.freeze({
  captureState: "rivet.capture.state",
  capturePolicy: "rivet.capture.policy",
  workspaceContext: "rivet.capture.workspace-context",
  pendingRemoteDiscards: "rivet.capture.pending-remote-discards",
  auth: "rivet.capture.auth",
});

export const CAPTURE_LIMITS = Object.freeze({
  maxSteps: 100,
  minimumScreenshotIntervalMs: 550,
  maxScreenshotBytes: 2_000_000,
  maxLabelCharacters: 100,
});
