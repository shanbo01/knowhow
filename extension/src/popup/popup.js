import { getConnectionState } from "../core/api-client.js";
import {
  getCapturedSteps,
  listCapturedSteps,
} from "../core/capture-store.js";
import { KNOWHOW_ORIGIN, STORAGE_KEYS } from "../core/config.js";
import {
  createCapturedStepCache,
  createRefreshGate,
  createThumbnailUrlCache,
  feedRevision,
  liveFeedVisible,
  stepCopy,
  thumbnailGeometry,
} from "./step-feed.js";

const elements = {
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  connectButton: document.querySelector("#connect-button"),
  panelTabs: Array.from(document.querySelectorAll("[data-panel-tab]")),
  capturePanel: document.querySelector("#capture-panel"),
  guidesPanel: document.querySelector("#guides-panel"),
  statusLabel: document.querySelector("#status-label"),
  statusDetail: document.querySelector("#status-detail"),
  stepCount: document.querySelector("#step-count"),
  stepFeed: document.querySelector("#step-feed"),
  feedCount: document.querySelector("#feed-count"),
  stepFeedScroll: document.querySelector("#step-feed-scroll"),
  stepFeedEmpty: document.querySelector("#step-feed-empty"),
  stepList: document.querySelector("#step-list"),
  startForm: document.querySelector("#start-form"),
  title: document.querySelector("#guide-title"),
  workspaceId: document.querySelector("#workspace-id"),
  startButton: document.querySelector("#start-button"),
  captureActions: document.querySelector("#capture-actions"),
  reviewActions: document.querySelector("#review-actions"),
  pauseButton: document.querySelector("#pause-button"),
  blurPanelButton: document.querySelector("#blur-panel-button"),
  finishButton: document.querySelector("#finish-button"),
  discardButton: document.querySelector("#discard-button"),
  reviewDiscardButton: document.querySelector("#review-discard-button"),
  openReviewButton: document.querySelector("#open-review-button"),
  privacySettings: document.querySelector("#privacy-settings"),
  smartBlurToggle: document.querySelector("#smart-blur-toggle"),
  smartBlurOptions: document.querySelector("#smart-blur-options"),
  excludeButton: document.querySelector("#exclude-button"),
  error: document.querySelector("#error"),
  policyInputs: Array.from(document.querySelectorAll("[data-policy]")),
  policyColor: document.querySelector("[data-policy-color]"),
  guideSearch: document.querySelector("#guide-search"),
  guideLibraryCount: document.querySelector("#guide-library-count"),
  guideLibraryEmpty: document.querySelector("#guide-library-empty"),
  guideResults: document.querySelector("#guide-results"),
  guideFollow: document.querySelector("#guide-follow"),
  guideFollowBack: document.querySelector("#guide-follow-back"),
  guideFollowStatus: document.querySelector("#guide-follow-status"),
  guideFollowTitle: document.querySelector("#guide-follow-title"),
  guideFollowSummary: document.querySelector("#guide-follow-summary"),
  guideFollowProgress: document.querySelector("#guide-follow-progress"),
  guideFollowProgressBar: document.querySelector("#guide-follow-progress-bar"),
  guideFollowSteps: document.querySelector("#guide-follow-steps"),
  guidePreviousStep: document.querySelector("#guide-previous-step"),
  guideNextStep: document.querySelector("#guide-next-step"),
  guideOpenApp: document.querySelector("#guide-open-app"),
};

let currentState;
let currentPolicy;
let currentContext;
let currentConnection;
let currentCompanion;
let activePanel = "capture";
let activeGuideId = null;
let activeGuideStep = 0;
let renderedFeedRevision = "";
let renderedFeedSessionId = null;
let captureActionPending = false;
let captureInitialized = false;
let connectionInitialized = false;
let policySaveTimer = null;
let policySaveDraft = null;
let policySaveInFlight = false;

