import {
  CAPTURE_LIMITS,
  CONTENT_SCRIPT_PATH,
  OFFSCREEN_DOCUMENT_PATH,
  KNOWHOW_ORIGIN,
  STORAGE_KEYS,
} from "../core/config.js";
import {
  clearAllCapturedSteps,
  deleteCapturedStep,
  deleteCapturedStepAndCompact,
  deleteCaptureSession,
  getCapturedSteps,
  listCapturedSteps,
} from "../core/capture-store.js";
import {
  beginRemoteCapture,
  beginKnowHowPairing,
  discardRemoteCapture,
  fetchGuideMedia,
  getConnectionState,
  getKnowHowContext,
  pauseRemoteCapture,
  resumeRemoteCapture,
  setRemoteExpectedSteps,
  submitPrivateDraft,
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
  withoutCapturedStep,
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
const recentInteractionByTab = new Map();
const captureHostAccess = Object.freeze({ origins: ["<all_urls>"] });
const connectableCaptureStatuses = new Set([
  CaptureStatus.IDLE,
  CaptureStatus.COMPLETED,
  CaptureStatus.ERROR,
]);
const livePolicyStatuses = new Set([
  CaptureStatus.RECORDING,
  CaptureStatus.PAUSED,
]);

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

const PREFLIGHT_STORAGE_KEY = "knowhow-pending-preflight";
const PREFLIGHT_TTL_MS = 10_000;
// A pre-click screenshot that cannot start within this window is skipped: the
// click has already landed by then, so the step falls back to photographing
// the painted result instead of storing a frame from the wrong moment.
const PREFLIGHT_DEADLINE_MS = 320;

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
  const rawPolicy = stored[STORAGE_KEYS.capturePolicy] || {};
  const merged = mergePolicy(rawPolicy);
  // Persist a one-time migration immediately so a later partial patch (which
  // re-merges over whatever is currently in storage) sees the current schema
  // version and doesn't re-strip the fields whose defaults changed.
  if (
    !Number.isInteger(rawPolicy.schemaVersion) ||
    rawPolicy.schemaVersion < merged.schemaVersion
  ) {
    await chrome.storage.local.set({ [STORAGE_KEYS.capturePolicy]: merged });
  }
  return merged;
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
    throw new Error("KnowHow returned an invalid workspace capture policy.");
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.workspaceContext]: context,
  });
  return context;
}

