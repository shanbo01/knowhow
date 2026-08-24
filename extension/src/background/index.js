import {
  CAPTURE_LIMITS,
  CONTENT_GEOMETRY_PATH,
  CONTENT_SCRIPT_PATH,
  CONTENT_SETTLED_PATH,
  CONTENT_STYLE_PATH,
  OFFSCREEN_DOCUMENT_PATH,
  KNOWHOW_ORIGIN,
  STORAGE_KEYS,
} from "../core/config.js";
import {
  clearAllCapturedSteps,
  deleteCaptureFrame,
  deleteCapturedStep,
  deleteCaptureSession,
  getCaptureFrame,
  getCaptureFrameForInteraction,
  getCapturedSteps,
  listCapturedSteps,
  putCapturedStep,
  pruneCaptureFrames,
  updateCapturedStep,
} from "../core/capture-store.js";
import {
  beginRemoteCapture,
  beginKnowHowPairing,
  discardRemoteCapture,
  fetchGuideMedia,
  fetchCompanionLibrary,
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
  newestEligiblePreparedFrame,
  newestSameTabPreparedFrame,
  preparedFrameEligible,
  retainPreparedFrameMetadata,
} from "../core/prepared-frame.js";
import {
  CaptureEvent,
  CaptureStatus,
  createWindowActivationEpochs,
  createIdleState,
  isCollecting,
  jobIsCurrent,
  snapshotCaptureJob,
  transitionCapture,
} from "../core/state-machine.js";
import {
  CaptureEntryStatus,
  captureEntry,
  clickEntryNeedsSettledFrame,
  initializeCaptureCoordinator,
  lastClickCaptureEntry,
  markCaptureEntryFailed,
  markCaptureEntryReady,
  navigationKey,
  noteClickInteraction,
  recentHandoffMatches,
  rememberNavigationKey,
  rememberRecordedDestination,
  removeCaptureEntry,
  resetCaptureEntryForRetry,
  reserveCaptureEntry,
  shouldDropTrailingTabSwitch,
  shouldMintNavigationStep,
  switchNavigationCopy,
  unconfirmedClickEntryAt,
  unresolvedCaptureEntries,
  updateCaptureEntry,
} from "../core/capture-coordinator.js";
import {
  createScreenshotQueue,
  ScreenshotPriority,
} from "./screenshot-queue.js";

let offscreenCreation;
let stateMutationQueue = Promise.resolve();
let capturePolicyMutationQueue = Promise.resolve();
let remoteLifecycleQueue = Promise.resolve();
let reviewTabQueue = Promise.resolve();
const windowActivationEpochs = createWindowActivationEpochs();
const interactionFinalizations = new Map();
const recaptureInFlight = new Map();
const settledFrameJobs = new Map();
const navigationTransitionQueueByTab = new Map();
const SCREENSHOT_RATE_STORAGE_KEY = "knowhow.capture.last-screenshot-at";
const enqueueScreenshot = createScreenshotQueue({
  readLastCaptureStartedAt: async () => {
    const stored = await chrome.storage.session.get(SCREENSHOT_RATE_STORAGE_KEY);
    return Number(stored[SCREENSHOT_RATE_STORAGE_KEY]) || 0;
  },
  writeLastCaptureStartedAt: async (startedAt) => {
    await chrome.storage.session.set({
      [SCREENSHOT_RATE_STORAGE_KEY]: startedAt,
    });
  },
});
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

