import {
  CAPTURE_LIMITS,
  CONTENT_SCRIPT_PATH,
  OFFSCREEN_DOCUMENT_PATH,
  REVIEW_PAGE_PATH,
  STORAGE_KEYS,
} from "../core/config.js";
import {
  clearAllCapturedSteps,
  deleteCapturedStep,
  deleteCaptureSession,
} from "../core/capture-store.js";
import {
  beginRemoteCapture,
  beginRivetPairing,
  discardRemoteCapture,
  getConnectionState,
  getRivetContext,
  pauseRemoteCapture,
  resumeRemoteCapture,
  setRemoteExpectedSteps,
} from "../core/api-client.js";
import {
  applyWorkspaceContext,
  evaluateCaptureUrl,
  mergePolicy,
  normalizeSitePattern,
} from "../core/policy.js";
import { sanitizeCapturedText } from "../core/redaction.js";
import {
  CaptureEvent,
  CaptureStatus,
  createIdleState,
  isCollecting,
  jobIsCurrent,
  snapshotCaptureJob,
  transitionCapture,
  withStepCount,
} from "../core/state-machine.js";
import { enqueueScreenshot } from "./screenshot-queue.js";

let offscreenCreation;
let stateMutationQueue = Promise.resolve();
let remoteLifecycleQueue = Promise.resolve();

function withStateMutation(operation) {
  const result = stateMutationQueue.then(operation, operation);
  stateMutationQueue = result.catch(() => undefined);
  return result;
}

function enqueueRemoteLifecycle(operation) {
  const result = remoteLifecycleQueue.then(operation, operation);
  remoteLifecycleQueue = result.catch(() => undefined);
  return result;
}

async function pendingRemoteDiscards() {
  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.pendingRemoteDiscards,
  );
  return Array.isArray(stored[STORAGE_KEYS.pendingRemoteDiscards])
    ? stored[STORAGE_KEYS.pendingRemoteDiscards].filter(
        (item) => typeof item === "string" && item,
      )
    : [];
}

async function rememberRemoteDiscard(captureId) {
  const pending = await pendingRemoteDiscards();
  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingRemoteDiscards]: [...new Set([...pending, captureId])],
  });
}

async function forgetRemoteDiscard(captureId) {
  const pending = await pendingRemoteDiscards();
  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingRemoteDiscards]: pending.filter(
      (item) => item !== captureId,
    ),
  });
}

function remoteDiscardIsResolved(error) {
  return /capture not found|finished guide must be managed/i.test(
    String(error?.message || error),
  );
}

async function flushRemoteDiscards() {
  const pending = await pendingRemoteDiscards();
  const remaining = [];
  for (const captureId of pending) {
    try {
      await enqueueRemoteLifecycle(() => discardRemoteCapture(captureId));
    } catch (error) {
      if (!remoteDiscardIsResolved(error)) {
        remaining.push(captureId);
      }
    }
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingRemoteDiscards]: remaining,
  });
  return remaining;
}

async function cleanupRemoteCapture(captureId) {
  if (!captureId) return true;
  try {
    await enqueueRemoteLifecycle(() => discardRemoteCapture(captureId));
    await forgetRemoteDiscard(captureId);
    return true;
  } catch (error) {
    if (remoteDiscardIsResolved(error)) {
      await forgetRemoteDiscard(captureId);
      return true;
    }
    await rememberRemoteDiscard(captureId);
    return false;
  }
}

async function recordRemoteSyncWarning(state, error) {
  await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (latest.sessionId !== state.sessionId) return latest;
    const next = {
      ...latest,
      remoteSyncWarning:
        error instanceof Error ? error.message : "Remote capture state is pending.",
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
}

function syncRemoteTransition(state, transition) {
  const captureId = state.remoteCaptureId || state.sessionId;
  if (!captureId) return;
  const operation =
    transition === "pause"
      ? () => pauseRemoteCapture(captureId)
      : () => resumeRemoteCapture(captureId);
  void enqueueRemoteLifecycle(operation).catch((error) =>
    recordRemoteSyncWarning(state, error),
  );
}

async function getCaptureState() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.captureState);
  return stored[STORAGE_KEYS.captureState] || createIdleState();
}

async function setCaptureState(state) {
  await chrome.storage.session.set({
    [STORAGE_KEYS.captureState]: state,
  });
  await updateActionBadge(state);
  return state;
}

