"use client";

import {
  ArrowUpRight,
  Crop as CropIcon,
  Download,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  MousePointerClick,
  Palette,
  PenLine,
  Redo2,
  RefreshCw,
  Square,
  Trash2,
  Type as TypeIcon,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { loadAuthorizedMediaUrl } from "../../lib/knowhow-client";
import type { EditorBlock } from "../../lib/knowhow-types";

type Annotation = NonNullable<EditorBlock["annotations"]>[number];
type Redaction = NonNullable<EditorBlock["redactions"]>[number];
type Crop = NonNullable<EditorBlock["crop"]>;
type Snapshot = {
  crop: Crop | undefined;
  annotations: Annotation[];
  redactions: Redaction[];
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_INCREMENT = 0.15;
const MIN_CROP_SIZE = 1 / MAX_ZOOM;
const MIN_CLICK_RADIUS = 0.018;
const MAX_CLICK_RADIUS = 0.22;
const MAX_HISTORY = 50;
const COLOR_SWATCHES = ["#b45309", "#d97706", "#166534", "#8a6d1f", "#7f1d1d", "#44403c"];

type Mode = "view" | "crop" | "redact" | "click" | "box" | "arrow" | "text";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isValidColor(value: string | undefined) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "");
}

function zoomOfCrop(crop: Crop | undefined) {
  if (!crop) return MIN_ZOOM;
  const size = Math.max(MIN_CROP_SIZE, Math.min(crop.width, crop.height));
  return clamp(1 / size, MIN_ZOOM, MAX_ZOOM);
}

/** Converts a rectangle normalized to the full source image into a
 * percentage box relative to the currently visible crop, for rendering
 * inside the (possibly zoomed) stage frame. Returns null when the region
 * doesn't overlap the visible crop at all. */
function toStageBox(
  crop: Crop,
  region: { x: number; y: number; width: number; height: number },
) {
  const left = (region.x - crop.x) / crop.width;
  const top = (region.y - crop.y) / crop.height;
  const width = region.width / crop.width;
  const height = region.height / crop.height;
  if (left + width <= 0 || top + height <= 0 || left >= 1 || top >= 1) return null;
  return { left: left * 100, top: top * 100, width: width * 100, height: height * 100 };
}

/** The stored bounding box for an annotation. Arrows carry an explicit tail
 * (x, y) and head (x2, y2) instead of a top-left + size box, so their true
 * bounds are derived from the two points instead of read directly. */
function annotationBounds(annotation: Annotation) {
  if (annotation.kind === "arrow" && annotation.x2 !== undefined && annotation.y2 !== undefined) {
    const left = Math.min(annotation.x, annotation.x2);
    const top = Math.min(annotation.y, annotation.y2);
    return {
      x: left,
      y: top,
      width: Math.max(0.002, Math.abs(annotation.x2 - annotation.x)),
      height: Math.max(0.002, Math.abs(annotation.y2 - annotation.y)),
    };
  }
  return {
    x: annotation.x,
    y: annotation.y,
    width: annotation.width ?? 0.08,
    height: annotation.height ?? 0.08,
  };
}

function pointerToImageCoordinate(
  event: { clientX: number; clientY: number },
  frame: HTMLElement,
  crop: Crop,
) {
  const rect = frame.getBoundingClientRect();
  const fracX = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const fracY = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  return { x: crop.x + fracX * crop.width, y: crop.y + fracY * crop.height };
}

function snapshotOf(step: EditorBlock): Snapshot {
  return {
    crop: step.crop,
    annotations: step.annotations ?? [],
    redactions: step.redactions ?? [],
  };
}

type Selection = { kind: "annotation" | "redaction"; id: string } | null;
type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "tail" | "head" | "edge";
type DragKind =
  | "pan"
  | "draw"
  | "draw-arrow"
  | "move-annotation"
  | "move-redaction"
  | "resize-annotation"
  | "resize-redaction";

/** Custom arrow geometry in frame pixels — line + filled head, no SVG markers. */
function arrowGeometry(x1: number, y1: number, x2: number, y2: number, stroke = 4.5) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const headLen = Math.min(18, Math.max(12, stroke * 3.2));
  const headWidth = headLen * 0.62;
  const tipX = x2;
  const tipY = y2;
  const baseX = tipX - ux * headLen;
  const baseY = tipY - uy * headLen;
  const px = -uy;
  const py = ux;
  return {
    line: { x1, y1, x2: baseX + ux * stroke * 0.15, y2: baseY + uy * stroke * 0.15 },
    head: `${tipX},${tipY} ${baseX + px * headWidth},${baseY + py * headWidth} ${baseX - px * headWidth},${baseY - py * headWidth}`,
  };
}

export type ScreenshotEditorProps = {
  workspaceId: string;
  step: EditorBlock;
  stepLabel: string;
  accentColor: string;
  clickTargetColor: string;
  locked: boolean;
  canReplace: boolean;
  busy: boolean;
  onChange: (patch: Partial<EditorBlock>) => void;
  onReplaceFile: (file: File) => void;
  onRemove: () => void;
};