function enqueueNavigationTransition(tabId, operation) {
  const previous = navigationTransitionQueueByTab.get(tabId) || Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.catch(() => undefined);
  navigationTransitionQueueByTab.set(tabId, tail);
  return result.finally(() => {
    if (navigationTransitionQueueByTab.get(tabId) === tail) {
      navigationTransitionQueueByTab.delete(tabId);
    }
  });
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

// The worker is the only writer of the capture state, so it can serve reads
// from memory instead of paying a structured-clone round trip to
// `chrome.storage.session` on every stage, commit and frame bookkeeping step.
// The cache is populated on first read and refreshed on every write; a
// terminated worker simply starts cold and reloads from storage.
let captureStateCache = null;
let captureStateBadge = null;

async function getCaptureState() {
  if (captureStateCache) return captureStateCache;
  const stored = await chrome.storage.session.get(STORAGE_KEYS.captureState);
  const state = stored[STORAGE_KEYS.captureState] || createIdleState();
  captureStateCache =
    state.sessionId &&
    (!Array.isArray(state.captureEntries) ||
      !Number.isInteger(state.nextEventSequence))
      ? initializeCaptureCoordinator(state)
      : state;
  return captureStateCache;
}

async function setCaptureState(state) {
  captureStateCache = state;
  await chrome.storage.session.set({
    [STORAGE_KEYS.captureState]: state,
  });
  // The badge only ever reflects the status, so repainting it on every frame
  // bookkeeping write costs three extension IPC calls for nothing.
  if (state.status !== captureStateBadge) {
    captureStateBadge = state.status;
    await updateActionBadge(state);
  }
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
  const userName = boundedCompanionText(value?.userName, 240);
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
    userName,
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

async function dropCompanionGuideByMedia(mediaId) {
  const id = String(mediaId || "").trim();
  if (!id) return;
  const companion = await getCompanion();
  if (!Array.isArray(companion?.guides) || !companion.guides.length) return;
  const guides = companion.guides.filter(
    (guide) =>
      !(guide.steps || []).some((step) => step.media?.mediaId === id),
  );
  if (guides.length === companion.guides.length) return;
  await setCompanion({ ...companion, guides });
}

async function refreshCompanionLibrary() {
  const current = await getCompanion();
  const library = await fetchCompanionLibrary();
  return setCompanion({
    ...library,
    theme:
      library?.theme === "dark" || library?.theme === "light"
        ? library.theme
        : current?.theme || "light",
  });
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
  captureStateBadge = state.status;
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

async function sendToCaptureSessionTabs(state, message) {
  const tabIds = new Set([
    ...(Number.isInteger(state?.tabId) ? [state.tabId] : []),
    ...Object.keys(state?.tabDocumentSessions || {})
      .map(Number)
      .filter(Number.isInteger),
  ]);
  await Promise.all(
    [...tabIds].map((tabId) =>
      chrome.tabs.sendMessage(tabId, message).catch(() => undefined),
    ),
  );
}

async function injectCaptureContent(state, capturePolicy, documentId) {
  const target = {
    tabId: state.tabId,
    ...(typeof documentId === "string" ? { documentIds: [documentId] } : {}),
  };
  await chrome.scripting.insertCSS({
    target,
    files: [CONTENT_STYLE_PATH],
  });
  await chrome.scripting.executeScript({
    target,
    files: [CONTENT_GEOMETRY_PATH, CONTENT_SETTLED_PATH, CONTENT_SCRIPT_PATH],
    injectImmediately: true,
  });
  const policy = capturePolicy || (await getCapturePolicy());
  const configured = await chrome.tabs.sendMessage(
    state.tabId,
    {
      type: "KNOWHOW_CONFIGURE",
      sessionId: state.sessionId,
      status: state.status,
      scopeLabel: state.scopeLabel,
      policy,
      documentId: documentId || state.activeDocumentId || null,
      navigationKey:
        state.activeNavigationKey || state.sanitizedUrl || null,
    },
    typeof documentId === "string" ? { documentId } : undefined,
  );
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

function shortWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopAcceptingCaptureEvents(reason) {
  const stopped = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (
      current.status !== CaptureStatus.RECORDING &&
      current.status !== CaptureStatus.PAUSED
    ) {
      return current;
    }
    const next = {
      ...current,
      acceptingEvents: false,
      pausedReason: reason || current.pausedReason,
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
  if (
    stopped.status === CaptureStatus.RECORDING ||
    stopped.status === CaptureStatus.PAUSED
  ) {
    await sendToCapturedTab(stopped, {
      type: "KNOWHOW_SET_STATUS",
      status: CaptureStatus.PAUSED,
      reason,
    });
  }
  return stopped;
}

async function drainAcceptedCaptureWork(reason) {
  const deadline = Date.now() + CAPTURE_LIMITS.interactionDrainTimeoutMs;
  while (true) {
    await reconcileCaptureEntries();
    const current = await getCaptureState();
    const capturing = (current.captureEntries || []).filter(
      (entry) => entry.status === CaptureEntryStatus.CAPTURING,
    );
    if (!capturing.length) return current;
    if (Date.now() >= deadline) {
      return withStateMutation(async () => {
        let latest = await getCaptureState();
        for (const entry of latest.captureEntries || []) {
          if (entry.status !== CaptureEntryStatus.CAPTURING) continue;
          latest = entry.committed
            ? markCaptureEntryFailed(
                latest,
                entry.id,
                "The accepted screenshot did not finish within ten seconds. Retry it from the side panel.",
              )
            : removeCaptureEntry(latest, entry.id);
        }
        latest = {
          ...latest,
          acceptingEvents: false,
          pausedReason: reason || latest.pausedReason,
        };
        await setCaptureState(latest);
        return latest;
      });
    }
    await shortWait(80);
  }
}

async function pauseCapture(reason) {
  const stopped = await stopAcceptingCaptureEvents(reason);
  if (
    stopped.status !== CaptureStatus.RECORDING &&
    stopped.status !== CaptureStatus.PAUSED
  ) {
    return stopped;
  }
  await drainAcceptedCaptureWork(reason);
  const paused = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (current.status === CaptureStatus.PAUSED) return current;
    if (current.status !== CaptureStatus.RECORDING) return current;
    const next = {
      ...transitionCapture(current, CaptureEvent.PAUSE, { reason }),
      preparedFrames: [],
    };
    await setCaptureState(next);
    return next;
  });
  if (paused.status === CaptureStatus.PAUSED) {
    syncRemoteTransition(paused, "pause");
    await retainCaptureFrames(paused);
  }
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
    // Arm live Smart Blur before the seed JPEG. The page stays paused so
    // clicks are not recorded while that first screenshot slot is held.
    const blurArmed = await chrome.tabs.sendMessage(prepared.tabId, {
      type: "KNOWHOW_SET_STATUS",
      status: CaptureStatus.PAUSED,
    });
    if (!blurArmed?.ok) {
      throw new Error("KnowHow could not arm Smart Blur on this page.");
    }
    await sendToCapturedTab(prepared, { type: "KNOWHOW_WAIT_PAGE_SETTLED" });
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
  let topFrame = null;
  try {
    topFrame = chrome.webNavigation.getFrame
      ? await chrome.webNavigation.getFrame({
          tabId: validated.tab.id,
          frameId: 0,
        })
      : null;
  } catch {
    topFrame = null;
  }
  const documentId = topFrame?.documentId || current.activeDocumentId || null;
  const pageChanged = Boolean(
    current.sanitizedUrl !== validated.verdict.sanitizedUrl ||
      (documentId &&
        current.activeDocumentId &&
        documentId !== current.activeDocumentId),
  );
  const resumeTransitionId = Math.max(
    0,
    Number(current.nextNavigationSequence) || 0,
  );
  const activeNavigationKey = pageChanged
    ? navigationKey(
        {
          tabId: validated.tab.id,
          documentId,
          sanitizedUrl: validated.verdict.sanitizedUrl,
          transitionId: resumeTransitionId,
        },
        "resume",
      )
    : current.activeNavigationKey || validated.verdict.sanitizedUrl;
  const pausedConfiguration = {
    ...current,
    windowId: validated.tab.windowId,
    origin: validated.verdict.origin,
    sanitizedUrl: validated.verdict.sanitizedUrl,
    activeDocumentId: documentId,
    activeNavigationKey,
    scopeLabel:
      (context.workspaceName || "Workspace") +
      " · " +
      validated.verdict.hostname,
    status: CaptureStatus.PAUSED,
  };
  await injectCaptureContent(
    pausedConfiguration,
    policy,
    documentId || undefined,
  );
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
      activeDocumentId: documentId,
      activeNavigationKey,
      nextNavigationSequence: pageChanged
        ? resumeTransitionId + 1
        : resumed.nextNavigationSequence,
      preparedFrames: [],
      manualBlurCount: pageChanged ? 0 : resumed.manualBlurCount,
      tabDocumentSessions: {
        ...(resumed.tabDocumentSessions || {}),
        [String(resumed.tabId)]: {
          documentId,
          navigationKey: activeNavigationKey,
          sanitizedUrl: verdict.sanitizedUrl,
          manualBlurCount: pageChanged
            ? 0
            : Number(resumed.manualBlurCount) || 0,
        },
      },
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
  if (pageChanged) {
    await recordNavigationDestination({
      tabId: scoped.tabId,
      frameId: 0,
      documentId,
      url: beforeResume.tab.url,
    });
  }
  return getCaptureState();
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
 * a capture uploads the locally rasterized and irreversibly masked screenshot
 * plus applied redaction metadata, commits the draft, then opens the app
 * editor for that guide. Unredacted pixels never cross the upload boundary.
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
  const stopped = await stopAcceptingCaptureEvents("Finishing capture");
  if (
    stopped.status !== CaptureStatus.RECORDING &&
    stopped.status !== CaptureStatus.PAUSED
  ) {
    throw new Error("This capture is not ready to finish.");
  }
  const drained = await drainAcceptedCaptureWork("Finishing capture");
  const failures = unresolvedCaptureEntries(drained).filter(
    (entry) => entry.status === CaptureEntryStatus.NEEDS_ATTENTION,
  );
  if (failures.length) {
    const paused = await withStateMutation(async () => {
      const current = await getCaptureState();
      if (current.status !== CaptureStatus.RECORDING) return current;
      const next = transitionCapture(current, CaptureEvent.PAUSE, {
        reason: "Resolve or delete screenshots that need attention before finishing.",
      });
      await setCaptureState(next);
      return next;
    });
    if (paused.status === CaptureStatus.PAUSED) syncRemoteTransition(paused, "pause");
    throw new Error(
      "Resolve or delete the screenshots that need attention before finishing.",
    );
  }
  const reviewing = await withStateMutation(async () => {
    const current = await getCaptureState();
    const next = transitionCapture(current, CaptureEvent.FINISH);
    await setCaptureState(next);
    return next;
  });
  await sendToCaptureSessionTabs(reviewing, {
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
  await sendToCaptureSessionTabs(current, {
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
  let removedEntry;
  const next = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (!livePolicyStatuses.has(current.status)) {
      throw new Error("Captured steps can be removed while recording or paused.");
    }
    removedEntry = (current.captureEntries || []).find(
      (entry) => entry.stepId === stepId,
    );
    if (!removedEntry || removedEntry.status !== CaptureEntryStatus.READY) {
      throw new Error("That captured step no longer exists.");
    }
    const updated = removeCaptureEntry(current, removedEntry.id);
    await setCaptureState(updated);
    return updated;
  });
  await deleteCapturedStep(removedEntry.sessionId || next.sessionId, stepId);
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

async function validateActiveCaptureTab(
  state,
  policy,
  expectedSanitizedUrl,
  { ignorePageMove = false } = {},
) {
  const [tab] = await chrome.tabs.query({
    active: true,
    windowId: state.windowId,
  });
  if (!tab || tab.id !== state.tabId) {
    throw new Error("Return to the captured tab to continue.");
  }
  const verdict = evaluateCaptureUrl(requireRegularPageUrl(tab), policy);
  if (!verdict.allowed) throw new Error(verdict.reason);
  if (!ignorePageMove) {
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
  }
  return { tab, verdict };
}

// Chrome refuses a visible-tab screenshot for reasons that clear on their own:
// the two-per-second quota, a tab mid-drag, a window still animating in.
// Surfacing those to the author as a failed step turns a transient condition
// into a screenshot they have to retry by hand, so retry them here first.
const TRANSIENT_CAPTURE_PATTERN =
  /quota|cannot be edited right now|dragging|not ready|busy/i;
const CAPTURE_RETRY_DELAYS_MS = [180, 420, 900];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureVisibleFrameWithRetry(windowId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      const message = String(error?.message || error);
      if (/permission|activeTab|all_urls/i.test(message)) {
        throw new Error(
          "Chrome removed KnowHow's website access. Click Resume in the side panel and select Allow to continue.",
        );
      }
      if (
        attempt >= CAPTURE_RETRY_DELAYS_MS.length ||
        !TRANSIENT_CAPTURE_PATTERN.test(message)
      ) {
        throw error;
      }
      await delay(CAPTURE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function captureVisiblePage(
  state,
  policy,
  expectedSanitizedUrl,
  reserveSlot,
  { hideLiveBlur = true, keepOnNavigation = false } = {},
) {
  await requireCaptureHostAccess();
  // The rate-limit wait happens before validation so the checks below describe
  // the tab as it is at the instant the screenshot is taken.
  if (!(await reserveSlot())) return null;
  const activationEpoch = windowActivationEpochs.current(state.windowId);
  await validateActiveCaptureTab(state, policy, expectedSanitizedUrl, {
    ignorePageMove: keepOnNavigation,
  });
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    throw new Error("The active tab changed before screenshot capture began.");
  }
  if (hideLiveBlur) {
    await sendToCapturedTab(state, {
      type: "KNOWHOW_PREPARE_SCREENSHOT",
    });
  }
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    throw new Error("The active tab changed before screenshot capture began.");
  }
  let dataUrl = await captureVisibleFrameWithRetry(state.windowId);
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
    { ignorePageMove: keepOnNavigation },
  );
  if (windowActivationEpochs.current(state.windowId) !== activationEpoch) {
    dataUrl = null;
    throw new Error(
      "The active tab changed during screenshot verification. KnowHow discarded the screenshot for privacy.",
    );
  }
  if (hideLiveBlur) {
    await sendToCapturedTab(state, {
      type: "KNOWHOW_RESTORE_PRIVACY_PREVIEW",
    });
  }
  return { dataUrl, ...verified };
}

async function captureStep(request, reserveSlot) {
  let snapshot = await getCaptureState();
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
  const entryId =
    request.entryId ||
    `navigation:${request.navigationKey || request.documentId || crypto.randomUUID()}`;
  const stepId = request.stepId || crypto.randomUUID();
  snapshot = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (!jobIsCurrent(current, request.sessionId, generation)) return current;
    const next = reserveCaptureEntry(current, {
      id: entryId,
      stepId,
      kind: request.sourceEvent || "navigation",
      sourceEvent: request.sourceEvent || "navigation",
      tabId: current.tabId,
      documentId: request.documentId || current.activeDocumentId || null,
      navigationKey: request.navigationKey || current.activeNavigationKey || null,
      context: {
        title: request.title,
        instructions: request.instructions,
        sanitizedUrl: request.sanitizedUrl,
      },
      committed: true,
    });
    await setCaptureState(next);
    return next;
  });
  const reserved = captureEntry(snapshot, entryId);
  if (!reserved || reserved.status === CaptureEntryStatus.READY) return false;
  let completed = false;
  let failureMessage =
    "KnowHow could not capture this screenshot. Retry it from the side panel.";
  try {

  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: snapshot.windowId,
  });
  if (!activeTab || activeTab.id !== snapshot.tabId) {
    throw new Error("Return to the captured tab and retry this screenshot.");
  }

  const policy = await getCapturePolicy();
  const verdict = evaluateCaptureUrl(request.pageUrl || activeTab.url || "", policy);
  if (!verdict.allowed) {
    throw new Error(verdict.reason);
  }
  const activeVerdict = evaluateCaptureUrl(activeTab.url || "", policy);
  if (!activeVerdict.allowed) {
    throw new Error(activeVerdict.reason);
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
  const order = reserved.order;
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
    await setCaptureState(markCaptureEntryReady(latest, entryId));
    return true;
  });
  if (!committed) {
    await deleteCapturedStep(snapshot.sessionId, stepId);
    return false;
  }
  completed = true;
  return true;
  } catch (error) {
    failureMessage =
      error instanceof Error && error.message
        ? error.message
        : failureMessage;
    throw error;
  } finally {
    if (!completed) {
      await withStateMutation(async () => {
        const latest = await getCaptureState();
        const entry = captureEntry(latest, entryId);
        if (!entry || entry.status !== CaptureEntryStatus.CAPTURING) return latest;
        const failed = markCaptureEntryFailed(
          latest,
          entryId,
          failureMessage,
        );
        await setCaptureState(failed);
        return failed;
      });
    }
  }
}