function boundedCompanionText(value, maximum = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function normalizedUnitRegion(value) {
  const region = ["x", "y", "width", "height"].map((axis) => Number(value?.[axis]));
  if (!region.every((item) => Number.isFinite(item) && item >= 0 && item <= 1)) {
    return null;
  }
  const [x, y, width, height] = region;
  if (width <= 0 || height <= 0 || x + width > 1.0001 || y + height > 1.0001) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Screenshot metadata for the guide reader: which private media object to
 * fetch, how the author framed it, where the click ring sits, and which blur
 * regions are still overlays rather than baked pixels.
 */
function normalizeCompanionMedia(value) {
  const mediaId = boundedCompanionText(value?.mediaId, 160);
  if (!mediaId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(mediaId)) return null;
  const click = value?.click;
  const clickX = Number(click?.x);
  const clickY = Number(click?.y);
  const radius = Number(click?.radius);
  return {
    mediaId,
    crop: normalizedUnitRegion(value?.crop),
    click:
      Number.isFinite(clickX) &&
      Number.isFinite(clickY) &&
      clickX >= 0 &&
      clickX <= 1 &&
      clickY >= 0 &&
      clickY <= 1
        ? {
            x: clickX,
            y: clickY,
            radius:
              Number.isFinite(radius) && radius > 0 && radius <= 0.25
                ? radius
                : 0.035,
            color: /^#[0-9a-f]{6}$/i.test(String(click?.color || ""))
              ? click.color
              : "#d97706",
          }
        : null,
    redactions: Array.isArray(value?.redactions)
      ? value.redactions
          .slice(0, 200)
          .filter((region) => region?.applied !== true)
          .map(normalizedUnitRegion)
          .filter(Boolean)
      : [],
  };
}

function normalizeCompanionGuide(value) {
  const id = boundedCompanionText(value?.id, 160);
  const title = boundedCompanionText(value?.title, 240);
  if (!id || !title) return null;
  let href = "";
  try {
    const candidate = new URL(String(value?.href || ""), KNOWHOW_ORIGIN);
    if (candidate.origin === KNOWHOW_ORIGIN) href = candidate.href;
  } catch {
    href = "";
  }
  const steps = Array.isArray(value?.steps)
    ? value.steps.slice(0, 200).map((step, index) => ({
        id: boundedCompanionText(step?.id, 160) || `step-${index + 1}`,
        kind: ["action", "heading", "note", "warning"].includes(step?.kind)
          ? step.kind
          : "action",
        title: boundedCompanionText(step?.title, 300) || `Step ${index + 1}`,
        description: boundedCompanionText(step?.description, 2_000),
        media: normalizeCompanionMedia(step?.media),
      }))
    : [];
  return {
    id,
    title,
    summary: boundedCompanionText(value?.summary, 500),
    status: ["draft", "review", "published", "archived"].includes(value?.status)
      ? value.status
      : "published",
    restricted: value?.restricted === true,
    updatedAt: boundedCompanionText(value?.updatedAt, 80),
    href,
    steps,
  };
}

function normalizeCompanion(value) {
  const workspaceId = boundedCompanionText(value?.workspaceId, 160);
  const workspaceName = boundedCompanionText(value?.workspaceName, 240);
  const theme = value?.theme === "dark" ? "dark" : "light";
  const guides = Array.isArray(value?.guides)
    ? value.guides
        .slice(0, 200)
        .map(normalizeCompanionGuide)
        .filter(Boolean)
    : [];
  return {
    workspaceId,
    workspaceName,
    theme,
    guides,
    syncedAt: new Date().toISOString(),
  };
}

async function setCompanion(value) {
  const companion = normalizeCompanion(value || {});
  await chrome.storage.local.set({ [STORAGE_KEYS.companion]: companion });
  return companion;
}

async function getCompanion() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.companion);
  return stored[STORAGE_KEYS.companion] || null;
}

async function refreshWorkspaceContext() {
  const connection = await getConnectionState();
  if (!connection.connected) {
    throw new Error("Connect KnowHow before starting a workspace capture.");
  }
  const context = await getKnowHowContext();
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
  const result = await withStateMutation(async () => {
    const state = await getCaptureState();
    if (
      !connectableCaptureStatuses.has(state.status) &&
      !livePolicyStatuses.has(state.status)
    ) {
      throw new Error(
        "Privacy settings cannot change while capture setup or upload is in progress.",
      );
    }
    const policy = await setCapturePolicy(patch);
    return { state, policy };
  });
  if (livePolicyStatuses.has(result.state.status)) {
    await sendToCapturedTab(result.state, {
      type: "KNOWHOW_UPDATE_POLICY",
      policy: result.policy,
    });
  }
  return result.policy;
}

function safeCaptureText(value, policy, maxLength, fallback) {
  const sanitized = sanitizeCapturedText(value, policy, maxLength);
  return sanitized.length >= 2 ? sanitized : fallback;
}

async function updateActionBadge(state) {
  const badges = {
    [CaptureStatus.PREPARING]: ["...", "#b45309"],
    [CaptureStatus.RECORDING]: ["REC", "#dc2626"],
    [CaptureStatus.PAUSED]: ["II", "#d97706"],
    [CaptureStatus.REVIEWING]: ["REV", "#a16207"],
    [CaptureStatus.UPLOADING]: ["UP", "#b45309"],
    [CaptureStatus.ERROR]: ["!", "#b91c1c"],
  };
  const [text = "", color = "#44403c"] = badges[state.status] || [];
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({
    title:
      state.status === CaptureStatus.IDLE
        ? "KnowHow Capture"
        : "KnowHow Capture: " + state.status,
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
      "The active page changed before KnowHow could " +
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
      "The selected page changed while KnowHow was " +
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
    "KnowHow does not have website access. In the side panel, click Start or Resume and select Allow in Chrome.",
  );
}

function requireRegularPageUrl(tab) {
  if (typeof tab?.url !== "string" || !tab.url) {
    throw new Error(
      "KnowHow could not read this page's URL. In the side panel, click Start or Resume and allow website access.",
    );
  }
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    throw new Error(
      "KnowHow could not read this page's URL. Select a regular website and try again.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "KnowHow can capture regular HTTP and HTTPS websites only. Chrome pages, extension pages, and local files cannot be captured.",
    );
  }
  return url.href;
}

