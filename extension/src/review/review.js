import {
  getConnectionState,
  submitPrivateDraft,
} from "../core/api-client.js";
import {
  deleteCapturedStep,
  deleteCaptureSession,
  listCapturedSteps,
  updateCapturedStep,
} from "../core/capture-store.js";
import { RIVET_ORIGIN } from "../core/config.js";
import {
  normalizedRegionFromPoints,
  sanitizeCapturedText,
  scaleNormalizedRegion,
} from "../core/redaction.js";

const elements = {
  guideTitle: document.querySelector("#guide-title"),
  connectionLabel: document.querySelector("#connection-label"),
  connectButton: document.querySelector("#connect-button"),
  pairingForm: document.querySelector("#pairing-form"),
  pairingCode: document.querySelector("#pairing-code"),
  cancelPairingButton: document.querySelector("#cancel-pairing-button"),
  discardButton: document.querySelector("#discard-button"),
  steps: document.querySelector("#steps"),
  emptyState: document.querySelector("#empty-state"),
  submitPanel: document.querySelector("#submit-panel"),
  confirmation: document.querySelector("#privacy-confirmation"),
  summary: document.querySelector("#summary"),
  submitButton: document.querySelector("#submit-button"),
  success: document.querySelector("#success"),
  editLink: document.querySelector("#edit-link"),
  error: document.querySelector("#error"),
};

const sessionId = new URLSearchParams(location.search).get("session");
let captureState;
let capturePolicy = {};
let steps = [];
let connected = false;
let busy = false;
let lastMaskSelection = null;
let applyAllButtons = [];
let stepCanvases = new Map();
let canvasRenderPromises = new Map();

function showError(message) {
  elements.error.textContent = message || "";
  elements.error.hidden = !message;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Rivet Capture request failed.");
  }
  return response;
}

function canSubmit() {
  return (
    connected &&
    !busy &&
    steps.length > 0 &&
    elements.confirmation.checked &&
    steps.every(
      (step) =>
        String(step.title || "").trim() &&
        String(step.instructions || "").trim(),
    )
  );
}

function updateSummary() {
  const automaticMasks = steps.reduce(
    (total, step) => total + Number(step.automaticMaskCount || 0),
    0,
  );
  const manualMasks = steps.reduce(
    (total, step) => total + Number(step.manualMaskCount || 0),
    0,
  );
  elements.summary.textContent =
    String(steps.length) +
    " step" +
    (steps.length === 1 ? "" : "s") +
    " · " +
    String(automaticMasks) +
    " automatic masks · " +
    String(manualMasks) +
    " manual masks";
  elements.submitButton.disabled = !canSubmit();
}

async function saveStepMetadata(step) {
  step.title =
    sanitizeCapturedText(step.title, capturePolicy, 200) || "Captured step";
  step.instructions =
    sanitizeCapturedText(step.instructions, capturePolicy, 2_000) ||
    "Follow the highlighted action.";
  await updateCapturedStep(step.sessionId, step.id, {
    title: step.title,
    instructions: step.instructions,
    order: step.order,
  });
}

function canvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(canvas.width, ((event.clientX - rect.left) / rect.width) * canvas.width),
    ),
    y: Math.max(
      0,
      Math.min(canvas.height, ((event.clientY - rect.top) / rect.height) * canvas.height),
    ),
  };
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not save manual mask.")),
      "image/jpeg",
      0.86,
    );
  });
}

