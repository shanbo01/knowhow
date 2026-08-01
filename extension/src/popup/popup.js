import { getConnectionState } from "../core/api-client.js";
import { REVIEW_PAGE_PATH } from "../core/config.js";

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
  excludeButton: document.querySelector("#exclude-button"),
  error: document.querySelector("#error"),
  policyInputs: Array.from(document.querySelectorAll("[data-policy]")),
  policyColor: document.querySelector("[data-policy-color]"),
};

let currentState;
let currentPolicy;
let currentContext;
let currentConnection;

function showError(message) {
  elements.error.textContent = message || "";
  elements.error.hidden = !message;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Rivet Capture could not complete the action.");
  }
  return response;
}

function statusDescription(state) {
  switch (state.status) {
    case "recording":
      return state.scopeLabel || "Capturing clicks and navigation in this tab.";
    case "paused":
      return state.pausedReason || "No events or screenshots are being collected.";
    case "reviewing":
      return "Capture stopped. Review every screenshot before submitting.";
    case "uploading":
      return "Uploading only the locally redacted screenshots.";
    case "completed":
      return "Private Rivet draft created successfully.";
    case "error":
      return state.lastError || "Capture needs attention.";
    default:
      return "Start from the page you want to document.";
  }
}

function renderState(state, policy) {
  currentState = state;
  currentPolicy = policy;
  const label =
    state.status.charAt(0).toUpperCase() + state.status.slice(1);
  elements.statusLabel.textContent = label;
  elements.statusDetail.textContent = statusDescription(state);
  elements.stepCount.textContent =
    String(state.stepCount || 0) +
    " step" +
    (state.stepCount === 1 ? "" : "s");

  const active = state.status === "recording" || state.status === "paused";
  const reviewing =
    state.status === "reviewing" || state.status === "uploading";
  elements.startForm.hidden = active || reviewing;
  elements.captureActions.hidden = !active;
  elements.reviewActions.hidden = !reviewing;
  elements.pauseButton.textContent =
    state.status === "paused" ? "Resume" : "Pause";
  elements.finishButton.disabled = state.status === "uploading";

  for (const input of elements.policyInputs) {
    input.checked = Boolean(policy[input.dataset.policy]);
    input.disabled = active;
  }
  elements.policyColor.value = policy.clickTargetColor || "#ff5d2e";
  elements.policyColor.disabled = active;
  elements.workspaceId.value =
    currentContext?.workspaceName ||
    currentContext?.workspaceId ||
    currentConnection?.workspaceId ||
    "";
  elements.startButton.disabled = !currentConnection?.connected;
}

async function refresh() {
  showError("");
  try {
    const [capture, connection] = await Promise.all([
      request({ type: "GET_CAPTURE_STATE" }),
      getConnectionState(),
    ]);
    currentContext = capture.context || null;
    currentConnection = connection;
    renderState(capture.state, capture.policy);
    elements.connectionDot.classList.toggle("connected", connection.connected);
    elements.connectionLabel.textContent = connection.connected
      ? "Connected to " + (currentContext?.workspaceName || "Rivet")
      : "Pair Rivet to capture";
    elements.connectButton.textContent = connection.connected
      ? "Reconnect"
      : "Connect";
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not load capture state.");
  }
}

elements.startForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  try {
    const response = await request({
      type: "START_CAPTURE",
      options: {
        title: elements.title.value.trim(),
      },
    });
    renderState(response.state, currentPolicy);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not start capture.");
  }
});

elements.pauseButton.addEventListener("click", async () => {
  showError("");
  try {
    const response = await request({
      type:
        currentState.status === "paused"
          ? "RESUME_CAPTURE"
          : "PAUSE_CAPTURE",
    });
    renderState(response.state, currentPolicy);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not change capture state.");
  }
});

elements.finishButton.addEventListener("click", async () => {
  showError("");
  try {
    const response = await request({ type: "FINISH_CAPTURE" });
    renderState(response.state, currentPolicy);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not finish capture.");
  }
});

async function discard() {
  if (!confirm("Discard this capture and every locally stored screenshot?")) return;
  showError("");
  try {
    const response = await request({ type: "DISCARD_CAPTURE" });
    renderState(response.state, currentPolicy);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not discard capture.");
  }
}

elements.discardButton.addEventListener("click", discard);
elements.reviewDiscardButton.addEventListener("click", discard);

elements.openReviewButton.addEventListener("click", async () => {
  if (!currentState?.sessionId) return;
  await chrome.tabs.create({
    url:
      chrome.runtime.getURL(REVIEW_PAGE_PATH) +
      "?session=" +
      encodeURIComponent(currentState.sessionId),
  });
});

elements.excludeButton.addEventListener("click", async () => {
  if (!confirm("Block Rivet Capture on the current site?")) return;
  showError("");
  try {
    const response = await request({ type: "EXCLUDE_CURRENT_SITE" });
    currentPolicy = response.policy;
    showError(response.hostname + " is now excluded.");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not exclude this site.");
  }
});

async function savePolicy() {
  const patch = {};
  for (const input of elements.policyInputs) {
    patch[input.dataset.policy] = input.checked;
  }
  patch.clickTargetColor = elements.policyColor.value;
  const response = await request({
    type: "UPDATE_CAPTURE_POLICY",
    policy: patch,
  });
  currentPolicy = response.policy;
  renderState(currentState, currentPolicy);
}

for (const input of elements.policyInputs) {
  input.addEventListener("change", () => {
    void savePolicy().catch((error) =>
      showError(error instanceof Error ? error.message : "Could not save privacy settings."),
    );
  });
}
elements.policyColor.addEventListener("change", () => {
  void savePolicy().catch((error) =>
    showError(error instanceof Error ? error.message : "Could not save click color."),
  );
});

function setPairingFormVisible(visible) {
  elements.pairingForm.hidden = !visible;
  if (visible) {
    elements.pairingCode.value = "";
    elements.pairingCode.focus();
  }
}

elements.connectButton.addEventListener("click", () => {
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
  showError("");
  const submitButton = elements.pairingForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  elements.connectButton.disabled = true;
  elements.connectionLabel.textContent = "Pairing workspace…";
  try {
    await request({
      type: "CONNECT_RIVET",
      code: elements.pairingCode.value,
    });
    setPairingFormVisible(false);
    await refresh();
  } catch (error) {
    await refresh();
    showError(error instanceof Error ? error.message : "Rivet pairing failed.");
  } finally {
    submitButton.disabled = false;
    elements.connectButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && Object.keys(changes).some((key) => key.includes("capture"))) {
    void refresh();
  }
});

void refresh();