async function getActiveTab(target = {}) {
  if (Number.isInteger(target.tabId) || Number.isInteger(target.windowId)) {
    if (!Number.isInteger(target.tabId) || !Number.isInteger(target.windowId)) {
      throw new Error("KnowHow received an incomplete browser tab selection.");
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
        "The active page changed before KnowHow could start. Return to the page you want to capture and try again.",
      );
    }
    return tab;
  }
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    throw new Error("KnowHow could not resolve the active browser tab.");
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
    type: "KNOWHOW_CONFIGURE",
    sessionId: state.sessionId,
    status: state.status,
    scopeLabel: state.scopeLabel,
    policy,
  });
  if (!configured?.ok) {
    throw new Error("KnowHow could not safely configure capture on this page.");
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
    type: "KNOWHOW_SET_STATUS",
    status: CaptureStatus.PAUSED,
    reason: paused.pausedReason,
  });
  return paused;
}

async function startCapture(options = {}) {
  await requireCaptureHostAccess();
  const initialTab = await getActiveTab(options);
  if (initialTab.incognito) {
    throw new Error("KnowHow Capture is disabled in incognito windows.");
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
        throw new Error("The capture session changed while KnowHow was preparing it.");
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
      throw new Error("KnowHow did not return a capture identifier.");
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
        throw new Error("The capture session changed while KnowHow was preparing it.");
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
    const capturedInitialStep = await enqueueScreenshot((reserveSlot) =>
      captureStep(initialJob, reserveSlot),
    );
    if (!capturedInitialStep) {
      throw new Error(
        "The selected page changed before KnowHow could capture the initial step.",
      );
    }
    const statusResponse = await chrome.tabs.sendMessage(recording.tabId, {
      type: "KNOWHOW_SET_STATUS",
      status: CaptureStatus.RECORDING,
    });
    if (!statusResponse?.ok) {
      throw new Error("KnowHow could not activate capture on this page.");
    }
    return await getCaptureState();
  } catch (error) {
    await sendToCapturedTab(preparing, {
      type: "KNOWHOW_SET_STATUS",
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
            : "KnowHow could not attach to this page.",
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
    throw new Error("KnowHow Capture is disabled in incognito windows.");
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
      type: "KNOWHOW_SET_STATUS",
      status: CaptureStatus.RECORDING,
    });
    if (!response?.ok) throw new Error("The page did not accept resume.");
  } catch (error) {
    await pauseCapture("KnowHow could not safely resume on this page.");
    throw error;
  }
  syncRemoteTransition(scoped, "resume");
  return scoped;
}