async function drawStepImage(step, canvas) {
  const bitmap = await createImageBitmap(step.imageBlob);
  try {
    canvas.width = step.imageWidth || bitmap.width;
    canvas.height = step.imageHeight || bitmap.height;
    canvas
      .getContext("2d", { alpha: false })
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

async function applyNormalizedMask(step, canvas, region) {
  await canvasRenderPromises.get(step.id)?.catch(() => undefined);
  await drawStepImage(step, canvas);
  const { x, y, width, height } = scaleNormalizedRegion(region, {
    width: canvas.width,
    height: canvas.height,
  });
  if (width < 4 || height < 4) return false;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#111827";
  context.fillRect(x, y, width, height);
  const imageBlob = await canvasBlob(canvas);
  step.imageBlob = imageBlob;
  step.manualMaskCount = Number(step.manualMaskCount || 0) + 1;
  await updateCapturedStep(step.sessionId, step.id, {
    imageBlob,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    manualMaskCount: step.manualMaskCount,
  });
  updateSummary();
  return true;
}

function maskAppliedToEveryStep() {
  return Boolean(
    lastMaskSelection &&
      steps.every((step) => lastMaskSelection.appliedStepIds.has(step.id)),
  );
}

function updateApplyAllButtons() {
  const disabled = busy || !lastMaskSelection || maskAppliedToEveryStep();
  for (const button of applyAllButtons) button.disabled = disabled;
}

async function applyLastRegionToAllSteps() {
  if (!lastMaskSelection || busy || maskAppliedToEveryStep()) return;
  busy = true;
  showError("");
  updateSummary();
  updateApplyAllButtons();
  try {
    for (const step of steps) {
      if (lastMaskSelection.appliedStepIds.has(step.id)) continue;
      const canvas = stepCanvases.get(step.id);
      if (!canvas) throw new Error("A captured screenshot is not ready yet.");
      const applied = await applyNormalizedMask(
        step,
        canvas,
        lastMaskSelection.region,
      );
      if (applied) lastMaskSelection.appliedStepIds.add(step.id);
    }
  } finally {
    busy = false;
    renderSteps();
  }
}

function moveStep(index, direction) {
  const destination = index + direction;
  if (destination < 0 || destination >= steps.length) return;
  const [moved] = steps.splice(index, 1);
  steps.splice(destination, 0, moved);
  steps.forEach((step, order) => {
    step.order = order;
  });
  void Promise.all(steps.map(saveStepMetadata))
    .then(renderSteps)
    .catch((error) =>
      showError(error instanceof Error ? error.message : "Could not reorder steps."),
    );
}

async function removeStep(step) {
  if (!confirm("Remove this captured step? This cannot be undone.")) return;
  await deleteCapturedStep(step.sessionId, step.id);
  steps = steps.filter((candidate) => candidate.id !== step.id);
  steps.forEach((candidate, order) => {
    candidate.order = order;
  });
  await Promise.all(steps.map(saveStepMetadata));
  renderSteps();
}

function createButton(label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", action);
  return button;
}

function renderSteps() {
  elements.steps.replaceChildren();
  applyAllButtons = [];
  stepCanvases = new Map();
  canvasRenderPromises = new Map();
  elements.emptyState.hidden = steps.length > 0;
  elements.submitPanel.hidden = steps.length === 0;

  steps.forEach((step, index) => {
    const article = document.createElement("article");
    article.className = "step-card";

    const header = document.createElement("div");
    header.className = "step-header";
    const number = document.createElement("span");
    number.className = "step-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const fields = document.createElement("div");
    fields.className = "step-fields";
    const title = document.createElement("input");
    title.value = step.title || "";
    title.maxLength = 200;
    title.setAttribute("aria-label", "Step " + String(index + 1) + " title");
    title.addEventListener("input", () => {
      step.title = title.value;
      updateSummary();
    });
    title.addEventListener("blur", () => {
      void saveStepMetadata(step)
        .then(() => {
          title.value = step.title;
          updateSummary();
        })
        .catch((error) =>
          showError(
            error instanceof Error ? error.message : "Could not save the step title.",
          ),
        );
    });
    const instructions = document.createElement("textarea");
    instructions.value = step.instructions || "";
    instructions.maxLength = 2_000;
    instructions.setAttribute(
      "aria-label",
      "Step " + String(index + 1) + " instructions",
    );
    instructions.addEventListener("input", () => {
      step.instructions = instructions.value;
      updateSummary();
    });
    instructions.addEventListener("blur", () => {
      void saveStepMetadata(step)
        .then(() => {
          instructions.value = step.instructions;
          updateSummary();
        })
        .catch((error) =>
          showError(
            error instanceof Error
              ? error.message
              : "Could not save the step instructions.",
          ),
        );
    });
    fields.append(title, instructions);

    const actions = document.createElement("div");
    actions.className = "step-actions";
    actions.append(
      createButton("↑", () => moveStep(index, -1)),
      createButton("↓", () => moveStep(index, 1)),
      createButton("Remove", () => void removeStep(step), "danger"),
    );
    header.append(number, fields, actions);

    const imageArea = document.createElement("div");
    imageArea.className = "step-image-area";
    const toolbar = document.createElement("div");
    toolbar.className = "image-toolbar";
    const counts = document.createElement("span");
    counts.textContent =
      String(step.automaticMaskCount || 0) +
      " automatic · " +
      String(step.manualMaskCount || 0) +
      " manual masks";
    const maskButton = createButton("Add solid mask", () => {
      const active = wrap.classList.toggle("masking");
      maskButton.classList.toggle("active", active);
      maskButton.textContent = active ? "Drawing mask…" : "Add solid mask";
    });
    const applyAllButton = createButton(
      "Redact this region in all steps",
      () =>
        void applyLastRegionToAllSteps().catch((error) =>
          showError(
            error instanceof Error
              ? error.message
              : "Could not redact the region in every step.",
          ),
        ),
    );
    applyAllButtons.push(applyAllButton);
    toolbar.append(counts, maskButton, applyAllButton);

    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas");
    stepCanvases.set(step.id, canvas);
    canvas.setAttribute(
      "aria-label",
      "Redacted screenshot for step " + String(index + 1),
    );
    let startPoint = null;
    canvas.addEventListener("pointerdown", (event) => {
      if (!wrap.classList.contains("masking")) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      startPoint = canvasPoint(canvas, event);
    });
    canvas.addEventListener("pointerup", (event) => {
      if (!startPoint || !wrap.classList.contains("masking")) return;
      const endPoint = canvasPoint(canvas, event);
      const capturedStart = startPoint;
      const region = normalizedRegionFromPoints(capturedStart, endPoint, {
        width: canvas.width,
        height: canvas.height,
      });
      startPoint = null;
      wrap.classList.remove("masking");
      maskButton.classList.remove("active");
      maskButton.textContent = "Add solid mask";
      void applyNormalizedMask(step, canvas, region)
        .then((applied) => {
          if (!applied) return;
          lastMaskSelection = {
            region,
            appliedStepIds: new Set([step.id]),
          };
          counts.textContent =
            String(step.automaticMaskCount || 0) +
            " automatic · " +
            String(step.manualMaskCount || 0) +
              " manual masks";
          updateApplyAllButtons();
        })
        .catch((error) =>
          showError(
            error instanceof Error ? error.message : "Could not add manual mask.",
          ),
        );
    });
    wrap.append(canvas);
    imageArea.append(toolbar, wrap);
    article.append(header, imageArea);
    elements.steps.append(article);
    const renderPromise = drawStepImage(step, canvas).catch((error) => {
      showError(
        error instanceof Error
          ? error.message
          : "Could not render a captured screenshot.",
      );
    });
    canvasRenderPromises.set(step.id, renderPromise);
  });
  updateApplyAllButtons();
  updateSummary();
}

async function refreshConnection() {
  const connection = await getConnectionState();
  connected = connection.connected;
  elements.connectionLabel.textContent = connected
    ? "Connected to Rivet"
    : "Not connected · local review only";
  elements.connectButton.textContent = connected ? "Reconnect" : "Connect";
  updateSummary();
}

async function load() {
  if (!sessionId) throw new Error("The review URL is missing a capture session.");
  const response = await request({ type: "GET_CAPTURE_STATE" });
  captureState = response.state;
  capturePolicy = response.policy || {};
  if (captureState.sessionId !== sessionId) {
    throw new Error("This capture session is no longer active.");
  }
  elements.guideTitle.textContent =
    captureState.title || "Review captured guide";
  steps = await listCapturedSteps(sessionId);
  renderSteps();
  await refreshConnection();

  if (captureState.status === "completed") {
    elements.submitPanel.hidden = true;
    elements.success.hidden = false;
  } else if (
    captureState.status !== "reviewing" &&
    captureState.status !== "uploading"
  ) {
    throw new Error("Finish the capture before opening privacy review.");
  }
}

elements.confirmation.addEventListener("change", updateSummary);

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
  try {
    await request({
      type: "CONNECT_RIVET",
      code: elements.pairingCode.value,
    });
    setPairingFormVisible(false);
    await refreshConnection();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Rivet pairing failed.");
  } finally {
    submitButton.disabled = false;
    elements.connectButton.disabled = false;
  }
});

