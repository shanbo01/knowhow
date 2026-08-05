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
  createWindowActivationEpochs,
  createIdleState,
  isCollecting,
  jobIsCurrent,
  snapshotCaptureJob,
  transitionCapture,
  withCapturedStep,
} from "../core/state-machine.js";
import { createInteractionSequencer } from "../core/interaction-sequence.js";
import { enqueueScreenshot } from "./screenshot-queue.js";

let offscreenCreation;
let stateMutationQueue = Promise.resolve();
let capturePolicyMutationQueue = Promise.resolve();
let remoteLifecycleQueue = Promise.resolve();
let reviewTabQueue = Promise.resolve();
const interactionSequencer = createInteractionSequencer();
const windowActivationEpochs = createWindowActivationEpochs();
const captureHostAccess = Object.freeze({ origins: ["<all_urls>"] });
const connectableCaptureStatuses = new Set([
  CaptureStatus.IDLE,
  CaptureStatus.COMPLETED,
  CaptureStatus.ERROR,
]);

function clickJobIsLatest(request) {
  return interactionSequencer.isLatest(request);
}

function configureActionSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return Promise.resolve();
  return chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}

void configureActionSidePanel();

function withStateMutation(operation) {
  const result = stateMutationQueue.then(operation, operation);
  stateMutationQueue = result.catch(() => undefined);
  return result;
}

function withCapturePolicyMutation(operation) {
  const result = capturePolicyMutationQueue.then(operation, operation);
  capturePolicyMutationQueue = result.catch(() => undefined);
  return result;
}

function withReviewTabMutation(operation) {
  const result = reviewTabQueue.then(operation, operation);
  reviewTabQueue = result.catch(() => undefined);
  return result;
}

function enqueueRemoteLifecycle(operation) {
  const result = remoteLifecycleQueue.then(operation, operation);
  remoteLifecycleQueue = result.catch(() => undefined);
  return result;
}

const PREFLIGHT_STORAGE_KEY = "rivet-pending-preflight";
const PREFLIGHT_TTL_MS = 10_000;

async function getPendingPreflight(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const stored = await chrome.storage.session.get(PREFLIGHT_STORAGE_KEY);
  const stash = stored[PREFLIGHT_STORAGE_KEY];
  if (!stash || stash.sessionId !== sessionId) return null;
  if (Date.now() - Number(stash.capturedAt || 0) > PREFLIGHT_TTL_MS) {
    await chrome.storage.session.remove(PREFLIGHT_STORAGE_KEY);
    return null;
  }
  return stash;
}

async function setPendingPreflight(stash) {
  await chrome.storage.session.set({ [PREFLIGHT_STORAGE_KEY]: stash });
}

async function clearPendingPreflight() {
  await chrome.storage.session.remove(PREFLIGHT_STORAGE_KEY);
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

async function readLocalCapturePolicy() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.capturePolicy);
  return mergePolicy(stored[STORAGE_KEYS.capturePolicy] || {});
}

async function getLocalCapturePolicy() {
  return withCapturePolicyMutation(() => readLocalCapturePolicy());
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
  return withCapturePolicyMutation(async () => {
    const current = await readLocalCapturePolicy();
    const merged = mergePolicy({ ...current, ...patch });
    await chrome.storage.local.set({
      [STORAGE_KEYS.capturePolicy]: merged,
    });
    const context = await getStoredWorkspaceContext();
    return context ? applyWorkspaceContext(merged, context) : merged;
  });
}

async function addExcludedSite(hostname) {
  return withCapturePolicyMutation(async () => {
    const current = await readLocalCapturePolicy();
    const merged = mergePolicy({
      ...current,
      excludedSites: [
        ...current.excludedSites,
        normalizeSitePattern(hostname),
      ],
    });
    await chrome.storage.local.set({
      [STORAGE_KEYS.capturePolicy]: merged,
    });
    const context = await getStoredWorkspaceContext();
    return context ? applyWorkspaceContext(merged, context) : merged;
  });
}

async function updateCapturePolicy(patch) {
  return withStateMutation(async () => {
    const state = await getCaptureState();
    if (!connectableCaptureStatuses.has(state.status)) {
      throw new Error(
        "Privacy settings cannot change during an active capture. Finish or discard it first.",
      );
    }
    return setCapturePolicy(patch);
  });
}

function safeCaptureText(value, policy, maxLength, fallback) {
  const sanitized = sanitizeCapturedText(value, policy, maxLength);
  return sanitized.length >= 2 ? sanitized : fallback;
}