async function openOrFocusEditorTab(editUrl) {
  return withReviewTabMutation(async () => {
    let target;
    try {
      target = new URL(editUrl, KNOWHOW_ORIGIN);
    } catch {
      return null;
    }
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => {
      if (typeof tab.url !== "string") return false;
      try {
        const candidate = new URL(tab.url);
        return candidate.origin === target.origin && candidate.pathname === target.pathname
          && candidate.searchParams.get("guide") === target.searchParams.get("guide");
      } catch {
        return false;
      }
    });
    if (Number.isInteger(existing?.id)) {
      try {
        const focused = await chrome.tabs.update(existing.id, {
          active: true,
          url: target.href,
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
        // The tab closed after the query; open a new one below.
      }
    }
    return chrome.tabs.create({ url: target.href });
  });
}

/**
 * The extension no longer opens a separate review tab: editing (crop,
 * blur, annotate) now happens directly in the app's guide editor. Finishing
 * a capture uploads every step as-is (raw screenshot + pending redaction
 * metadata), commits the draft, then opens the app editor for that guide.
 */
async function performDraftUpload(reviewing) {
  const steps = Array.isArray(reviewing.stepIds)
    ? await getCapturedSteps(reviewing.sessionId, reviewing.stepIds)
    : await listCapturedSteps(reviewing.sessionId);
  if (!steps.length) {
    throw new Error("Nothing was captured to upload.");
  }
  const uploading = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (
      current.sessionId !== reviewing.sessionId ||
      current.status !== CaptureStatus.REVIEWING
    ) {
      throw new Error("The capture session changed before it could upload.");
    }
    const next = transitionCapture(current, CaptureEvent.BEGIN_UPLOAD);
    await setCaptureState(next);
    return next;
  });
  const captureId = uploading.remoteCaptureId || uploading.sessionId;
  try {
    await enqueueRemoteLifecycle(() =>
      setRemoteExpectedSteps(captureId, steps.length),
    );
    await enqueueRemoteLifecycle(() => resumeRemoteCapture(captureId));
    const policy = await getCapturePolicy();
    const result = await submitPrivateDraft({
      capture: uploading,
      steps,
      policy,
    });
    await deleteCaptureSession(reviewing.sessionId);
    const completed = await withStateMutation(async () => {
      const current = await getCaptureState();
      if (current.status !== CaptureStatus.UPLOADING) return current;
      const next = transitionCapture(current, CaptureEvent.COMPLETE, {
        guideId: result.guideId,
        editUrl: result.editUrl,
      });
      await setCaptureState(next);
      return next;
    });
    if (result.editUrl) {
      await openOrFocusEditorTab(result.editUrl);
    }
    return completed;
  } catch (error) {
    await withStateMutation(async () => {
      const current = await getCaptureState();
      if (current.status !== CaptureStatus.UPLOADING) return current;
      const next = {
        ...current,
        status: CaptureStatus.REVIEWING,
        generation: current.generation + 1,
        lastError:
          error instanceof Error ? error.message : "Draft upload failed.",
        updatedAt: new Date().toISOString(),
      };
      await setCaptureState(next);
      return next;
    });
    throw error;
  }
}

async function finishCapture() {
  const reviewing = await withStateMutation(async () => {
    const current = await getCaptureState();
    const next = transitionCapture(current, CaptureEvent.FINISH);
    await setCaptureState(next);
    return next;
  });
  await sendToCapturedTab(reviewing, {
    type: "KNOWHOW_SET_STATUS",
    status: CaptureStatus.REVIEWING,
  });
  return performDraftUpload(reviewing);
}

async function retryDraftUpload() {
  const current = await getCaptureState();
  if (current.status !== CaptureStatus.REVIEWING) {
    throw new Error("There is no failed upload to retry.");
  }
  return performDraftUpload(current);
}

async function discardCapture() {
  let current;
  const discarded = await withStateMutation(async () => {
    current = await getCaptureState();
    if (current.status === CaptureStatus.UPLOADING) {
      throw new Error(
        "KnowHow cannot discard this capture while its reviewed draft is uploading.",
      );
    }
    const next = transitionCapture(current, CaptureEvent.DISCARD);
    await setCaptureState(next);
    return next;
  });
  const sessionId = current.sessionId;
  const remoteCaptureId = current.remoteCaptureId || sessionId;
  await sendToCapturedTab(current, {
    type: "KNOWHOW_SET_STATUS",
    status: CaptureStatus.IDLE,
  });
  if (sessionId) await deleteCaptureSession(sessionId);
  const cleaned = await cleanupRemoteCapture(remoteCaptureId);
  const result = { ...discarded, remoteCleanupPending: !cleaned };
  await setCaptureState(result);
  return result;
}

async function removeCapturedStep(stepId) {
  let sessionId;
  const next = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (!livePolicyStatuses.has(current.status)) {
      throw new Error("Captured steps can be removed while recording or paused.");
    }
    if (!Array.isArray(current.stepIds) || !current.stepIds.includes(stepId)) {
      throw new Error("That captured step no longer exists.");
    }
    sessionId = current.sessionId;
    const updated = withoutCapturedStep(current, stepId);
    await setCaptureState(updated);
    return updated;
  });
  await deleteCapturedStepAndCompact(sessionId, stepId, next.stepIds);
  return next;
}