elements.discardButton.addEventListener("click", async () => {
  if (!confirm("Discard this capture and every locally stored screenshot?")) return;
  showError("");
  try {
    await request({ type: "DISCARD_CAPTURE" });
    location.replace("about:blank");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not discard capture.");
  }
});

elements.submitButton.addEventListener("click", async () => {
  if (!canSubmit()) return;
  busy = true;
  updateSummary();
  showError("");
  try {
    await Promise.all(steps.map(saveStepMetadata));
    await request({
      type: "BEGIN_DRAFT_UPLOAD",
      expectedSteps: steps.length,
    });
    const privacyReview = {
      completedAt: new Date().toISOString(),
      policyVersion: captureState.policyVersion,
      automaticMaskCount: steps.reduce(
        (total, step) => total + Number(step.automaticMaskCount || 0),
        0,
      ),
      manualMaskCount: steps.reduce(
        (total, step) => total + Number(step.manualMaskCount || 0),
        0,
      ),
      attestation: "all-screenshots-reviewed",
    };
    const result = await submitPrivateDraft({
      capture: captureState,
      steps,
      privacyReview,
      policy: capturePolicy,
    });
    await request({
      type: "DRAFT_UPLOAD_COMPLETE",
      guideId: result.guideId,
      editUrl: result.editUrl,
    });
    await deleteCaptureSession(sessionId);
    elements.steps.replaceChildren();
    elements.submitPanel.hidden = true;
    elements.success.hidden = false;
    if (result.editUrl) {
      const editUrl = new URL(result.editUrl, RIVET_ORIGIN);
      if (editUrl.origin === RIVET_ORIGIN) {
        elements.editLink.href = editUrl.href;
        elements.editLink.hidden = false;
      } else {
        elements.editLink.hidden = true;
      }
    } else {
      elements.editLink.hidden = true;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Private draft upload failed.";
    await request({ type: "DRAFT_UPLOAD_FAILED", message }).catch(() => null);
    showError(message);
  } finally {
    busy = false;
    updateSummary();
  }
});

void load().catch((error) =>
  showError(error instanceof Error ? error.message : "Could not load privacy review."),
);
