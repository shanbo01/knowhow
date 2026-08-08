import { getConnectionState } from "../core/api-client.js";
import {
  getCapturedSteps,
  listCapturedSteps,
} from "../core/capture-store.js";
import { STORAGE_KEYS } from "../core/config.js";
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
  pairingForm: document.querySelector("#pairing-form"),
  pairingCode: document.querySelector("#pairing-code"),
  cancelPairingButton: document.querySelector("#cancel-pairing-button"),
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
  finishButton: document.querySelector("#finish-button"),
  discardButton: document.querySelector("#discard-button"),
  reviewDiscardButton: document.querySelector("#review-discard-button"),
  openReviewButton: document.querySelector("#open-review-button"),
  privacySettings: document.querySelector("#privacy-settings"),
  excludeButton: document.querySelector("#exclude-button"),
  error: document.querySelector("#error"),
  policyInputs: Array.from(document.querySelectorAll("[data-policy]")),
  policyColor: document.querySelector("[data-policy-color]"),
};

let currentState;
let currentPolicy;
let currentContext;
let currentConnection;
let renderedFeedRevision = "";
let renderedFeedSessionId = null;
let captureActionPending = false;
let captureInitialized = false;
let connectionInitialized = false;
let pairingPending = false;
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

function captureLifecycleLocksConnection() {
  return [
    "preparing",
    "recording",
    "paused",
    "reviewing",
    "uploading",
  ].includes(currentState?.status);
}

function policySavePending() {
  return Boolean(policySaveTimer || policySaveDraft || policySaveInFlight);
}

function policyControlsLocked() {
  return (
    !captureInitialized ||
    ["preparing", "recording", "paused", "reviewing", "uploading"].includes(
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
  elements.policyColor.value = policy?.clickTargetColor || "#ff5d2e";
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
    copyRow.append(number, text);
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
      image.style.height = geometry.image.height + "%";
      thumbnail.append(image);
      if (geometry.clickTarget) {
        const ring = document.createElement("span");
        ring.className = "step-click-ring";
        ring.style.left = geometry.clickTarget.x * 100 + "%";
        ring.style.top = geometry.clickTarget.y * 100 + "%";
        ring.style.setProperty(
          "--click-color",
          geometry.clickTarget.color || currentPolicy?.clickTargetColor || "#ef6f47",
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

function renderState(state, policy) {
  currentState = state;
  if (!policySavePending() || !currentPolicy) {
    currentPolicy = policy || currentPolicy || {};
  }
  const label =
    state.status.charAt(0).toUpperCase() + state.status.slice(1);
  elements.statusLabel.textContent = label;
  elements.statusDetail.textContent = statusDescription(state);
  elements.stepCount.textContent =
    String(state.stepCount || 0) +
    " step" +
    (state.stepCount === 1 ? "" : "s");

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
  elements.privacySettings.hidden = preparing || active || reviewing;
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
}

function syncConnectionControls() {
  const locked = captureLifecycleLocksConnection();
  elements.connectButton.hidden = locked;
  elements.connectButton.disabled = locked || pairingPending;
  if (locked) elements.pairingForm.hidden = true;
  const submitButton = elements.pairingForm.querySelector("button[type=submit]");
  submitButton.disabled = locked || pairingPending;
  elements.cancelPairingButton.disabled = locked || pairingPending;
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
    ? "Connected to " + (currentContext?.workspaceName || "KnowHow")
    : "Pair KnowHow to capture";
  elements.connectButton.textContent = currentConnection.connected
    ? "Reconnect"
    : "Connect";
  syncConnectionControls();
  syncCaptureActionControls();
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

function setPairingFormVisible(visible) {
  if (visible && captureLifecycleLocksConnection()) return;
  elements.pairingForm.hidden = !visible;
  if (visible) {
    elements.pairingCode.value = "";
    elements.pairingCode.focus();
  }
}

elements.connectButton.addEventListener("click", () => {
  if (captureLifecycleLocksConnection() || pairingPending) return;
  showError("");
  setPairingFormVisible(elements.pairingForm.hidden);
});

elements.cancelPairingButton.addEventListener("click", () => {
  setPairingFormVisible(false);
});

elements.pairingCode.addEventListener("input", () => {
  elements.pairingCode.value = elements.pairingCode.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "");
});

elements.pairingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (captureLifecycleLocksConnection() || pairingPending) return;
  showError("");
  pairingPending = true;
  syncConnectionControls();
  elements.connectionLabel.textContent = "Pairing workspace…";
  try {
    await request({
      type: "CONNECT_KNOWHOW",
      code: elements.pairingCode.value,
    });
    setPairingFormVisible(false);
    await refresh();
  } catch (error) {
    await refresh();
    showError(error instanceof Error ? error.message : "KnowHow pairing failed.");
  } finally {
    pairingPending = false;
    syncConnectionControls();
  }
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
});

addEventListener(
  "pagehide",
  () => {
    thumbnailUrls.dispose();
    capturedSteps.clear();
  },
  { once: true },
);

void refresh();