function preparedFrameMatches(frame, message, state, sender) {
  return preparedFrameEligible(
    frame,
    {
      sessionId: state.sessionId,
      tabId: sender.tab?.id,
      documentId: sender.documentId || null,
      navigationKey: message.navigationKey,
      visualEpoch: message.visualEpoch,
      viewportKey: message.viewportKey,
    },
    {
      maxAgeMs: CAPTURE_LIMITS.preparedFrameMaxAgeMs,
      // A claimed pre-click frame stays valid if hover only changed class/style.
      ignoreVisualEpoch: Boolean(message.frameId),
    },
  );
}

async function retainCaptureFrames(state) {
  if (!state?.sessionId) return;
  const retainIds = [
    ...(state.preparedFrames || []).map((frame) => frame.id),
    ...(state.captureEntries || []).flatMap((entry) => [
      entry.frameId,
      entry.additionalFrameId,
    ]),
  ].filter(Boolean);
  await pruneCaptureFrames(state.sessionId, {
    retainIds,
    olderThan: Number.POSITIVE_INFINITY,
  });
}

async function processPreparedFrame({
  state,
  context,
  frameId,
  interactionId = null,
  navigationKey: frameNavigationKey,
  visualEpoch,
  viewportKey,
  documentId,
  reserveSlot,
  deadlineRequired = false,
  hideLiveBlur = true,
}) {
  if (deadlineRequired) return null;
  const latest = await getCaptureState();
  if (
    latest.sessionId !== state.sessionId ||
    !isCollecting(latest) ||
    latest.acceptingEvents === false
  ) {
    return null;
  }
  const policy = await getCapturePolicy();
  const captured = await captureVisiblePage(
    latest,
    policy,
    latest.sanitizedUrl,
    reserveSlot,
    { hideLiveBlur, keepOnNavigation: true },
  );
  if (!captured) return null;
  let dataUrl = captured.dataUrl;
  try {
    await ensureOffscreenDocument();
    const capturedAtMs = Date.now();
    const processed = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "KNOWHOW_PROCESS_CAPTURE_FRAME",
      dataUrl,
      frame: {
        sessionId: state.sessionId,
        id: frameId,
        interactionId,
        tabId: state.tabId,
        documentId: documentId || null,
        navigationKey: frameNavigationKey,
        visualEpoch,
        viewportKey,
        capturedAtMs,
        createdAtMs: capturedAtMs,
      },
      masks: context.masks || [],
      viewport: context.viewport,
      limits: CAPTURE_LIMITS,
    });
    if (!processed?.ok) {
      throw new Error(processed?.error || "Local screenshot redaction failed.");
    }
    const verified = await sendToCapturedTab(
      state,
      { type: "KNOWHOW_VERIFY_DOCUMENT" },
      typeof documentId === "string" ? { documentId } : undefined,
    ).catch(() => null);
    return {
      id: frameId,
      capturedAtMs,
      navigationKey:
        verified?.ok && verified.navigationKey
          ? verified.navigationKey
          : frameNavigationKey,
      viewportKey:
        verified?.ok && verified.viewportKey
          ? verified.viewportKey
          : viewportKey,
      visualEpoch:
        verified?.ok && Number.isFinite(Number(verified.visualEpoch))
          ? Number(verified.visualEpoch)
          : visualEpoch,
    };
  } finally {
    dataUrl = null;
  }
}

async function prepareCaptureFrame(message, sender) {
  const state = await getCaptureState();
  if (
    !sender.tab ||
    sender.tab.id !== state.tabId ||
    message.sessionId !== state.sessionId ||
    !isCollecting(state) ||
    state.acceptingEvents === false
  ) {
    return { ok: false, ignored: true };
  }
  const documentId = sender.documentId || null;
  const existing = newestEligiblePreparedFrame(
    state.preparedFrames,
    {
      sessionId: state.sessionId,
      tabId: sender.tab?.id,
      documentId,
      navigationKey: message.navigationKey,
      visualEpoch: message.visualEpoch,
      viewportKey: message.viewportKey,
    },
    { maxAgeMs: CAPTURE_LIMITS.preparedFrameMaxAgeMs },
  );
  if (existing) {
    return {
      ok: true,
      frameId: existing.id,
      capturedAtMs: existing.capturedAtMs,
      navigationKey: existing.navigationKey,
      reused: true,
    };
  }
  const frameId = crypto.randomUUID();
  const result = await enqueueScreenshot(
    (reserveSlot) =>
      processPreparedFrame({
        state,
        context: message.context || {},
        frameId,
        navigationKey: message.navigationKey,
        visualEpoch: message.visualEpoch,
        viewportKey: message.viewportKey,
        documentId,
        reserveSlot,
        deadlineRequired: false,
        hideLiveBlur: false,
      }),
    {
      deadlineMs: 1_600,
      priority: ScreenshotPriority.PREPARED,
      // Only the newest pre-warm for a tab is worth taking. An older one still
      // waiting for a slot photographs a page state the author already left.
      supersedes: `prepared:${state.tabId}`,
    },
  );
  if (!result) return { ok: false, abandoned: true };
  const storedNavigationKey = result.navigationKey || message.navigationKey;
  const storedViewportKey = result.viewportKey || message.viewportKey;
  const storedVisualEpoch = Number.isFinite(Number(result.visualEpoch))
    ? Number(result.visualEpoch)
    : message.visualEpoch;
  const next = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      latest.sessionId !== state.sessionId ||
      !isCollecting(latest) ||
      latest.acceptingEvents === false
    ) {
      return latest;
    }
    const preparedFrames = [
      ...(latest.preparedFrames || []).filter((frame) => frame.id !== frameId),
      {
        sessionId: latest.sessionId,
        id: frameId,
        tabId: latest.tabId,
        documentId,
        navigationKey: storedNavigationKey,
        visualEpoch: storedVisualEpoch,
        viewportKey: storedViewportKey,
        capturedAtMs: result.capturedAtMs,
      },
    ].slice(-2);
    const updated = {
      ...latest,
      preparedFrames,
      diagnostics: {
        ...(latest.diagnostics || {}),
        prepared: Number(latest.diagnostics?.prepared || 0) + 1,
      },
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(updated);
    return updated;
  });
  if (!(next.preparedFrames || []).some((frame) => frame.id === frameId)) {
    await deleteCaptureFrame(state.sessionId, frameId);
    return { ok: false, ignored: true };
  }
  await retainCaptureFrames(next);
  return {
    ok: true,
    frameId,
    capturedAtMs: result.capturedAtMs,
    navigationKey: storedNavigationKey,
    viewportKey: storedViewportKey,
    visualEpoch: storedVisualEpoch,
  };
}

function pageMovedError(error) {
  return /page changed before KnowHow|moved to another site before its screenshot|preserve its pre-action screenshot/i.test(
    String(error?.message || error || ""),
  );
}

function newestReusablePreparedFrame(state) {
  return newestSameTabPreparedFrame(
    state?.preparedFrames,
    {
      sessionId: state?.sessionId,
      tabId: state?.tabId,
    },
    { maxAgeMs: 12_000 },
  );
}

