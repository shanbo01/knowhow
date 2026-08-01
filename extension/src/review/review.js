import { getConnectionState, submitPrivateDraft } from "../core/api-client.js";
import {
  deleteCaptureSession,
  listCapturedSteps,
  updateCapturedStep,
} from "../core/capture-store.js";
import { RIVET_ORIGIN } from "../core/config.js";
import { sanitizeCapturedText } from "../core/redaction.js";
import {
  applyEditorCommand,
  blurAtPoint,
  cloneDocument,
  commitEditor,
  createEditorDocument,
  createEditorHistory,
  focusCrop,
  panCrop,
  pointFromClient,
  rectFromPoints,
  redoEditor,
  serializeEditorState,
  undoEditor,
  validColor,
  zoomCrop,
} from "./editor-state.js";

const elements = Object.fromEntries(
  [
    "guide-title",
    "connection-label",
    "connect-button",
    "pairing-form",
    "pairing-code",
    "cancel-pairing-button",
    "discard-button",
    "step-count",
    "step-list",
    "tool-group",
    "undo-button",
    "redo-button",
    "fit-button",
    "focus-button",
    "zoom-out-button",
    "zoom-slider",
    "zoom-in-button",
    "zoom-label",
    "stage-shell",
    "editor-canvas",
    "stage-loading",
    "stage-empty",
    "tool-hint",
    "image-size",
    "step-title",
    "step-instructions",
    "inspector-title",
    "mask-summary",
    "add-blur-button",
    "blur-list",
    "clear-drawings-button",
    "draw-color",
    "draw-width",
    "drawing-summary",
    "remove-click-button",
    "click-color",
    "click-radius",
    "place-click-button",
    "crop-readout",
    "inspector-focus-button",
    "inspector-fit-button",
    "move-up-button",
    "move-down-button",
    "remove-step-button",
    "submit-panel",
    "privacy-confirmation",
    "summary",
    "submit-button",
    "empty-state",
    "success",
    "edit-link",
    "error",
  ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]),
);

const sessionId = new URLSearchParams(location.search).get("session");
const bitmapCache = new Map();
const storedSteps = new Map();
let captureState;
let capturePolicy = {};
let history = createEditorHistory(createEditorDocument([]));
let connected = false;
let busy = false;
let activeTool = "select";
let gesture = null;
let renderToken = 0;
let renderFrame = 0;
let persistTimer = 0;
let persistChain = Promise.resolve();
let textTransaction = null;
let draggedStepId = null;
let resizeObserver;

const TOOL_HINTS = {
  select: "Select and drag the click target, or choose a tool.",
  blur: "Drag over information to add a reversible manual blur.",
  unblur: "Select one of your manual blur regions to remove it.",
  draw: "Draw directly on the screenshot. One gesture creates one undo step.",
  click: "Select a point to place or move the click target.",
  crop: "Drag a tighter frame. The submitted image uses this exact crop.",
  pan: "Drag the framed image to reveal another part of the safe screenshot.",
};

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

function documentState() {
  return history.present;
}

function selectedStep() {
  const document = documentState();
  return document.steps.find((step) => step.id === document.selectedStepId) || null;
}

function cropZoom(crop) {
  return Math.round((1 / Math.max(crop.width, crop.height)) * 100);
}

function automaticMaskCount(step) {
  return Math.max(0, Number(step?.automaticMaskCount) || 0);
}

function lockedMaskCount(step) {
  return automaticMaskCount(step) + Math.max(
    0,
    Number(step?.editorState?.legacyManualMaskCount) || 0,
  );
}

function currentCrop(step) {
  return gesture?.previewCrop || step.editorState.crop;
}

function currentClick(step) {
  return gesture?.previewClick || step.editorState.clickTarget;
}

function canSubmit() {
  const steps = documentState().steps;
  return Boolean(
    connected &&
      !busy &&
      steps.length &&
      elements.privacy_confirmation.checked &&
      steps.every(
        (step) =>
          String(step.title || "").trim() &&
          String(step.instructions || "").trim(),
      ),
  );
}

function updateSummary() {
  const steps = documentState().steps;
  const automatic = steps.reduce(
    (total, step) => total + automaticMaskCount(step),
    0,
  );
  const manual = steps.reduce(
    (total, step) => total + step.editorState.manualBlurs.length,
    0,
  );
  elements.summary.textContent = `${steps.length} ${steps.length === 1 ? "step" : "steps"} | ${automatic} locked | ${manual} editable blur${manual === 1 ? "" : "s"}`;
  elements.submit_button.disabled = !canSubmit();
}

function invalidatePrivacyReview() {
  if (elements.privacy_confirmation.checked) {
    elements.privacy_confirmation.checked = false;
  }
  updateSummary();
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function intersectRect(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.width, right.x + right.width);
  const edgeY = Math.min(left.y + left.height, right.y + right.height);
  if (edgeX <= x || edgeY <= y) return null;
  return { x, y, width: edgeX - x, height: edgeY - y };
}