const captureRefreshGate = createRefreshGate();
const thumbnailUrls = createThumbnailUrlCache();
const capturedSteps = createCapturedStepCache({
  getSteps: getCapturedSteps,
  listSteps: listCapturedSteps,
});

const captureAccess = Object.freeze({ origins: ["<all_urls>"] });

async function requestCaptureAccess() {
  const granted = await chrome.permissions.request(captureAccess);
  if (!granted) {
    throw new Error(
      "KnowHow needs website access to capture the page. Click Start again and select Allow in Chrome.",
    );
  }
}

async function getSelectedContentTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    throw new Error(
      "KnowHow could not find the active page. Select the page you want to capture and try again.",
    );
  }
  return { tabId: tab.id, windowId: tab.windowId };
}

function showError(message) {
  elements.error.textContent = message || "";
  elements.error.hidden = !message;
}

function policySavePending() {
  return Boolean(policySaveTimer || policySaveDraft || policySaveInFlight);
}

function policyControlsLocked() {
  return (
    !captureInitialized ||
    ["preparing", "reviewing", "uploading"].includes(
      currentState?.status,
    )
  );
}

function readPolicyControls() {
  const patch = {};
  for (const input of elements.policyInputs) {
    patch[input.dataset.policy] = input.checked;
  }
  patch.clickTargetColor = elements.policyColor.value;
  return patch;
}

function applyPolicyControls(policy) {
  for (const input of elements.policyInputs) {
    input.checked = Boolean(policy?.[input.dataset.policy]);
  }
  elements.policyColor.value = policy?.clickTargetColor || "#d97706";
  elements.smartBlurOptions.dataset.enabled =
    policy?.smartBlurEnabled === true ? "true" : "false";
  const smartBlurEnabled = policy?.smartBlurEnabled === true;
  elements.blurPanelButton.classList.toggle("active", smartBlurEnabled);
  elements.blurPanelButton.setAttribute("aria-pressed", String(smartBlurEnabled));
  elements.blurPanelButton.title = smartBlurEnabled
    ? "Smart Blur is on — open settings"
    : "Smart Blur is off — open settings";
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "KnowHow Capture could not complete the action.");
  }
  return response;
}

function statusDescription(state) {
  switch (state.status) {
    case "preparing":
      return "Preparing a private capture and attaching KnowHow to this tab.";
    case "recording":
      return state.captureWarning ||
        state.scopeLabel ||
        "Capturing clicks and navigation in this tab.";
    case "paused":
      return state.pausedReason || "No events or screenshots are being collected.";
    case "reviewing":
      return state.lastError
        ? state.lastError
        : "Wrapping up the capture before upload.";
    case "uploading":
      return "Uploading your captured screenshots to KnowHow.";
    case "completed":
      return "Draft created. Continue editing it in the KnowHow app.";
    case "error":
      return state.lastError || "Capture needs attention.";
    default:
      return "Start from the page you want to document.";
  }
}

function nearFeedBottom() {
  const feed = elements.stepFeedScroll;
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 72;
}

function createTrashIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const paths = ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v5", "M14 11v5"];
  for (const data of paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

function renderStepFeed(state, rawSteps) {
  const visible = liveFeedVisible(state);
  elements.stepFeed.hidden = !visible;
  if (!visible) {
    if (renderedFeedSessionId) {
      capturedSteps.clear(renderedFeedSessionId);
    }
    renderedFeedRevision = "";
    renderedFeedSessionId = null;
    thumbnailUrls.dispose();
    elements.feedCount.textContent = "0";
    elements.stepList.replaceChildren();
    elements.stepFeedEmpty.hidden = false;
    return;
  }

  const steps = [...rawSteps];
  const revision = feedRevision(state.sessionId, steps);
  if (
    renderedFeedSessionId === state.sessionId &&
    renderedFeedRevision === revision
  ) {
    return;
  }

  if (renderedFeedSessionId !== state.sessionId) {
    if (renderedFeedSessionId) {
      capturedSteps.clear(renderedFeedSessionId);
    }
    thumbnailUrls.dispose();
  }
  const shouldFollowLatest = nearFeedBottom();
  const fragment = document.createDocumentFragment();

  steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = "step-card";
    item.dataset.sourceEvent =
      step.sourceEvent === "navigation" ? "navigation" : "interaction";

    const copy = stepCopy(step);
    const copyRow = document.createElement("div");
    copyRow.className = "step-card-copy";
    const number = document.createElement("span");
    number.className = "step-number";
    number.textContent = String(index + 1);
    const text = document.createElement("span");
    text.className = "step-card-text";
    const title = document.createElement("strong");
    title.className = "step-card-title";
    title.textContent = copy.title;
    text.append(title);
    if (copy.detail) {
      const detail = document.createElement("span");
      detail.className = "step-card-detail";
      detail.textContent = copy.detail;
      text.append(detail);
    }
    const remove = document.createElement("button");
    remove.className = "step-delete";
    remove.type = "button";
    remove.title = "Delete this captured step";
    remove.setAttribute("aria-label", `Delete step ${index + 1}`);
    remove.append(createTrashIcon());
    remove.addEventListener("click", async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      showError("");
      try {
        await request({ type: "DELETE_CAPTURED_STEP", stepId: step.id });
        renderedFeedRevision = "";
        await refreshCapture();
      } catch (error) {
        remove.disabled = false;
        showError(error instanceof Error ? error.message : "Could not delete this step.");
      }
    });
    copyRow.append(number, text, remove);
    item.append(copyRow);

    const thumbnailUrl =
      step.sourceEvent === "navigation" ? null : thumbnailUrls.get(step);
    if (thumbnailUrl) {
      const geometry = thumbnailGeometry(step);
      const thumbnail = document.createElement("figure");
      thumbnail.className = "step-thumbnail";
      thumbnail.style.aspectRatio = String(geometry.aspectRatio);
      const image = document.createElement("img");
      image.src = thumbnailUrl;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.style.left = geometry.image.left + "%";
      image.style.top = geometry.image.top + "%";
      image.style.width = geometry.image.width + "%";
      thumbnail.append(image);
      if (geometry.clickTarget) {
        const ring = document.createElement("span");
        ring.className = "step-click-ring";
        ring.style.left = geometry.clickTarget.x * 100 + "%";
        ring.style.top = geometry.clickTarget.y * 100 + "%";
        ring.style.setProperty(
          "--click-color",
          geometry.clickTarget.color || currentPolicy?.clickTargetColor || "#d97706",
        );
        thumbnail.append(ring);
      }
      item.append(thumbnail);
    }
    fragment.append(item);
  });

  elements.stepList.replaceChildren(fragment);
  elements.feedCount.textContent = String(steps.length);
  elements.stepFeedEmpty.hidden = steps.length > 0;
  thumbnailUrls.prune(
    steps
      .filter(
        (step) =>
          step.sourceEvent !== "navigation" && step.imageBlob instanceof Blob,
      )
      .map((step) => step.id),
  );
  renderedFeedSessionId = state.sessionId;
  renderedFeedRevision = revision;

  if (shouldFollowLatest && steps.length) {
    requestAnimationFrame(() => {
      elements.stepFeedScroll.scrollTop = elements.stepFeedScroll.scrollHeight;
    });
  }
}

function companionGuides() {
  return Array.isArray(currentCompanion?.guides) ? currentCompanion.guides : [];
}

function setActivePanel(panel) {
  activePanel = panel === "guides" ? "guides" : "capture";
  elements.capturePanel.hidden = activePanel !== "capture";
  elements.guidesPanel.hidden = activePanel !== "guides";
  for (const tab of elements.panelTabs) {
    const selected = tab.dataset.panelTab === activePanel;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  }
  if (activePanel === "guides") renderGuideLibrary();
}