async function captureFallbackFrame(
  entryId,
  { deadlineMs = 1_200, preparePage = false, hideLiveBlur = true } = {},
) {
  const state = await getCaptureState();
  const entry = captureEntry(state, entryId);
  if (!entry || entry.status !== CaptureEntryStatus.CAPTURING) return;
  if (entry.frameId) return;
  const frameId = `interaction-${entry.id}`;

  async function attachFrame(nextFrameId) {
    const attached = await withStateMutation(async () => {
      const latest = await getCaptureState();
      const current = captureEntry(latest, entryId);
      if (!current || current.status !== CaptureEntryStatus.CAPTURING) {
        if (nextFrameId === frameId) {
          await deleteCaptureFrame(state.sessionId, frameId).catch(
            () => undefined,
          );
        }
        return latest;
      }
      if (current.frameId && current.frameId !== nextFrameId) return latest;
      const updated = {
        ...updateCaptureEntry(latest, entryId, {
          frameId: nextFrameId,
          capturePending: false,
        }),
        preparedFrames: (latest.preparedFrames || []).filter(
          (frame) => frame.id !== nextFrameId,
        ),
      };
      await setCaptureState(updated);
      return updated;
    });
    if (captureEntry(attached, entryId)?.frameId === nextFrameId) {
      await finalizeInteractionEntry(entryId);
      return true;
    }
    return false;
  }

  try {
    let captureContext = {
      ...(entry.context || {}),
      masks: entry.context?.masks || [],
      viewport: entry.context?.viewport,
    };
    if (preparePage) {
      const privacyReady = await sendToCapturedTab(state, {
        type: "KNOWHOW_PREPARE_SCREENSHOT",
      });
      if (privacyReady?.ok) {
        captureContext = {
          ...captureContext,
          masks: privacyReady.context?.masks || captureContext.masks || [],
          viewport: privacyReady.context?.viewport || captureContext.viewport,
        };
      }
    }
    const result = await enqueueScreenshot(
      async (reserveSlot) => {
        const latest = await getCaptureState();
        const current = captureEntry(latest, entryId);
        if (
          !current ||
          current.frameId ||
          current.status !== CaptureEntryStatus.CAPTURING
        ) {
          return null;
        }
        return processPreparedFrame({
          state: latest,
          context: captureContext,
          frameId,
          interactionId: current.id,
          navigationKey: current.navigationKey,
          visualEpoch: current.visualEpoch,
          viewportKey: current.viewportKey,
          documentId: current.documentId,
          reserveSlot,
          deadlineRequired: false,
          hideLiveBlur,
        });
      },
      { deadlineMs, priority: ScreenshotPriority.INTERACTION },
    );
    let attachedId = result ? frameId : null;
    if (!attachedId) {
      const latest = await getCaptureState();
      attachedId = newestReusablePreparedFrame(latest)?.id || null;
    }
    if (attachedId) {
      await attachFrame(attachedId);
    }
    await sendToCapturedTab(state, {
      type: "KNOWHOW_RESTORE_PRIVACY_PREVIEW",
    });
  } catch (error) {
    await sendToCapturedTab(state, {
      type: "KNOWHOW_RESTORE_PRIVACY_PREVIEW",
    });
    if (pageMovedError(error)) {
      const latest = await getCaptureState();
      const reused = newestReusablePreparedFrame(latest);
      if (reused) await attachFrame(reused.id);
      return;
    }
    await deleteCaptureFrame(state.sessionId, frameId).catch(() => undefined);
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      const failed = markCaptureEntryFailed(
        latest,
        entryId,
        error instanceof Error ? error.message : "Screenshot capture failed.",
      );
      await setCaptureState(failed);
      return failed;
    });
  }
}

async function finalizeInteractionEntry(entryId) {
  if (interactionFinalizations.has(entryId)) {
    return interactionFinalizations.get(entryId);
  }
  const operation = (async () => {
    const state = await getCaptureState();
    const entry = captureEntry(state, entryId);
    if (
      !entry ||
      !entry.committed ||
      entry.status !== CaptureEntryStatus.CAPTURING
    ) {
      return false;
    }
    let frame = entry.frameId
      ? await getCaptureFrame(state.sessionId, entry.frameId)
      : await getCaptureFrameForInteraction(state.sessionId, entry.id);
    if (!frame) {
      if (entry.capturePending === true) return false;
      await withStateMutation(async () => {
        const latest = await getCaptureState();
        const failed = markCaptureEntryFailed(
          latest,
          entryId,
          "The pre-action screenshot was unavailable. Return to this control and retry.",
        );
        await setCaptureState(failed);
        return failed;
      });
      return false;
    }
    const policy = await getCapturePolicy();
    await ensureOffscreenDocument();
    const processed = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "KNOWHOW_COMMIT_CAPTURE_FRAME",
      sessionId: state.sessionId,
      frameId: frame.id,
      step: {
        sessionId: state.sessionId,
        id: entry.stepId,
        order: entry.order,
        title: safeCaptureText(
          entry.context?.title || "Captured step",
          policy,
          200,
          "Captured step",
        ),
        instructions: safeCaptureText(
          entry.context?.instructions || "Follow the highlighted action.",
          policy,
          2_000,
          "Follow the highlighted action.",
        ),
        sanitizedUrl: entry.context?.sanitizedUrl || state.sanitizedUrl || "",
        sourceEvent: entry.sourceEvent || "click",
        interactionId: entry.id,
        capturedAt: new Date(frame.capturedAtMs || Date.now()).toISOString(),
      },
      targetRect: entry.context?.targetRect || null,
      clickPoint: entry.context?.clickPoint || null,
      viewport: entry.context?.viewport,
      interactionViewport: entry.context?.viewport,
      clickTargetColor: policy.clickTargetColor,
    });
    frame = null;
    if (!processed?.ok) {
      throw new Error(processed?.error || "Could not commit the prepared screenshot.");
    }
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      const current = captureEntry(latest, entryId);
      if (!current || current.status !== CaptureEntryStatus.CAPTURING) {
        await deleteCapturedStep(state.sessionId, entry.stepId);
        return latest;
      }
      const ready = markCaptureEntryReady(latest, entryId);
      await setCaptureState(ready);
      return ready;
    });
    return true;
  })()
    .catch(async (error) => {
      await withStateMutation(async () => {
        const latest = await getCaptureState();
        const failed = markCaptureEntryFailed(
          latest,
          entryId,
          error instanceof Error ? error.message : "Screenshot capture failed.",
        );
        await setCaptureState(failed);
        return failed;
      });
      return false;
    })
    .finally(() => interactionFinalizations.delete(entryId));
  interactionFinalizations.set(entryId, operation);
  return operation;
}

async function reconcileCaptureEntries({ workerRecovery = false } = {}) {
  let state = await getCaptureState();
  if (!state.sessionId) return state;
  const retainedPrepared = retainPreparedFrameMetadata(state.preparedFrames, {
    retentionMs: CAPTURE_LIMITS.preparedFrameRetentionMs,
  });
  if (retainedPrepared.length !== (state.preparedFrames || []).length) {
    state = await withStateMutation(async () => {
      const latest = await getCaptureState();
      const next = {
        ...latest,
        preparedFrames: retainPreparedFrameMetadata(latest.preparedFrames, {
          retentionMs: CAPTURE_LIMITS.preparedFrameRetentionMs,
        }),
      };
      await setCaptureState(next);
      return next;
    });
  }
  for (const entry of state.captureEntries || []) {
    if (entry.status !== CaptureEntryStatus.CAPTURING) continue;
    if (!entry.committed && Date.now() - Number(entry.acceptedAtMs || 0) > 10_000) {
      await withStateMutation(async () => {
        const latest = await getCaptureState();
        const next = removeCaptureEntry(latest, entry.id);
        await setCaptureState(next);
        return next;
      });
      continue;
    }
    if (!entry.committed) continue;
    const availableFrame = entry.frameId
      ? await getCaptureFrame(state.sessionId, entry.frameId)
      : await getCaptureFrameForInteraction(state.sessionId, entry.id);
    if (availableFrame) {
      await finalizeInteractionEntry(entry.id);
      continue;
    }
    if (
      !workerRecovery &&
      entry.capturePending === true &&
      Date.now() - Number(entry.acceptedAtMs || 0) <=
        CAPTURE_LIMITS.preparedFrameMaxAgeMs + 500
    ) {
      continue;
    }
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      const failed = markCaptureEntryFailed(
        latest,
        entry.id,
        "The pre-action screenshot was interrupted before it could be preserved. Retry this step from the side panel.",
      );
      await setCaptureState(failed);
      return failed;
    });
  }
  const latest = await getCaptureState();
  await retainCaptureFrames(latest);
  return latest;
}

function senderMatchesCapture(state, message, sender, { allowPaused = false } = {}) {
  const activeStatus = allowPaused
    ? livePolicyStatuses.has(state.status)
    : isCollecting(state);
  if (
    !activeStatus ||
    !sender.tab ||
    sender.tab.id !== state.tabId ||
    message.sessionId !== state.sessionId
  ) {
    return false;
  }
  if (
    state.activeDocumentId &&
    sender.documentId &&
    state.activeDocumentId !== sender.documentId
  ) {
    return false;
  }
  return true;
}