async function connectKnowHow(code) {
  return withStateMutation(async () => {
    const state = await getCaptureState();
    if (!connectableCaptureStatuses.has(state.status)) {
      throw new Error(
        "KnowHow cannot reconnect while a capture is active or under review. Finish or discard it first.",
      );
    }
    if ((await flushRemoteDiscards()).length) {
      throw new Error(
        "KnowHow must finish cleaning up a previous capture before reconnecting.",
      );
    }
    await beginKnowHowPairing(code);
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
  let response = await sendToCapturedTab(state, {
    type: "KNOWHOW_PREPARE_SCREENSHOT",
  }, typeof fallback.documentId === "string"
    ? { documentId: fallback.documentId }
    : undefined);
  // A click can legitimately replace the document before its queued
  // screenshot runs. Keep the original click geometry/copy, but collect masks
  // from the current same-origin document instead of discarding the step.
  if (!response?.ok && typeof fallback.documentId === "string") {
    response = await sendToCapturedTab(state, {
      type: "KNOWHOW_PREPARE_SCREENSHOT",
    });
  }
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
  // Capture follows the author across sites, so what has to hold is that the tab
  // still shows the exact page this screenshot was queued for. Without a pinned
  // page, the session's current origin is the guard.
  if (expectedSanitizedUrl) {
    if (verdict.sanitizedUrl !== expectedSanitizedUrl) {
      throw new Error(
        "The captured page changed before its screenshot was ready. Try the action again.",
      );
    }
  } else if (verdict.origin !== state.origin) {
    throw new Error(
      "The captured page moved to another site before its screenshot was ready. Try the action again.",
    );
  }
  return { tab, verdict };
}

async function captureVisiblePage(
  state,
  policy,
  expectedSanitizedUrl,
  reserveSlot,
) {
  await requireCaptureHostAccess();
  // The rate-limit wait happens before validation so the checks below describe
  // the tab as it is at the instant the screenshot is taken.
  if (!(await reserveSlot())) return null;
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
        "Chrome removed KnowHow's website access. Click Resume in the side panel and select Allow to continue.",
      );
    }
    throw error;
  }
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    dataUrl = null;
    throw new Error(
      "The active tab changed during screenshot capture. KnowHow discarded the screenshot for privacy.",
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
      "The active tab changed during screenshot verification. KnowHow discarded the screenshot for privacy.",
    );
  }
  await sendToCapturedTab(state, {
    type: "KNOWHOW_RESTORE_PRIVACY_PREVIEW",
  });
  return { dataUrl, ...verified };
}