function renderGuideFollow() {
  const guide = companionGuides().find((item) => item.id === activeGuideId);
  if (!guide) {
    activeGuideId = null;
    elements.guideFollow.hidden = true;
    elements.guideResults.hidden = false;
    return;
  }
  const steps = Array.isArray(guide.steps) ? guide.steps : [];
  activeGuideStep = Math.max(0, Math.min(activeGuideStep, Math.max(0, steps.length - 1)));
  elements.guideResults.hidden = true;
  elements.guideLibraryEmpty.hidden = true;
  elements.guideFollow.hidden = false;
  elements.guideFollowStatus.textContent = guide.restricted ? "Restricted guide" : guide.status;
  elements.guideFollowTitle.textContent = guide.title;
  elements.guideFollowSummary.textContent = guide.summary || "Follow each step in order.";
  const completed = steps.length ? activeGuideStep + 1 : 0;
  elements.guideFollowProgress.textContent = steps.length
    ? `Step ${completed} of ${steps.length}`
    : "No steps";
  elements.guideFollowProgressBar.style.width =
    (steps.length ? (completed / steps.length) * 100 : 0) + "%";
  const fragment = document.createDocumentFragment();
  steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = "guide-follow-step";
    if (index === activeGuideStep) item.classList.add("active");
    if (index < activeGuideStep) item.classList.add("complete");
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => {
      activeGuideStep = index;
      renderGuideFollow();
    });
    const number = document.createElement("span");
    number.textContent = index < activeGuideStep ? "✓" : String(index + 1);
    const copy = document.createElement("span");
    const kind = document.createElement("small");
    kind.textContent = step.kind || "action";
    const title = document.createElement("strong");
    title.textContent = step.title || `Step ${index + 1}`;
    copy.append(kind, title);
    if (step.description) {
      const description = document.createElement("p");
      description.textContent = step.description;
      copy.append(description);
    }
    button.append(number, copy);
    item.append(button);
    fragment.append(item);
  });
  elements.guideFollowSteps.replaceChildren(fragment);
  elements.guidePreviousStep.disabled = activeGuideStep <= 0;
  elements.guideNextStep.disabled = !steps.length || activeGuideStep >= steps.length - 1;
}

function renderGuideLibrary() {
  applySharedTheme();
  const guides = companionGuides();
  elements.guideLibraryCount.textContent = String(guides.length);
  if (activeGuideId) {
    renderGuideFollow();
    return;
  }
  elements.guideFollow.hidden = true;
  elements.guideResults.hidden = false;
  const query = elements.guideSearch.value.trim().toLowerCase();
  const filtered = guides.filter((guide) => {
    if (!query) return true;
    const searchable = [
      guide.title,
      guide.summary,
      ...(guide.steps || []).flatMap((step) => [step.title, step.description]),
    ].join(" ").toLowerCase();
    return searchable.includes(query);
  });
  elements.guideLibraryEmpty.hidden = filtered.length > 0;
  elements.guideLibraryEmpty.textContent = guides.length
    ? `No guides match “${elements.guideSearch.value.trim()}”.`
    : "Open KnowHow once to sync the guides you can access.";
  const fragment = document.createDocumentFragment();
  for (const guide of filtered) {
    const button = document.createElement("button");
    button.className = "guide-result";
    button.type = "button";
    button.addEventListener("click", () => {
      activeGuideId = guide.id;
      activeGuideStep = 0;
      renderGuideFollow();
    });
    const icon = document.createElement("span");
    icon.className = "guide-result-icon";
    icon.textContent = "↗";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = guide.title;
    const summary = document.createElement("small");
    summary.textContent = guide.summary || `${guide.steps?.length || 0} steps`;
    const meta = document.createElement("span");
    meta.textContent = `${guide.steps?.length || 0} steps · ${guide.status}`;
    copy.append(title, summary, meta);
    button.append(icon, copy);
    fragment.append(button);
  }
  elements.guideResults.replaceChildren(fragment);
}

