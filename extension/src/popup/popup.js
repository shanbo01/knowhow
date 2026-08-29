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
  captureFeedSteps,
  feedRevision,
  liveFeedVisible,
  stepCopy,
  thumbnailGeometry,
} from "./step-feed.js";

const elements = {
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  connectButton: document.querySelector("#connect-button"),
  userName: document.querySelector("#user-name"),
  panelTabs: Array.from(document.querySelectorAll("[data-panel-tab]")),
  capturePanel: document.querySelector("#capture-panel"),
  guidesPanel: document.querySelector("#guides-panel"),
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
  pauseButtonLabel: document.querySelector("#pause-button span"),
  blurPanelButton: document.querySelector("#blur-panel-button"),
  finishButton: document.querySelector("#finish-button"),
  discardButton: document.querySelector("#discard-button"),
  reviewDiscardButton: document.querySelector("#review-discard-button"),
  openReviewButton: document.querySelector("#open-review-button"),
  privacySettings: document.querySelector("#privacy-settings"),
  smartBlurToggle: document.querySelector("#smart-blur-toggle"),
  smartBlurOptions: document.querySelector("#smart-blur-options"),
  smartBlurProBadge: document.querySelector("#smart-blur-pro-badge"),
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

// The title only ever had to be typed because the field was marked required.
// The worker already falls back to the page title, so this just shows the
// author what the guide will be called and lets them change it — no model
// involved, and nothing to fill in before recording.
let guideTitleEdited = false;

function defaultGuideTitle(tab) {
  const pageTitle = String(tab?.title || "").replace(/\s+/g, " ").trim();
  const named =
    pageTitle ||
    (() => {
      try {
        return new URL(tab?.url || "").hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();
  if (!named) return "";
  const day = new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${named.slice(0, 120)} — ${day}`;
}

async function suggestGuideTitle() {
  if (guideTitleEdited || elements.title.value.trim()) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Without host access Chrome withholds both title and URL; the worker
    // still names the guide once access is granted at capture start.
    const suggestion = defaultGuideTitle(tab);
    if (suggestion && !guideTitleEdited && !elements.title.value.trim()) {
      elements.title.value = suggestion;
    }
  } catch {
    // Leave the field empty; the worker names the capture instead.
  }
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
  const smartBlurLocked = policy?.privacyToolsEnabled !== true;
  elements.blurPanelButton.dataset.proLocked = String(smartBlurLocked);
  elements.smartBlurProBadge.hidden = !smartBlurLocked;
  elements.blurPanelButton.classList.toggle("active", smartBlurEnabled);
  elements.blurPanelButton.setAttribute("aria-pressed", String(smartBlurEnabled));
  elements.blurPanelButton.title = smartBlurLocked
    ? "Auto Blur is available on Pro"
    : smartBlurEnabled
      ? "Auto Blur is on — open settings"
      : "Auto Blur is off — open settings";
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "KnowHow Capture could not complete the action.");
  }
  return response;
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

function clickRingColor(geometry) {
  return (
    geometry.clickTarget?.color || currentPolicy?.clickTargetColor || "#d97706"
  );
}

/**
 * Paints one screenshot the way a reader should see it: framed to the author's
 * crop, pending blur regions covering sensitive details, and a ring on the
 * control that was clicked. Both the live capture feed and the guide reader
 * share this so a step never looks different before and after upload.
 */
function paintStepFigure(figure, geometry, source) {
  figure.dataset.state = "ready";
  figure.style.aspectRatio = String(geometry.aspectRatio);
  const image = document.createElement("img");
  image.src = source;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.style.left = geometry.image.left + "%";
  image.style.top = geometry.image.top + "%";
  image.style.width = geometry.image.width + "%";
  const layers = [image];
  for (const region of geometry.redactions) {
    const blur = document.createElement("span");
    blur.className = "step-blur";
    blur.style.left = region.x * 100 + "%";
    blur.style.top = region.y * 100 + "%";
    blur.style.width = region.width * 100 + "%";
    blur.style.height = region.height * 100 + "%";
    layers.push(blur);
  }
  if (geometry.clickTarget) {
    const ring = document.createElement("span");
    ring.className = "step-click-ring";
    ring.style.left = geometry.clickTarget.x * 100 + "%";
    ring.style.top = geometry.clickTarget.y * 100 + "%";
    // Diameter as a share of the frame, with a ceiling so a heavily zoomed
    // crop cannot inflate the ring into a blot over the control it points at.
    ring.style.width =
      Math.min(26, geometry.clickTarget.radius * 200) + "%";
    ring.style.setProperty("--click-color", clickRingColor(geometry));
    layers.push(ring);
  }
  figure.replaceChildren(...layers);
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

  const steps = captureFeedSteps(state, rawSteps);
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
    item.dataset.captureStatus = step.captureStatus || "ready";

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
    // A shortcut reads as keys, not as a sentence: "Press [Ctrl] + [C]".
    if (Array.isArray(step.keys) && step.keys.length) {
      title.append(document.createTextNode("Press "));
      step.keys.forEach((keyName, keyIndex) => {
        if (keyIndex > 0) {
          const plus = document.createElement("span");
          plus.className = "step-key-plus";
          plus.textContent = "+";
          title.append(plus);
        }
        const badge = document.createElement("kbd");
        badge.className = "step-key";
        badge.textContent = String(keyName);
        title.append(badge);
      });
    } else {
      title.textContent = copy.title;
    }
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
        await request(
          step.entryId && step.captureStatus !== "ready"
            ? { type: "DELETE_CAPTURE_ENTRY", entryId: step.entryId }
            : { type: "DELETE_CAPTURED_STEP", stepId: step.id },
        );
        renderedFeedRevision = "";
        await refreshCapture();
      } catch (error) {
        remove.disabled = false;
        showError(error instanceof Error ? error.message : "Could not delete this step.");
      }
    });
    const actions = document.createElement("span");
    actions.className = "step-card-actions";
    // A step KnowHow kept without a picture is a complete step: it uploads, it
    // reads correctly, and it never blocks finishing. The offer to retake it is
    // an invitation, not a repair the author owes.
    const retakeable =
      Boolean(step.entryId) &&
      step.textOnly !== true &&
      (step.captureStatus === "needs_attention" ||
        step.screenshotMissing === true ||
        step.showsResultOfAction === true);
    if (retakeable) {
      const retry = document.createElement("button");
      retry.className = "step-retry";
      retry.type = "button";
      retry.textContent = step.captureStatus === "needs_attention"
        ? "Retry"
        : "Retake";
      retry.addEventListener("click", async () => {
        if (retry.disabled) return;
        retry.disabled = true;
        showError("");
        try {
          await request({ type: "RETRY_CAPTURE_ENTRY", entryId: step.entryId });
          renderedFeedRevision = "";
          await refreshCapture();
        } catch (error) {
          retry.disabled = false;
          showError(
            error instanceof Error ? error.message : "Could not retry this screenshot.",
          );
        }
      });
      actions.append(retry);
    }
    actions.append(remove);
    copyRow.append(number, text, actions);
    item.append(copyRow);

    const thumbnailUrl = thumbnailUrls.get(step);
    if (thumbnailUrl) {
      const thumbnail = document.createElement("figure");
      thumbnail.className = "step-thumbnail";
      paintStepFigure(thumbnail, thumbnailGeometry(step), thumbnailUrl);
      item.append(thumbnail);
    } else if (step.captureStatus === "capturing") {
      const pending = document.createElement("div");
      pending.className = "step-thumbnail step-thumbnail-pending";
      pending.setAttribute("aria-label", "Screenshot is being privacy-processed");
      pending.append(document.createElement("span"));
      item.append(pending);
    } else if (step.textOnly === true) {
      // Typed values are notes on purpose. No placeholder, no apology: the
      // sentence is the step.
      item.dataset.stepShape = "note";
    } else if (step.screenshotMissing === true) {
      const missing = document.createElement("div");
      missing.className = "step-thumbnail step-thumbnail-missing";
      missing.textContent =
        "No screenshot for this step — the action was still recorded.";
      item.append(missing);
    }
    fragment.append(item);
  });

  elements.stepList.replaceChildren(fragment);
  elements.feedCount.textContent = String(steps.length);
  elements.stepFeedEmpty.hidden = steps.length > 0;
  thumbnailUrls.prune(
    steps
      .filter(
        (step) => step.imageBlob instanceof Blob,
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

const GUIDE_MEDIA_CACHE_LIMIT = 14;
const guideMediaCache = new Map();
const guideMediaRequests = new Map();

function decodedImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.addEventListener("load", () =>
      resolve({ width: probe.naturalWidth, height: probe.naturalHeight }),
    );
    probe.addEventListener("error", () =>
      reject(new Error("This step screenshot could not be decoded.")),
    );
    probe.src = dataUrl;
  });
}

function rememberGuideMedia(mediaId, entry) {
  guideMediaCache.set(mediaId, entry);
  while (guideMediaCache.size > GUIDE_MEDIA_CACHE_LIMIT) {
    const oldest = guideMediaCache.keys().next().value;
    if (oldest === undefined || oldest === mediaId) break;
    guideMediaCache.delete(oldest);
  }
  return entry;
}

function loadGuideMedia(mediaId) {
  const cached = guideMediaCache.get(mediaId);
  if (cached) return Promise.resolve(cached);
  let pending = guideMediaRequests.get(mediaId);
  if (!pending) {
    pending = request({ type: "GET_GUIDE_MEDIA", mediaId })
      .then(async (response) => {
        const size = await decodedImageSize(response.dataUrl);
        return rememberGuideMedia(mediaId, {
          ok: true,
          dataUrl: response.dataUrl,
          ...size,
        });
      })
      // Failures are not cached: reopening the guide retries instead of
      // showing a permanent placeholder for a transient network error.
      .catch((error) => ({
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "This step screenshot is unavailable.",
      }))
      .finally(() => guideMediaRequests.delete(mediaId));
    guideMediaRequests.set(mediaId, pending);
  }
  return pending;
}

let guideMediaObserver = null;
const guideMediaSources = new WeakMap();

function guideStepGeometry(media, image) {
  return thumbnailGeometry({
    imageWidth: image.width,
    imageHeight: image.height,
    ...(media.crop ? { crop: media.crop } : {}),
    ...(media.click ? { clickTarget: media.click } : {}),
    pendingRedactions: Array.isArray(media.redactions) ? media.redactions : [],
  });
}

/**
 * Screenshots load only once their step scrolls into view. A long guide can
 * hold dozens of private images, and fetching them all on open would stall the
 * panel and pull megabytes the reader may never look at.
 */
function observeGuideMedia(figure, media) {
  if (!guideMediaObserver) {
    guideMediaObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target;
          guideMediaObserver.unobserve(target);
          const pending = guideMediaSources.get(target);
          if (!pending) continue;
          guideMediaSources.delete(target);
          void loadGuideMedia(pending.mediaId).then((result) => {
            if (!target.isConnected) return;
            if (!result.ok) {
              target.dataset.state = "failed";
              target.dataset.message = result.message;
              return;
            }
            paintStepFigure(
              target,
              guideStepGeometry(pending, result),
              result.dataUrl,
            );
          });
        }
      },
      { root: elements.guidesPanel, rootMargin: "260px 0px" },
    );
  }
  guideMediaSources.set(figure, media);
  guideMediaObserver.observe(figure);
}

function resetGuideMediaObserver() {
  guideMediaObserver?.disconnect();
  guideMediaObserver = null;
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
  if (activePanel === "guides") {
    renderGuideLibrary();
    void refreshCompanion({ pull: true }).catch(() => undefined);
  }
}

function renderGuideFollow({ reveal = false } = {}) {
  elements.guidesPanel.dataset.view = "follow";
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
  const figures = [];
  steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = "guide-follow-step step-card";
    if (index === activeGuideStep) item.classList.add("active");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "guide-step-select step-card-copy";
    button.addEventListener("click", () => {
      activeGuideStep = index;
      renderGuideFollow();
    });
    const number = document.createElement("span");
    number.className = "step-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("span");
    copy.className = "step-card-text";
    const title = document.createElement("strong");
    title.className = "step-card-title";
    title.textContent = step.title || `Step ${index + 1}`;
    copy.append(title);
    if (step.description) {
      const description = document.createElement("p");
      description.className = "step-card-detail";
      description.textContent = step.description;
      copy.append(description);
    }
    let figure = null;
    if (step.media?.mediaId && currentConnection?.connected) {
      figure = document.createElement("figure");
      figure.className = "guide-step-figure";
      figure.dataset.state = "loading";
      figures.push([figure, step.media]);
    }
    button.append(number, copy);
    item.append(button);
    if (figure) item.append(figure);
    fragment.append(item);
  });
  resetGuideMediaObserver();
  elements.guideFollowSteps.replaceChildren(fragment);
  for (const [figure, media] of figures) observeGuideMedia(figure, media);
  elements.guidePreviousStep.disabled = activeGuideStep <= 0;
  elements.guideNextStep.disabled = !steps.length || activeGuideStep >= steps.length - 1;
  if (reveal) {
    elements.guideFollowSteps.children[activeGuideStep]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }
}

function renderGuideLibrary() {
  applySharedTheme();
  const guides = companionGuides();
  elements.guideLibraryCount.textContent = String(guides.length);
  if (activeGuideId) {
    renderGuideFollow();
    return;
  }
  elements.guidesPanel.dataset.view = "library";
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
    : currentConnection?.connected
      ? "No guides in this workspace yet."
      : "Connect this browser to KnowHow to load your guides.";
  const fragment = document.createDocumentFragment();
  for (const guide of filtered) {
    const button = document.createElement("button");
    button.className = "guide-result";
    button.type = "button";
    button.addEventListener("click", () => {
      activeGuideId = guide.id;
      activeGuideStep = 0;
      elements.guidesPanel.scrollTop = 0;
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
  elements.pauseButtonLabel.textContent =
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
  const unresolvedScreenshots = (currentState?.captureEntries || []).some(
    (entry) => entry.status === "needs_attention",
  );
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
    captureActionPending ||
    unresolvedScreenshots ||
    !["recording", "paused"].includes(status);
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
  const userName = currentCompanion?.userName || "";
  elements.userName.textContent = userName;
  elements.userName.hidden = !userName;
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

async function applyStoredCompanion() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.companion);
  currentCompanion = stored[STORAGE_KEYS.companion] || null;
  applySharedTheme();
  renderGuideLibrary();
  renderConnection();
}

let libraryPull = null;

async function refreshCompanion({ pull = false } = {}) {
  if (pull) {
    if (!libraryPull) {
      libraryPull = request({ type: "REFRESH_LIBRARY" }).finally(() => {
        libraryPull = null;
      });
    }
    try {
      await libraryPull;
    } catch {
      // Keep the last stored companion if the live library is unreachable.
    }
  }
  await applyStoredCompanion();
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
    refreshCompanion({ pull: true }),
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
    // The name now belongs to the running capture; clear the field so the next
    // one is suggested from wherever the author starts it, not from this one.
    elements.title.value = "";
    guideTitleEdited = false;
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
  if (currentPolicy?.privacyToolsEnabled !== true) {
    showError("Auto Blur is available on Pro. Browser capture is included on Free.");
    return;
  }
  try {
    await request({ type: "TOGGLE_SMART_BLUR_PANEL" });
  } catch (error) {
    showError(
      error instanceof Error
        ? error.message
        : "Could not open Auto Blur settings.",
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

elements.title.addEventListener("input", () => {
  guideTitleEdited = elements.title.value.trim().length > 0;
});

// The panel stays open while the author moves between tabs looking for the
// page they want to record, so the suggested name follows them.
chrome.tabs.onActivated.addListener(() => void suggestGuideTitle());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab?.active && changeInfo.title) void suggestGuideTitle();
});

for (const tab of elements.panelTabs) {
  tab.addEventListener("click", () => setActivePanel(tab.dataset.panelTab));
}

elements.guideSearch.addEventListener("input", renderGuideLibrary);
elements.guideFollowBack.addEventListener("click", () => {
  activeGuideId = null;
  activeGuideStep = 0;
  elements.guidesPanel.scrollTop = 0;
  renderGuideLibrary();
});
elements.guidePreviousStep.addEventListener("click", () => {
  activeGuideStep = Math.max(0, activeGuideStep - 1);
  renderGuideFollow({ reveal: true });
});
elements.guideNextStep.addEventListener("click", () => {
  activeGuideStep += 1;
  renderGuideFollow({ reveal: true });
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
    void applyStoredCompanion().catch(() => undefined);
  }
});

addEventListener(
  "pagehide",
  () => {
    thumbnailUrls.dispose();
    capturedSteps.clear();
    resetGuideMediaObserver();
    guideMediaCache.clear();
  },
  { once: true },
);

setActivePanel("capture");
void refresh();
void suggestGuideTitle();