export function ScreenshotEditor({
  workspaceId,
  step,
  stepLabel,
  accentColor,
  clickTargetColor,
  locked,
  canReplace,
  busy,
  onChange,
  onReplaceFile,
  onRemove,
}: ScreenshotEditorProps) {
  const mediaId = step.screenshotMediaId ?? "";
  const mediaKey = `${workspaceId}:${mediaId}`;
  const [media, setMedia] = useState({ key: "", url: "", error: "" });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState<Mode>("view");
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [canvasMenuView, setCanvasMenuView] = useState<"main" | "annotate">("main");
  const [selection, setSelection] = useState<Selection>(null);
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [draftArrow, setDraftArrow] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [renderCrop, setRenderCrop] = useState<Crop | undefined>(step.crop);
  const [isPanning, setIsPanning] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textEditStartedRef = useRef(false);
  const pendingCropRef = useRef<Crop | undefined>(undefined);
  const cropFrameRef = useRef<number | null>(null);
  const cropPendingRef = useRef(false);
  const dragRef = useRef<{
    kind: DragKind;
    startClientX: number;
    startClientY: number;
    startImagePoint: { x: number; y: number };
    originCrop: Crop;
    targetId?: string;
    handle?: ResizeHandle;
    targetOriginal?: {
      x: number;
      y: number;
      width?: number;
      height?: number;
      x2?: number;
      y2?: number;
    };
  } | null>(null);

  const crop: Crop = useMemo(() => renderCrop ?? { x: 0, y: 0, width: 1, height: 1 }, [renderCrop]);
  const zoom = zoomOfCrop(renderCrop);
  const annotations = step.annotations ?? [];
  const redactions = step.redactions ?? [];

  useEffect(() => {
    if (!mediaId) return;
    let active = true;
    let objectUrl = "";
    void loadAuthorizedMediaUrl(workspaceId, mediaId)
      .then((nextUrl) => {
        objectUrl = nextUrl;
        if (active) setMedia({ key: mediaKey, url: nextUrl, error: "" });
        else URL.revokeObjectURL(nextUrl);
      })
      .catch((nextError: unknown) => {
        if (active) {
          setMedia({
            key: mediaKey,
            url: "",
            error: nextError instanceof Error ? nextError.message : "The protected screenshot could not be loaded.",
          });
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaId, mediaKey, workspaceId]);

  const [priorMediaId, setPriorMediaId] = useState(mediaId);
  if (mediaId !== priorMediaId) {
    setPriorMediaId(mediaId);
    setMode("view");
    setSelection(null);
    setCanvasMenuOpen(false);
    setCanvasMenuView("main");
    setHistory({ past: [], future: [] });
    setRenderCrop(step.crop);
  }

  useEffect(() => () => {
    if (cropFrameRef.current !== null) cancelAnimationFrame(cropFrameRef.current);
  }, []);

  useEffect(() => {
    if (!selection && mode === "view" && !canvasMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (canvasMenuOpen) {
        closeCanvasMenu();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && target.classList.contains("shot-text-inline-input")) {
        // Let the floating text field blur via selection clear below.
      }
      event.preventDefault();
      if (selection) {
        setSelection(null);
        return;
      }
      if (mode !== "view") {
        setMode("view");
        setDraftRect(null);
        setDraftArrow(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasMenuOpen, selection, mode]);

  const url = media.key === mediaKey ? media.url : "";
  const loadError = media.key === mediaKey ? media.error : "";

  // Tracked in real pixels (not percent) so arrow lines and their heads can
  // be drawn in a coordinate space with a uniform x/y scale. A viewBox that
  // only matches the frame's percentage box (which is rarely square) would
  // force the SVG to stretch x and y by different amounts, warping every
  // arrowhead and stroke that isn't perfectly diagonal.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setFrameSize({ width, height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [url]);


  function pushHistory() {
    setHistory((current) => ({
      past: [...current.past, snapshotOf(step)].slice(-MAX_HISTORY),
      future: [],
    }));
  }

  /** Discrete, one-shot edits: snapshot first, then apply. */
  function commit(patch: Partial<EditorBlock>) {
    if (Object.prototype.hasOwnProperty.call(patch, "crop")) setRenderCrop(patch.crop);
    pushHistory();
    onChange(patch);
  }

  /** Continuous edits mid-drag: the snapshot for the whole gesture was
   * already taken when the drag started, so just apply the live value. */
  function applyLive(patch: Partial<EditorBlock>) {
    onChange(patch);
  }

  function undo() {
    if (!history.past.length) return;
    const previous = history.past[history.past.length - 1];
    const currentSnapshot = snapshotOf(step);
    setHistory({ past: history.past.slice(0, -1), future: [currentSnapshot, ...history.future].slice(0, MAX_HISTORY) });
    setSelection(null);
    setRenderCrop(previous.crop);
    onChange({ crop: previous.crop, annotations: previous.annotations, redactions: previous.redactions });
  }

  function redo() {
    if (!history.future.length) return;
    const next = history.future[0];
    const currentSnapshot = snapshotOf(step);
    setHistory({ past: [...history.past, currentSnapshot].slice(-MAX_HISTORY), future: history.future.slice(1) });
    setSelection(null);
    setRenderCrop(next.crop);
    onChange({ crop: next.crop, annotations: next.annotations, redactions: next.redactions });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const isFreeTextField =
      (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text") ||
      target.tagName === "TEXTAREA";

    if (event.key === "Enter") {
      // Never bubble Enter up to the guide form (which would save & close).
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (selection) {
        setSelection(null);
        return;
      }
      if (mode !== "view") {
        setMode("view");
        setDraftRect(null);
        setDraftArrow(null);
      }
      return;
    }

    if (isFreeTextField) return;
    const meta = event.ctrlKey || event.metaKey;
    if (!meta || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  }

  function patchCropLive(nextCrop: Crop | undefined) {
    setRenderCrop(nextCrop);
    pendingCropRef.current = nextCrop;
    cropPendingRef.current = true;
    if (cropFrameRef.current !== null) return;
    cropFrameRef.current = requestAnimationFrame(() => {
      cropFrameRef.current = null;
      if (!cropPendingRef.current) return;
      cropPendingRef.current = false;
      onChange({ crop: pendingCropRef.current });
    });
  }

  function flushPendingCrop() {
    if (cropFrameRef.current !== null) {
      cancelAnimationFrame(cropFrameRef.current);
      cropFrameRef.current = null;
    }
    if (!cropPendingRef.current) return;
    cropPendingRef.current = false;
    onChange({ crop: pendingCropRef.current });
  }

  function setZoom(nextZoom: number) {
    const size = clamp(1 / clamp(nextZoom, MIN_ZOOM, MAX_ZOOM), MIN_CROP_SIZE, 1);
    const centerX = crop.x + crop.width / 2;
    const centerY = crop.y + crop.height / 2;
    const nextCrop =
      size >= 0.999
        ? undefined
        : {
            x: clamp(centerX - size / 2, 0, 1 - size),
            y: clamp(centerY - size / 2, 0, 1 - size),
            width: size,
            height: size,
          };
    commit({ crop: nextCrop });
  }

  function closeCanvasMenu() {
    setCanvasMenuOpen(false);
    setCanvasMenuView("main");
  }

  function chooseCanvasTool(nextMode: Mode) {
    setMode(nextMode);
    closeCanvasMenu();
  }

  function addAnnotation(kind: Annotation["kind"], point: { x: number; y: number }, size?: { width: number; height: number }, extra?: Partial<Annotation>) {
    const isClick = kind === "click";
    const width = size?.width ?? (isClick ? 0.035 : 0.22);
    const height = size?.height ?? (isClick ? 0.035 : 0.12);
    const annotation: Annotation = {
      id: newId("annotation"),
      kind,
      x: isClick ? point.x : clamp(point.x, 0, 1 - width),
      y: isClick ? point.y : clamp(point.y, 0, 1 - height),
      width,
      height,
      ...(kind === "text" ? { text: "Annotation" } : {}),
      color: isClick ? clickTargetColor : accentColor,
      ...extra,
    };
    commit({ annotations: [...annotations, annotation] });
    setSelection({ kind: "annotation", id: annotation.id });
    if (kind !== "click") setMode("view");
  }

  function updateAnnotationLive(id: string, patch: Partial<Annotation>) {
    applyLive({
      annotations: annotations.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  }

  function removeAnnotation(id: string) {
    commit({ annotations: annotations.filter((item) => item.id !== id) });
    setSelection((current) => (current?.kind === "annotation" && current.id === id ? null : current));
  }

  function addRedaction(rect: { x: number; y: number; width: number; height: number }) {
    if (rect.width < 0.01 || rect.height < 0.01) {
      setMode("view");
      return;
    }
    const redaction: Redaction = { id: newId("redaction"), ...rect, applied: false };
    commit({ redactions: [...redactions, redaction] });
    setMode("view");
  }

  function removeRedaction(id: string) {
    commit({ redactions: redactions.filter((item) => item.id !== id) });
    setSelection((current) => (current?.kind === "redaction" && current.id === id ? null : current));
  }

  function findMarker(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const markerId = target.closest<HTMLElement>("[data-marker-id]")?.dataset.markerId;
    const markerKind = target.closest<HTMLElement>("[data-marker-kind]")?.dataset.markerKind as "annotation" | "redaction" | undefined;
    return { markerId, markerKind };
  }

  function handleResizeHandlePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    kind: "annotation" | "redaction",
    id: string,
    handle: ResizeHandle,
  ) {
    event.stopPropagation();
    event.preventDefault();
    const frame = frameRef.current;
    if (!frame || locked) return;
    rootRef.current?.focus({ preventScroll: true });
    const original =
      kind === "annotation"
        ? annotations.find((item) => item.id === id)
        : redactions.find((item) => item.id === id);
    if (!original) return;
    pushHistory();
    setSelection({ kind, id });
    setMode("view");
    dragRef.current = {
      kind: kind === "annotation" ? "resize-annotation" : "resize-redaction",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startImagePoint: pointerToImageCoordinate(event, frame, crop),
      originCrop: crop,
      targetId: id,
      handle,
      targetOriginal: {
        x: original.x,
        y: original.y,
        width: "width" in original ? original.width : undefined,
        height: "height" in original ? original.height : undefined,
        ...("x2" in original && original.x2 !== undefined ? { x2: original.x2, y2: original.y2 } : {}),
      },
    };
    frame.setPointerCapture(event.pointerId);
  }

  function handleStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Ignore presses that started on the floating toolbar / zoom chrome.
    if ((event.target as HTMLElement).closest(".shot-selection-toolbar, .shot-canvas-pen, .shot-canvas-menu, .shot-history-controls, .shot-zoom-controls, .shot-mode-banner")) {
      return;
    }
    if (canvasMenuOpen) {
      closeCanvasMenu();
      return;
    }
    rootRef.current?.focus({ preventScroll: true });
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    const { markerId, markerKind } = findMarker(event);

    // Existing markers always win over crop-pan / draw tools, so selecting
    // an annotation and dragging it never pans the screenshot underneath.
    if (markerId && markerKind && !locked) {
      event.stopPropagation();
      setSelection({ kind: markerKind, id: markerId });
      setMode("view");
      const originalList = markerKind === "annotation" ? annotations : redactions;
      const original = originalList.find((item) => item.id === markerId);
      if (!original) return;
      pushHistory();
      dragRef.current = {
        kind: markerKind === "annotation" ? "move-annotation" : "move-redaction",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startImagePoint: pointerToImageCoordinate(event, frame, crop),
        originCrop: crop,
        targetId: markerId,
        targetOriginal: {
          x: original.x,
          y: original.y,
          width: "width" in original ? original.width : undefined,
          height: "height" in original ? original.height : undefined,
          ...("x2" in original && (original as Annotation).x2 !== undefined
            ? { x2: (original as Annotation).x2, y2: (original as Annotation).y2 }
            : {}),
        },
      };
      frame.setPointerCapture(event.pointerId);
      return;
    }

    if (mode === "view" || mode === "crop") {
      setSelection(null);
      // Pan when zoomed (crop active), whether or not the Crop tool is selected.
      if (zoom > MIN_ZOOM + 0.01) {
        pushHistory();
        setIsPanning(true);
        dragRef.current = {
          kind: "pan",
          startClientX: event.clientX,
          startClientY: event.clientY,
          startImagePoint: { x: 0, y: 0 },
          originCrop: crop,
        };
        frame.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (mode === "click") {
      addAnnotation("click", pointerToImageCoordinate(event, frame, crop));
      return;
    }

    if (mode === "text") {
      const point = pointerToImageCoordinate(event, frame, crop);
      addAnnotation("text", { x: clamp(point.x, 0, 0.7), y: clamp(point.y, 0, 0.85) }, { width: 0.18, height: 0.06 });
      return;
    }

    if (mode === "arrow") {
      const point = pointerToImageCoordinate(event, frame, crop);
      dragRef.current = {
        kind: "draw-arrow",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startImagePoint: point,
        originCrop: crop,
      };
      setDraftArrow({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
      frame.setPointerCapture(event.pointerId);
      return;
    }

    if (mode === "box" || mode === "redact") {
      const point = pointerToImageCoordinate(event, frame, crop);
      dragRef.current = {
        kind: "draw",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startImagePoint: point,
        originCrop: crop,
      };
      setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
      frame.setPointerCapture(event.pointerId);
    }
  }

  function resizeRect(
    original: { x: number; y: number; width: number; height: number },
    handle: ResizeHandle,
    point: { x: number; y: number },
  ) {
    const minSize = 0.02;
    let { x, y, width, height } = original;
    const right = original.x + original.width;
    const bottom = original.y + original.height;
    if (handle.includes("e")) {
      width = clamp(point.x - original.x, minSize, 1 - original.x);
    }
    if (handle.includes("s")) {
      height = clamp(point.y - original.y, minSize, 1 - original.y);
    }
    if (handle.includes("w")) {
      const nextX = clamp(point.x, 0, right - minSize);
      width = right - nextX;
      x = nextX;
    }
    if (handle.includes("n")) {
      const nextY = clamp(point.y, 0, bottom - minSize);
      height = bottom - nextY;
      y = nextY;
    }
    return { x, y, width, height };
  }

  function handleStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame) return;

    if (drag.kind === "pan") {
      const rect = frame.getBoundingClientRect();
      const deltaFracX = ((event.clientX - drag.startClientX) / Math.max(1, rect.width)) * drag.originCrop.width;
      const deltaFracY = ((event.clientY - drag.startClientY) / Math.max(1, rect.height)) * drag.originCrop.height;
      patchCropLive({
        x: clamp(drag.originCrop.x - deltaFracX, 0, 1 - drag.originCrop.width),
        y: clamp(drag.originCrop.y - deltaFracY, 0, 1 - drag.originCrop.height),
        width: drag.originCrop.width,
        height: drag.originCrop.height,
      });
      return;
    }

    if (drag.kind === "draw") {
      const point = pointerToImageCoordinate(event, frame, drag.originCrop);
      setDraftRect({
        x: Math.min(drag.startImagePoint.x, point.x),
        y: Math.min(drag.startImagePoint.y, point.y),
        width: Math.abs(point.x - drag.startImagePoint.x),
        height: Math.abs(point.y - drag.startImagePoint.y),
      });
      return;
    }

    if (drag.kind === "draw-arrow") {
      const point = pointerToImageCoordinate(event, frame, drag.originCrop);
      setDraftArrow({ x1: drag.startImagePoint.x, y1: drag.startImagePoint.y, x2: point.x, y2: point.y });
      return;
    }

    if (drag.kind === "resize-annotation" && drag.targetId && drag.targetOriginal && drag.handle) {
      const point = pointerToImageCoordinate(event, frame, drag.originCrop);
      const target = annotations.find((item) => item.id === drag.targetId);
      if (!target) return;

      if (target.kind === "click") {
        // Click targets are center-point annotations. Keep that point fixed
        // while the dedicated east-edge handle changes the radius, so a resize
        // neither jumps on the first move nor drags the target off its mark.
        const radius = drag.targetOriginal.width ?? 0.035;
        const cx = drag.targetOriginal.x;
        const boundaryRadius = Math.min(cx, 1 - cx);
        const maxRadius = Math.min(MAX_CLICK_RADIUS, Math.max(radius, MIN_CLICK_RADIUS, boundaryRadius));
        const nextRadius = clamp(point.x - cx, MIN_CLICK_RADIUS, maxRadius);
        updateAnnotationLive(drag.targetId, { width: nextRadius, height: nextRadius });
        return;
      }

      if (target.kind === "arrow") {
        if (drag.handle === "head") {
          updateAnnotationLive(drag.targetId, { x2: clamp(point.x, 0, 1), y2: clamp(point.y, 0, 1) });
        } else if (drag.handle === "tail") {
          updateAnnotationLive(drag.targetId, { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) });
        }
        return;
      }

      const next = resizeRect(
        {
          x: drag.targetOriginal.x,
          y: drag.targetOriginal.y,
          width: drag.targetOriginal.width ?? 0.08,
          height: drag.targetOriginal.height ?? 0.08,
        },
        drag.handle,
        point,
      );
      updateAnnotationLive(drag.targetId, next);
      return;
    }

    if (drag.kind === "resize-redaction" && drag.targetId && drag.targetOriginal && drag.handle) {
      const point = pointerToImageCoordinate(event, frame, drag.originCrop);
      const next = resizeRect(
        {
          x: drag.targetOriginal.x,
          y: drag.targetOriginal.y,
          width: drag.targetOriginal.width ?? 0.08,
          height: drag.targetOriginal.height ?? 0.08,
        },
        drag.handle,
        point,
      );
      applyLive({
        redactions: redactions.map((item) => (item.id === drag.targetId ? { ...item, ...next } : item)),
      });
      return;
    }

    if (drag.kind === "move-annotation" && drag.targetId && drag.targetOriginal) {
      const point = pointerToImageCoordinate(event, frame, drag.originCrop);
      const dx = point.x - drag.startImagePoint.x;
      const dy = point.y - drag.startImagePoint.y;
      const target = annotations.find((item) => item.id === drag.targetId);
      if (!target) return;

      if (target.kind === "arrow" && drag.targetOriginal.x2 !== undefined && drag.targetOriginal.y2 !== undefined) {
        const nextX = clamp(drag.targetOriginal.x + dx, 0, 1);
        const nextY = clamp(drag.targetOriginal.y + dy, 0, 1);
        const nextX2 = clamp(drag.targetOriginal.x2 + dx, 0, 1);
        const nextY2 = clamp(drag.targetOriginal.y2 + dy, 0, 1);
        updateAnnotationLive(drag.targetId, { x: nextX, y: nextY, x2: nextX2, y2: nextY2 });
        return;
      }

      if (target.kind === "click") {
        updateAnnotationLive(drag.targetId, {
          x: clamp(drag.targetOriginal.x + dx, 0, 1),
          y: clamp(drag.targetOriginal.y + dy, 0, 1),
        });
        return;
      }

      const width = drag.targetOriginal.width ?? target.width ?? 0.08;
      const height = drag.targetOriginal.height ?? target.height ?? 0.08;
      updateAnnotationLive(drag.targetId, {
        x: clamp(drag.targetOriginal.x + dx, 0, 1 - width),
        y: clamp(drag.targetOriginal.y + dy, 0, 1 - height),
      });
      return;
    }

    if (drag.kind === "move-redaction" && drag.targetId && drag.targetOriginal) {
      const point = pointerToImageCoordinate(event, frame, drag.originCrop);
      const dx = point.x - drag.startImagePoint.x;
      const dy = point.y - drag.startImagePoint.y;
      const target = redactions.find((item) => item.id === drag.targetId);
      if (!target) return;
      applyLive({
        redactions: redactions.map((item) =>
          item.id === drag.targetId
            ? {
                ...item,
                x: clamp(drag.targetOriginal!.x + dx, 0, 1 - item.width),
                y: clamp(drag.targetOriginal!.y + dy, 0, 1 - item.height),
              }
            : item,
        ),
      });
    }
  }

  function handleStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    frameRef.current?.releasePointerCapture(event.pointerId);
    if (drag.kind === "pan") {
      flushPendingCrop();
      setIsPanning(false);
    }
    if (drag.kind === "draw" && draftRect) {
      if (mode === "redact") addRedaction(draftRect);
      else addAnnotation("box", { x: draftRect.x, y: draftRect.y }, { width: draftRect.width, height: draftRect.height });
      setDraftRect(null);
    }
    if (drag.kind === "draw-arrow" && draftArrow) {
      const width = Math.abs(draftArrow.x2 - draftArrow.x1);
      const height = Math.abs(draftArrow.y2 - draftArrow.y1);
      if (Math.hypot(width, height) >= 0.01) {
        addAnnotation(
          "arrow",
          { x: draftArrow.x1, y: draftArrow.y1 },
          { width, height },
          { x2: draftArrow.x2, y2: draftArrow.y2 },
        );
      } else {
        setMode("view");
      }
      setDraftArrow(null);
    }
  }

  function handleMarkerDoubleClick(event: ReactMouseEvent<HTMLSpanElement>, annotation: Annotation) {
    event.stopPropagation();
    if (locked) return;
    setSelection({ kind: "annotation", id: annotation.id });
  }

  async function handleDownload() {
    if (!url) return;
    const blob = await fetch(url).then((response) => response.blob());
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${stepLabel.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "screenshot"}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(anchor.href);
  }

  function handleDelete() {
    if (!window.confirm("Delete this screenshot? This cannot be undone.")) return;
    onRemove();
  }

  const selectedAnnotation = selection?.kind === "annotation" ? annotations.find((item) => item.id === selection.id) : undefined;
  const selectedRedaction = selection?.kind === "redaction" ? redactions.find((item) => item.id === selection.id) : undefined;

  function commitAnnotationColor(id: string, color: string) {
    commit({ annotations: annotations.map((item) => (item.id === id ? { ...item, color } : item)) });
  }

  /** Converts a normalized image point to real pixels inside the frame, or
   * null when it falls outside the currently visible crop. */
  function pointToFramePixels(point: { x: number; y: number }) {
    const box = toStageBox(crop, { x: point.x, y: point.y, width: 0, height: 0 });
    if (!box) return null;
    return { x: (box.left / 100) * frameSize.width, y: (box.top / 100) * frameSize.height };
  }

  const arrowOverlayLines = useMemo(() => {
    if (!frameSize.width || !frameSize.height) return [];
    const lines: Array<{ id: string; color: string; selected: boolean; tail: { x: number; y: number }; head: { x: number; y: number } }> = [];
    for (const annotation of annotations) {
      if (annotation.kind !== "arrow") continue;
      const bounds = annotationBounds(annotation);
      const hasHead = annotation.x2 !== undefined && annotation.y2 !== undefined;
      const tailPoint = hasHead ? { x: annotation.x, y: annotation.y } : { x: bounds.x, y: bounds.y + bounds.height };
      const headPoint = hasHead ? { x: annotation.x2!, y: annotation.y2! } : { x: bounds.x + bounds.width, y: bounds.y };
      const tail = pointToFramePixels(tailPoint);
      const head = pointToFramePixels(headPoint);
      if (!tail || !head) continue;
      lines.push({
        id: annotation.id,
        color: isValidColor(annotation.color) ? annotation.color! : accentColor,
        selected: selection?.id === annotation.id,
        tail,
        head,
      });
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, crop, frameSize, selection, accentColor]);

  const draftArrowLine = useMemo(() => {
    if (!draftArrow || !frameSize.width || !frameSize.height) return null;
    const tail = pointToFramePixels({ x: draftArrow.x1, y: draftArrow.y1 });
    const head = pointToFramePixels({ x: draftArrow.x2, y: draftArrow.y2 });
    if (!tail || !head) return null;
    return { color: accentColor, tail, head };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftArrow, crop, frameSize, accentColor]);

  const cursor = useMemo(() => {
    if (mode === "crop") return "grab";
    if (mode === "view") return "default";
    return "crosshair";
  }, [mode]);

  if (!mediaId) return null;

  return (
    <div className="shot-editor" ref={rootRef} tabIndex={-1} onKeyDown={handleKeyDown}>
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onReplaceFile(file);
        }}
      />

      <div
        className={`shot-stage mode-${mode}`}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onPointerLeave={(event) => {
          if (dragRef.current?.kind === "draw" || dragRef.current?.kind === "draw-arrow") handleStagePointerUp(event);
        }}
        style={{ cursor }}
      >
        {loadError ? (
          <div className="shot-frame-state" role="status"><ImagePlus /><span>{loadError}</span></div>
        ) : !url ? (
          <div className="shot-frame-state" role="status"><LoaderCircle className="spin" /><span>Loading protected screenshot</span></div>
        ) : (
          <div
            className="shot-frame"
            ref={frameRef}
            style={{ aspectRatio: naturalSize.width && naturalSize.height ? `${naturalSize.width} / ${naturalSize.height}` : "16 / 9" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={`shot-image${isPanning ? " panning" : ""}`}
              src={url}
              alt={`Screenshot for ${stepLabel}`}
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              style={{
                position: "absolute",
                width: `${zoom * 100}%`,
                height: `${zoom * 100}%`,
                left: `${-crop.x * zoom * 100}%`,
                top: `${-crop.y * zoom * 100}%`,
                maxWidth: "none",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />

            <button
              type="button"
              className={`shot-canvas-pen${canvasMenuOpen ? " active" : ""}`}
              aria-label="Open screenshot tools"
              aria-expanded={canvasMenuOpen}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (canvasMenuOpen) closeCanvasMenu();
                else setCanvasMenuOpen(true);
              }}
            ><PenLine /></button>
            {canvasMenuOpen ? (
              <div className="shot-canvas-menu" role="menu" aria-label="Screenshot tools" onPointerDown={(event) => event.stopPropagation()}>
                {canvasMenuView === "main" ? (
                  <>
                    <button type="button" role="menuitem" onClick={() => chooseCanvasTool("click")} disabled={locked}><MousePointerClick /> Add click target</button>
                    <button type="button" role="menuitem" onClick={() => setCanvasMenuView("annotate")} disabled={locked}><Square /> Annotate</button>
                    <button type="button" role="menuitem" onClick={() => chooseCanvasTool("redact")} disabled={locked}><EyeOff /> Redact</button>
                    <button type="button" role="menuitem" onClick={() => chooseCanvasTool(mode === "crop" ? "view" : "crop")}><CropIcon /> {mode === "crop" ? "Done cropping" : "Crop"}</button>
                    {zoom > MIN_ZOOM + 0.01 ? <button type="button" role="menuitem" onClick={() => { commit({ crop: undefined }); closeCanvasMenu(); }}><CropIcon /> Reset crop</button> : null}
                    <div className="shot-canvas-menu-divider" />
                    <button type="button" role="menuitem" onClick={() => { fileInputRef.current?.click(); closeCanvasMenu(); }} disabled={!canReplace || busy}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />} Replace image</button>
                    <button type="button" role="menuitem" onClick={() => { void handleDownload(); closeCanvasMenu(); }} disabled={!url}><Download /> Download</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { closeCanvasMenu(); handleDelete(); }}><Trash2 /> Delete image</button>
                  </>
                ) : (
                  <>
                    <button type="button" role="menuitem" className="shot-canvas-menu-back" onClick={() => setCanvasMenuView("main")}><Undo2 /> Back to tools</button>
                    <button type="button" role="menuitem" onClick={() => chooseCanvasTool("box")} disabled={locked}><Square /> Box annotation</button>
                    <button type="button" role="menuitem" onClick={() => chooseCanvasTool("arrow")} disabled={locked}><ArrowUpRight /> Arrow</button>
                    <button type="button" role="menuitem" onClick={() => chooseCanvasTool("text")} disabled={locked}><TypeIcon /> Text label</button>
                  </>
                )}
              </div>
            ) : null}

            {redactions.map((redaction) => {
              const box = toStageBox(crop, redaction);
              if (!box) return null;
              const style: CSSProperties = { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` };
              if (redaction.applied) {
                return <span key={redaction.id} className="shot-region shot-redaction applied" style={style} aria-hidden="true" />;
              }
              const isSelected = selection?.id === redaction.id;
              return (
                <span
                  key={redaction.id}
                  className={`shot-region shot-redaction${isSelected ? " selected" : ""}`}
                  style={style}
                  data-marker-id={redaction.id}
                  data-marker-kind="redaction"
                >
                  {isSelected && !locked ? (
                    <>
                      {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                        <span
                          key={handle}
                          className={`shot-resize-handle ${handle}`}
                          onPointerDown={(event) => handleResizeHandlePointerDown(event, "redaction", redaction.id, handle)}
                        />
                      ))}
                    </>
                  ) : null}
                </span>
              );
            })}

            {annotations.map((annotation) => {
              const color = isValidColor(annotation.color) ? annotation.color! : annotation.kind === "click" ? clickTargetColor : accentColor;
              const isSelected = selection?.id === annotation.id;
              if (annotation.kind === "click") {
                const box = toStageBox(crop, { x: annotation.x, y: annotation.y, width: 0, height: 0 });
                if (!box) return null;
                const radius = annotation.width ?? 0.035;
                const diameter = (radius / crop.width) * 200;
                return (
                  <span
                    key={annotation.id}
                    className={`shot-region shot-click${isSelected ? " selected" : ""}`}
                    style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${diameter}%`, borderColor: color, boxShadow: `0 0 0 5px ${color}33` }}
                    data-marker-id={annotation.id}
                    data-marker-kind="annotation"
                    onDoubleClick={(event) => handleMarkerDoubleClick(event, annotation)}
                  >
                    {isSelected && mode === "view" && !locked ? (
                      <span
                        className="shot-resize-handle edge"
                        onPointerDown={(event) => handleResizeHandlePointerDown(event, "annotation", annotation.id, "edge")}
                        title="Drag to resize"
                      />
                    ) : null}
                  </span>
                );
              }
              const bounds = annotationBounds(annotation);
              const box = toStageBox(crop, bounds);
              if (!box) return null;
              const style: CSSProperties = { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` };
              if (annotation.kind === "arrow") {
                const hasHead = annotation.x2 !== undefined && annotation.y2 !== undefined;
                const tailBox = toStageBox(crop, { x: annotation.x, y: annotation.y, width: 0, height: 0 });
                const headBox = hasHead
                  ? toStageBox(crop, { x: annotation.x2!, y: annotation.y2!, width: 0, height: 0 })
                  : toStageBox(crop, { x: bounds.x + bounds.width, y: bounds.y, width: 0, height: 0 });
                return (
                  <span
                    key={annotation.id}
                    className={`shot-region shot-arrow-hit${isSelected ? " selected" : ""}`}
                    style={style}
                    data-marker-id={annotation.id}
                    data-marker-kind="annotation"
                    onDoubleClick={(event) => handleMarkerDoubleClick(event, annotation)}
                  >
                    {isSelected && !locked && tailBox && headBox ? (
                      <>
                        <span
                          className="shot-resize-handle arrow-end"
                          style={{ left: `${((annotation.x - bounds.x) / Math.max(0.002, bounds.width)) * 100}%`, top: `${((annotation.y - bounds.y) / Math.max(0.002, bounds.height)) * 100}%` }}
                          onPointerDown={(event) => handleResizeHandlePointerDown(event, "annotation", annotation.id, "tail")}
                          title="Move arrow start"
                        />
                        <span
                          className="shot-resize-handle arrow-end"
                          style={{ left: `${(((hasHead ? annotation.x2! : bounds.x + bounds.width) - bounds.x) / Math.max(0.002, bounds.width)) * 100}%`, top: `${(((hasHead ? annotation.y2! : bounds.y) - bounds.y) / Math.max(0.002, bounds.height)) * 100}%` }}
                          onPointerDown={(event) => handleResizeHandlePointerDown(event, "annotation", annotation.id, "head")}
                          title="Move arrow end"
                        />
                      </>
                    ) : null}
                  </span>
                );
              }
              if (annotation.kind === "text") {
                return (
                  <span
                    key={annotation.id}
                    className={`shot-region shot-text${isSelected ? " selected" : ""}`}
                    style={{ ...style, borderColor: color, color, backgroundColor: `${color}22` }}
                    data-marker-id={annotation.id}
                  data-marker-kind="annotation"
                  onDoubleClick={(event) => handleMarkerDoubleClick(event, annotation)}
                >
                    {isSelected && !locked ? (
                      <input
                        className="shot-text-inline-input"
                        value={annotation.text ?? ""}
                        maxLength={500}
                        autoFocus
                        aria-label="Edit annotation text"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          if (!textEditStartedRef.current) {
                            textEditStartedRef.current = true;
                            pushHistory();
                          }
                          updateAnnotationLive(annotation.id, { text: event.target.value });
                        }}
                        onFocus={(event) => {
                          textEditStartedRef.current = false;
                          event.currentTarget.select();
                        }}
                      />
                    ) : annotation.text?.trim() || "Annotation"}
                    {isSelected && !locked ? (
                      <>
                        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                          <span
                            key={handle}
                            className={`shot-resize-handle ${handle}`}
                            onPointerDown={(event) => handleResizeHandlePointerDown(event, "annotation", annotation.id, handle)}
                          />
                        ))}
                      </>
                    ) : null}
                  </span>
                );
              }
              return (
                <span
                  key={annotation.id}
                  className={`shot-region shot-box${isSelected ? " selected" : ""}`}
                  style={{ ...style, borderColor: color }}
                  data-marker-id={annotation.id}
                  data-marker-kind="annotation"
                  onDoubleClick={(event) => handleMarkerDoubleClick(event, annotation)}
                >
                  {isSelected && !locked ? (
                    <>
                      {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                        <span
                          key={handle}
                          className={`shot-resize-handle ${handle}`}
                          onPointerDown={(event) => handleResizeHandlePointerDown(event, "annotation", annotation.id, handle)}
                        />
                      ))}
                    </>
                  ) : null}
                </span>
              );
            })}

            {draftRect ? (() => {
              const box = toStageBox(crop, draftRect);
              if (!box) return null;
              return <span className={`shot-region shot-draft ${mode === "redact" ? "shot-redaction" : "shot-box"}`} style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }} />;
            })() : null}

            {frameSize.width && frameSize.height && (arrowOverlayLines.length || draftArrowLine) ? (
              <svg
                className="shot-arrow-overlay"
                viewBox={`0 0 ${frameSize.width} ${frameSize.height}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {arrowOverlayLines.map((line) => {
                  const stroke = line.selected ? 5 : 4;
                  const geometry = arrowGeometry(line.tail.x, line.tail.y, line.head.x, line.head.y, stroke);
                  return (
                    <g key={line.id}>
                      <line
                        x1={geometry.line.x1}
                        y1={geometry.line.y1}
                        x2={geometry.line.x2}
                        y2={geometry.line.y2}
                        stroke={line.color}
                        strokeWidth={stroke}
                        strokeLinecap="round"
                      />
                      <polygon points={geometry.head} fill={line.color} />
                    </g>
                  );
                })}
                {draftArrowLine ? (() => {
                  const geometry = arrowGeometry(draftArrowLine.tail.x, draftArrowLine.tail.y, draftArrowLine.head.x, draftArrowLine.head.y, 4);
                  return (
                    <g>
                      <line
                        x1={geometry.line.x1}
                        y1={geometry.line.y1}
                        x2={geometry.line.x2}
                        y2={geometry.line.y2}
                        stroke={draftArrowLine.color}
                        strokeWidth={4}
                        strokeLinecap="round"
                        strokeDasharray="3 7"
                      />
                      <polygon points={geometry.head} fill={draftArrowLine.color} opacity={0.85} />
                    </g>
                  );
                })() : null}
              </svg>
            ) : null}

            {selectedAnnotation && !locked ? (
              <div
                className="shot-selection-toolbar"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="shot-swatch-row">
                  {COLOR_SWATCHES.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      className={`shot-swatch${(isValidColor(selectedAnnotation.color) ? selectedAnnotation.color!.toLowerCase() : "") === swatch ? " active" : ""}`}
                      style={{ background: swatch }}
                      aria-label={`Use color ${swatch}`}
                      onClick={() => commitAnnotationColor(selectedAnnotation.id, swatch)}
                    />
                  ))}
                  <label className="shot-swatch shot-swatch-custom" title="Custom color">
                    <Palette />
                    <input
                      type="color"
                      value={isValidColor(selectedAnnotation.color) ? selectedAnnotation.color : accentColor}
                      onFocus={() => pushHistory()}
                      onChange={(event) => updateAnnotationLive(selectedAnnotation.id, { color: event.target.value })}
                    />
                  </label>
                </div>
                <span className="shot-floating-divider" />
                <button type="button" className="icon-button tiny danger" onClick={() => removeAnnotation(selectedAnnotation.id)} aria-label="Remove annotation" title="Delete">
                  <Trash2 />
                </button>
                <button type="button" className="icon-button tiny" onClick={() => setSelection(null)} aria-label="Close" title="Close">
                  <X />
                </button>
              </div>
            ) : null}

            {selectedRedaction && !selectedRedaction.applied && !locked ? (
              <div
                className="shot-selection-toolbar"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span className="shot-floating-label"><EyeOff /> Blur region</span>
                <span className="shot-floating-divider" />
                <button type="button" className="icon-button tiny danger" onClick={() => removeRedaction(selectedRedaction.id)} aria-label="Remove blur region" title="Delete">
                  <Trash2 />
                </button>
                <button type="button" className="icon-button tiny" onClick={() => setSelection(null)} aria-label="Close" title="Close">
                  <X />
                </button>
              </div>
            ) : null}
          </div>
        )}

        {url && !loadError ? (
          <div className="shot-history-controls" onPointerDown={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button tiny" onClick={undo} disabled={!history.past.length} aria-label="Undo"><Undo2 /></button>
            <button type="button" className="icon-button tiny" onClick={redo} disabled={!history.future.length} aria-label="Redo"><Redo2 /></button>
          </div>
        ) : null}

        {url && !loadError ? (
          <div className="shot-zoom-controls" onPointerDown={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button tiny" onClick={() => setZoom(zoom + ZOOM_INCREMENT)} disabled={zoom >= MAX_ZOOM - 0.01} aria-label="Zoom in by 15 percent"><ZoomIn /></button>
            <button type="button" className="icon-button tiny" onClick={() => setZoom(zoom - ZOOM_INCREMENT)} disabled={zoom <= MIN_ZOOM + 0.01} aria-label="Zoom out by 15 percent"><ZoomOut /></button>
          </div>
        ) : null}

        {mode !== "view" && mode !== "crop" ? (
          <div className="shot-mode-banner">
            <span>
              {mode === "redact"
                ? "Drag to blur a region"
                : mode === "click"
                  ? "Click to place a click target — keep clicking to add more"
                  : mode === "text"
                    ? "Click to place a text label"
                    : mode === "arrow"
                      ? "Drag in any direction to draw an arrow"
                      : "Drag to draw"}
            </span>
            <button type="button" className="icon-button tiny" onClick={() => setMode("view")} aria-label="Cancel tool"><X /></button>
          </div>
        ) : null}
      </div>

    </div>
  );
}