async function captureStep(request, reserveSlot) {
  const snapshot = await getCaptureState();
  const generation = request.generation;
  if (!Number.isInteger(generation)) return false;
  if (!jobIsCurrent(snapshot, request.sessionId, generation)) return false;
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
  const activeVerdict = evaluateCaptureUrl(activeTab.url || "", policy);
  if (!activeVerdict.allowed) {
    await pauseCapture(activeVerdict.reason);
    return false;
  }
  // The session may legitimately have moved to another site since this job was
  // queued. That is the navigation's own step to record, so the stale job is
  // dropped rather than photographed against the wrong page or paused.
  if (verdict.origin !== activeVerdict.origin) return false;

  const context = await preparePageContext(snapshot, request);
  if (!context) return false;
  if (
    context.sanitizedUrl &&
    context.sanitizedUrl !== activeVerdict.sanitizedUrl
  ) return false;
  const beforeCapture = await getCaptureState();
  if (
    !jobIsCurrent(beforeCapture, snapshot.sessionId, generation)
  ) return false;
  const captured = await captureVisiblePage(
    snapshot,
    policy,
    activeVerdict.sanitizedUrl,
    reserveSlot,
  );
  if (!captured) return false;
  let dataUrl = captured.dataUrl;

  const afterCapture = await getCaptureState();
  if (
    !jobIsCurrent(afterCapture, snapshot.sessionId, generation)
  ) {
    dataUrl = null;
    return false;
  }
  const capturedVerdict = captured.verdict;
  if (
    typeof request.documentId === "string" &&
    activeVerdict.sanitizedUrl === verdict.sanitizedUrl
  ) {
    const verified = await sendToCapturedTab(
      snapshot,
      { type: "KNOWHOW_VERIFY_DOCUMENT" },
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
    type: "KNOWHOW_PROCESS_SCREENSHOT",
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
      sanitizedUrl: context.sanitizedUrl || activeVerdict.sanitizedUrl,
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
    type: "KNOWHOW_PROCESS_SCREENSHOT",
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

// The side panel names the site being recorded, so following the author to
// another host has to rename the scope with it.
function scopeLabelForHost(state, hostname) {
  const workspace = String(state?.scopeLabel || "").split(" · ")[0];
  if (!hostname) return state?.scopeLabel;
  return (workspace || "Workspace") + " · " + hostname;
}

function waitForTabComplete(tabId, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch(finish);
  });
}

/**
 * Recorded pages that open a link in a new tab (target=_blank, window.open,
 * ctrl/cmd-click) keep recording in that new tab under the same session,
 * matching Scribe's multi-tab capture behavior. A "Navigate to ..." step
 * marks the hand-off.
 */
async function followNewTabNavigation(details) {
  const state = await getCaptureState();
  if (!isCollecting(state) || state.tabId !== details.sourceTabId) return;
  const policy = await getCapturePolicy();

  // A new target can initially report about:blank even when it immediately
  // navigates to a regular website. Wait for the final tab URL before applying
  // capture policy so window.open() and target=_blank both continue reliably.
  await waitForTabComplete(details.tabId);
  let tab;
  try {
    tab = await chrome.tabs.get(details.tabId);
  } catch {
    return;
  }
  let verdict;
  try {
    verdict = evaluateCaptureUrl(requireRegularPageUrl(tab), policy);
  } catch {
    return;
  }
  if (!verdict.allowed) return;

  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
  } catch {
    return;
  }

  const switched = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !isCollecting(latest) ||
      latest.sessionId !== state.sessionId ||
      latest.tabId !== details.sourceTabId ||
      latest.tabId === tab.id
    ) {
      return null;
    }
    const next = {
      ...latest,
      tabId: tab.id,
      windowId: tab.windowId,
      origin: verdict.origin,
      scopeLabel: scopeLabelForHost(latest, verdict.hostname),
      sanitizedUrl: verdict.sanitizedUrl,
      lastNavigationUrl: verdict.sanitizedUrl,
      lastNavigationAt: Date.now(),
      generation: latest.generation + 1,
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
  if (!switched) return;

  try {
    await injectCaptureContent(switched, policy);
    const context = await sendToCapturedTab(switched, {
      type: "KNOWHOW_GET_PAGE_CONTEXT",
    });
    if (!context?.ok) return;
    const job = snapshotCaptureJob(switched, {
      ...context.context,
      pageUrl: tab.url,
      sourceEvent: "navigation",
      title: context.context.title
        ? "Open " + context.context.title + " in a new tab"
        : "Open a new tab",
      instructions: "Continue in the new tab.",
      targetRect: null,
      clickPoint: null,
    });
    await enqueueScreenshot((reserveSlot) => captureStep(job, reserveSlot));
  } catch (error) {
    await pauseCapture(
      "KnowHow could not continue after opening a new tab: " +
        (error instanceof Error ? error.message : "unknown error"),
    );
  }
}

/**
 * Switching to any other regular, capturable tab keeps recording there instead
 * of merely pausing, matching real cross-tab workflows (e.g. copying a code
 * from a mail tab back into a signup tab). Tabs in another window count too,
 * because workflows routinely spill into a second window. A "Switch to ..."
 * step marks the hand-off, the same way followNewTabNavigation() marks a tab
 * opened from a link.
 */