async function updateActionBadge(state) {
  const badges = {
    [CaptureStatus.PREPARING]: ["...", "#356fe5"],
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

function selectionFromTab(tab, verdict) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    pageUrl: requireRegularPageUrl(tab),
    origin: verdict.origin,
    sanitizedUrl: verdict.sanitizedUrl,
    activationEpoch: windowActivationEpochs.current(tab.windowId),
  };
}

async function revalidateSelectedTab(selection, policy, action = "continue") {
  let tab;
  try {
    tab = await chrome.tabs.get(selection.tabId);
  } catch {
    throw new Error(
      "The page selected for capture is no longer open. Select a page and try again.",
    );
  }
  if (
    tab.windowId !== selection.windowId ||
    !tab.active ||
    windowActivationEpochs.current(selection.windowId) !==
      selection.activationEpoch
  ) {
    throw new Error(
      "The active page changed before Rivet could " +
        action +
        ". Return to the page you selected and try again.",
    );
  }
  const pageUrl = requireRegularPageUrl(tab);
  const verdict = evaluateCaptureUrl(pageUrl, policy);
  if (!verdict.allowed) throw new Error(verdict.reason);
  if (
    pageUrl !== selection.pageUrl ||
    verdict.origin !== selection.origin
  ) {
    throw new Error(
      "The selected page changed while Rivet was " +
        action +
        ". Return to the page you want to capture and try again.",
    );
  }
  return { tab, verdict };
}

async function getOriginalActiveTab(state, target = {}) {
  if (
    Number.isInteger(target.tabId) &&
    target.tabId !== state.tabId
  ) {
    throw new Error("Return to the originally captured tab before resuming.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    throw new Error(
      "The originally captured tab is no longer open. Discard this capture and start again.",
    );
  }
  if (
    (Number.isInteger(target.windowId) && target.windowId !== tab.windowId) ||
    !tab.active
  ) {
    throw new Error("Return to the originally captured tab before resuming.");
  }
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  if (!activeTab || activeTab.id !== tab.id) {
    throw new Error("Return to the originally captured tab before resuming.");
  }
  return tab;
}

async function requireCaptureHostAccess() {
  if (await chrome.permissions.contains(captureHostAccess)) return;
  throw new Error(
    "Rivet does not have website access. In the side panel, click Start or Resume and select Allow in Chrome.",
  );
}

function requireRegularPageUrl(tab) {
  if (typeof tab?.url !== "string" || !tab.url) {
    throw new Error(
      "Rivet could not read this page's URL. In the side panel, click Start or Resume and allow website access.",
    );
  }
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    throw new Error(
      "Rivet could not read this page's URL. Select a regular website and try again.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Rivet can capture regular HTTP and HTTPS websites only. Chrome pages, extension pages, and local files cannot be captured.",
    );
  }
  return url.href;
}

async function getActiveTab(target = {}) {
  if (Number.isInteger(target.tabId) || Number.isInteger(target.windowId)) {
    if (!Number.isInteger(target.tabId) || !Number.isInteger(target.windowId)) {
      throw new Error("Rivet received an incomplete browser tab selection.");
    }
    let tab;
    try {
      tab = await chrome.tabs.get(target.tabId);
    } catch {
      throw new Error(
        "The page selected for capture is no longer open. Select a page and try again.",
      );
    }
    if (tab.windowId !== target.windowId || !tab.active) {
      throw new Error(
        "The active page changed before Rivet could start. Return to the page you want to capture and try again.",
      );
    }
    return tab;
  }
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    throw new Error("Rivet could not resolve the active browser tab.");
  }
  return tab;
}

async function sendToCapturedTab(state, message, options) {
  if (!Number.isInteger(state?.tabId)) return null;
  try {
    return options
      ? await chrome.tabs.sendMessage(state.tabId, message, options)
      : await chrome.tabs.sendMessage(state.tabId, message);
  } catch {
    return null;
  }
}