async function getLocalCapturePolicy() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.capturePolicy);
  return mergePolicy(stored[STORAGE_KEYS.capturePolicy] || {});
}

async function getStoredWorkspaceContext() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.workspaceContext);
  const context = stored[STORAGE_KEYS.workspaceContext];
  return context && typeof context === "object" ? context : null;
}

async function setWorkspaceContext(context) {
  if (
    !context ||
    typeof context.workspaceId !== "string" ||
    !context.workspaceId ||
    typeof context.policyVersion !== "string" ||
    !context.policyVersion
  ) {
    throw new Error("Rivet returned an invalid workspace capture policy.");
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.workspaceContext]: context,
  });
  return context;
}

async function refreshWorkspaceContext() {
  const connection = await getConnectionState();
  if (!connection.connected) {
    throw new Error("Connect Rivet before starting a workspace capture.");
  }
  const context = await getRivetContext();
  if (
    connection.workspaceId &&
    context.workspaceId !== connection.workspaceId
  ) {
    throw new Error("The paired workspace does not match the capture policy.");
  }
  await setWorkspaceContext(context);
  await flushRemoteDiscards();
  return context;
}

async function getCapturePolicy() {
  const [local, context] = await Promise.all([
    getLocalCapturePolicy(),
    getStoredWorkspaceContext(),
  ]);
  return context ? applyWorkspaceContext(local, context) : local;
}

async function setCapturePolicy(patch) {
  const current = await getLocalCapturePolicy();
  const merged = mergePolicy({ ...current, ...patch });
  await chrome.storage.local.set({
    [STORAGE_KEYS.capturePolicy]: merged,
  });
  const context = await getStoredWorkspaceContext();
  return context ? applyWorkspaceContext(merged, context) : merged;
}

function safeCaptureText(value, policy, maxLength, fallback) {
  const sanitized = sanitizeCapturedText(value, policy, maxLength);
  return sanitized.length >= 2 ? sanitized : fallback;
}

async function updateActionBadge(state) {
  const badges = {
    [CaptureStatus.RECORDING]: ["REC", "#dc2626"],
    [CaptureStatus.PAUSED]: ["II", "#d97706"],
    [CaptureStatus.REVIEWING]: ["REV", "#4f46e5"],
    [CaptureStatus.UPLOADING]: ["UP", "#2563eb"],
    [CaptureStatus.ERROR]: ["!", "#b91c1c"],
  };
  const [text = "", color = "#334155"] = badges[state.status] || [];
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({
    title:
      state.status === CaptureStatus.IDLE
        ? "Rivet Capture"
        : "Rivet Capture: " + state.status,
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    throw new Error("Rivet could not resolve the active browser tab.");
  }
  return tab;
}

async function sendToCapturedTab(state, message) {
  if (!Number.isInteger(state?.tabId)) return null;
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch {
    return null;
  }
}

async function injectCaptureContent(state) {
  await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    files: [CONTENT_SCRIPT_PATH],
  });
  const policy = await getCapturePolicy();
  await chrome.tabs.sendMessage(state.tabId, {
    type: "RIVET_CONFIGURE",
    sessionId: state.sessionId,
    status: state.status,
    scopeLabel: state.scopeLabel,
    policy,
  });
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (existing.length) return;

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["BLOBS"],
        justification:
          "Apply irreversible local redaction before a screenshot is stored.",
      })
      .finally(() => {
        offscreenCreation = null;
      });
  }
  await offscreenCreation;
}

async function pauseCapture(reason) {
  const paused = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (current.status !== CaptureStatus.RECORDING) return current;
    const next = transitionCapture(current, CaptureEvent.PAUSE, { reason });
    await setCaptureState(next);
    return next;
  });
  if (paused.status !== CaptureStatus.PAUSED) return paused;
  syncRemoteTransition(paused, "pause");
  await sendToCapturedTab(paused, {
    type: "RIVET_SET_STATUS",
    status: CaptureStatus.PAUSED,
    reason: paused.pausedReason,
  });
  return paused;
}