function projectedPoint(point, crop, width, height) {
  return {
    x: ((point.x - crop.x) / crop.width) * width,
    y: ((point.y - crop.y) / crop.height) * height,
  };
}

function drawBlur(context, bitmap, blur, crop, width, height) {
  const visible = intersectRect(blur, crop);
  if (!visible) return;
  const topLeft = projectedPoint(visible, crop, width, height);
  const bottomRight = projectedPoint(
    { x: visible.x + visible.width, y: visible.y + visible.height },
    crop,
    width,
    height,
  );
  context.save();
  context.beginPath();
  context.rect(
    topLeft.x,
    topLeft.y,
    bottomRight.x - topLeft.x,
    bottomRight.y - topLeft.y,
  );
  context.clip();
  context.filter = `blur(${Math.max(7, Math.min(width, height) * 0.018 * blur.strength)}px)`;
  context.drawImage(
    bitmap,
    crop.x * bitmap.width,
    crop.y * bitmap.height,
    crop.width * bitmap.width,
    crop.height * bitmap.height,
    0,
    0,
    width,
    height,
  );
  context.filter = "none";
  context.fillStyle = "rgba(23,32,27,.12)";
  context.fillRect(
    topLeft.x,
    topLeft.y,
    bottomRight.x - topLeft.x,
    bottomRight.y - topLeft.y,
  );
  context.restore();
}

function drawStroke(context, drawing, crop, width, height) {
  const visible = drawing.points.filter(
    (point) =>
      point.x >= crop.x - 0.03 &&
      point.x <= crop.x + crop.width + 0.03 &&
      point.y >= crop.y - 0.03 &&
      point.y <= crop.y + crop.height + 0.03,
  );
  if (!visible.length) return;
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.strokeStyle = drawing.color;
  context.fillStyle = drawing.color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(
    2,
    (drawing.width / Math.max(crop.width, crop.height)) * Math.min(width, height),
  );
  context.beginPath();
  visible.forEach((point, index) => {
    const projected = projectedPoint(point, crop, width, height);
    if (index === 0) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
  });
  if (visible.length === 1) {
    const projected = projectedPoint(visible[0], crop, width, height);
    context.arc(projected.x, projected.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.stroke();
  }
  context.restore();
}

function drawClick(context, click, crop, width, height) {
  if (
    !click ||
    click.x < crop.x ||
    click.x > crop.x + crop.width ||
    click.y < crop.y ||
    click.y > crop.y + crop.height
  ) return;
  const point = projectedPoint(click, crop, width, height);
  const radius = Math.max(
    6,
    (click.radius / Math.max(crop.width, crop.height)) * Math.min(width, height),
  );
  context.save();
  context.strokeStyle = click.color;
  context.fillStyle = click.color;
  context.lineWidth = Math.max(3, Math.min(width, height) / 280);
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 0.18;
  context.fill();
  context.globalAlpha = 1;
  context.beginPath();
  context.arc(point.x, point.y, Math.max(2, radius * 0.12), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawComposite(context, bitmap, step, crop, width, height, editing = false) {
  context.save();
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    crop.x * bitmap.width,
    crop.y * bitmap.height,
    crop.width * bitmap.width,
    crop.height * bitmap.height,
    0,
    0,
    width,
    height,
  );
  for (const blur of step.editorState.manualBlurs) {
    drawBlur(context, bitmap, blur, crop, width, height);
  }
  for (const drawing of step.editorState.drawings) {
    drawStroke(context, drawing, crop, width, height);
  }
  if (gesture?.draftDrawing?.length) {
    drawStroke(
      context,
      {
        points: gesture.draftDrawing,
        color: validColor(elements.draw_color.value, "#1f7653"),
        width: Number(elements.draw_width.value) / 1000,
      },
      crop,
      width,
      height,
    );
  }
  drawClick(context, currentClick(step), crop, width, height);

  if (editing && gesture?.startPoint && gesture?.currentPoint) {
    const draft = rectFromPoints(gesture.startPoint, gesture.currentPoint);
    if (draft && (gesture.type === "blur" || gesture.type === "crop")) {
      const start = projectedPoint(draft, crop, width, height);
      const end = projectedPoint(
        { x: draft.x + draft.width, y: draft.y + draft.height },
        crop,
        width,
        height,
      );
      context.save();
      context.strokeStyle = gesture.type === "blur" ? "#57bd8d" : "#ffffff";
      context.fillStyle = gesture.type === "blur"
        ? "rgba(87,189,141,.16)"
        : "rgba(255,255,255,.08)";
      context.lineWidth = 2;
      context.setLineDash([7, 5]);
      context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
      context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      context.restore();
    }
  }
  context.restore();
}

async function bitmapForStep(step) {
  const cached = bitmapCache.get(step.id);
  if (cached?.blob === step.imageBlob) return cached.bitmap;
  if (cached?.bitmap) cached.bitmap.close();
  const bitmap = await createImageBitmap(step.imageBlob);
  bitmapCache.set(step.id, { blob: step.imageBlob, bitmap });
  return bitmap;
}

function scheduleCanvasRender() {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    void renderStage();
  });
}