async function followActiveTabSwitch({ tabId, windowId }) {
  const state = await getCaptureState();
  if (!isCollecting(state) || state.tabId === tabId) return;
  const policy = await getCapturePolicy();
  await waitForTabComplete(tabId);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.incognito) return;
  // The tab may have been dragged into another window while it loaded, so the
  // window it lives in now decides whether it is the tab in front.
  const targetWindowId = Number.isInteger(tab.windowId) ? tab.windowId : windowId;
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: targetWindowId,
  });
  if (!activeTab || activeTab.id !== tabId) return;
  let verdict;
  try {
    verdict = evaluateCaptureUrl(requireRegularPageUrl(tab), policy);
  } catch {
    return;
  }
  if (!verdict.allowed) return;

  const switched = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !isCollecting(latest) ||
      latest.sessionId !== state.sessionId ||
      latest.tabId === tabId
    ) {
      return null;
    }
    const next = {
      ...latest,
      tabId,
      windowId: targetWindowId,
      origin: verdict.origin,
      scopeLabel: scopeLabelForHost(latest, verdict.hostname),
      sanitizedUrl: verdict.sanitizedUrl,
      lastNavigationUrl: verdict.sanitizedUrl,
      lastNavigationAt: Date.now(),
      generation: latest.generation + 1,
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
  if (!switched) return;

  try {
    await injectCaptureContent(switched, policy);
    const context = await sendToCapturedTab(switched, {
      type: "KNOWHOW_GET_PAGE_CONTEXT",
    });
    if (!context?.ok) return;
    const job = snapshotCaptureJob(switched, {
      ...context.context,
      pageUrl: tab.url,
      sourceEvent: "navigation",
      title: context.context.title
        ? "Switch to " + context.context.title
        : "Switch tabs",
      instructions: "Continue on this tab.",
      targetRect: null,
      clickPoint: null,
    });
    await enqueueScreenshot((reserveSlot) => captureStep(job, reserveSlot));
  } catch (error) {
    await pauseCapture(
      "KnowHow could not continue after switching tabs: " +
        (error instanceof Error ? error.message : "unknown error"),
    );
  }
}

/**
 * A tab the author opens themselves — Ctrl+T, a bookmark, pasting a URL — has no
 * opener, so no new-target event exists to follow. The tab starts life on the new
 * tab page, which is not capturable, so the moment it finishes loading a real
 * page while it is the tab in front, the session continues there.
 */
async function followOwnNewTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.active !== true) return;
  await followActiveTabSwitch({ tabId, windowId: tab.windowId });
}