async function injectCaptureContent(state, capturePolicy) {
  await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    files: [CONTENT_SCRIPT_PATH],
  });
  const policy = capturePolicy || (await getCapturePolicy());
  const configured = await chrome.tabs.sendMessage(state.tabId, {
    type: "RIVET_CONFIGURE",
    sessionId: state.sessionId,
    status: state.status,
    scopeLabel: state.scopeLabel,
    policy,
  });
  if (!configured?.ok) {
    throw new Error("Rivet could not safely configure capture on this page.");
  }
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
  await requireCaptureHostAccess();
  const initialTab = await getActiveTab(options);
  if (initialTab.incognito) {
    throw new Error("Rivet Capture is disabled in incognito windows.");
  }
  let initialPolicy;
  let cachedContext;
  let initialVerdict;
  let initialSelection;
  let previousSessionId;
  const preparing = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (
      current.status !== CaptureStatus.IDLE &&
      current.status !== CaptureStatus.COMPLETED &&
      current.status !== CaptureStatus.ERROR
    ) {
      throw new Error("Finish or discard the current capture first.");
    }
    [initialPolicy, cachedContext] = await Promise.all([
      getCapturePolicy(),
      getStoredWorkspaceContext(),
    ]);
    initialVerdict = evaluateCaptureUrl(
      requireRegularPageUrl(initialTab),
      initialPolicy,
    );
    if (!initialVerdict.allowed) throw new Error(initialVerdict.reason);
    initialSelection = selectionFromTab(initialTab, initialVerdict);
    const context = cachedContext || {};
    previousSessionId = current.sessionId;
    const started = transitionCapture(current, CaptureEvent.START, {
      sessionId: crypto.randomUUID(),
      tabId: initialTab.id,
      windowId: initialTab.windowId,
      origin: initialVerdict.origin,
      sanitizedUrl: initialVerdict.sanitizedUrl,
      title: safeCaptureText(
        options.title || initialTab.title || "Captured guide",
        initialPolicy,
        200,
        "Captured guide",
      ),
      workspaceId: cachedContext?.workspaceId || null,
      scopeLabel:
        (context.workspaceName || "Workspace") +
        " · " +
        initialVerdict.hostname,
      policyVersion: cachedContext?.policyVersion || initialPolicy.version,
    });
    await setCaptureState(started);
    return started;
  });
  if (previousSessionId) await deleteCaptureSession(previousSessionId);
  let prepared = preparing;
  let remoteCreated = false;
  let remoteAttempted = false;
  let remoteCaptureId = preparing.sessionId;
  try {
    const workspaceContext = await refreshWorkspaceContext();
    const policy = applyWorkspaceContext(
      await getLocalCapturePolicy(),
      workspaceContext,
    );
    const afterWorkspace = await revalidateSelectedTab(
      initialSelection,
      policy,
      "preparing this capture",
    );
    const refreshedSelection = selectionFromTab(
      afterWorkspace.tab,
      afterWorkspace.verdict,
    );
    prepared = await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        latest.sessionId !== preparing.sessionId ||
        latest.status !== CaptureStatus.PREPARING
      ) {
        throw new Error("The capture session changed while Rivet was preparing it.");
      }
      const next = {
        ...latest,
        origin: afterWorkspace.verdict.origin,
        sanitizedUrl: afterWorkspace.verdict.sanitizedUrl,
        title: safeCaptureText(
          options.title || afterWorkspace.tab.title || "Captured guide",
          policy,
          200,
          "Captured guide",
        ),
        workspaceId: workspaceContext.workspaceId,
        scopeLabel:
          (workspaceContext.workspaceName || "Workspace") +
          " · " +
          afterWorkspace.verdict.hostname,
        policyVersion: workspaceContext.policyVersion,
        updatedAt: new Date().toISOString(),
      };
      await setCaptureState(next);
      return next;
    });
    remoteAttempted = true;
    const remote = await enqueueRemoteLifecycle(() =>
      beginRemoteCapture(prepared),
    );
    remoteCreated = true;
    remoteCaptureId =
      typeof remote?.captureId === "string" && remote.captureId
        ? remote.captureId
        : preparing.sessionId;
    if (!remote?.captureId) {
      throw new Error("Rivet did not return a capture identifier.");
    }
    await revalidateSelectedTab(
      refreshedSelection,
      policy,
      "creating the workspace capture",
    );
    prepared = await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        latest.sessionId !== preparing.sessionId ||
        latest.status !== CaptureStatus.PREPARING
      ) {
        throw new Error("The capture session changed while Rivet was preparing it.");
      }
      const remotePrepared = {
        ...latest,
        remoteCaptureId: remote.captureId,
        remoteGuideId: remote.guideId,
        remoteRevisionId: remote.revisionId,
        remoteSyncWarning: null,
        updatedAt: new Date().toISOString(),
      };
      await setCaptureState(remotePrepared);
      return remotePrepared;
    });
    await revalidateSelectedTab(
      refreshedSelection,
      policy,
      "attaching capture to this page",
    );
    await injectCaptureContent(prepared, policy);
    const beforeReady = await revalidateSelectedTab(
      refreshedSelection,
      policy,
      "finishing capture setup",
    );
    const recording = await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        latest.sessionId !== preparing.sessionId ||
        latest.status !== CaptureStatus.PREPARING
      ) {
        throw new Error("The capture session changed before it became ready.");
      }
      const ready = transitionCapture(
        {
          ...latest,
          sanitizedUrl: beforeReady.verdict.sanitizedUrl,
          lastNavigationUrl: beforeReady.verdict.sanitizedUrl,
          lastNavigationAt: Date.now(),
        },
        CaptureEvent.READY,
      );
      await setCaptureState(ready);
      return ready;
    });
    const initialJob = snapshotCaptureJob(recording, {
      pageUrl: beforeReady.tab.url,
      sourceEvent: "navigation",
      title: "Navigate to " + beforeReady.verdict.sanitizedUrl,
      instructions: "Navigate to " + beforeReady.verdict.sanitizedUrl + ".",
      targetRect: null,
      clickPoint: null,
    });
    const capturedInitialStep = await enqueueScreenshot(() =>
      captureStep(initialJob),
    );
    if (!capturedInitialStep) {
      throw new Error(
        "The selected page changed before Rivet could capture the initial step.",
      );
    }
    const statusResponse = await chrome.tabs.sendMessage(recording.tabId, {
      type: "RIVET_SET_STATUS",
      status: CaptureStatus.RECORDING,
    });
    if (!statusResponse?.ok) {
      throw new Error("Rivet could not activate capture on this page.");
    }
    return await getCaptureState();
  } catch (error) {
    await sendToCapturedTab(preparing, {
      type: "RIVET_SET_STATUS",
      status: CaptureStatus.ERROR,
    });
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        latest.sessionId !== preparing.sessionId ||
        latest.status === CaptureStatus.IDLE ||
        latest.status === CaptureStatus.ERROR
      ) {
        return latest;
      }
      const failed = transitionCapture(latest, CaptureEvent.FAIL, {
        message:
          error instanceof Error
            ? error.message
            : "Rivet could not attach to this page.",
      });
      const cleanedFailure = {
        ...failed,
        stepCount: 0,
        stepIds: [],
      };
      await setCaptureState(cleanedFailure);
      return cleanedFailure;
    });
    await deleteCaptureSession(preparing.sessionId);
    if (remoteCreated || remoteAttempted) {
      await cleanupRemoteCapture(remoteCaptureId);
    }
    throw error;
  }
}