async function startCapture(options = {}) {
  const context = await refreshWorkspaceContext();
  const tab = await getActiveTab();
  if (tab.incognito) {
    throw new Error("Rivet Capture is disabled in incognito windows.");
  }
  const policy = applyWorkspaceContext(
    await getLocalCapturePolicy(),
    context,
  );
  const verdict = evaluateCaptureUrl(tab.url || "", policy);
  if (!verdict.allowed) throw new Error(verdict.reason);

  let previousSessionId;
  const next = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (
      current.status !== CaptureStatus.IDLE &&
      current.status !== CaptureStatus.COMPLETED &&
      current.status !== CaptureStatus.ERROR
    ) {
      throw new Error("Finish or discard the current capture first.");
    }
    previousSessionId = current.sessionId;
    const started = transitionCapture(current, CaptureEvent.START, {
      sessionId: crypto.randomUUID(),
      tabId: tab.id,
      windowId: tab.windowId,
      origin: verdict.origin,
      sanitizedUrl: verdict.sanitizedUrl,
      title: safeCaptureText(
        options.title || tab.title || "Captured guide",
        policy,
        200,
        "Captured guide",
      ),
      workspaceId: context.workspaceId,
      scopeLabel:
        (context.workspaceName || "Workspace") + " · " + verdict.hostname,
      policyVersion: context.policyVersion,
    });
    await setCaptureState(started);
    return started;
  });
  if (previousSessionId) await deleteCaptureSession(previousSessionId);
  let prepared = next;
  let remoteCreated = false;
  let remoteCaptureId = null;
  try {
    const remote = await enqueueRemoteLifecycle(() => beginRemoteCapture(next));
    remoteCreated = true;
    remoteCaptureId =
      typeof remote?.captureId === "string" && remote.captureId
        ? remote.captureId
        : next.sessionId;
    if (!remote?.captureId) {
      throw new Error("Rivet did not return a capture identifier.");
    }
    prepared = await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (latest.sessionId !== next.sessionId) {
        throw new Error("The capture session changed while Rivet was preparing it.");
      }
      const ready = {
        ...latest,
        remoteCaptureId: remote.captureId,
        remoteGuideId: remote.guideId,
        remoteRevisionId: remote.revisionId,
        remoteSyncWarning: null,
        updatedAt: new Date().toISOString(),
      };
      await setCaptureState(ready);
      return ready;
    });
    await injectCaptureContent(prepared);
  } catch (error) {
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        latest.sessionId !== next.sessionId ||
        latest.status !== CaptureStatus.RECORDING
      ) {
        return latest;
      }
      const failed = transitionCapture(latest, CaptureEvent.FAIL, {
        message:
          error instanceof Error
            ? error.message
            : "Rivet could not attach to this page.",
      });
      await setCaptureState(failed);
      return failed;
    });
    if (remoteCreated) await cleanupRemoteCapture(remoteCaptureId);
    throw error;
  }
  return prepared;
}

async function resumeCapture() {
  const context = await refreshWorkspaceContext();
  const current = await getCaptureState();
  if (current.workspaceId !== context.workspaceId) {
    throw new Error("Reconnect the workspace used to start this capture.");
  }
  const tab = await getActiveTab();
  if (tab.id !== current.tabId) {
    throw new Error("Return to the originally captured tab before resuming.");
  }
  if (tab.incognito) {
    throw new Error("Rivet Capture is disabled in incognito windows.");
  }
  const policy = applyWorkspaceContext(
    await getLocalCapturePolicy(),
    context,
  );
  const verdict = evaluateCaptureUrl(tab.url || "", policy);
  if (!verdict.allowed) throw new Error(verdict.reason);
  const scoped = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (latest.sessionId !== current.sessionId) {
      throw new Error("The capture session changed before it could resume.");
    }
    const resumed = transitionCapture(latest, CaptureEvent.RESUME, {
      origin: verdict.origin,
      sanitizedUrl: verdict.sanitizedUrl,
    });
    const next = {
      ...resumed,
      scopeLabel:
        (context.workspaceName || "Workspace") + " · " + verdict.hostname,
    };
    await setCaptureState(next);
    return next;
  });
  syncRemoteTransition(scoped, "resume");
  try {
    await injectCaptureContent(scoped);
  } catch (error) {
    await pauseCapture("Rivet could not safely resume on this page.");
    throw error;
  }
  return scoped;
}

