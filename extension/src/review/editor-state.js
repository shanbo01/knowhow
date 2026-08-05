export const EDITOR_STATE_VERSION = 1;
export const MAX_HISTORY = 80;

const DEFAULT_ACCENT = "#356fe5";
const DEFAULT_CLICK = "#ef6f47";
const MIN_CROP_SIZE = 0.12;

export function clamp(value, minimum = 0, maximum = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
}

export function validColor(value, fallback = DEFAULT_ACCENT) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
}

export function normalizedPoint(value, fallback = { x: 0.5, y: 0.5 }) {
  return {
    x: clamp(value?.x ?? fallback.x),
    y: clamp(value?.y ?? fallback.y),
  };
}

export function normalizedRect(
  value,
  fallback = { x: 0, y: 0, width: 1, height: 1 },
  minimumSize = 0.001,
) {
  const width = clamp(value?.width ?? fallback.width, minimumSize, 1);
  const height = clamp(value?.height ?? fallback.height, minimumSize, 1);
  const x = clamp(value?.x ?? fallback.x, 0, 1 - width);
  const y = clamp(value?.y ?? fallback.y, 0, 1 - height);
  return {
    x,
    y,
    width,
    height,
  };
}

function contextualCrop(step) {
  const focus = step?.focusRegion
    ? normalizedRect(step.focusRegion)
    : step?.clickTarget
      ? { ...normalizedPoint(step.clickTarget), width: 0, height: 0 }
      : null;
  if (!focus) return { x: 0, y: 0, width: 1, height: 1 };

  const centerX = clamp(focus.x + focus.width / 2);
  const centerY = clamp(focus.y + focus.height / 2);
  const width = clamp(Math.max(0.52, focus.width * 2.4), MIN_CROP_SIZE, 1);
  const height = clamp(Math.max(0.58, focus.height * 3), MIN_CROP_SIZE, 1);
  return normalizedRect({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  }, undefined, MIN_CROP_SIZE);
}

function normalizeBlur(item, index) {
  const rect = normalizedRect(item, undefined, 0.002);
  return {
    id: String(item?.id || `blur_${index}`),
    ...rect,
    strength: clamp(item?.strength ?? 0.62, 0.15, 1),
  };
}

function normalizeDrawing(item, index, accentColor) {
  const points = Array.isArray(item?.points)
    ? item.points.slice(0, 4_000).map((point) => normalizedPoint(point))
    : [];
  return {
    id: String(item?.id || `drawing_${index}`),
    points,
    color: validColor(item?.color, accentColor),
    width: clamp(item?.width ?? 0.006, 0.001, 0.05),
  };
}

function normalizeClickTarget(value, fallbackColor) {
  if (!value) return null;
  const point = normalizedPoint(value);
  return {
    ...point,
    radius: clamp(value.radius ?? 0.035, 0.008, 0.2),
    color: validColor(value.color, fallbackColor),
  };
}

export function normalizeEditorStep(
  step,
  { accentColor = DEFAULT_ACCENT, clickTargetColor = DEFAULT_CLICK } = {},
) {
  const saved = step?.editorState && typeof step.editorState === "object"
    ? step.editorState
    : {};
  const hasSavedEditor = saved.version === EDITOR_STATE_VERSION;
  const legacyManualMaskCount = hasSavedEditor
    ? Math.max(0, Number(saved.legacyManualMaskCount) || 0)
    : Math.max(0, Number(step?.manualMaskCount) || 0);
  const manualBlurs = Array.isArray(saved.manualBlurs)
    ? saved.manualBlurs.map(normalizeBlur)
    : [];
  const drawings = Array.isArray(saved.drawings)
    ? saved.drawings.map((item, index) => normalizeDrawing(item, index, accentColor))
    : [];
  const clickSource = saved.clickTarget === null
    ? null
    : saved.clickTarget || step?.clickTarget || null;
  const crop = normalizedRect(
    saved.crop || contextualCrop(step),
    undefined,
    MIN_CROP_SIZE,
  );

  return {
    ...step,
    editorState: {
      version: EDITOR_STATE_VERSION,
      crop,
      manualBlurs,
      drawings,
      clickTarget: normalizeClickTarget(clickSource, clickTargetColor),
      legacyManualMaskCount,
    },
    manualMaskCount: legacyManualMaskCount + manualBlurs.length,
  };
}

function cloneEditorState(editorState) {
  return {
    ...editorState,
    crop: { ...editorState.crop },
    manualBlurs: editorState.manualBlurs.map((item) => ({ ...item })),
    drawings: editorState.drawings.map((item) => ({
      ...item,
      points: item.points.map((point) => ({ ...point })),
    })),
    clickTarget: editorState.clickTarget ? { ...editorState.clickTarget } : null,
  };
}

export function cloneDocument(document) {
  return {
    selectedStepId: document.selectedStepId,
    steps: document.steps.map((step) => ({
      ...step,
      editorState: cloneEditorState(step.editorState),
    })),
  };
}

export function createEditorDocument(steps, palette) {
  const normalizedSteps = steps.map((step) => normalizeEditorStep(step, palette));
  return {
    selectedStepId: normalizedSteps[0]?.id || null,
    steps: normalizedSteps,
  };
}