async function resumeCapture(options = {}) {
  await requireCaptureHostAccess();
  const current = await getCaptureState();
  const initialTab = await getOriginalActiveTab(current, options);
  if (initialTab.incognito) {
    throw new Error("Rivet Capture is disabled in incognito windows.");
  }
  const initialPolicy = await getCapturePolicy();
  const initialVerdict = evaluateCaptureUrl(
    requireRegularPageUrl(initialTab),
    initialPolicy,
  );
  if (!initialVerdict.allowed) throw new Error(initialVerdict.reason);
  const initialSelection = selectionFromTab(initialTab, initialVerdict);
  const context = await refreshWorkspaceContext();
  if (current.workspaceId !== context.workspaceId) {
    throw new Error("Reconnect the workspace used to start this capture.");
  }
  const policy = applyWorkspaceContext(
    await getLocalCapturePolicy(),
    context,
  );
  const validated = await revalidateSelectedTab(
    initialSelection,
    policy,
    "resuming capture",
  );
  const resumeSelection = selectionFromTab(validated.tab, validated.verdict);
  const pausedConfiguration = {
    ...current,
    windowId: validated.tab.windowId,
    origin: validated.verdict.origin,
    sanitizedUrl: validated.verdict.sanitizedUrl,
    scopeLabel:
      (context.workspaceName || "Workspace") +
      " · " +
      validated.verdict.hostname,
    status: CaptureStatus.PAUSED,
  };
  await injectCaptureContent(pausedConfiguration, policy);
  const beforeResume = await revalidateSelectedTab(
    resumeSelection,
    policy,
    "finishing resume",
  );
  const verdict = beforeResume.verdict;
  const scoped = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (latest.sessionId !== current.sessionId) {
      throw new Error("The capture session changed before it could resume.");
    }
    const resumed = transitionCapture(latest, CaptureEvent.RESUME, {
      windowId: beforeResume.tab.windowId,
      origin: beforeResume.verdict.origin,
      sanitizedUrl: beforeResume.verdict.sanitizedUrl,
    });
    const next = {
      ...resumed,
      scopeLabel:
        (context.workspaceName || "Workspace") + " · " + verdict.hostname,
    };
    await setCaptureState(next);
    return next;
  });
  try {
    const response = await chrome.tabs.sendMessage(scoped.tabId, {
      type: "RIVET_SET_STATUS",
      status: CaptureStatus.RECORDING,
    });
    if (!response?.ok) throw new Error("The page did not accept resume.");
  } catch (error) {
    await pauseCapture("Rivet could not safely resume on this page.");
    throw error;
  }
  syncRemoteTransition(scoped, "resume");
  return scoped;
}