async function finishCapture() {
  const reviewing = await withStateMutation(async () => {
    const current = await getCaptureState();
    const next = transitionCapture(current, CaptureEvent.FINISH);
    await setCaptureState(next);
    return next;
  });
  await sendToCapturedTab(reviewing, {
    type: "RIVET_SET_STATUS",
    status: CaptureStatus.REVIEWING,
  });
  const url =
    chrome.runtime.getURL(REVIEW_PAGE_PATH) +
    "?session=" +
    encodeURIComponent(reviewing.sessionId);
  await chrome.tabs.create({ url });
  return reviewing;
}

async function discardCapture() {
  let current;
  const discarded = await withStateMutation(async () => {
    current = await getCaptureState();
    const next = transitionCapture(current, CaptureEvent.DISCARD);
    await setCaptureState(next);
    return next;
  });
  const sessionId = current.sessionId;
  const remoteCaptureId = current.remoteCaptureId || sessionId;
  await sendToCapturedTab(current, {
    type: "RIVET_SET_STATUS",
    status: CaptureStatus.IDLE,
  });
  if (sessionId) await deleteCaptureSession(sessionId);
  const cleaned = await cleanupRemoteCapture(remoteCaptureId);
  const result = { ...discarded, remoteCleanupPending: !cleaned };
  await setCaptureState(result);
  return result;
}

async function excludeCurrentSite() {
  const tab = await getActiveTab();
  const verdict = evaluateCaptureUrl(tab.url || "", {
    ...(await getCapturePolicy()),
    excludedSites: [],
  });
  if (!verdict.origin) {
    throw new Error(verdict.reason || "This page cannot be excluded.");
  }
  const hostname = new URL(verdict.origin).hostname;
  const localPolicy = await getLocalCapturePolicy();
  const nextPolicy = await setCapturePolicy({
    excludedSites: [
      ...localPolicy.excludedSites,
      normalizeSitePattern(hostname),
    ],
  });
  const state = await getCaptureState();
  if (state.tabId === tab.id && isCollecting(state)) {
    await pauseCapture("The current site was added to the exclusion list.");
  }
  return { policy: nextPolicy, hostname };
}

async function preparePageContext(state, fallback) {
  const response = await sendToCapturedTab(state, {
    type: "RIVET_PREPARE_SCREENSHOT",
  });
  if (!response?.ok) {
    return {
      masks: fallback.masks || [],
      viewport: fallback.viewport,
      targetRect: fallback.targetRect,
      title: fallback.title,
      instructions: fallback.instructions,
      sanitizedUrl: fallback.sanitizedUrl,
    };
  }
  return {
    ...response.context,
    targetRect: fallback.targetRect || response.context.targetRect,
    title: fallback.title || response.context.title,
    instructions: fallback.instructions || response.context.instructions,
    sanitizedUrl: fallback.sanitizedUrl || response.context.sanitizedUrl,
  };
}