async function stageCaptureInteraction(message, sender) {
  const snapshot = await getCaptureState();
  if (
    !senderMatchesCapture(snapshot, message, sender) ||
    snapshot.acceptingEvents === false
  ) {
    return { ok: false, ignored: true };
  }
  if (typeof message.interactionId !== "string" || !message.interactionId) {
    throw new Error("KnowHow received an invalid interaction identifier.");
  }
  const expectedNavigationKey =
    snapshot.activeNavigationKey || snapshot.sanitizedUrl || null;
  if (
    expectedNavigationKey &&
    message.navigationKey &&
    expectedNavigationKey !== message.navigationKey
  ) {
    return { ok: false, ignored: true };
  }

  let stagedEntry = null;
  let needsFallback = false;
  const next = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (
      !senderMatchesCapture(current, message, sender) ||
      current.acceptingEvents === false
    ) {
      return current;
    }
    const existing = captureEntry(current, message.interactionId);
    if (existing) {
      stagedEntry = existing;
      return current;
    }
    if ((current.captureEntries || []).length >= CAPTURE_LIMITS.maxSteps) {
      throw new Error(
        `This capture reached the ${CAPTURE_LIMITS.maxSteps}-step safety limit.`,
      );
    }
    const preparedCandidate = {
      sessionId: current.sessionId,
      tabId: sender.tab?.id,
      documentId: sender.documentId || null,
      navigationKey: message.navigationKey,
      visualEpoch: message.visualEpoch,
      viewportKey: message.viewportKey,
    };
    const prepared = message.frameId
      ? (current.preparedFrames || []).find(
          (frame) =>
            frame.id === message.frameId &&
            preparedFrameMatches(frame, message, current, sender),
        )
      : newestEligiblePreparedFrame(
          current.preparedFrames,
          preparedCandidate,
          { maxAgeMs: CAPTURE_LIMITS.preparedFrameMaxAgeMs },
        ) ||
        newestEligiblePreparedFrame(
          current.preparedFrames,
          preparedCandidate,
          {
            maxAgeMs: CAPTURE_LIMITS.preparedFrameMaxAgeMs,
            ignoreVisualEpoch: true,
          },
        );
    const reserved = reserveCaptureEntry(current, {
      id: message.interactionId,
      stepId: crypto.randomUUID(),
      kind: ["click", "contextmenu", "dblclick"].includes(message.sourceEvent)
        ? message.sourceEvent
        : "click",
      sourceEvent: ["click", "contextmenu", "dblclick"].includes(
        message.sourceEvent,
      )
        ? message.sourceEvent
        : "click",
      tabId: current.tabId,
      windowId: current.windowId,
      documentId: sender.documentId || null,
      navigationKey: message.navigationKey || expectedNavigationKey,
      visualEpoch: Number(message.visualEpoch) || 0,
      viewportKey: String(message.viewportKey || ""),
      frameId: prepared?.id || null,
      capturePending: !prepared,
      committed: false,
      context: {
        ...(message.context || {}),
        pageUrl: sender.tab.url || message.context?.pageUrl,
        masks: Array.isArray(message.context?.masks)
          ? message.context.masks
          : [],
      },
    });
    const updated = {
      ...reserved,
      activeDocumentId: current.activeDocumentId || sender.documentId || null,
      activeNavigationKey:
        current.activeNavigationKey || message.navigationKey || null,
      preparedFrames: prepared
        ? (reserved.preparedFrames || []).filter(
            (frame) => frame.id !== prepared.id,
          )
        : reserved.preparedFrames || [],
    };
    stagedEntry = captureEntry(updated, message.interactionId);
    needsFallback = !prepared;
    await setCaptureState(updated);
    return updated;
  });
  if (!stagedEntry) return { ok: false, ignored: true };
  await retainCaptureFrames(next);
  if (needsFallback) {
    void captureFallbackFrame(stagedEntry.id);
  } else {
    void sendToCapturedTab(next, {
      type: "KNOWHOW_RESTORE_PRIVACY_PREVIEW",
    });
  }
  return {
    ok: true,
    interactionId: stagedEntry.id,
    sequence: stagedEntry.order,
    frameClaimed: Boolean(stagedEntry.frameId),
  };
}

async function commitCaptureInteraction(message, sender) {
  const state = await getCaptureState();
  if (!senderMatchesCapture(state, message, sender, { allowPaused: true })) {
    return { ok: false, ignored: true };
  }
  let committedEntry = null;
  await withStateMutation(async () => {
    const current = await getCaptureState();
    const entry = captureEntry(current, message.interactionId);
    if (!entry) return current;
    if (entry.committed) {
      committedEntry = entry;
      return current;
    }
    const next = noteClickInteraction(
      updateCaptureEntry(current, entry.id, { committed: true }),
      { tabId: current.tabId },
    );
    committedEntry = captureEntry(next, entry.id);
    await setCaptureState(next);
    return next;
  });
  if (!committedEntry) return { ok: false, ignored: true };
  if (committedEntry.status === CaptureEntryStatus.CAPTURING) {
    void finalizeInteractionEntry(committedEntry.id);
  }
  return { ok: true, queued: true, sequence: committedEntry.order };
}

async function cancelCaptureInteraction(message, sender) {
  const state = await getCaptureState();
  if (!senderMatchesCapture(state, message, sender, { allowPaused: true })) {
    return { ok: false, ignored: true };
  }
  let removed = null;
  const next = await withStateMutation(async () => {
    const current = await getCaptureState();
    const entry = captureEntry(current, message.interactionId);
    if (!entry || entry.status === CaptureEntryStatus.READY || entry.committed) {
      return current;
    }
    removed = entry;
    const updated = removeCaptureEntry(current, entry.id);
    await setCaptureState(updated);
    return updated;
  });
  if (removed?.frameId) {
    await deleteCaptureFrame(next.sessionId, removed.frameId).catch(() => undefined);
  }
  await retainCaptureFrames(next);
  return { ok: true, cancelled: Boolean(removed) };
}

async function upgradeCaptureInteraction(message, sender) {
  const state = await getCaptureState();
  if (!senderMatchesCapture(state, message, sender, { allowPaused: true })) {
    return { ok: false, ignored: true };
  }
  const policy = await getCapturePolicy();
  let upgraded = null;
  await withStateMutation(async () => {
    const current = await getCaptureState();
    const entry = captureEntry(current, message.interactionId);
    if (!entry) return current;
    const isSelect = message.sourceEvent === "select";
    const sourceEvent = isSelect
      ? entry.sourceEvent || "click"
      : message.sourceEvent === "dblclick"
        ? "dblclick"
        : entry.sourceEvent || "click";
    const fallbackTitle = isSelect
      ? "Select the option"
      : sourceEvent === "dblclick"
        ? "Double-click this control"
        : entry.context?.title || "Click here";
    const context = {
      ...(entry.context || {}),
      title: safeCaptureText(message.title, policy, 200, fallbackTitle),
      instructions: safeCaptureText(
        message.instructions,
        policy,
        2_000,
        fallbackTitle + ".",
      ),
    };
    const next = updateCaptureEntry(current, entry.id, {
      sourceEvent,
      kind: sourceEvent,
      context,
    });
    upgraded = captureEntry(next, entry.id);
    await setCaptureState(next);
    return next;
  });
  if (upgraded?.status === CaptureEntryStatus.READY) {
    await updateCapturedStep(state.sessionId, upgraded.stepId, {
      sourceEvent: upgraded.sourceEvent,
      title: upgraded.context?.title || "Captured step",
      instructions:
        upgraded.context?.instructions || "Follow the highlighted action.",
    }).catch(() => undefined);
  }
  return { ok: Boolean(upgraded), upgraded: Boolean(upgraded) };
}