async function renderStage() {
  const token = ++renderToken;
  const step = selectedStep();
  const canvas = elements.editor_canvas;
  if (!step?.imageBlob) {
    elements.stage_loading.hidden = true;
    elements.stage_empty.hidden = false;
    canvas.hidden = true;
    return;
  }
  elements.stage_empty.hidden = true;
  elements.stage_loading.hidden = false;
  let bitmap;
  try {
    bitmap = await bitmapForStep(step);
  } catch (error) {
    if (token === renderToken) {
      elements.stage_loading.textContent = "The protected screenshot could not be prepared.";
      showError(error instanceof Error ? error.message : "Could not render screenshot.");
    }
    return;
  }
  if (token !== renderToken || step.id !== selectedStep()?.id) return;

  const crop = currentCrop(step);
  const backdrop = canvas.parentElement;
  const maxWidth = Math.max(180, backdrop.clientWidth - 28);
  const maxHeight = Math.max(160, backdrop.clientHeight - 28);
  const aspect = (bitmap.width * crop.width) / (bitmap.height * crop.height);
  let cssWidth = maxWidth;
  let cssHeight = cssWidth / aspect;
  if (cssHeight > maxHeight) {
    cssHeight = maxHeight;
    cssWidth = cssHeight * aspect;
  }
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(cssWidth * ratio));
  const height = Math.max(1, Math.round(cssHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${Math.round(cssWidth)}px`;
  canvas.style.height = `${Math.round(cssHeight)}px`;
  canvas.hidden = false;
  drawComposite(canvas.getContext("2d", { alpha: false }), bitmap, step, crop, width, height, true);
  elements.stage_loading.hidden = true;
  elements.image_size.textContent = `${Math.max(1, Math.round(bitmap.width * crop.width))} x ${Math.max(1, Math.round(bitmap.height * crop.height))} px output`;
}

function schedulePersist(delay = 140) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    persistChain = persistChain
      .then(() => persistDocument())
      .catch((error) => showError(
        error instanceof Error ? error.message : "Could not save local editor state.",
      ));
  }, delay);
}

async function persistDocument() {
  const document = cloneDocument(documentState());
  const visibleIds = new Set(document.steps.map((step) => step.id));
  const writes = [];
  document.steps.forEach((step, order) => {
    const serialized = serializeEditorState(step);
    const updates = {
      title: step.title,
      instructions: step.instructions,
      order,
      manualMaskCount: serialized.manualMaskCount,
      clickTarget: serialized.clickTarget,
      editorState: { ...serialized.editorState, deleted: false },
    };
    writes.push(
      updateCapturedStep(step.sessionId, step.id, updates).then((stored) => {
        storedSteps.set(step.id, stored);
      }),
    );
  });
  for (const [stepId, stored] of storedSteps) {
    if (visibleIds.has(stepId) || stored.editorState?.deleted) continue;
    const updates = {
      editorState: {
        ...(stored.editorState || {}),
        deleted: true,
      },
    };
    writes.push(
      updateCapturedStep(stored.sessionId, stepId, updates).then((next) => {
        storedSteps.set(stepId, next);
      }),
    );
  }
  await Promise.all(writes);
}

async function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
    persistChain = persistChain.then(() => persistDocument());
  }
  await persistChain;
}

function applyCommand(command, { invalidate = false, stage = true } = {}) {
  const previous = history;
  history = commitEditor(history, command);
  if (history === previous) return false;
  if (invalidate) invalidatePrivacyReview();
  schedulePersist();
  renderInterface({ stage });
  return true;
}

function undo() {
  const next = undoEditor(history);
  if (next === history) return;
  history = next;
  invalidatePrivacyReview();
  schedulePersist();
  renderInterface();
}

function redo() {
  const next = redoEditor(history);
  if (next === history) return;
  history = next;
  invalidatePrivacyReview();
  schedulePersist();
  renderInterface();
}

function selectStep(stepId) {
  finishTextTransaction();
  if (!applyCommand({ type: "select-step", stepId })) {
    renderInterface();
  }
}

function moveSelectedStep(delta) {
  const document = documentState();
  const index = document.steps.findIndex((step) => step.id === document.selectedStepId);
  if (index < 0) return;
  applyCommand(
    { type: "move-step", stepId: document.selectedStepId, toIndex: index + delta },
    { invalidate: true, stage: false },
  );
}

function removeSelectedStep() {
  const document = documentState();
  if (document.steps.length <= 1 || !document.selectedStepId) return;
  applyCommand(
    { type: "remove-step", stepId: document.selectedStepId },
    { invalidate: true },
  );
}

function renderStepList() {
  const editorDocument = documentState();
  elements.step_list.replaceChildren();
  elements.step_count.textContent = String(editorDocument.steps.length);
  editorDocument.steps.forEach((step, index) => {
    const item = createElement("button", "step-list-item");
    item.type = "button";
    item.id = `step-option-${step.id}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(step.id === editorDocument.selectedStepId));
    item.setAttribute("aria-grabbed", "false");
    item.draggable = true;
    if (step.id === editorDocument.selectedStepId) item.classList.add("active");
    const number = createElement("span", "step-list-number", String(index + 1).padStart(2, "0"));
    const copy = createElement("span", "step-list-copy");
    copy.append(
      createElement("strong", "", step.title || "Untitled step"),
      createElement(
        "small",
        "",
        `${lockedMaskCount(step)} locked | ${step.editorState.manualBlurs.length} manual`,
      ),
    );
    item.append(number, copy);
    item.addEventListener("click", () => selectStep(step.id));
    item.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = editorDocument.steps[index + direction];
      if (next) {
        selectStep(next.id);
        document.getElementById(`step-option-${next.id}`)?.focus();
      }
    });
    item.addEventListener("dragstart", (event) => {
      draggedStepId = step.id;
      item.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", step.id);
    });
    item.addEventListener("dragend", () => {
      draggedStepId = null;
      item.setAttribute("aria-grabbed", "false");
      for (const target of elements.step_list.querySelectorAll(".drag-target")) {
        target.classList.remove("drag-target");
      }
    });
    item.addEventListener("dragover", (event) => {
      if (!draggedStepId || draggedStepId === step.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      item.classList.add("drag-target");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-target"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("drag-target");
      const sourceId = draggedStepId || event.dataTransfer.getData("text/plain");
      if (sourceId && sourceId !== step.id) {
        applyCommand(
          { type: "move-step", stepId: sourceId, toIndex: index },
          { invalidate: true, stage: false },
        );
      }
    });
    elements.step_list.append(item);
  });
}