function reviewTabHasSession(tab, reviewPageUrl, sessionId) {
  if (typeof tab?.url !== "string") return false;
  try {
    const candidate = new URL(tab.url);
    const reviewPage = new URL(reviewPageUrl);
    return (
      candidate.protocol === reviewPage.protocol &&
      candidate.hostname === reviewPage.hostname &&
      candidate.pathname === reviewPage.pathname &&
      candidate.searchParams.get("session") === sessionId
    );
  } catch {
    return false;
  }
}

async function openOrFocusReviewTab(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("The capture is missing its review session.");
  }
  return withReviewTabMutation(async () => {
    const reviewPageUrl = chrome.runtime.getURL(REVIEW_PAGE_PATH);
    const url =
      reviewPageUrl + "?session=" + encodeURIComponent(sessionId);
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) =>
      reviewTabHasSession(tab, reviewPageUrl, sessionId),
    );
    if (Number.isInteger(existing?.id)) {
      try {
        const focused = await chrome.tabs.update(existing.id, {
          active: true,
        });
        if (
          Number.isInteger(existing.windowId) &&
          typeof chrome.windows?.update === "function"
        ) {
          await chrome.windows
            .update(existing.windowId, { focused: true })
            .catch(() => undefined);
        }
        return focused;
      } catch {
        // The review tab closed after the query; replace it below.
      }
    }
    return chrome.tabs.create({ url });
  });
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
  await openOrFocusReviewTab(reviewing.sessionId);
  return reviewing;
}