function renderState(state, policy) {
  currentState = state;
  if (!policySavePending() || !currentPolicy) {
    currentPolicy = policy || currentPolicy || {};
  }
  const label =
    state.status.charAt(0).toUpperCase() + state.status.slice(1);
  elements.statusLabel.textContent = label;
  elements.statusDetail.textContent = statusDescription(state);
  elements.stepCount.textContent = String(state.stepCount || 0);

  const preparing = state.status === "preparing";
  const active = state.status === "recording" || state.status === "paused";
  const reviewing =
    state.status === "reviewing" || state.status === "uploading";
  document.body.dataset.captureMode = preparing
    ? "preparing"
    : active
    ? "active"
    : reviewing
      ? "reviewing"
      : "idle";
  elements.startForm.hidden = preparing || active || reviewing;
  elements.stepFeed.hidden = !active;
  // The full policy controls now live in the page-level Smart Blur panel so
  // they can preview protected regions in context. These inputs remain wired
  // here as the single source of truth for policy persistence.
  elements.privacySettings.hidden = true;
  elements.captureActions.hidden = !(preparing || active);
  elements.reviewActions.hidden = !reviewing;
  elements.pauseButton.textContent =
    state.status === "paused" ? "Resume" : "Pause";

  if (!policySavePending()) applyPolicyControls(currentPolicy);
  const lockPolicy = policyControlsLocked();
  for (const input of elements.policyInputs) input.disabled = lockPolicy;
  elements.policyColor.disabled = lockPolicy;
  elements.workspaceId.value =
    currentContext?.workspaceName ||
    currentContext?.workspaceId ||
    currentConnection?.workspaceId ||
    "";
  syncCaptureActionControls();
  syncConnectionControls();
}

function syncCaptureActionControls() {
  const status = currentState?.status || "idle";
  elements.startButton.disabled =
    captureActionPending ||
    policySavePending() ||
    !captureInitialized ||
    !connectionInitialized ||
    !currentPolicy ||
    !currentConnection?.connected;
  elements.pauseButton.disabled =
    captureActionPending || !["recording", "paused"].includes(status);
  elements.finishButton.disabled =
    captureActionPending || !["recording", "paused"].includes(status);
  elements.discardButton.disabled =
    captureActionPending || !["preparing", "recording", "paused"].includes(status);
  elements.reviewDiscardButton.disabled =
    captureActionPending || status !== "reviewing";
  elements.openReviewButton.disabled =
    captureActionPending || status !== "reviewing";
  elements.excludeButton.disabled =
    captureActionPending || policySavePending() || !captureInitialized;
  elements.blurPanelButton.disabled =
    captureActionPending || !["recording", "paused"].includes(status);
}

function syncConnectionControls() {
  elements.connectButton.disabled = captureActionPending;
}

function beginCaptureAction() {
  if (captureActionPending) return false;
  captureActionPending = true;
  syncCaptureActionControls();
  return true;
}

function endCaptureAction() {
  captureActionPending = false;
  syncCaptureActionControls();
}

async function refreshCapture() {
  const token = captureRefreshGate.next();
  const capture = await request({ type: "GET_CAPTURE_STATE" });
  const steps = liveFeedVisible(capture.state)
    ? await capturedSteps.load(capture.state)
    : [];
  if (!captureRefreshGate.isCurrent(token)) return;
  captureInitialized = true;
  currentContext = capture.context || null;
  renderState(capture.state, capture.policy);
  renderStepFeed(capture.state, steps);
  if (!liveFeedVisible(capture.state)) capturedSteps.clear();
  renderConnection();
}