export function createEditorHistory(document) {
  return { past: [], present: cloneDocument(document), future: [] };
}

function withStep(document, stepId, updater) {
  return {
    ...document,
    steps: document.steps.map((step) =>
      step.id === stepId ? updater(step) : step,
    ),
  };
}

export function applyEditorCommand(document, command) {
  if (command.type === "select-step") {
    if (!document.steps.some((step) => step.id === command.stepId)) return document;
    return { ...document, selectedStepId: command.stepId };
  }
  if (command.type === "update-step") {
    return withStep(document, command.stepId, (step) => {
      const editorState = command.editorPatch
        ? cloneEditorState({ ...step.editorState, ...command.editorPatch })
        : cloneEditorState(step.editorState);
      const next = { ...step, ...(command.patch || {}), editorState };
      next.manualMaskCount =
        editorState.legacyManualMaskCount + editorState.manualBlurs.length;
      return next;
    });
  }
  if (command.type === "move-step") {
    const from = document.steps.findIndex((step) => step.id === command.stepId);
    if (from < 0) return document;
    const to = clamp(command.toIndex, 0, document.steps.length - 1);
    if (from === to) return document;
    const steps = [...document.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved);
    return { ...document, steps };
  }
  if (command.type === "remove-step") {
    if (document.steps.length <= 1) return document;
    const index = document.steps.findIndex((step) => step.id === command.stepId);
    if (index < 0) return document;
    const steps = document.steps.filter((step) => step.id !== command.stepId);
    return {
      ...document,
      steps,
      selectedStepId:
        document.selectedStepId === command.stepId
          ? steps[Math.min(index, steps.length - 1)]?.id || null
          : document.selectedStepId,
    };
  }
  return document;
}

export function commitEditor(history, command) {
  const next = applyEditorCommand(history.present, command);
  if (next === history.present) return history;
  if (command.type === "select-step") {
    return { ...history, present: next };
  }
  return {
    past: [...history.past, cloneDocument(history.present)].slice(-MAX_HISTORY),
    present: next,
    future: [],
  };
}

export function undoEditor(history) {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: cloneDocument(previous),
    future: [cloneDocument(history.present), ...history.future].slice(0, MAX_HISTORY),
  };
}

export function redoEditor(history) {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, cloneDocument(history.present)].slice(-MAX_HISTORY),
    present: cloneDocument(next),
    future: history.future.slice(1),
  };
}

export function pointFromClient(clientX, clientY, bounds, crop) {
  const displayX = clamp((clientX - bounds.left) / Math.max(1, bounds.width));
  const displayY = clamp((clientY - bounds.top) / Math.max(1, bounds.height));
  return {
    x: crop.x + displayX * crop.width,
    y: crop.y + displayY * crop.height,
  };
}

export function rectFromPoints(start, end, minimumSize = 0.002) {
  const left = clamp(Math.min(start.x, end.x));
  const top = clamp(Math.min(start.y, end.y));
  const right = clamp(Math.max(start.x, end.x));
  const bottom = clamp(Math.max(start.y, end.y));
  if (right - left < minimumSize || bottom - top < minimumSize) return null;
  return normalizedRect(
    { x: left, y: top, width: right - left, height: bottom - top },
    undefined,
    minimumSize,
  );
}

export function zoomCrop(crop, zoomFactor, anchor = null) {
  const current = normalizedRect(crop, undefined, MIN_CROP_SIZE);
  const factor = clamp(zoomFactor, 0.2, 5);
  const focus = anchor ? normalizedPoint(anchor) : {
    x: current.x + current.width / 2,
    y: current.y + current.height / 2,
  };
  const relativeX = clamp((focus.x - current.x) / current.width);
  const relativeY = clamp((focus.y - current.y) / current.height);
  const width = clamp(current.width / factor, MIN_CROP_SIZE, 1);
  const height = clamp(current.height / factor, MIN_CROP_SIZE, 1);
  return normalizedRect({
    x: focus.x - relativeX * width,
    y: focus.y - relativeY * height,
    width,
    height,
  }, undefined, MIN_CROP_SIZE);
}

export function panCrop(crop, deltaX, deltaY) {
  const current = normalizedRect(crop, undefined, MIN_CROP_SIZE);
  return {
    ...current,
    x: clamp(current.x + deltaX, 0, 1 - current.width),
    y: clamp(current.y + deltaY, 0, 1 - current.height),
  };
}

export function focusCrop(step) {
  return contextualCrop(step);
}

export function blurAtPoint(blurs, point) {
  for (let index = blurs.length - 1; index >= 0; index -= 1) {
    const blur = blurs[index];
    if (
      point.x >= blur.x &&
      point.x <= blur.x + blur.width &&
      point.y >= blur.y &&
      point.y <= blur.y + blur.height
    ) {
      return blur;
    }
  }
  return null;
}

export function serializeEditorState(step) {
  const editorState = cloneEditorState(step.editorState);
  return {
    editorState,
    clickTarget: editorState.clickTarget,
    manualMaskCount:
      editorState.legacyManualMaskCount + editorState.manualBlurs.length,
  };
}