async function discardCapture() {
  let current;
  const discarded = await withStateMutation(async () => {
    current = await getCaptureState();
    if (current.status === CaptureStatus.UPLOADING) {
      throw new Error(
        "Rivet cannot discard this capture while its reviewed draft is uploading.",
      );
    }
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

async function connectRivet(code) {
  return withStateMutation(async () => {
    const state = await getCaptureState();
    if (!connectableCaptureStatuses.has(state.status)) {
      throw new Error(
        "Rivet cannot reconnect while a capture is active or under review. Finish or discard it first.",
      );
    }
    if ((await flushRemoteDiscards()).length) {
      throw new Error(
        "Rivet must finish cleaning up a previous capture before reconnecting.",
      );
    }
    await beginRivetPairing(code);
    return refreshWorkspaceContext();
  });
}

async function excludeCurrentSite(options = {}) {
  await requireCaptureHostAccess();
  const initialTab = await getActiveTab(options);
  const pageUrl = requireRegularPageUrl(initialTab);
  const policyWithoutLocalExclusions = {
    ...(await getCapturePolicy()),
    excludedSites: [],
  };
  const initialVerdict = evaluateCaptureUrl(
    pageUrl,
    policyWithoutLocalExclusions,
  );
  if (!initialVerdict.allowed || !initialVerdict.origin) {
    throw new Error(initialVerdict.reason || "This page cannot be excluded.");
  }
  const selection = selectionFromTab(initialTab, initialVerdict);
  const { tab, verdict } = await revalidateSelectedTab(
    selection,
    policyWithoutLocalExclusions,
    "exclude this site",
  );
  const hostname = new URL(verdict.origin).hostname;
  const nextPolicy = await addExcludedSite(hostname);
  const state = await getCaptureState();
  if (state.tabId === tab.id && isCollecting(state)) {
    await pauseCapture("The current site was added to the exclusion list.");
  }
  return { policy: nextPolicy, hostname };
}

async function preparePageContext(state, fallback) {
  const response = await sendToCapturedTab(state, {
    type: "RIVET_PREPARE_SCREENSHOT",
  }, typeof fallback.documentId === "string"
    ? { documentId: fallback.documentId }
    : undefined);
  if (!response?.ok) {
    return null;
  }
  return {
    ...response.context,
    targetRect: fallback.targetRect || response.context.targetRect,
    clickPoint: fallback.clickPoint || null,
    interactionViewport: fallback.viewport || response.context.viewport,
    title: fallback.title || response.context.title,
    instructions: fallback.instructions || response.context.instructions,
    sanitizedUrl: response.context.sanitizedUrl || fallback.sanitizedUrl,
  };
}

async function validateActiveCaptureTab(state, policy, expectedSanitizedUrl) {
  const [tab] = await chrome.tabs.query({
    active: true,
    windowId: state.windowId,
  });
  if (!tab || tab.id !== state.tabId) {
    throw new Error("Return to the captured tab to continue.");
  }
  const verdict = evaluateCaptureUrl(requireRegularPageUrl(tab), policy);
  if (!verdict.allowed) throw new Error(verdict.reason);
  if (verdict.origin !== state.origin) {
    throw new Error(
      "The page changed origin. Resume explicitly to continue on the new site.",
    );
  }
  if (
    expectedSanitizedUrl &&
    verdict.sanitizedUrl !== expectedSanitizedUrl
  ) {
    throw new Error(
      "The captured page changed before its screenshot was ready. Try the action again.",
    );
  }
  return { tab, verdict };
}

async function captureVisiblePage(state, policy, expectedSanitizedUrl) {
  await requireCaptureHostAccess();
  const activationEpoch = windowActivationEpochs.current(state.windowId);
  await validateActiveCaptureTab(state, policy, expectedSanitizedUrl);
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    throw new Error("The active tab changed before screenshot capture began.");
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(state.windowId, {
      format: "png",
    });
  } catch (error) {
    if (/permission|activeTab|all_urls/i.test(String(error?.message || error))) {
      throw new Error(
        "Chrome removed Rivet's website access. Click Resume in the side panel and select Allow to continue.",
      );
    }
    throw error;
  }
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    dataUrl = null;
    throw new Error(
      "The active tab changed during screenshot capture. Rivet discarded the screenshot for privacy.",
    );
  }
  const verified = await validateActiveCaptureTab(
    state,
    policy,
    expectedSanitizedUrl,
  );
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    dataUrl = null;
    throw new Error(
      "The active tab changed during screenshot verification. Rivet discarded the screenshot for privacy.",
    );
  }
  return { dataUrl, ...verified };
}