async function retryCaptureEntry(entryId) {
  const state = await getCaptureState();
  if (!livePolicyStatuses.has(state.status)) {
    throw new Error("Screenshots can be retried while recording or paused.");
  }
  const entry = captureEntry(state, entryId);
  if (!entry || entry.status !== CaptureEntryStatus.NEEDS_ATTENTION) {
    throw new Error("That failed screenshot is no longer available.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(entry.tabId);
  } catch {
    throw new Error(
      "That tab was closed. Delete this step and capture the action again.",
    );
  }
  if (!Number.isInteger(tab?.id)) {
    throw new Error(
      "That tab was closed. Delete this step and capture the action again.",
    );
  }
  await chrome.tabs.update(entry.tabId, { active: true });
  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
  await followActiveTabSwitch({
    tabId: entry.tabId,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : state.windowId,
  });
  return recaptureFailedEntry(entryId);
}

async function recaptureFailedEntry(entryId) {
  const existing = recaptureInFlight.get(entryId);
  if (existing) return existing;
  const operation = (async () => {
    const state = await getCaptureState();
    if (!livePolicyStatuses.has(state.status)) {
      throw new Error("Screenshots can be retried while recording or paused.");
    }
    const entry = captureEntry(state, entryId);
    if (!entry) {
      throw new Error("That failed screenshot is no longer available.");
    }
    if (entry.status !== CaptureEntryStatus.NEEDS_ATTENTION) {
      return state;
    }
    if (state.tabId !== entry.tabId) {
      throw new Error(
        "KnowHow could not return to that tab. Delete this step and capture the action again.",
      );
    }
    let page = await sendToCapturedTab(state, {
      type: "KNOWHOW_GET_PAGE_CONTEXT",
    });
    if (!page?.ok) {
      await injectCaptureContent(state, await getCapturePolicy());
      page = await sendToCapturedTab(await getCaptureState(), {
        type: "KNOWHOW_GET_PAGE_CONTEXT",
      });
    }
    if (!page?.ok) {
      throw new Error("KnowHow could not read this page for retry.");
    }
    await withStateMutation(async () => {
      const current = await getCaptureState();
      const latestEntry = captureEntry(current, entryId);
      if (
        !latestEntry ||
        latestEntry.status !== CaptureEntryStatus.NEEDS_ATTENTION
      ) {
        return current;
      }
      const next = resetCaptureEntryForRetry(current, entryId, {
        tabId: current.tabId,
        documentId: current.activeDocumentId || latestEntry.documentId || null,
        navigationKey:
          page.context?.navigationKey ||
          current.activeNavigationKey ||
          latestEntry.navigationKey,
        visualEpoch: Number(page.context?.visualEpoch) || latestEntry.visualEpoch,
        viewportKey: page.context?.viewportKey || latestEntry.viewportKey || "",
        context: {
          ...(latestEntry.context || {}),
          masks: page.context?.masks || [],
          viewport: page.context?.viewport || latestEntry.context?.viewport,
          sanitizedUrl:
            page.context?.sanitizedUrl ||
            current.sanitizedUrl ||
            latestEntry.context?.sanitizedUrl,
        },
      });
      await setCaptureState(next);
      return next;
    });
    void captureFallbackFrame(entryId, {
      deadlineMs: 1_600,
      preparePage: true,
      hideLiveBlur: false,
    });
    return getCaptureState();
  })().finally(() => {
    recaptureInFlight.delete(entryId);
  });
  recaptureInFlight.set(entryId, operation);
  return operation;
}

async function autoRetryNeedsAttentionOnTab(tabId) {
  const state = await getCaptureState();
  if (!livePolicyStatuses.has(state.status) || state.tabId !== tabId) return;
  const pending = (state.captureEntries || []).filter(
    (entry) =>
      entry.status === CaptureEntryStatus.NEEDS_ATTENTION &&
      entry.tabId === tabId,
  );
  for (const entry of pending) {
    try {
      await recaptureFailedEntry(entry.id);
    } catch {
      // Leave the card; the author can still retry or delete it.
    }
  }
}

async function deleteCaptureEntryFromFeed(entryId) {
  let removed = null;
  const next = await withStateMutation(async () => {
    const current = await getCaptureState();
    if (!livePolicyStatuses.has(current.status)) {
      throw new Error("Capture entries can be deleted while recording or paused.");
    }
    removed = captureEntry(current, entryId);
    if (!removed) throw new Error("That capture entry no longer exists.");
    const updated = removeCaptureEntry(current, entryId);
    await setCaptureState(updated);
    return updated;
  });
  if (removed.frameId) {
    await deleteCaptureFrame(next.sessionId, removed.frameId).catch(() => undefined);
  }
  if (removed.additionalFrameId) {
    await deleteCaptureFrame(next.sessionId, removed.additionalFrameId).catch(
      () => undefined,
    );
  }
  if (removed.stepId) {
    await deleteCapturedStep(next.sessionId, removed.stepId).catch(() => undefined);
  }
  await retainCaptureFrames(next);
  return next;
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
  await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !isCollecting(latest) ||
      latest.sessionId !== state.sessionId ||
      latest.tabId !== details.sourceTabId
    ) {
      return latest;
    }
    const next = {
      ...latest,
      pendingNavigationTargets: [
        ...(latest.pendingNavigationTargets || []).filter(
          (target) => target.tabId !== details.tabId,
        ),
        {
          tabId: details.tabId,
          sourceTabId: details.sourceTabId,
          createdAtMs: Date.now(),
        },
      ].slice(-20),
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
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
  // Wake an already-injected recorder before any load wait so Smart Blur
  // covers the page on the same turn the author lands on it.
  void chrome.tabs
    .sendMessage(tabId, { type: "KNOWHOW_WAKE_SMART_BLUR" })
    .catch(() => undefined);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.incognito) return;
  let verdict;
  try {
    verdict = evaluateCaptureUrl(requireRegularPageUrl(tab), policy);
  } catch {
    await waitForTabComplete(tabId);
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    if (tab.incognito) return;
    try {
      verdict = evaluateCaptureUrl(requireRegularPageUrl(tab), policy);
    } catch {
      return;
    }
  }
  // The tab may have been dragged into another window while it loaded, so the
  // window it lives in now decides whether it is the tab in front.
  const targetWindowId = Number.isInteger(tab.windowId) ? tab.windowId : windowId;
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: targetWindowId,
  });
  if (!activeTab || activeTab.id !== tabId) return;
  if (!verdict.allowed) return;

  await sendToCapturedTab(state, {
    type: "KNOWHOW_SET_STATUS",
    status: CaptureStatus.PAUSED,
    reason: "Capture moved to another tab.",
  });
  let topFrame = null;
  try {
    topFrame = chrome.webNavigation.getFrame
      ? await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
      : null;
  } catch {
    topFrame = null;
  }
  const documentId = topFrame?.documentId || null;
  let activationRecordKey = null;
  let openedTarget = false;

  const switched = await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !isCollecting(latest) ||
      latest.sessionId !== state.sessionId ||
      latest.tabId === tabId
    ) {
      return null;
    }
    const transitionId = Math.max(
      0,
      Number(latest.nextNavigationSequence) || 0,
    );
    const tabDocumentSessions = { ...(latest.tabDocumentSessions || {}) };
    if (Number.isInteger(latest.tabId) && latest.activeNavigationKey) {
      tabDocumentSessions[String(latest.tabId)] = {
        documentId: latest.activeDocumentId || null,
        navigationKey: latest.activeNavigationKey,
        sanitizedUrl: latest.sanitizedUrl,
        manualBlurCount: Number(latest.manualBlurCount) || 0,
      };
    }
    const previousTargetSession = tabDocumentSessions[String(tabId)];
    const canResumePageSession = Boolean(
      previousTargetSession?.navigationKey &&
        previousTargetSession.sanitizedUrl === verdict.sanitizedUrl &&
        (!documentId ||
          !previousTargetSession.documentId ||
          previousTargetSession.documentId === documentId),
    );
    const activeDocumentId =
      documentId ||
      (canResumePageSession ? previousTargetSession.documentId : null);
    const activeNavigationKey = canResumePageSession
      ? previousTargetSession.navigationKey
      : navigationKey(
          {
            tabId,
            documentId: activeDocumentId,
            sanitizedUrl: verdict.sanitizedUrl,
            transitionId,
          },
          "document",
        );
    activationRecordKey = navigationKey(
      {
        tabId,
        documentId: activeDocumentId,
        sanitizedUrl: verdict.sanitizedUrl,
        transitionId,
      },
      "activation",
    );
    openedTarget = (latest.pendingNavigationTargets || []).some(
      (target) => target.tabId === tabId,
    );
    tabDocumentSessions[String(tabId)] = {
      documentId: activeDocumentId,
      navigationKey: activeNavigationKey,
      sanitizedUrl: verdict.sanitizedUrl,
      manualBlurCount: canResumePageSession
        ? Number(previousTargetSession.manualBlurCount) || 0
        : 0,
    };
    const next = {
      ...latest,
      tabId,
      windowId: targetWindowId,
      origin: verdict.origin,
      scopeLabel: scopeLabelForHost(latest, verdict.hostname),
      sanitizedUrl: verdict.sanitizedUrl,
      activeDocumentId,
      activeNavigationKey,
      tabDocumentSessions,
      nextNavigationSequence: transitionId + 1,
      preparedFrames: [],
      manualBlurCount: canResumePageSession
        ? Number(previousTargetSession.manualBlurCount) || 0
        : 0,
      pendingNavigationTargets: (latest.pendingNavigationTargets || []).filter(
        (target) => target.tabId !== tabId,
      ),
      lastNavigationUrl: verdict.sanitizedUrl,
      lastNavigationAt: Date.now(),
      lastNavigationHandoff: activeDocumentId
        ? {
            tabId,
            documentId: activeDocumentId,
            sanitizedUrl: verdict.sanitizedUrl,
            recordedAtMs: Date.now(),
          }
        : null,
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
  if (!switched) return;

  try {
    await injectCaptureContent(
      switched,
      policy,
      switched.activeDocumentId || undefined,
    );
  } catch {
    return;
  }
  await retainCaptureFrames(switched);
  await recordNavigationDestination(
    {
      tabId,
      frameId: 0,
      documentId: switched.activeDocumentId || null,
      url: tab.url,
    },
    {
      titleMode: openedTarget ? "new-tab" : "switch",
      policy,
      recordKey: activationRecordKey,
    },
  );
  await autoRetryNeedsAttentionOnTab(tabId);
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

async function commitNavigationTransition(details, kind = "document") {
  if (details.frameId !== 0) return null;
  const state = await getCaptureState();
  if (!isCollecting(state) || state.tabId !== details.tabId) return null;
  const policy = await getCapturePolicy();
  let verdict;
  try {
    verdict = evaluateCaptureUrl(details.url, policy);
  } catch {
    return null;
  }
  if (!verdict.allowed) {
    await pauseCapture(verdict.reason);
    return null;
  }
  let salvagedClickId = null;
  const transitioned = await withStateMutation(async () => {
    let latest = await getCaptureState();
    if (
      !isCollecting(latest) ||
      latest.acceptingEvents === false ||
      latest.sessionId !== state.sessionId ||
      latest.tabId !== details.tabId
    ) {
      return null;
    }
    // The click that triggered this navigation may have lost its commit when
    // the page went away. Adopt it now, before the transition clears the
    // prepared frames it was going to use.
    const unconfirmed = unconfirmedClickEntryAt(latest, {
      tabId: details.tabId,
    });
    if (unconfirmed) {
      salvagedClickId = unconfirmed.id;
      latest = noteClickInteraction(
        updateCaptureEntry(latest, unconfirmed.id, { committed: true }),
        { tabId: latest.tabId },
      );
    }
    const transitionId = Math.max(
      0,
      Number(latest.nextNavigationSequence) || 0,
    );
    const activeNavigationKey = navigationKey(
      {
        tabId: details.tabId,
        documentId: details.documentId || latest.activeDocumentId,
        sanitizedUrl: verdict.sanitizedUrl,
        transitionId,
      },
      kind,
    );
    const tabDocumentSessions = {
      ...(latest.tabDocumentSessions || {}),
      [String(details.tabId)]: {
        documentId: details.documentId || null,
        navigationKey: activeNavigationKey,
        sanitizedUrl: verdict.sanitizedUrl,
      },
    };
    const next = {
      ...latest,
      origin: verdict.origin,
      scopeLabel: scopeLabelForHost(latest, verdict.hostname),
      sanitizedUrl: verdict.sanitizedUrl,
      activeDocumentId: details.documentId || null,
      activeNavigationKey,
      tabDocumentSessions,
      nextNavigationSequence: transitionId + 1,
      preparedFrames: [],
      manualBlurCount: 0,
      lastNavigationUrl: verdict.sanitizedUrl,
      lastNavigationAt: Date.now(),
      updatedAt: new Date().toISOString(),
    };
    await setCaptureState(next);
    return next;
  });
  if (!transitioned) return null;
  if (salvagedClickId) {
    const salvaged = captureEntry(transitioned, salvagedClickId);
    if (salvaged?.status === CaptureEntryStatus.CAPTURING) {
      void finalizeInteractionEntry(salvagedClickId);
    }
  }
  await retainCaptureFrames(transitioned);
  try {
    await injectCaptureContent(
      transitioned,
      policy,
      details.documentId || undefined,
    );
    if (kind === "history") {
      await sendToCapturedTab(
        transitioned,
        {
          type: "KNOWHOW_RESET_PAGE_SESSION",
          navigationKey: transitioned.activeNavigationKey,
        },
        details.documentId ? { documentId: details.documentId } : undefined,
      );
    }
  } catch {
    // onCompleted retries injection after the destination document is ready.
  }
  return transitioned;
}

async function recordNavigationAttention(
  snapshot,
  details,
  verdict,
  stableRecordKey,
  error,
) {
  return withStateMutation(async () => {
    const current = await getCaptureState();
    if (
      !isCollecting(current) ||
      current.acceptingEvents === false ||
      current.sessionId !== snapshot.sessionId ||
      current.tabId !== details.tabId
    ) {
      return current;
    }
    const remembered = rememberNavigationKey(current, stableRecordKey);
    if (remembered.duplicate) {
      await setCaptureState(remembered.state);
      return remembered.state;
    }
    const entryId = `navigation:${stableRecordKey}`;
    const reserved = reserveCaptureEntry(remembered.state, {
      id: entryId,
      stepId: crypto.randomUUID(),
      kind: "navigation",
      sourceEvent: "navigation",
      tabId: current.tabId,
      windowId: current.windowId,
      documentId: details.documentId || current.activeDocumentId || null,
      navigationKey: current.activeNavigationKey || stableRecordKey,
      committed: true,
      capturePending: false,
      context: {
        title: `Open ${verdict.sanitizedUrl}`,
        instructions: "Continue on the captured page.",
        sanitizedUrl: verdict.sanitizedUrl,
      },
    });
    const failed = markCaptureEntryFailed(reserved, entryId, error);
    await setCaptureState(failed);
    return failed;
  });
}

async function attachSettledFrameToLastClick(details) {
  const tabKey = `tab:${details.tabId}`;
  if (settledFrameJobs.has(tabKey)) return false;
  const operation = (async () => {
    const snapshot = await getCaptureState();
    if (!isCollecting(snapshot) || snapshot.tabId !== details.tabId) return false;
    const response = await sendToCapturedTab(snapshot, {
      type: "KNOWHOW_CAPTURE_SETTLED_FRAME",
    });
    if (!response?.ok) return false;
    const latest = await getCaptureState();
    if (!clickEntryNeedsSettledFrame(latest, details)) return false;
    const entry = lastClickCaptureEntry(latest);
    if (!entry) return false;
    const frameId = `settled-${entry.id}`;
    const result = await enqueueScreenshot(
      (reserveSlot) =>
        processPreparedFrame({
          state: latest,
          context: {
            ...(entry.context || {}),
            ...(response.context || {}),
            masks: response.context?.masks || entry.context?.masks || [],
            viewport: response.context?.viewport || entry.context?.viewport,
          },
          frameId,
          interactionId: entry.id,
          navigationKey: latest.activeNavigationKey,
          visualEpoch: Number(response.context?.visualEpoch) || 0,
          viewportKey: String(response.context?.viewportKey || ""),
          documentId: latest.activeDocumentId || entry.documentId,
          reserveSlot,
          deadlineRequired: false,
        }),
      { deadlineMs: 1_600, priority: ScreenshotPriority.NAVIGATION },
    );
    if (!result) return false;
    const attached = await withStateMutation(async () => {
      const current = await getCaptureState();
      const currentEntry = captureEntry(current, entry.id);
      if (!currentEntry || currentEntry.additionalFrameId) {
        await deleteCaptureFrame(current.sessionId, frameId).catch(() => undefined);
        return current;
      }
      const updated = updateCaptureEntry(
        current,
        entry.id,
        currentEntry.frameId
          ? { additionalFrameId: frameId }
          : { frameId, capturePending: false },
      );
      await setCaptureState(updated);
      return updated;
    });
    const attachedEntry = captureEntry(attached, entry.id);
    if (
      attachedEntry?.status === CaptureEntryStatus.CAPTURING &&
      attachedEntry.frameId === frameId
    ) {
      await finalizeInteractionEntry(attachedEntry.id);
    } else if (
      attachedEntry?.status === CaptureEntryStatus.READY &&
      attachedEntry.additionalFrameId === frameId
    ) {
      await updateCapturedStep(attached.sessionId, attachedEntry.stepId, {
        additionalFrameId: frameId,
      }).catch(() => undefined);
    }
    await retainCaptureFrames(attached);
    return true;
  })();
  settledFrameJobs.set(tabKey, operation);
  return operation.finally(() => {
    if (settledFrameJobs.get(tabKey) === operation) {
      settledFrameJobs.delete(tabKey);
    }
  });
}

async function persistTextNavigationStep({
  state,
  entryId,
  stepId,
  title,
  instructions,
  sanitizedUrl,
}) {
  const policy = await getCapturePolicy();
  const reserved = captureEntry(state, entryId);
  await putCapturedStep({
    sessionId: state.sessionId,
    id: stepId,
    order: reserved?.order || 0,
    title: safeCaptureText(title, policy, 200, "Switch to this tab"),
    instructions: safeCaptureText(
      instructions,
      policy,
      2_000,
      "Continue on this tab.",
    ),
    sanitizedUrl: sanitizedUrl || "",
    sourceEvent: "navigation",
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    automaticMaskCount: 0,
    manualMaskCount: 0,
    pendingRedactions: [],
  });
  await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (!captureEntry(latest, entryId)) return latest;
    const next = markCaptureEntryReady(latest, entryId);
    await setCaptureState(next);
    return next;
  });
}