async function captureStep(request) {
  const snapshot = await getCaptureState();
  const generation = request.generation;
  if (!Number.isInteger(generation)) return;
  if (!jobIsCurrent(snapshot, request.sessionId, generation)) return;
  if (snapshot.stepCount >= CAPTURE_LIMITS.maxSteps) {
    await pauseCapture(
      "This capture reached the " +
        String(CAPTURE_LIMITS.maxSteps) +
        "-step safety limit.",
    );
    return;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: snapshot.windowId,
  });
  if (!activeTab || activeTab.id !== snapshot.tabId) {
    await pauseCapture("Return to the captured tab to continue.");
    return;
  }

  const policy = await getCapturePolicy();
  const verdict = evaluateCaptureUrl(request.pageUrl || activeTab.url || "", policy);
  if (!verdict.allowed) {
    await pauseCapture(verdict.reason);
    return;
  }
  if (verdict.origin !== snapshot.origin) {
    await pauseCapture(
      "The page changed origin. Resume explicitly to continue on the new site.",
    );
    return;
  }

  const context = await preparePageContext(snapshot, request);
  const beforeCapture = await getCaptureState();
  if (!jobIsCurrent(beforeCapture, snapshot.sessionId, generation)) {
    await sendToCapturedTab(snapshot, {
      type: "RIVET_RESTORE_INDICATOR",
    });
    return;
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(snapshot.windowId, {
      format: "png",
    });
  } finally {
    await sendToCapturedTab(snapshot, {
      type: "RIVET_RESTORE_INDICATOR",
    });
  }

  const afterCapture = await getCaptureState();
  if (!jobIsCurrent(afterCapture, snapshot.sessionId, generation)) {
    dataUrl = null;
    return;
  }

  await ensureOffscreenDocument();
  const stepId = crypto.randomUUID();
  const order = afterCapture.stepCount;
  const processed = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "RIVET_PROCESS_SCREENSHOT",
    dataUrl,
    step: {
      sessionId: snapshot.sessionId,
      id: stepId,
      order,
      title: safeCaptureText(
        context.title || request.title || "Captured step",
        policy,
        200,
        "Captured step",
      ),
      instructions: safeCaptureText(
        context.instructions ||
          request.instructions ||
          "Follow the highlighted action.",
        policy,
        2_000,
        "Follow the highlighted action.",
      ),
      sanitizedUrl: verdict.sanitizedUrl,
      sourceEvent: request.sourceEvent || "click",
      capturedAt: new Date().toISOString(),
    },
    masks: context.masks || request.masks || [],
    targetRect: context.targetRect || request.targetRect || null,
    viewport: context.viewport || request.viewport,
    clickTargetColor: policy.clickTargetColor,
    limits: CAPTURE_LIMITS,
  });
  dataUrl = null;
  if (!processed?.ok) {
    throw new Error(processed?.error || "Local screenshot redaction failed.");
  }

  const committed = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (!jobIsCurrent(latest, snapshot.sessionId, generation)) {
      return false;
    }
    await setCaptureState(withStepCount(latest, latest.stepCount + 1));
    return true;
  });
  if (!committed) {
    await deleteCapturedStep(snapshot.sessionId, stepId);
    return;
  }
}