async function clickJobMayProceed(request) {
  if (clickJobIsLatest(request)) return true;
  if (request?.sourceEvent !== "click" || request.rapidSkipRecorded) {
    return false;
  }
  request.rapidSkipRecorded = true;
  await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (latest.sessionId !== request.sessionId) return latest;
    const skipped = Number(latest.rapidInteractionsSkipped || 0) + 1;
    const next = {
      ...latest,
      rapidInteractionsSkipped: skipped,
      captureWarning:
        "Rivet skipped " +
        String(skipped) +
        " rapid interaction" +
        (skipped === 1 ? "" : "s") +
        " because the page changed before a safe screenshot could be taken.",
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
  return false;
}

async function captureStep(request) {
  if (!(await clickJobMayProceed(request))) return false;
  const snapshot = await getCaptureState();
  const generation = request.generation;
  if (!Number.isInteger(generation)) return false;
  if (!jobIsCurrent(snapshot, request.sessionId, generation)) return false;
  if (!(await clickJobMayProceed(request))) return false;
  if (snapshot.stepCount >= CAPTURE_LIMITS.maxSteps) {
    await pauseCapture(
      "This capture reached the " +
        String(CAPTURE_LIMITS.maxSteps) +
        "-step safety limit.",
    );
    return false;
  }
  await requireCaptureHostAccess();

  if (request.preflight === true) {
    const stash = await getPendingPreflight(request.sessionId);
    if (stash && stash.generation === generation) {
      return commitPreflightStep(stash, request, snapshot);
    }
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: snapshot.windowId,
  });
  if (!activeTab || activeTab.id !== snapshot.tabId) {
    await pauseCapture("Return to the captured tab to continue.");
    return false;
  }

  const policy = await getCapturePolicy();
  const verdict = evaluateCaptureUrl(request.pageUrl || activeTab.url || "", policy);
  if (!verdict.allowed) {
    await pauseCapture(verdict.reason);
    return false;
  }
  if (verdict.origin !== snapshot.origin) {
    await pauseCapture(
      "The page changed origin. Resume explicitly to continue on the new site.",
    );
    return false;
  }
  const activeVerdict = evaluateCaptureUrl(activeTab.url || "", policy);
  if (!activeVerdict.allowed) {
    await pauseCapture(activeVerdict.reason);
    return false;
  }
  if (activeVerdict.sanitizedUrl !== verdict.sanitizedUrl) return false;

  const context = await preparePageContext(snapshot, request);
  if (!context) return false;
  if (!(await clickJobMayProceed(request))) return false;
  if (
    context.sanitizedUrl &&
    context.sanitizedUrl !== activeVerdict.sanitizedUrl
  ) return false;
  const beforeCapture = await getCaptureState();
  if (
    !jobIsCurrent(beforeCapture, snapshot.sessionId, generation) ||
    !(await clickJobMayProceed(request))
  ) return false;
  const captured = await captureVisiblePage(
    snapshot,
    policy,
    verdict.sanitizedUrl,
  );
  let dataUrl = captured.dataUrl;

  const afterCapture = await getCaptureState();
  if (
    !jobIsCurrent(afterCapture, snapshot.sessionId, generation)
  ) {
    dataUrl = null;
    return false;
  }
  const capturedVerdict = captured.verdict;
  if (typeof request.documentId === "string") {
    const verified = await sendToCapturedTab(
      snapshot,
      { type: "RIVET_VERIFY_DOCUMENT" },
      { documentId: request.documentId },
    );
    if (
      !verified?.ok ||
      verified.sanitizedUrl !== capturedVerdict.sanitizedUrl
    ) {
      dataUrl = null;
      return false;
    }
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
      ...(Number.isInteger(request.interactionSequence)
        ? { interactionSequence: request.interactionSequence }
        : {}),
      capturedAt: new Date().toISOString(),
    },
    masks: context.masks || request.masks || [],
    targetRect: context.targetRect || request.targetRect || null,
    clickPoint: context.clickPoint || request.clickPoint || null,
    viewport: context.viewport || request.viewport,
    interactionViewport:
      context.interactionViewport || request.viewport || context.viewport,
    clickTargetColor: policy.clickTargetColor,
    limits: CAPTURE_LIMITS,
  });
  dataUrl = null;
  if (!processed?.ok) {
    throw new Error(processed?.error || "Local screenshot redaction failed.");
  }

  const committed = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !jobIsCurrent(latest, snapshot.sessionId, generation)
    ) {
      return false;
    }
    await setCaptureState(withCapturedStep(latest, stepId));
    return true;
  });
  if (!committed) {
    await deleteCapturedStep(snapshot.sessionId, stepId);
    return false;
  }
  return true;
}