async function warmDestinationPreparedFrame(state, context, details) {
  if (!context?.viewportKey) return;
  await sendToCapturedTab(state, { type: "KNOWHOW_WAIT_PAGE_SETTLED" });
  const frameId = crypto.randomUUID();
  const documentId = details.documentId || state.activeDocumentId || null;
  const frameNavigationKey =
    state.activeNavigationKey || context.navigationKey || null;
  try {
    const result = await enqueueScreenshot(
      (reserveSlot) =>
        processPreparedFrame({
          state,
          context,
          frameId,
          navigationKey: frameNavigationKey,
          visualEpoch: Number(context.visualEpoch) || 0,
          viewportKey: String(context.viewportKey || ""),
          documentId,
          reserveSlot,
          deadlineRequired: false,
          hideLiveBlur: false,
        }),
      {
        deadlineMs: 1_600,
        priority: ScreenshotPriority.PREPARED,
        supersedes: `prepared:${state.tabId}`,
      },
    );
    if (!result) return;
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        latest.sessionId !== state.sessionId ||
        !isCollecting(latest) ||
        latest.tabId !== details.tabId
      ) {
        return latest;
      }
      const preparedFrames = [
        ...(latest.preparedFrames || []).filter((frame) => frame.id !== frameId),
        {
          sessionId: latest.sessionId,
          id: frameId,
          tabId: latest.tabId,
          documentId,
          navigationKey: frameNavigationKey,
          visualEpoch: Number(context.visualEpoch) || 0,
          viewportKey: String(context.viewportKey || ""),
          capturedAtMs: result.capturedAtMs,
        },
      ].slice(-2);
      const next = { ...latest, preparedFrames, updatedAt: new Date().toISOString() };
      await setCaptureState(next);
      return next;
    });
  } catch {
    // The next click can still fall back to a queued tab screenshot.
  }
}

