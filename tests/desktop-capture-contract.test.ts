import assert from "node:assert/strict";
import test from "node:test";
import {
  isCapturedGuideSource,
  validateDesktopCaptureInteraction,
  validateDesktopCaptureScope,
  validateDesktopCaptureSession,
} from "../lib/guide-contracts";

function privacyPolicy(textInputCapture: "none" | "exact-non-password") {
  return {
    excludePasswordFields: true,
    captureRawKeystrokes: false,
    captureClipboard: false,
    captureIncognito: false,
    retainUnredactedScreenshots: false,
    textInputCapture,
    autoRedactionCategories: ["email", "form-field"],
    assistedRedactionCategories: ["common-name", "long-text"],
  };
}

function textEntry(passwordStatus: "not-password" | "password" | "unknown") {
  return {
    id: "step-text-1",
    type: "desktop-interaction",
    kind: "text-entry",
    occurredAt: "2026-08-20T10:00:01.000Z",
    displayId: "display-primary",
    windowId: "window-notepad",
    target: {
      applicationName: "Notepad",
      windowTitle: "Untitled - Notepad",
      controlRole: "Edit",
      controlLabel: "Text editor",
      bounds: { x: -1200, y: 80, width: 900, height: 600 },
      passwordStatus,
    },
    text: "Exact non-password text",
    instruction: "Enter Exact non-password text in Text editor in Notepad",
  };
}

test("desktop capture v2 accepts mixed-coordinate scopes and exact non-password text", () => {
  const scope = {
    kind: "monitor",
    monitorId: "display-primary",
    monitorName: "Left display",
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    excludedWindowIds: ["knowhow-main", "knowhow-hud"],
  };
  assert.equal(validateDesktopCaptureScope(scope).success, true);
  assert.equal(validateDesktopCaptureInteraction(textEntry("not-password")).success, true);

  const session = {
    schemaVersion: 2,
    source: "desktop-capture",
    captureId: "capture-desktop-1",
    workspaceId: "workspace-acme",
    state: "recording",
    startedAt: "2026-08-20T10:00:00.000Z",
    scope,
    privacyPolicy: privacyPolicy("exact-non-password"),
    pauses: [],
    events: [textEntry("not-password")],
    draftBlocks: [],
  };
  assert.equal(validateDesktopCaptureSession(session).success, true);
  assert.equal(isCapturedGuideSource("browser-capture"), true);
  assert.equal(isCapturedGuideSource("desktop-capture"), true);
  assert.equal(isCapturedGuideSource("manual"), false);
});

test("desktop capture v2 fails closed for password uncertainty and disabled text", () => {
  const uncertain = validateDesktopCaptureInteraction(textEntry("unknown"));
  assert.equal(uncertain.success, false);
  assert.match(
    uncertain.issues.map((item) => item.message).join("\n"),
    /Exact text is forbidden/i,
  );

  const session = {
    schemaVersion: 2,
    source: "desktop-capture",
    captureId: "capture-desktop-2",
    workspaceId: "workspace-acme",
    state: "recording",
    startedAt: "2026-08-20T10:00:00.000Z",
    scope: {
      kind: "all-displays",
      monitorIds: ["display-primary", "display-secondary"],
      excludedWindowIds: ["knowhow-main", "knowhow-hud"],
    },
    privacyPolicy: privacyPolicy("none"),
    pauses: [],
    events: [textEntry("not-password")],
    draftBlocks: [],
  };
  const disabled = validateDesktopCaptureSession(session);
  assert.equal(disabled.success, false);
  assert.match(
    disabled.issues.map((item) => item.message).join("\n"),
    /Text is disabled by this capture privacy policy/i,
  );
});

test("desktop scope contracts enforce owned dialogs and a display-per-action model", () => {
  assert.equal(
    validateDesktopCaptureScope({
      kind: "window",
      windowId: "window-1",
      applicationName: "Microsoft Word",
      includeOwnedDialogs: false,
      excludedWindowIds: [],
    }).success,
    false,
  );

  const drag = validateDesktopCaptureInteraction({
    id: "step-drag-1",
    type: "desktop-interaction",
    kind: "drag",
    occurredAt: "2026-08-20T10:00:02.000Z",
    displayId: "display-secondary",
    point: { x: 40, y: 40 },
    target: {
      applicationName: "File Explorer",
      passwordStatus: "not-password",
    },
    instruction: "Drag the selected item in File Explorer",
  });
  assert.equal(drag.success, false);
  assert.match(drag.issues.map((item) => item.message).join("\n"), /destination/i);
});