function renderConnection() {
  if (!currentConnection) {
    syncConnectionControls();
    syncCaptureActionControls();
    return;
  }
  elements.connectionDot.classList.toggle(
    "connected",
    currentConnection.connected,
  );
  elements.connectionLabel.textContent = currentConnection.connected
    ? currentCompanion?.workspaceName || currentContext?.workspaceName || "Connected to KnowHow"
    : "Open KnowHow to connect";
  const connectLabel = currentConnection.connected
    ? "Open KnowHow"
    : "Connect in KnowHow";
  elements.connectButton.title = connectLabel;
  elements.connectButton.setAttribute("aria-label", connectLabel);
  syncConnectionControls();
  syncCaptureActionControls();
}

function applySharedTheme() {
  const shared = currentCompanion?.theme;
  const preferred = currentContext?.themePreference;
  const resolved = shared === "dark" || shared === "light"
    ? shared
    : preferred === "dark" || preferred === "light"
      ? preferred
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = resolved;
}

async function refreshCompanion() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.companion);
  currentCompanion = stored[STORAGE_KEYS.companion] || null;
  applySharedTheme();
  renderGuideLibrary();
  renderConnection();
}

async function refreshConnection() {
  currentConnection = await getConnectionState();
  connectionInitialized = true;
  renderConnection();
  if (currentState && currentPolicy) renderState(currentState, currentPolicy);
}

async function refresh() {
  showError("");
  const results = await Promise.allSettled([
    refreshCapture(),
    refreshConnection(),
    refreshCompanion(),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    showError(
      failure.reason instanceof Error
        ? failure.reason.message
        : "Could not load KnowHow Capture.",
    );
  }
}

elements.startForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements.startButton.disabled) return;
  if (!beginCaptureAction()) return;
  showError("");
  try {
    await requestCaptureAccess();
    const captureTarget = await getSelectedContentTab();
    const response = await request({
      type: "START_CAPTURE",
      options: {
        title: elements.title.value.trim(),
        ...captureTarget,
      },
    });
    renderState(response.state, currentPolicy);
    await refreshCapture();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not start capture.");
  } finally {
    endCaptureAction();
  }
});

elements.pauseButton.addEventListener("click", async () => {
  if (!beginCaptureAction()) return;
  showError("");
  try {
    const resuming = currentState.status === "paused";
    let captureTarget = null;
    if (resuming) {
      await requestCaptureAccess();
      captureTarget = await getSelectedContentTab();
    }
    const response = await request({
      type: resuming ? "RESUME_CAPTURE" : "PAUSE_CAPTURE",
      ...(captureTarget ? { options: captureTarget } : {}),
    });
    renderState(response.state, currentPolicy);
    await refreshCapture();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not change capture state.");
  } finally {
    endCaptureAction();
  }
});

elements.blurPanelButton.addEventListener("click", async () => {
  if (elements.blurPanelButton.disabled) return;
  showError("");
  try {
    await request({ type: "TOGGLE_SMART_BLUR_PANEL" });
  } catch (error) {
    showError(
      error instanceof Error
        ? error.message
        : "Could not open Smart Blur settings.",
    );
  }
});

elements.finishButton.addEventListener("click", async () => {
  if (!beginCaptureAction()) return;
  showError("");
  try {
    const response = await request({ type: "FINISH_CAPTURE" });
    renderState(response.state, currentPolicy);
    await refreshCapture();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not finish capture.");
  } finally {
    endCaptureAction();
  }
});

async function discard() {
  if (!confirm("Discard this capture and every locally stored screenshot?")) return;
  if (!beginCaptureAction()) return;
  showError("");
  try {
    const response = await request({ type: "DISCARD_CAPTURE" });
    renderState(response.state, currentPolicy);
    await refreshCapture();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not discard capture.");
  } finally {
    endCaptureAction();
  }
}

elements.discardButton.addEventListener("click", discard);
elements.reviewDiscardButton.addEventListener("click", discard);

elements.openReviewButton.addEventListener("click", async () => {
  if (currentState?.status !== "reviewing" || !beginCaptureAction()) {
    return;
  }
  showError("");
  try {
    const response = await request({ type: "RETRY_DRAFT_UPLOAD" });
    renderState(response.state, currentPolicy);
    await refreshCapture();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not retry the upload.");
  } finally {
    endCaptureAction();
  }
});