async function recordNavigationDestination(
  details,
  { titleMode = "navigation", policy: providedPolicy, recordKey } = {},
) {
  let state = await getCaptureState();
  if (
    details.frameId !== 0 ||
    !isCollecting(state) ||
    state.acceptingEvents === false ||
    state.tabId !== details.tabId
  ) {
    return false;
  }
  const policy = providedPolicy || (await getCapturePolicy());
  const verdict = evaluateCaptureUrl(details.url, policy);
  if (!verdict.allowed) return false;
  if (state.sanitizedUrl !== verdict.sanitizedUrl) {
    state = await commitNavigationTransition(details, "document");
    if (!state) return false;
  }
  if (!shouldMintNavigationStep(titleMode)) {
    await withStateMutation(async () => {
      const latest = await getCaptureState();
      if (
        !isCollecting(latest) ||
        latest.sessionId !== state.sessionId ||
        latest.tabId !== details.tabId
      ) {
        return latest;
      }
      const remembered = rememberRecordedDestination(
        latest,
        verdict.sanitizedUrl,
      );
      await setCaptureState(remembered);
      return remembered;
    });
    void attachSettledFrameToLastClick(details);
    return false;
  }
  if (shouldDropTrailingTabSwitch(state, details, { titleMode })) {
    return false;
  }
  if (
    details.documentId &&
    state.activeDocumentId &&
    details.documentId !== state.activeDocumentId
  ) {
    return false;
  }
  const stableRecordKey =
    recordKey || `destination:${state.activeNavigationKey || verdict.sanitizedUrl}`;
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: state.windowId,
  });
  if (!activeTab || activeTab.id !== state.tabId) {
    await recordNavigationAttention(
      state,
      details,
      verdict,
      stableRecordKey,
      "The destination was no longer visible when its screenshot was due. Return to the page and retry, or delete this step.",
    );
    return false;
  }
  try {
    await injectCaptureContent(
      state,
      policy,
      details.documentId || state.activeDocumentId || undefined,
    );
  } catch {
    await recordNavigationAttention(
      state,
      details,
      verdict,
      stableRecordKey,
      "KnowHow could not attach to the destination document. Reload the page and retry, or delete this step.",
    );
    return false;
  }
  const response = await sendToCapturedTab(
    state,
    { type: "KNOWHOW_GET_PAGE_CONTEXT" },
    details.documentId || state.activeDocumentId
      ? { documentId: details.documentId || state.activeDocumentId }
      : undefined,
  );
  let pageTitle = response?.ok ? response.context?.title : "";
  if (!pageTitle) {
    try {
      const tab = await chrome.tabs.get(details.tabId);
      pageTitle = tab?.title || "";
    } catch {
      pageTitle = "";
    }
  }
  pageTitle = pageTitle || "the next page";
  if (titleMode !== "switch" && !response?.ok) {
    await recordNavigationAttention(
      state,
      details,
      verdict,
      stableRecordKey,
      "KnowHow could not prepare the destination screenshot. Return to the page and retry, or delete this step.",
    );
    return false;
  }
  const switched = titleMode === "switch" ? switchNavigationCopy(pageTitle) : null;
  const title = switched
    ? switched.title
    : titleMode === "new-tab"
      ? `Open ${pageTitle} in a new tab`
      : `Open ${pageTitle}`;
  const instructions = switched
    ? switched.instructions
    : titleMode === "new-tab"
      ? "Continue in the new tab."
      : "Continue on the captured page.";
  const entryId = `navigation:${stableRecordKey}`;
  const stepId = crypto.randomUUID();
  let duplicate = false;
  let reservedState = null;
  await withStateMutation(async () => {
    const latest = await getCaptureState();
    if (
      !isCollecting(latest) ||
      latest.acceptingEvents === false ||
      latest.sessionId !== state.sessionId ||
      latest.tabId !== details.tabId
    ) {
      return latest;
    }
    const remembered = rememberNavigationKey(latest, stableRecordKey);
    duplicate = remembered.duplicate;
    let next = remembered.state;
    if (!duplicate) {
      next = rememberRecordedDestination(
        reserveCaptureEntry(next, {
        id: entryId,
        stepId,
        kind: "navigation",
        sourceEvent: "navigation",
        tabId: latest.tabId,
        windowId: latest.windowId,
        documentId: details.documentId || latest.activeDocumentId || null,
        navigationKey: latest.activeNavigationKey || stableRecordKey,
        committed: true,
        capturePending: false,
        context: {
          ...((response?.context && typeof response.context === "object"
            ? response.context
            : {})),
          title,
          instructions,
          sanitizedUrl: verdict.sanitizedUrl,
        },
      }),
        verdict.sanitizedUrl,
      );
      reservedState = next;
    }
    await setCaptureState(next);
    return next;
  });
  if (duplicate || !reservedState) return false;
  if (titleMode === "switch") {
    await persistTextNavigationStep({
      state: reservedState,
      entryId,
      stepId,
      title,
      instructions,
      sanitizedUrl: verdict.sanitizedUrl,
    });
    if (response?.ok) {
      void warmDestinationPreparedFrame(
        reservedState,
        response.context || {},
        details,
      );
    }
    return true;
  }
  const job = snapshotCaptureJob(reservedState, {
    ...response.context,
    pageUrl: details.url,
    sourceEvent: "navigation",
    title,
    instructions,
    targetRect: null,
    clickPoint: null,
    documentId: details.documentId || reservedState.activeDocumentId || undefined,
    navigationKey: reservedState.activeNavigationKey || stableRecordKey,
    entryId,
    stepId,
  });
  try {
    return await enqueueScreenshot(
      (reserveSlot) => captureStep(job, reserveSlot),
      { priority: ScreenshotPriority.NAVIGATION },
    );
  } catch {
    return false;
  }
}

async function captureNavigation(details) {
  const state = await getCaptureState();
  if (!isCollecting(state) || details.frameId !== 0) return;
  if (state.tabId !== details.tabId) {
    await followOwnNewTab(details.tabId);
    return;
  }
  const verdict = evaluateCaptureUrl(details.url, await getCapturePolicy());
  if (!verdict.allowed) return;
  if (
    recentHandoffMatches(state, {
      tabId: details.tabId,
      documentId: details.documentId,
      sanitizedUrl: verdict.sanitizedUrl,
    })
  ) {
    return;
  }
  if (
    state.sanitizedUrl !== verdict.sanitizedUrl ||
    (details.documentId && state.activeDocumentId !== details.documentId)
  ) {
    await commitNavigationTransition(details, "document");
  }
  await recordNavigationDestination(details);
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
    case "RETRY_CAPTURE_ENTRY":
      return {
        ok: true,
        state: await retryCaptureEntry(message.entryId),
      };
    case "DELETE_CAPTURE_ENTRY":
      return {
        ok: true,
        state: await deleteCaptureEntryFromFeed(message.entryId),
      };
    case "EXCLUDE_CURRENT_SITE":
      return { ok: true, ...(await excludeCurrentSite(message.options)) };
    // Guide screenshots are private objects: the side panel asks the worker,
    // which is the only context holding the paired device credential.
    case "GET_GUIDE_MEDIA":
      try {
        return { ok: true, ...(await fetchGuideMedia(message.mediaId)) };
      } catch (error) {
        if (error?.status === 404) {
          await dropCompanionGuideByMedia(message.mediaId);
        }
        throw error;
      }
    case "REFRESH_LIBRARY":
      return { ok: true, companion: await refreshCompanionLibrary() };
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
    case "CONTENT_READY": {
      const state = await getCaptureState();
      if (
        !sender.tab ||
        sender.tab.id !== state.tabId ||
        !livePolicyStatuses.has(state.status)
      ) {
        return { ok: false, ignored: true };
      }
      if (!state.activeDocumentId && sender.documentId) {
        await withStateMutation(async () => {
          const current = await getCaptureState();
          if (current.tabId !== sender.tab.id || current.activeDocumentId) {
            return current;
          }
          const next = { ...current, activeDocumentId: sender.documentId };
          await setCaptureState(next);
          return next;
        });
      }
      return { ok: true };
    }
    case "PREPARE_CAPTURE_FRAME":
      return prepareCaptureFrame(message, sender);
    case "STAGE_INTERACTION":
      return stageCaptureInteraction(message, sender);
    case "COMMIT_INTERACTION":
      return commitCaptureInteraction(message, sender);
    case "CANCEL_INTERACTION":
      return cancelCaptureInteraction(message, sender);
    case "UPGRADE_INTERACTION":
      return upgradeCaptureInteraction(message, sender);
    case "MANUAL_BLUR_CHANGED": {
      const state = await getCaptureState();
      if (!senderMatchesCapture(state, message, sender, { allowPaused: true })) {
        return { ok: false, ignored: true };
      }
      const count = Math.max(0, Math.min(200, Number(message.count) || 0));
      await withStateMutation(async () => {
        const current = await getCaptureState();
        if (!senderMatchesCapture(current, message, sender, { allowPaused: true })) {
          return current;
        }
        const next = { ...current, manualBlurCount: count };
        await setCaptureState(next);
        return next;
      });
      return { ok: true, count };
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
  void enqueueNavigationTransition(activeInfo.tabId, () =>
    followActiveTabSwitch(activeInfo),
  ).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void (async () => {
    let closedActiveCapture = false;
    await withStateMutation(async () => {
      const current = await getCaptureState();
      if (!current.sessionId) return current;
      closedActiveCapture = current.tabId === tabId && isCollecting(current);
      const tabDocumentSessions = { ...(current.tabDocumentSessions || {}) };
      delete tabDocumentSessions[String(tabId)];
      const next = {
        ...current,
        tabDocumentSessions,
        pendingNavigationTargets: (current.pendingNavigationTargets || []).filter(
          (target) => target.tabId !== tabId && target.sourceTabId !== tabId,
        ),
      };
      await setCaptureState(next);
      return next;
    });
    if (closedActiveCapture) {
      const [replacement] = await chrome.tabs.query({
        active: true,
        windowId: removeInfo.windowId,
      });
      if (replacement && Number.isInteger(replacement.id)) {
        await enqueueNavigationTransition(replacement.id, () =>
          followActiveTabSwitch({
            tabId: replacement.id,
            windowId: replacement.windowId,
          }),
        );
      } else {
        await pauseCapture(
          "The captured tab was closed. Discard this capture or open a page and resume.",
        );
      }
    }
  })().catch(() => undefined);
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
      return enqueueNavigationTransition(tab.id, () =>
        followActiveTabSwitch({ tabId: tab.id, windowId }),
      );
    })
    .catch(() => undefined);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void enqueueNavigationTransition(details.tabId, () =>
    commitNavigationTransition(details, "document"),
  ).catch(() => undefined);
});
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  void enqueueNavigationTransition(details.tabId, () =>
    captureNavigation(details),
  ).catch(() => undefined);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void enqueueNavigationTransition(details.tabId, async () => {
    const transitioned = await commitNavigationTransition(details, "history");
    if (transitioned) await recordNavigationDestination(details);
  }).catch(() => undefined);
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void enqueueNavigationTransition(details.sourceTabId, () =>
    followNewTabNavigation(details),
  ).catch(() => undefined);
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

void (async () => {
  const state = await getCaptureState();
  const recovered = state.sessionId
    ? await reconcileCaptureEntries({ workerRecovery: true })
    : state;
  await updateActionBadge(recovered);
})().catch(() => undefined);