async function captureNavigation(details) {
  const state = await getCaptureState();
  if (
    !isCollecting(state) ||
    state.tabId !== details.tabId ||
    details.frameId !== 0
  ) {
    return;
  }

  const policy = await getCapturePolicy();
  const verdict = evaluateCaptureUrl(details.url, policy);
  if (!verdict.allowed) {
    await pauseCapture(verdict.reason);
    return;
  }
  if (verdict.origin !== state.origin) {
    await pauseCapture(
      "The page changed origin. Resume explicitly to continue on the new site.",
    );
    return;
  }
  if (
    state.lastNavigationUrl === verdict.sanitizedUrl &&
    Date.now() - Number(state.lastNavigationAt || 0) < 2_000
  ) {
    return;
  }
  const navigationState = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !jobIsCurrent(latest, state.sessionId, state.generation) ||
      latest.tabId !== details.tabId
    ) {
      return null;
    }
    const next = {
      ...latest,
      sanitizedUrl: verdict.sanitizedUrl,
      lastNavigationUrl: verdict.sanitizedUrl,
      lastNavigationAt: Date.now(),
    };
    await setCaptureState(next);
    return next;
  });
  if (!navigationState) return;
  try {
    await injectCaptureContent(navigationState);
    const context = await sendToCapturedTab(navigationState, {
      type: "RIVET_GET_PAGE_CONTEXT",
    });
    if (!context?.ok) return;
    const job = snapshotCaptureJob(navigationState, {
        ...context.context,
        pageUrl: details.url,
        sourceEvent: "navigation",
        title: context.context.title
          ? "Open " + context.context.title
          : "Open the next page",
        instructions: "Continue on the captured page.",
        targetRect: null,
      });
    await enqueueScreenshot(() => captureStep(job));
  } catch (error) {
    await pauseCapture(
      "Rivet could not continue after navigation: " +
        (error instanceof Error ? error.message : "unknown error"),
    );
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_CAPTURE_STATE":
      return {
        ok: true,
        state: await getCaptureState(),
        policy: await getCapturePolicy(),
        context: await getStoredWorkspaceContext(),
      };
    case "START_CAPTURE":
      return { ok: true, state: await startCapture(message.options) };
    case "PAUSE_CAPTURE":
      return { ok: true, state: await pauseCapture("Paused by user") };
    case "RESUME_CAPTURE":
      return { ok: true, state: await resumeCapture() };
    case "FINISH_CAPTURE":
      return { ok: true, state: await finishCapture() };
    case "DISCARD_CAPTURE":
      return { ok: true, state: await discardCapture() };
    case "EXCLUDE_CURRENT_SITE":
      return { ok: true, ...(await excludeCurrentSite()) };
    case "CONNECT_RIVET":
      if ((await flushRemoteDiscards()).length) {
        throw new Error(
          "Rivet must finish cleaning up a previous capture before reconnecting.",
        );
      }
      await beginRivetPairing(message.code);
      return { ok: true, context: await refreshWorkspaceContext() };
    case "UPDATE_CAPTURE_POLICY":
      return {
        ok: true,
        policy: await setCapturePolicy(message.policy || {}),
      };
    case "CAPTURE_EVENT": {
      const state = await getCaptureState();
      if (
        !sender.tab ||
        sender.tab.id !== state.tabId ||
        message.sessionId !== state.sessionId ||
        !isCollecting(state)
      ) {
        return { ok: false, ignored: true };
      }
      const job = snapshotCaptureJob(state, {
          ...message.context,
          pageUrl: sender.tab.url || message.context?.pageUrl,
          sourceEvent: "click",
        });
      void enqueueScreenshot(() => captureStep(job)).catch(async (error) => {
        const latest = await getCaptureState();
        if (isCollecting(latest)) {
          await pauseCapture(
            "Screenshot capture paused: " +
              (error instanceof Error ? error.message : "unknown error"),
          );
        }
      });
      return { ok: true, queued: true };
    }
    case "BEGIN_DRAFT_UPLOAD": {
      const expectedSteps = Number(message.expectedSteps);
      if (
        !Number.isInteger(expectedSteps) ||
        expectedSteps < 1 ||
        expectedSteps > CAPTURE_LIMITS.maxSteps
      ) {
        throw new Error("The reviewed capture has an invalid final step count.");
      }
      const next = await withStateMutation(async () => {
        const current = await getCaptureState();
        const uploading = transitionCapture(
          current,
          CaptureEvent.BEGIN_UPLOAD,
        );
        await setCaptureState(uploading);
        return uploading;
      });
      const captureId = next.remoteCaptureId || next.sessionId;
      if (!captureId) throw new Error("The reviewed capture is missing its remote ID.");
      await enqueueRemoteLifecycle(() =>
        setRemoteExpectedSteps(captureId, expectedSteps),
      );
      await enqueueRemoteLifecycle(() => resumeRemoteCapture(captureId));
      return { ok: true, state: next };
    }
    case "DRAFT_UPLOAD_COMPLETE": {
      const next = await withStateMutation(async () => {
        const current = await getCaptureState();
        const completed = transitionCapture(
          current,
          CaptureEvent.COMPLETE,
          message,
        );
        await setCaptureState(completed);
        return completed;
      });
      return { ok: true, state: next };
    }
    case "DRAFT_UPLOAD_FAILED": {
      const next = await withStateMutation(async () => {
        const current = await getCaptureState();
        if (current.status !== CaptureStatus.UPLOADING) return current;
        const reviewing = {
          ...current,
          status: CaptureStatus.REVIEWING,
          generation: current.generation + 1,
          lastError: String(message.message || "Draft upload failed."),
          updatedAt: new Date().toISOString(),
        };
        await setCaptureState(reviewing);
        return reviewing;
      });
      return { ok: true, state: next };
    }
    default:
      return { ok: false, error: "Unknown extension message." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Extension request failed.",
      }),
    );
  return true;
});

chrome.webNavigation.onCompleted.addListener((details) => {
  void captureNavigation(details);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  void captureNavigation(details);
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const current = await getCaptureState();
    await clearAllCapturedSteps();
    await setCapturePolicy({});
    await setCaptureState(createIdleState());
    if (
      current.sessionId &&
      current.status !== CaptureStatus.IDLE &&
      current.status !== CaptureStatus.COMPLETED
    ) {
      await cleanupRemoteCapture(
        current.remoteCaptureId || current.sessionId,
      );
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await flushRemoteDiscards();
    const state = await getCaptureState();
    if (state.status === CaptureStatus.RECORDING) {
      await pauseCapture(
        "Browser startup restored this session in a safe paused state.",
      );
    } else {
      if (state.status === CaptureStatus.IDLE) {
        await clearAllCapturedSteps();
      }
      await updateActionBadge(state);
    }
  })();
});

void getCaptureState().then(updateActionBadge);