async function commitPreflightStep(stash, request, snapshot) {
  await clearPendingPreflight();
  const policy = await getCapturePolicy();
  const context = stash.context || {};
  const latest = await getCaptureState();
  if (!jobIsCurrent(latest, snapshot.sessionId, request.generation)) {
    return false;
  }
  const stepId = crypto.randomUUID();
  const order = latest.stepCount;
  await ensureOffscreenDocument();
  const processed = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "RIVET_PROCESS_SCREENSHOT",
    dataUrl: stash.dataUrl,
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
      sanitizedUrl: stash.verdictUrl || context.sanitizedUrl || "",
      sourceEvent: request.sourceEvent || "click",
      ...(Number.isInteger(request.interactionSequence)
        ? { interactionSequence: request.interactionSequence }
        : {}),
      capturedAt: new Date().toISOString(),
    },
    masks: Array.isArray(context.masks) ? context.masks : [],
    targetRect: context.targetRect || request.targetRect || null,
    clickPoint: context.clickPoint || request.clickPoint || null,
    viewport: context.viewport || request.viewport,
    interactionViewport: context.viewport || request.viewport,
    clickTargetColor: policy.clickTargetColor,
    limits: CAPTURE_LIMITS,
  });
  if (!processed?.ok) {
    throw new Error(processed?.error || "Local screenshot redaction failed.");
  }
  const committed = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (!jobIsCurrent(current, snapshot.sessionId, request.generation)) {
      return false;
    }
    await setCaptureState(withCapturedStep(current, stepId));
    return true;
  });
  if (!committed) {
    await deleteCapturedStep(snapshot.sessionId, stepId);
    return false;
  }
  return true;
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
        clickPoint: null,
        ...(typeof details.documentId === "string"
          ? { documentId: details.documentId }
          : {}),
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
      return { ok: true, state: await resumeCapture(message.options) };
    case "FINISH_CAPTURE":
      return { ok: true, state: await finishCapture() };
    case "DISCARD_CAPTURE":
      return { ok: true, state: await discardCapture() };
    case "EXCLUDE_CURRENT_SITE":
      return { ok: true, ...(await excludeCurrentSite(message.options)) };
    case "CONNECT_RIVET":
      return { ok: true, context: await connectRivet(message.code) };
    case "UPDATE_CAPTURE_POLICY":
      return {
        ok: true,
        policy: await updateCapturePolicy(message.policy || {}),
      };
    case "PREFLIGHT_CAPTURE": {
      const state = await getCaptureState();
      if (
        !sender.tab ||
        sender.tab.id !== state.tabId ||
        message.sessionId !== state.sessionId ||
        !isCollecting(state)
      ) {
        return { ok: false, ignored: true };
      }
      const policy = await getCapturePolicy();
      const verdict = evaluateCaptureUrl(
        message.context?.pageUrl || sender.tab.url || "",
        policy,
      );
      if (!verdict.allowed || verdict.origin !== state.origin) {
        return { ok: false };
      }
      try {
        const captured = await enqueueScreenshot(() =>
          captureVisiblePage(state, policy, verdict.sanitizedUrl),
        );
        await setPendingPreflight({
          sessionId: state.sessionId,
          generation: state.generation,
          dataUrl: captured.dataUrl,
          context: message.context || {},
          verdictUrl: verdict.sanitizedUrl,
          capturedAt: Date.now(),
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Screenshot preflight failed.",
        };
      }
    }
    case "PREFLIGHT_DISCARD": {
      const state = await getCaptureState();
      if (state.sessionId === message.sessionId) {
        await clearPendingPreflight();
      }
      return { ok: true };
    }
    case "CAPTURE_EVENT": {
      const interactionSequence = interactionSequencer.reserve();
      const state = await getCaptureState();
      if (
        !sender.tab ||
        sender.tab.id !== state.tabId ||
        message.sessionId !== state.sessionId ||
        !isCollecting(state)
      ) {
        return { ok: false, ignored: true };
      }
      interactionSequencer.confirm(state.sessionId, interactionSequence);
      const job = snapshotCaptureJob(state, {
          ...message.context,
          pageUrl: sender.tab.url || message.context?.pageUrl,
          sourceEvent: "click",
          interactionSequence,
          preflight: message.preflight === true,
          ...(Number.isInteger(message.interactionSequence)
            ? { sourceInteractionSequence: message.interactionSequence }
            : {}),
          ...(typeof sender.documentId === "string"
            ? { documentId: sender.documentId }
            : {}),
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

chrome.tabs.onActivated.addListener(({ windowId }) => {
  windowActivationEpochs.note(windowId);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  void captureNavigation(details);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  void captureNavigation(details);
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await configureActionSidePanel();
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
    if (state.status === CaptureStatus.PREPARING) {
      if (state.sessionId) await deleteCaptureSession(state.sessionId);
      await cleanupRemoteCapture(state.remoteCaptureId || state.sessionId);
      const failed = transitionCapture(state, CaptureEvent.FAIL, {
        message:
          "Browser startup interrupted capture preparation. Start the capture again.",
      });
      await setCaptureState({
        ...failed,
        stepCount: 0,
        stepIds: [],
      });
    } else if (state.status === CaptureStatus.RECORDING) {
      await pauseCapture(
        "Browser startup restored this session in a safe paused state.",
      );
    } else if (state.status === CaptureStatus.UPLOADING) {
      await withStateMutation(async () => {
        const latest = await getCaptureState();
        if (latest.status !== CaptureStatus.UPLOADING) return latest;
        const reviewing = {
          ...latest,
          status: CaptureStatus.REVIEWING,
          generation: latest.generation + 1,
          lastError:
            "Browser startup interrupted the draft upload. Reopen privacy review and retry.",
          updatedAt: new Date().toISOString(),
        };
        await setCaptureState(reviewing);
        return reviewing;
      });
    } else {
      if (state.status === CaptureStatus.IDLE) {
        await clearAllCapturedSteps();
      }
      await updateActionBadge(state);
    }
  })();
});

void getCaptureState().then(updateActionBadge);