function removeBlur(stepId, blurId) {
  const step = documentState().steps.find((item) => item.id === stepId);
  if (!step) return;
  applyCommand(
    {
      type: "update-step",
      stepId,
      editorPatch: {
        manualBlurs: step.editorState.manualBlurs.filter((item) => item.id !== blurId),
      },
    },
    { invalidate: true },
  );
}

function renderBlurList(step) {
  elements.blur_list.replaceChildren();
  if (!step.editorState.manualBlurs.length) {
    elements.blur_list.append(
      createElement("p", "property-empty", "No editable manual blurs yet."),
    );
    return;
  }
  step.editorState.manualBlurs.forEach((blur, index) => {
    const row = createElement("div", "property-row");
    row.append(
      createElement(
        "span",
        "",
        `Manual blur ${index + 1} | ${Math.round(blur.width * 100)} x ${Math.round(blur.height * 100)}%`,
      ),
    );
    const remove = createElement("button", "", "Unblur");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove manual blur ${index + 1}`);
    remove.addEventListener("click", () => removeBlur(step.id, blur.id));
    row.append(remove);
    elements.blur_list.append(row);
  });
}

function cropStat(label, value) {
  const stat = createElement("span", "crop-stat");
  stat.append(
    createElement("span", "", label),
    createElement("strong", "", `${Math.round(value * 100)}%`),
  );
  return stat;
}

function renderInspector(step) {
  const document = documentState();
  const index = document.steps.findIndex((item) => item.id === step.id);
  const editor = step.editorState;
  elements.inspector_title.textContent = `Step ${index + 1} details`;
  elements.mask_summary.textContent = `${lockedMaskCount(step)} locked, ${editor.manualBlurs.length} manual`;
  renderBlurList(step);
  elements.drawing_summary.textContent = editor.drawings.length
    ? `${editor.drawings.length} drawing ${editor.drawings.length === 1 ? "stroke" : "strokes"}`
    : "No drawing strokes";
  elements.clear_drawings_button.disabled = !editor.drawings.length;
  elements.remove_click_button.disabled = !editor.clickTarget;
  elements.click_color.value = validColor(
    editor.clickTarget?.color,
    capturePolicy.clickTargetColor || "#ef6f47",
  );
  elements.click_radius.value = String(
    Math.round((editor.clickTarget?.radius ?? 0.035) * 1000),
  );
  elements.crop_readout.replaceChildren(
    cropStat("Left", editor.crop.x),
    cropStat("Top", editor.crop.y),
    cropStat("Width", editor.crop.width),
    cropStat("Height", editor.crop.height),
  );
  elements.move_up_button.disabled = index <= 0;
  elements.move_down_button.disabled = index < 0 || index >= document.steps.length - 1;
  elements.remove_step_button.disabled = document.steps.length <= 1;
}

function syncTextControls(step) {
  if (document.activeElement !== elements.step_title) {
    elements.step_title.value = step.title || "";
  }
  if (document.activeElement !== elements.step_instructions) {
    elements.step_instructions.value = step.instructions || "";
  }
}

function renderInterface({ stage = true } = {}) {
  const step = selectedStep();
  renderStepList();
  elements.undo_button.disabled = !history.past.length;
  elements.redo_button.disabled = !history.future.length;
  elements.tool_hint.textContent = TOOL_HINTS[activeTool];
  elements.stage_shell.dataset.tool = activeTool;
  for (const button of elements.tool_group.querySelectorAll("[data-tool]")) {
    const active = button.dataset.tool === activeTool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  if (!step) {
    elements.editor_canvas.hidden = true;
    elements.stage_loading.hidden = true;
    elements.stage_empty.hidden = false;
    updateSummary();
    return;
  }
  syncTextControls(step);
  renderInspector(step);
  const zoom = Math.min(800, Math.max(100, cropZoom(step.editorState.crop)));
  elements.zoom_slider.value = String(zoom);
  elements.zoom_label.value = `${zoom}%`;
  elements.zoom_label.textContent = `${zoom}%`;
  updateSummary();
  if (stage) scheduleCanvasRender();
}

function setTool(tool, { focus = false } = {}) {
  if (!Object.hasOwn(TOOL_HINTS, tool)) return;
  activeTool = tool;
  gesture = null;
  elements.stage_shell.classList.remove("interacting");
  renderInterface({ stage: false });
  scheduleCanvasRender();
  if (focus) {
    elements.tool_group.querySelector(`[data-tool="${tool}"]`)?.focus();
  }
}

function beginTextTransaction(field) {
  const step = selectedStep();
  if (!step || textTransaction) return;
  textTransaction = {
    field,
    stepId: step.id,
    before: cloneDocument(documentState()),
    initialValue: String(step[field] || ""),
  };
}

function updateTextField(field, value) {
  const step = selectedStep();
  if (!step) return;
  if (!textTransaction) beginTextTransaction(field);
  history = {
    ...history,
    present: applyEditorCommand(history.present, {
      type: "update-step",
      stepId: step.id,
      patch: { [field]: value },
    }),
    future: [],
  };
  renderStepList();
  updateSummary();
  schedulePersist(360);
}

function finishTextTransaction() {
  if (!textTransaction) return;
  const transaction = textTransaction;
  textTransaction = null;
  const step = documentState().steps.find((item) => item.id === transaction.stepId);
  if (!step) return;
  const maximum = transaction.field === "title" ? 200 : 2_000;
  const fallback = transaction.field === "title"
    ? "Captured step"
    : "Follow the highlighted action.";
  const sanitized = sanitizeCapturedText(
    step[transaction.field],
    capturePolicy,
    maximum,
  ) || fallback;
  history = {
    ...history,
    present: applyEditorCommand(history.present, {
      type: "update-step",
      stepId: step.id,
      patch: { [transaction.field]: sanitized },
    }),
  };
  if (transaction.initialValue !== sanitized) {
    history = {
      past: [...history.past, transaction.before].slice(-80),
      present: history.present,
      future: [],
    };
  }
  schedulePersist();
  renderInterface({ stage: false });
}

function pointerPoint(event, crop = null) {
  const step = selectedStep();
  if (!step) return null;
  return pointFromClient(
    event.clientX,
    event.clientY,
    elements.editor_canvas.getBoundingClientRect(),
    crop || currentCrop(step),
  );
}

function clickTargetHit(step, point) {
  const click = step.editorState.clickTarget;
  if (!click) return false;
  const crop = step.editorState.crop;
  const dx = (point.x - click.x) / Math.max(crop.width, 0.001);
  const dy = (point.y - click.y) / Math.max(crop.height, 0.001);
  const displayedRadius = click.radius / Math.max(crop.width, crop.height);
  return Math.hypot(dx, dy) <= Math.max(0.025, displayedRadius * 1.7);
}

function beginCanvasGesture(event) {
  if (busy || event.button !== 0) return;
  const step = selectedStep();
  if (!step) return;
  const point = pointerPoint(event);
  if (!point) return;

  if (activeTool === "unblur") {
    const blur = blurAtPoint(step.editorState.manualBlurs, point);
    if (blur) removeBlur(step.id, blur.id);
    else showError("Only manual blurs added in this editor can be removed.");
    return;
  }

  let type = activeTool;
  if (activeTool === "select") {
    if (!clickTargetHit(step, point)) return;
    type = "click";
  }
  gesture = {
    type,
    pointerId: event.pointerId,
    startClient: { x: event.clientX, y: event.clientY },
    startPoint: point,
    currentPoint: point,
    originalCrop: { ...step.editorState.crop },
    previewCrop: null,
    previewClick: type === "click"
      ? {
          ...point,
          radius: step.editorState.clickTarget?.radius ?? Number(elements.click_radius.value) / 1000,
          color: validColor(
            step.editorState.clickTarget?.color || elements.click_color.value,
            capturePolicy.clickTargetColor || "#ef6f47",
          ),
        }
      : null,
    draftDrawing: type === "draw" ? [point] : null,
  };
  elements.editor_canvas.setPointerCapture(event.pointerId);
  elements.stage_shell.classList.add("interacting");
  event.preventDefault();
  scheduleCanvasRender();
}

function updateCanvasGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const step = selectedStep();
  if (!step) return;
  if (gesture.type === "pan") {
    const bounds = elements.editor_canvas.getBoundingClientRect();
    const deltaX = -(
      (event.clientX - gesture.startClient.x) /
      Math.max(1, bounds.width)
    ) * gesture.originalCrop.width;
    const deltaY = -(
      (event.clientY - gesture.startClient.y) /
      Math.max(1, bounds.height)
    ) * gesture.originalCrop.height;
    gesture.previewCrop = panCrop(gesture.originalCrop, deltaX, deltaY);
  } else {
    const point = pointerPoint(event, gesture.originalCrop);
    if (!point) return;
    gesture.currentPoint = point;
    if (gesture.type === "click") {
      gesture.previewClick = { ...gesture.previewClick, ...point };
    } else if (gesture.type === "draw") {
      const previous = gesture.draftDrawing.at(-1);
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.0015) {
        gesture.draftDrawing.push(point);
      }
    }
  }
  event.preventDefault();
  scheduleCanvasRender();
}

function finishCanvasGesture(event, cancelled = false) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const completed = gesture;
  gesture = null;
  elements.stage_shell.classList.remove("interacting");
  try {
    elements.editor_canvas.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
  if (cancelled) {
    scheduleCanvasRender();
    return;
  }
  const step = selectedStep();
  if (!step) return;

  if (completed.type === "blur") {
    const blur = rectFromPoints(completed.startPoint, completed.currentPoint, 0.005);
    if (blur) {
      applyCommand(
        {
          type: "update-step",
          stepId: step.id,
          editorPatch: {
            manualBlurs: [
              ...step.editorState.manualBlurs,
              { id: newId("blur"), ...blur, strength: 0.62 },
            ],
          },
        },
        { invalidate: true },
      );
    } else {
      scheduleCanvasRender();
    }
    return;
  }
  if (completed.type === "crop") {
    const crop = rectFromPoints(completed.startPoint, completed.currentPoint, 0.03);
    if (crop) {
      applyCommand(
        { type: "update-step", stepId: step.id, editorPatch: { crop } },
        { invalidate: true },
      );
    } else {
      scheduleCanvasRender();
    }
    return;
  }
  if (completed.type === "draw") {
    if (completed.draftDrawing.length) {
      applyCommand(
        {
          type: "update-step",
          stepId: step.id,
          editorPatch: {
            drawings: [
              ...step.editorState.drawings,
              {
                id: newId("drawing"),
                points: completed.draftDrawing,
                color: validColor(elements.draw_color.value, "#1f7653"),
                width: Number(elements.draw_width.value) / 1000,
              },
            ],
          },
        },
        { invalidate: true },
      );
    } else {
      scheduleCanvasRender();
    }
    return;
  }
  if (completed.type === "click" && completed.previewClick) {
    applyCommand(
      {
        type: "update-step",
        stepId: step.id,
        editorPatch: { clickTarget: completed.previewClick },
      },
      { invalidate: true },
    );
    return;
  }
  if (completed.type === "pan" && completed.previewCrop) {
    applyCommand(
      {
        type: "update-step",
        stepId: step.id,
        editorPatch: { crop: completed.previewCrop },
      },
      { invalidate: true },
    );
    return;
  }
  scheduleCanvasRender();
}

function focusSelectedStep() {
  const step = selectedStep();
  if (!step) return;
  const source = step.editorState.clickTarget
    ? { ...step, focusRegion: null, clickTarget: step.editorState.clickTarget }
    : step;
  applyCommand(
    {
      type: "update-step",
      stepId: step.id,
      editorPatch: { crop: focusCrop(source) },
    },
    { invalidate: true },
  );
}

function fitSelectedStep() {
  const step = selectedStep();
  if (!step) return;
  applyCommand(
    {
      type: "update-step",
      stepId: step.id,
      editorPatch: { crop: { x: 0, y: 0, width: 1, height: 1 } },
    },
    { invalidate: true },
  );
}

function zoomSelectedStep(factor) {
  const step = selectedStep();
  if (!step) return;
  const crop = step.editorState.crop;
  const anchor = step.editorState.clickTarget || {
    x: crop.x + crop.width / 2,
    y: crop.y + crop.height / 2,
  };
  applyCommand(
    {
      type: "update-step",
      stepId: step.id,
      editorPatch: { crop: zoomCrop(crop, factor, anchor) },
    },
    { invalidate: true },
  );
}

function setZoomPercent(percent) {
  const step = selectedStep();
  if (!step) return;
  const current = Math.max(100, cropZoom(step.editorState.crop));
  zoomSelectedStep(Math.max(0.2, Math.min(5, Number(percent) / current)));
}

for (const button of elements.tool_group.querySelectorAll("[data-tool]")) {
  button.addEventListener("click", () => setTool(button.dataset.tool));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...elements.tool_group.querySelectorAll("[data-tool]")];
    const index = buttons.indexOf(button);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    setTool(buttons[nextIndex].dataset.tool, { focus: true });
  });
}

elements.editor_canvas.addEventListener("pointerdown", beginCanvasGesture);
elements.editor_canvas.addEventListener("pointermove", updateCanvasGesture);
elements.editor_canvas.addEventListener("pointerup", (event) => finishCanvasGesture(event));
elements.editor_canvas.addEventListener("pointercancel", (event) => finishCanvasGesture(event, true));

elements.undo_button.addEventListener("click", undo);
elements.redo_button.addEventListener("click", redo);
elements.fit_button.addEventListener("click", fitSelectedStep);
elements.inspector_fit_button.addEventListener("click", fitSelectedStep);
elements.focus_button.addEventListener("click", focusSelectedStep);
elements.inspector_focus_button.addEventListener("click", focusSelectedStep);
elements.zoom_in_button.addEventListener("click", () => zoomSelectedStep(1.22));
elements.zoom_out_button.addEventListener("click", () => zoomSelectedStep(1 / 1.22));
elements.zoom_slider.addEventListener("change", () => setZoomPercent(elements.zoom_slider.value));
elements.zoom_slider.addEventListener("input", () => {
  elements.zoom_label.value = `${elements.zoom_slider.value}%`;
  elements.zoom_label.textContent = `${elements.zoom_slider.value}%`;
});

elements.add_blur_button.addEventListener("click", () => setTool("blur", { focus: true }));
elements.place_click_button.addEventListener("click", () => setTool("click", { focus: true }));
elements.clear_drawings_button.addEventListener("click", () => {
  const step = selectedStep();
  if (!step?.editorState.drawings.length) return;
  applyCommand(
    { type: "update-step", stepId: step.id, editorPatch: { drawings: [] } },
    { invalidate: true },
  );
});
elements.remove_click_button.addEventListener("click", () => {
  const step = selectedStep();
  if (!step?.editorState.clickTarget) return;
  applyCommand(
    { type: "update-step", stepId: step.id, editorPatch: { clickTarget: null } },
    { invalidate: true },
  );
});
elements.click_color.addEventListener("change", () => {
  const step = selectedStep();
  if (!step?.editorState.clickTarget) return;
  applyCommand(
    {
      type: "update-step",
      stepId: step.id,
      editorPatch: {
        clickTarget: {
          ...step.editorState.clickTarget,
          color: validColor(elements.click_color.value, "#ef6f47"),
        },
      },
    },
    { invalidate: true },
  );
});
elements.click_radius.addEventListener("change", () => {
  const step = selectedStep();
  if (!step?.editorState.clickTarget) return;
  applyCommand(
    {
      type: "update-step",
      stepId: step.id,
      editorPatch: {
        clickTarget: {
          ...step.editorState.clickTarget,
          radius: Number(elements.click_radius.value) / 1000,
        },
      },
    },
    { invalidate: true },
  );
});

elements.move_up_button.addEventListener("click", () => moveSelectedStep(-1));
elements.move_down_button.addEventListener("click", () => moveSelectedStep(1));
elements.remove_step_button.addEventListener("click", removeSelectedStep);

elements.step_title.addEventListener("focus", () => beginTextTransaction("title"));
elements.step_title.addEventListener("input", () => updateTextField("title", elements.step_title.value));
elements.step_title.addEventListener("blur", finishTextTransaction);
elements.step_instructions.addEventListener("focus", () => beginTextTransaction("instructions"));
elements.step_instructions.addEventListener("input", () => updateTextField("instructions", elements.step_instructions.value));
elements.step_instructions.addEventListener("blur", finishTextTransaction);

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    finishTextTransaction();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    finishTextTransaction();
    redo();
    return;
  }
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomSelectedStep(1.22);
  } else if (event.key === "-") {
    event.preventDefault();
    zoomSelectedStep(1 / 1.22);
  } else if (event.key === "0") {
    event.preventDefault();
    fitSelectedStep();
  } else if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    focusSelectedStep();
  }
});

async function refreshConnection() {
  const connection = await getConnectionState();
  connected = connection.connected;
  elements.connection_label.textContent = connected
    ? `Connected to ${connection.workspaceName || "Rivet"}`
    : "Not connected | local review only";
  elements.connect_button.textContent = connected ? "Reconnect" : "Connect";
  updateSummary();
}

function setPairingFormVisible(visible) {
  elements.pairing_form.hidden = !visible;
  if (visible) {
    elements.pairing_code.value = "";
    elements.pairing_code.focus();
  }
}

elements.connect_button.addEventListener("click", () => {
  showError("");
  setPairingFormVisible(elements.pairing_form.hidden);
});
elements.cancel_pairing_button.addEventListener("click", () => setPairingFormVisible(false));
elements.pairing_code.addEventListener("input", () => {
  elements.pairing_code.value = elements.pairing_code.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "");
});
elements.pairing_form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const submit = elements.pairing_form.querySelector("button[type=submit]");
  submit.disabled = true;
  elements.connect_button.disabled = true;
  try {
    await request({ type: "CONNECT_RIVET", code: elements.pairing_code.value });
    setPairingFormVisible(false);
    await refreshConnection();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Rivet pairing failed.");
  } finally {
    submit.disabled = false;
    elements.connect_button.disabled = false;
  }
});

function showPageState(panel) {
  const shell = document.querySelector(".editor-shell");
  document.body.classList.add("terminal-state");
  shell.hidden = true;
  shell.inert = true;
  panel.hidden = false;
  panel.tabIndex = -1;
  panel.focus();
}

elements.discard_button.addEventListener("click", async () => {
  if (!confirm("Discard this capture and every locally stored screenshot?")) return;
  showError("");
  try {
    await request({ type: "DISCARD_CAPTURE" });
    location.replace("about:blank");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not discard capture.");
  }
});

elements.privacy_confirmation.addEventListener("change", updateSummary);

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob
        ? resolve(blob)
        : reject(new Error("Could not flatten the edited screenshot.")),
      "image/jpeg",
      0.84,
    );
  });
}

async function flattenStep(step) {
  const bitmap = await bitmapForStep(step);
  const crop = step.editorState.crop;
  const width = Math.max(1, Math.round(bitmap.width * crop.width));
  const height = Math.max(1, Math.round(bitmap.height * crop.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not prepare the edited screenshot.");
  drawComposite(context, bitmap, step, crop, width, height, false);
  const imageBlob = await canvasBlob(canvas);
  canvas.width = 1;
  canvas.height = 1;
  return {
    ...step,
    imageBlob,
    imageWidth: width,
    imageHeight: height,
    manualMaskCount:
      step.editorState.legacyManualMaskCount + step.editorState.manualBlurs.length,
  };
}

elements.submit_button.addEventListener("click", async () => {
  if (!canSubmit()) return;
  finishTextTransaction();
  busy = true;
  renderInterface({ stage: false });
  showError("");
  try {
    await flushPersist();
    const submissionSteps = [];
    for (const step of documentState().steps) {
      submissionSteps.push(await flattenStep(step));
    }
    await request({
      type: "BEGIN_DRAFT_UPLOAD",
      expectedSteps: submissionSteps.length,
    });
    const privacyReview = {
      completedAt: new Date().toISOString(),
      policyVersion: captureState.policyVersion,
      automaticMaskCount: submissionSteps.reduce(
        (total, step) => total + automaticMaskCount(step),
        0,
      ),
      manualMaskCount: submissionSteps.reduce(
        (total, step) => total + Number(step.manualMaskCount || 0),
        0,
      ),
      attestation: "all-screenshots-reviewed",
    };
    const result = await submitPrivateDraft({
      capture: captureState,
      steps: submissionSteps,
      privacyReview,
      policy: capturePolicy,
    });
    await request({
      type: "DRAFT_UPLOAD_COMPLETE",
      guideId: result.guideId,
      editUrl: result.editUrl,
    });
    await deleteCaptureSession(sessionId);
    elements.submit_panel.hidden = true;
    showPageState(elements.success);
    if (result.editUrl) {
      const editUrl = new URL(result.editUrl, RIVET_ORIGIN);
      if (editUrl.origin === RIVET_ORIGIN) {
        elements.edit_link.href = editUrl.href;
        elements.edit_link.hidden = false;
      } else {
        elements.edit_link.hidden = true;
      }
    } else {
      elements.edit_link.hidden = true;
    }
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Private draft upload failed.";
    await request({ type: "DRAFT_UPLOAD_FAILED", message }).catch(() => null);
    showError(message);
  } finally {
    busy = false;
    renderInterface({ stage: false });
  }
});

async function load() {
  if (!sessionId) throw new Error("The review URL is missing a capture session.");
  const response = await request({ type: "GET_CAPTURE_STATE" });
  captureState = response.state;
  capturePolicy = response.policy || {};
  if (captureState.sessionId !== sessionId) {
    throw new Error("This capture session is no longer active.");
  }
  elements.guide_title.textContent = captureState.title || "Review captured guide";
  const loaded = await listCapturedSteps(sessionId);
  for (const step of loaded) storedSteps.set(step.id, step);
  const visible = loaded.filter((step) => step.editorState?.deleted !== true);
  history = createEditorHistory(
    createEditorDocument(visible, {
      accentColor: capturePolicy.accentColor || "#1f7653",
      clickTargetColor: capturePolicy.clickTargetColor || "#ef6f47",
    }),
  );
  elements.draw_color.value = validColor(
    capturePolicy.accentColor,
    "#1f7653",
  );

  if (!visible.length) {
    elements.empty_state.hidden = false;
    showPageState(elements.empty_state);
  } else {
    renderInterface();
    schedulePersist(0);
  }
  await refreshConnection();

  if (captureState.status === "completed") {
    elements.submit_panel.hidden = true;
    showPageState(elements.success);
  } else if (
    captureState.status !== "reviewing" &&
    captureState.status !== "uploading"
  ) {
    throw new Error("Finish the capture before opening privacy review.");
  }

  resizeObserver = new ResizeObserver(() => scheduleCanvasRender());
  resizeObserver.observe(document.querySelector(".stage-backdrop"));
}

window.addEventListener("beforeunload", () => {
  resizeObserver?.disconnect();
  for (const cached of bitmapCache.values()) cached.bitmap.close();
});

void load().catch((error) => {
  showError(error instanceof Error ? error.message : "Could not load privacy review.");
});