elements.excludeButton.addEventListener("click", async () => {
  if (elements.excludeButton.disabled) return;
  if (!confirm("Block KnowHow Capture on the current site?")) return;
  if (!beginCaptureAction()) return;
  showError("");
  try {
    await requestCaptureAccess();
    const captureTarget = await getSelectedContentTab();
    const response = await request({
      type: "EXCLUDE_CURRENT_SITE",
      options: captureTarget,
    });
    currentPolicy = response.policy;
    showError(response.hostname + " is now excluded.");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not exclude this site.");
  } finally {
    endCaptureAction();
  }
});

async function flushPolicySave() {
  if (policySaveInFlight || !policySaveDraft) return;
  const patch = policySaveDraft;
  policySaveDraft = null;
  policySaveInFlight = true;
  syncCaptureActionControls();

  let failure = null;
  try {
    const response = await request({
      type: "UPDATE_CAPTURE_POLICY",
      policy: patch,
    });
    currentPolicy = response.policy;
  } catch (error) {
    failure = error;
  }
  policySaveInFlight = false;

  if (failure) {
    policySaveDraft = null;
    if (policySaveTimer) clearTimeout(policySaveTimer);
    policySaveTimer = null;
    try {
      await refreshCapture();
    } catch {
      applyPolicyControls(currentPolicy || {});
    }
    syncCaptureActionControls();
    const message =
      failure instanceof Error
        ? failure.message
        : "Could not save privacy settings.";
    showError(message + " Your previous settings were restored.");
    return;
  }

  if (policySaveDraft) {
    await flushPolicySave();
    return;
  }

  applyPolicyControls(currentPolicy || {});
  syncCaptureActionControls();
}

function schedulePolicySave() {
  if (policyControlsLocked()) return;
  showError("");
  policySaveDraft = readPolicyControls();
  if (policySaveTimer) clearTimeout(policySaveTimer);
  policySaveTimer = setTimeout(() => {
    policySaveTimer = null;
    void flushPolicySave();
  }, 140);
  syncCaptureActionControls();
}

for (const input of elements.policyInputs) {
  input.addEventListener("change", schedulePolicySave);
}
elements.policyColor.addEventListener("change", schedulePolicySave);

elements.connectButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: KNOWHOW_ORIGIN });
});

for (const tab of elements.panelTabs) {
  tab.addEventListener("click", () => setActivePanel(tab.dataset.panelTab));
}

elements.guideSearch.addEventListener("input", renderGuideLibrary);
elements.guideFollowBack.addEventListener("click", () => {
  activeGuideId = null;
  activeGuideStep = 0;
  renderGuideLibrary();
});
elements.guidePreviousStep.addEventListener("click", () => {
  activeGuideStep = Math.max(0, activeGuideStep - 1);
  renderGuideFollow();
});
elements.guideNextStep.addEventListener("click", () => {
  activeGuideStep += 1;
  renderGuideFollow();
});
elements.guideOpenApp.addEventListener("click", () => {
  const guide = companionGuides().find((item) => item.id === activeGuideId);
  if (!guide?.href) return;
  void chrome.tabs.create({ url: new URL(guide.href, KNOWHOW_ORIGIN).href });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "session" &&
    Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.captureState)
  ) {
    void refreshCapture().catch((error) =>
      showError(
        error instanceof Error ? error.message : "Could not refresh captured steps.",
      ),
    );
  }
  if (
    area === "local" &&
    Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.companion)
  ) {
    void refreshCompanion().catch(() => undefined);
  }
});

addEventListener(
  "pagehide",
  () => {
    thumbnailUrls.dispose();
    capturedSteps.clear();
  },
  { once: true },
);

setActivePanel("capture");
void refresh();