async function captureNavigation(details) {
  const state = await getCaptureState();
  if (!isCollecting(state) || details.frameId !== 0) return;
  if (state.tabId !== details.tabId) {
    await followOwnNewTab(details.tabId);
    return;
  }

  const policy = await getCapturePolicy();
  const verdict = evaluateCaptureUrl(details.url, policy);
  if (!verdict.allowed) {
    await pauseCapture(verdict.reason);
    return;
  }
  // Following a link onto another site is an ordinary part of a real workflow
  // (an app hands off to a payment provider, an identity provider, a docs site),
  // so capture continues there and records the hand-off. Sites the workspace
  // excludes, and anything that is not a regular page, still stop capture above.
  const recentInteraction = recentInteractionByTab.get(details.tabId);
  if (
    recentInteraction?.sessionId === state.sessionId &&
    Date.now() - recentInteraction.at < 1_800
  ) {
    // Same-tab navigation immediately following a click is the result of that
    // click, not a separate user step. The queued click adopts the destination
    // screenshot, so only refresh routing state here and avoid noisy URL rows.
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (!isCollecting(latest) || latest.sessionId !== state.sessionId) {
        return latest;
      }
      const next = {
        ...latest,
        origin: verdict.origin,
        scopeLabel: scopeLabelForHost(latest, verdict.hostname),
        sanitizedUrl: verdict.sanitizedUrl,
        lastNavigationUrl: verdict.sanitizedUrl,
        lastNavigationAt: Date.now(),
        updatedAt: new Date().toISOString(),
      };
      await setCaptureState(next);
      return next;
    });
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
      origin: verdict.origin,
      scopeLabel: scopeLabelForHost(latest, verdict.hostname),
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
      type: "KNOWHOW_GET_PAGE_CONTEXT",
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
    await enqueueScreenshot((reserveSlot) => captureStep(job, reserveSlot));
  } catch (error) {
    await pauseCapture(
      "KnowHow could not continue after navigation: " +
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
    case "RETRY_DRAFT_UPLOAD":
      return { ok: true, state: await retryDraftUpload() };
    case "DISCARD_CAPTURE":
      return { ok: true, state: await discardCapture() };
    case "DELETE_CAPTURED_STEP":
      return {
        ok: true,
        state: await removeCapturedStep(message.stepId),
      };
    case "EXCLUDE_CURRENT_SITE":
      return { ok: true, ...(await excludeCurrentSite(message.options)) };
    // Guide screenshots are private objects: the side panel asks the worker,
    // which is the only context holding the paired device credential.
    case "GET_GUIDE_MEDIA":
      return { ok: true, ...(await fetchGuideMedia(message.mediaId)) };
    case "CONNECT_KNOWHOW":
      return { ok: true, context: await connectKnowHow(message.code) };
    case "UPDATE_CAPTURE_POLICY":
      return {
        ok: true,
        policy: await updateCapturePolicy(message.policy || {}),
      };
    case "TOGGLE_SMART_BLUR_PANEL": {
      const state = await getCaptureState();
      if (!isCollecting(state)) {
        throw new Error("Start a capture before opening Smart Blur.");
      }
      const response = await sendToCapturedTab(state, {
        type: "KNOWHOW_TOGGLE_SMART_BLUR_PANEL",
      });
      if (!response?.ok) {
        throw new Error("KnowHow could not open Smart Blur on this page.");
      }
      return { ok: true, open: response.open === true };
    }
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
        const captured = await enqueueScreenshot(
          (reserveSlot) =>
            captureVisiblePage(
              state,
              policy,
              verdict.sanitizedUrl,
              reserveSlot,
            ),
          { deadlineMs: PREFLIGHT_DEADLINE_MS },
        );
        if (!captured) return { ok: false, abandoned: true };
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
      if (Number.isInteger(sender.tab.id)) {
        recentInteractionByTab.set(sender.tab.id, {
          at: Date.now(),
          sessionId: state.sessionId,
          interactionSequence,
        });
        setTimeout(() => {
          const recent = recentInteractionByTab.get(sender.tab.id);
          if (recent?.interactionSequence === interactionSequence) {
            recentInteractionByTab.delete(sender.tab.id);
          }
        }, 2_500);
      }
      const job = snapshotCaptureJob(state, {
          ...message.context,
          pageUrl: sender.tab.url || message.context?.pageUrl,
          sourceEvent: ["contextmenu", "dblclick"].includes(message.sourceEvent)
            ? message.sourceEvent
            : "click",
          interactionSequence,
          preflight: message.preflight === true,
          ...(Number.isInteger(message.interactionSequence)
            ? { sourceInteractionSequence: message.interactionSequence }
            : {}),
          ...(typeof sender.documentId === "string"
            ? { documentId: sender.documentId }
            : {}),
        });
      void enqueueScreenshot((reserveSlot) =>
        captureStep(job, reserveSlot),
      ).catch(async (error) => {
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
    default:
      return { ok: false, error: "Unknown extension message." };
  }
}

function trustedWebsiteSender(sender) {
  const candidate = sender?.origin || sender?.url;
  try {
    return new URL(candidate).origin === KNOWHOW_ORIGIN;
  } catch {
    return false;
  }
}

async function handleExternalMessage(message, sender) {
  if (!trustedWebsiteSender(sender)) {
    throw new Error("KnowHow rejected an untrusted website connection.");
  }
  switch (message?.type) {
    case "KNOWHOW_WEB_PING":
      return {
        ok: true,
        version: chrome.runtime.getManifest().version,
        connection: await getConnectionState(),
        companion: await getCompanion(),
      };
    case "KNOWHOW_WEB_SYNC":
      return {
        ok: true,
        companion: await setCompanion(message.companion),
      };
    case "KNOWHOW_WEB_CONNECT": {
      const companion = await setCompanion(message.companion);
      const context = await connectKnowHow(message.pairingCode);
      return { ok: true, context, companion };
    }
    default:
      throw new Error("Unknown KnowHow website message.");
  }
}

chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    handleExternalMessage(message, sender)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "KnowHow could not connect to the extension.",
        }),
      );
    return true;
  },
);

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

chrome.tabs.onActivated.addListener((activeInfo) => {
  windowActivationEpochs.note(activeInfo.windowId);
  void followActiveTabSwitch(activeInfo);
});

// Moving to another browser window does not activate a tab, so capture follows
// the tab already in front of the newly focused window.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  void chrome.tabs
    .query({ active: true, windowId })
    .then(([tab]) => {
      if (!tab || !Number.isInteger(tab.id)) return;
      return followActiveTabSwitch({ tabId: tab.id, windowId });
    })
    .catch(() => undefined);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  void captureNavigation(details);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  void captureNavigation(details);
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void followNewTabNavigation(details);
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
            "Browser startup interrupted the draft upload. Retry the upload from the KnowHow side panel.",
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
