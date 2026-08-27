"use client";

import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  ExternalLink,
  GripVertical,
  Heading2,
  ImagePlus,
  ListChecks,
  Pencil,
  Plus,
  Save,
  Share2,
  StickyNote,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadAuthorizedMediaUrl, replaceDraftScreenshot } from "../../lib/knowhow-client";
import type { NavigationGuard } from "../../lib/navigation-guard";
import { isCapturedGuideSource, type GuideSource } from "../../lib/guide-contracts";
import type {
  Audience,
  Guide,
  EditorBlock,
  EditorBlockKind,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceSettings,
  WorkspaceSummary,
} from "../../lib/knowhow-types";
import { flattenScreenshot, needsFlattening } from "../../lib/screenshot-flatten";
import { parseStepLink } from "../../lib/step-links";
import { ScreenshotEditor } from "./screenshot-editor";
import { SelectMenu } from "./select-menu";
import { GuideShareDialog } from "./guide-share-dialog";
import { GuideExportDialog, type GuideExportFormatChoice } from "./guide-export-dialog";
import { GuideDeleteDialog } from "./guide-delete-dialog";
import { Button } from "@/components/ui/button";

function StepTitleField({
  value,
  linkable,
  placeholder,
  onChange,
}: {
  value: string;
  linkable: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const link = linkable ? parseStepLink(value) : null;

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  if (!link || editing) {
    return (
      <input
        ref={inputRef}
        className="step-title-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setEditing(false)}
        placeholder={placeholder}
      />
    );
  }

  return (
    <div className="step-title-display">
      <span className="step-title-rendered">
        {link.before}
        <a
          className="step-title-inline-link"
          href={link.href}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${link.label}`}
        >
          <span>{link.label}</span>
          <ExternalLink />
        </a>
        {link.after}
      </span>
      <button
        className="step-title-edit-button"
        type="button"
        aria-label="Edit action title"
        title="Edit action title"
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </button>
    </div>
  );
}

export type GuideEditorPayload = {
  guideId?: string;
  revisionId?: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  systemReferences: string[];
  steps: EditorBlock[];
  audiences: Audience[];
  source: GuideSource;
  privacyReviewed: boolean;
  transition: "draft" | "review";
};

export type GuideSaveResult = {
  guideId: string;
  revisionId: string;
};

type GuideEditorProps = {
  guide: Guide | null;
  workspace: WorkspaceSummary & { settings: WorkspaceSettings };
  groups: WorkspaceGroup[];
  members: WorkspaceMember[];
  busy: boolean;
  privacyToolsEnabled?: boolean;
  onClose: () => void;
  onSave: (payload: GuideEditorPayload) => Promise<GuideSaveResult>;
  onShare?: (payload: GuideEditorPayload) => Promise<GuideSaveResult>;
  onExport?: (format: GuideExportFormatChoice) => Promise<void>;
  onStartTrial?: () => void;
  onSaved?: (result: GuideSaveResult, transition: GuideEditorPayload["transition"] | "share") => void;
  onMediaChanged?: () => Promise<unknown>;
  onDelete?: () => Promise<void>;
  onRegisterNavigationGuard: (guard: NavigationGuard | null) => void;
  requireReviewBeforePublish?: boolean;
  canShare?: boolean;
  liveUrl?: string;
  fileExportsEnabled?: boolean;
  canExport?: boolean;
};

const STEP_KINDS: Array<{
  value: EditorBlockKind;
  label: string;
  icon: typeof ListChecks;
}> = [
  { value: "action", label: "Action", icon: ListChecks },
  { value: "heading", label: "Heading", icon: Heading2 },
  { value: "note", label: "Note", icon: StickyNote },
  { value: "warning", label: "Warning", icon: TriangleAlert },
];

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function newStep(kind: EditorBlockKind = "action"): EditorBlock {
  return {
    id: newId("step"),
    kind,
    title: kind === "heading" ? "" : "",
    description: "",
  };
}

function selectedRevision(guide: Guide | null) {
  return guide?.workingRevision ?? guide?.publishedRevision ?? null;
}

function editableSteps(revision: ReturnType<typeof selectedRevision>) {
  return revision?.steps.length ? revision.steps : [newStep()];
}

function normalizedCoordinate(value: number | undefined, fallback: number) {
  const numeric = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(1, Math.max(0, numeric > 1 ? numeric / 100 : numeric));
}

export function ScreenshotAnnotationPreview({
  step,
  accentColor,
  clickTargetColor,
  showCropOutline = true,
}: {
  step: EditorBlock;
  accentColor: string;
  clickTargetColor: string;
  showCropOutline?: boolean;
}) {
  const cropScale = step.crop && Math.max(
    step.crop.x,
    step.crop.y,
    step.crop.width,
    step.crop.height,
  ) <= 1 ? 100 : 1;
  return <>
    {showCropOutline && step.crop ? <span className="annotation-preview-crop" style={{ left: `${Math.max(0, step.crop.x * cropScale)}%`, top: `${Math.max(0, step.crop.y * cropScale)}%`, width: `${Math.max(0, step.crop.width * cropScale)}%`, height: `${Math.max(0, step.crop.height * cropScale)}%` }} /> : null}
    {(step.redactions ?? []).filter((redaction) => !redaction.applied).map((redaction) => {
      const x = normalizedCoordinate(redaction.x, 0);
      const y = normalizedCoordinate(redaction.y, 0);
      const width = normalizedCoordinate(redaction.width, 0.08);
      const height = normalizedCoordinate(redaction.height, 0.08);
      return <span className="annotation-preview-redaction" key={redaction.id} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }} />;
    })}
    {(step.annotations ?? []).map((annotation) => {
      const x = normalizedCoordinate(annotation.x, 0);
      const y = normalizedCoordinate(annotation.y, 0);
      const width = normalizedCoordinate(annotation.width, 0.08);
      const height = normalizedCoordinate(annotation.height, 0.08);
      const fallback = annotation.kind === "click" ? clickTargetColor : accentColor;
      const color = /^#[0-9a-f]{6}$/i.test(annotation.color ?? "") ? annotation.color! : fallback;
      if (annotation.kind === "click") {
        return <span className="annotation-preview-click" key={annotation.id} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${Math.max(0.01, width) * 200}%`, borderColor: color, boxShadow: `0 0 0 4px ${color}33` }} />;
      }
      if (annotation.kind === "arrow") {
        const hasHead = annotation.x2 !== undefined && annotation.y2 !== undefined;
        // Tail/head, normalized to the full screenshot. When x2/y2 are absent
        // (annotations saved before dynamic arrows existed), fall back to the
        // original fixed bottom-left-to-top-right diagonal of the box.
        const tailPoint = hasHead ? { x, y } : { x, y: y + height };
        const headPoint = hasHead
          ? { x: normalizedCoordinate(annotation.x2, x), y: normalizedCoordinate(annotation.y2, y) }
          : { x: x + width, y };
        const left = Math.min(tailPoint.x, headPoint.x);
        const top = Math.min(tailPoint.y, headPoint.y);
        const boxWidth = Math.max(0.002, Math.abs(headPoint.x - tailPoint.x));
        const boxHeight = Math.max(0.002, Math.abs(headPoint.y - tailPoint.y));
        const arrowPosition = { left: `${left * 100}%`, top: `${top * 100}%`, width: `${boxWidth * 100}%`, height: `${boxHeight * 100}%` };
        const tailX = ((tailPoint.x - left) / boxWidth) * 100;
        const tailY = ((tailPoint.y - top) / boxHeight) * 100;
        const headX = ((headPoint.x - left) / boxWidth) * 100;
        const headY = ((headPoint.y - top) / boxHeight) * 100;
        const markerId = `guide-arrowhead-${annotation.id}`;
        return (
          <svg className="annotation-preview-arrow" key={annotation.id} viewBox="0 0 100 100" preserveAspectRatio="none" overflow="visible" style={arrowPosition}>
            <defs>
              <marker id={markerId} markerWidth="8" markerHeight="8" refX="2.4" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth">
                <path d="M0,0 L8,4 L0,8 Z" fill={color} />
              </marker>
            </defs>
            <line x1={tailX} y1={tailY} x2={headX} y2={headY} stroke={color} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" markerEnd={`url(#${markerId})`} />
          </svg>
        );
      }
      const position = { left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` };
      if (annotation.kind === "text") {
        return <span className="annotation-preview-text" key={annotation.id} style={{ ...position, borderColor: color, color, backgroundColor: `${color}22` }}>{annotation.text?.trim() || "Annotation"}</span>;
      }
      return <span className="annotation-preview-box" key={annotation.id} style={{ ...position, borderColor: color }} />;
    })}
  </>;
}

async function rasterizeReplacement(file: File) {
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    throw new Error("Choose a PNG or JPEG screenshot.");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Choose a screenshot smaller than 10 MB.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > 32_000_000) {
      throw new Error("The screenshot dimensions are not supported.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { alpha: file.type === "image/png" });
    if (!context) throw new Error("This browser could not prepare the screenshot.");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (next) => next ? resolve(next) : reject(new Error("The screenshot could not be encoded.")),
        file.type,
        file.type === "image/jpeg" ? 0.92 : undefined,
      );
    });
    return { blob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function initialAudience(revision: ReturnType<typeof selectedRevision>) {
  return revision
    ? revision.audiences
    : [{ kind: "workspace" as const, label: "Entire workspace" }];
}

function guideDraftSnapshot({
  title,
  summary,
  category,
  tags,
  systemReferences,
  steps,
  audiences,
  privacyReviewed,
}: {
  title: string;
  summary: string;
  category: string;
  tags: string;
  systemReferences: string;
  steps: EditorBlock[];
  audiences: Audience[];
  privacyReviewed: boolean;
}) {
  return JSON.stringify({
    title,
    summary,
    category,
    tags,
    systemReferences,
    steps,
    audiences,
    privacyReviewed,
  });
}

export function GuideEditor({
  guide,
  workspace,
  groups,
  members,
  busy,
  privacyToolsEnabled = true,
  onClose,
  onSave,
  onShare,
  onExport,
  onStartTrial,
  onSaved,
  onMediaChanged,
  onDelete,
  onRegisterNavigationGuard,
  requireReviewBeforePublish = false,
  canShare = true,
  liveUrl = "",
  fileExportsEnabled = false,
  canExport = false,
}: GuideEditorProps) {
  const revision = selectedRevision(guide);
  const [title, setTitle] = useState(revision?.title ?? "");
  const [summary, setSummary] = useState(revision?.summary ?? "");
  const [category, setCategory] = useState(revision?.category ?? "");
  const [tags, setTags] = useState(revision?.tags.join(", ") ?? "");
  const [systemReferences, setSystemReferences] = useState(
    revision?.systemReferences.join(", ") ?? "",
  );
  const [steps, setSteps] = useState<EditorBlock[]>(() => editableSteps(revision));
  const [audiences, setAudiences] = useState<Audience[]>(initialAudience(revision));
  const [privacyReviewed, setPrivacyReviewed] = useState(
    Boolean(revision?.privacyReviewedAt) || !isCapturedGuideSource(revision?.source),
  );
  const [localError, setLocalError] = useState("");
  const [uploadingStepId, setUploadingStepId] = useState("");
  const [dragOverStepId, setDragOverStepId] = useState("");
  const [transition, setTransition] = useState<"draft" | "review">("draft");
  const [flattening, setFlattening] = useState(false);
  const [insertAfterId, setInsertAfterId] = useState<string | "start" | null>(null);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [deletePromptOpen, setDeletePromptOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const ensureDraftRef = useRef<Promise<GuideSaveResult> | null>(null);
  const [draftIds, setDraftIds] = useState<GuideSaveResult | null>(
    guide?.workingRevision
      ? { guideId: guide.id, revisionId: guide.workingRevision.id }
      : null,
  );

  const source = revision?.source ?? "manual";
  const isCaptured = isCapturedGuideSource(source);
  const isDesktopCapture = source === "desktop-capture";
  const liveAudience = guide?.publishedRevision?.audiences ?? [];
  const scopeLabel = !guide?.publishedRevision
    ? "Private"
    : liveAudience.some((item) => item.kind === "workspace")
      ? "Entire workspace"
      : "Restricted";
  const [savedSnapshot, setSavedSnapshot] = useState(() => guideDraftSnapshot({
    title,
    summary,
    category,
    tags,
    systemReferences,
    steps,
    audiences,
    privacyReviewed,
  }));
  const currentSnapshot = useMemo(() => guideDraftSnapshot({
    title,
    summary,
    category,
    tags,
    systemReferences,
    steps,
    audiences,
    privacyReviewed,
  }), [audiences, category, privacyReviewed, steps, summary, systemReferences, tags, title]);
  const isDirty = currentSnapshot !== savedSnapshot;
  const dirtyRef = useRef(isDirty);
  const pendingNavigationRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  useEffect(() => {
    const guard: NavigationGuard = {
      shouldBlock: () => dirtyRef.current,
      requestConfirmation: ({ proceed }) => {
        pendingNavigationRef.current = proceed;
        setLeavePromptOpen(true);
      },
    };
    onRegisterNavigationGuard(guard);
    return () => onRegisterNavigationGuard(null);
  }, [onRegisterNavigationGuard]);

  useEffect(() => {
    if (insertAfterId === null) return;
    const dismissInsertMenu = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".step-insert-menu, .step-insert-button")) return;
      setInsertAfterId(null);
    };
    window.addEventListener("pointerdown", dismissInsertMenu);
    return () => window.removeEventListener("pointerdown", dismissInsertMenu);
  }, [insertAfterId]);

  function updateStep(id: string, patch: Partial<EditorBlock>) {
    setSteps((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function insertStep(afterId: string | "start", kind: EditorBlockKind) {
    setSteps((items) => {
      const index = afterId === "start" ? -1 : items.findIndex((item) => item.id === afterId);
      return [...items.slice(0, index + 1), newStep(kind), ...items.slice(index + 1)];
    });
    setInsertAfterId(null);
  }

  function updateScreenshotState(step: EditorBlock, patch: Partial<EditorBlock>) {
    updateStep(step.id, patch);
    if (isCaptured) setPrivacyReviewed(false);
  }

  async function ensureWorkingDraft() {
    if (guide?.workingRevision) {
      return { guideId: guide.id, revisionId: guide.workingRevision.id };
    }
    if (draftIds) return draftIds;
    if (!ensureDraftRef.current) {
      ensureDraftRef.current = onSave({
        guideId: guide?.id,
        revisionId: guide?.workingRevision?.id,
        title: title.trim() || "Untitled guide",
        summary: summary.trim() || "Draft in progress",
        category: category.trim(),
        tags: tags
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        systemReferences: systemReferences
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        steps: steps.map((step) => ({
          ...step,
          title:
            step.title.trim() ||
            (step.kind === "heading" ? "Section heading" : "Untitled step"),
        })),
        audiences,
        source,
        privacyReviewed,
        transition: "draft",
      }).then((result) => {
        setDraftIds(result);
        return result;
      });
    }
    return ensureDraftRef.current;
  }

  async function handleScreenshotUpload(step: EditorBlock, file: File) {
    setUploadingStepId(step.id);
    setLocalError("");
    try {
      const draft = await ensureWorkingDraft();
      const raster = await rasterizeReplacement(file);
      const result = await replaceDraftScreenshot({
        workspaceId: workspace.id,
        guideId: draft.guideId,
        revisionId: draft.revisionId,
        stepId: step.id,
        bytes: raster.blob,
        width: raster.width,
        height: raster.height,
        redactionState: guide?.screenshotsLockedAt ? "redacted" : "pending",
      });
      const screenshotPatch: Partial<EditorBlock> = {
        screenshotMediaId: result.mediaId,
        screenshotUrl: undefined,
        crop: undefined,
        annotations: undefined,
        redactions: undefined,
      };
      const nextSteps = steps.map((item) =>
        item.id === step.id ? { ...item, ...screenshotPatch } : item,
      );
      updateScreenshotState(step, screenshotPatch);
      await onMediaChanged?.();
      if (!guide) {
        // Creating the working draft and attaching its screenshot are both
        // durable at this point. The route replacement that exposes the new
        // guide ID is an internal continuation of the upload, not an attempt
        // to discard the editor. Keep the navigation guard from opening its
        // leave prompt while this component is being replaced.
        setSavedSnapshot(guideDraftSnapshot({
          title,
          summary,
          category,
          tags,
          systemReferences,
          steps: nextSteps,
          audiences,
          privacyReviewed,
        }));
        dirtyRef.current = false;
        onSaved?.(draft, "draft");
      }
    } catch (error) {
      ensureDraftRef.current = null;
      setLocalError(error instanceof Error ? error.message : "The screenshot could not be uploaded.");
    } finally {
      setUploadingStepId("");
    }
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((items) => {
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function duplicateStep(index: number) {
    setSteps((items) => {
      const copy = {
        ...items[index],
        id: newId("step"),
        ...(items[index].annotations
          ? {
              annotations: items[index].annotations!.map((annotation) => ({
                ...annotation,
                id: newId("annotation"),
              })),
            }
          : {}),
      };
      return [...items.slice(0, index + 1), copy, ...items.slice(index + 1)];
    });
  }

  function validateDraft() {
    if (title.trim().length < 3) {
      setLocalError("Give the guide a clear title.");
      return false;
    }
    if (!summary.trim()) {
      setLocalError("Add a short purpose or outcome.");
      return false;
    }
    if (!steps.length || steps.some((step) => !step.title.trim())) {
      setLocalError("Every step needs a title.");
      return false;
    }
    for (const step of steps) {
      if (!step.crop) continue;
      const { x, y, width, height } = step.crop;
      if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
        setLocalError("Each screenshot crop must stay inside the image boundary.");
        return false;
      }
    }
    for (const step of steps) {
      for (const annotation of step.annotations ?? []) {
        const width = annotation.width ?? 0.08;
        const height = annotation.height ?? 0.08;
        const finite = [annotation.x, annotation.y, width, height].every(Number.isFinite);
        const pointValid = annotation.x >= 0 && annotation.x <= 1 && annotation.y >= 0 && annotation.y <= 1;
        const regionValid = width > 0 && height > 0 && annotation.x + width <= 1 && annotation.y + height <= 1;
        if (!finite || !pointValid || (annotation.kind !== "click" && !regionValid)) {
          setLocalError("Each screenshot annotation must stay inside the image boundary.");
          return false;
        }
        if (annotation.color && !/^#[0-9a-f]{6}$/i.test(annotation.color)) {
          setLocalError("Each screenshot annotation needs a valid six-digit color.");
          return false;
        }
      }
    }
    return true;
  }

  async function flattenIfNeeded() {
    if (guide?.screenshotsLockedAt || !steps.some(needsFlattening)) return steps;
    if (!guide?.workingRevision) {
      throw new Error("Save a private draft before sharing.");
    }
    const workingRevisionId = guide.workingRevision.id;
    setFlattening(true);
    try {
      const finalSteps = await Promise.all(
        steps.map(async (step) => {
          if (!step.screenshotMediaId || !needsFlattening(step)) return step;
          const mediaUrl = await loadAuthorizedMediaUrl(workspace.id, step.screenshotMediaId);
          try {
            const flattened = await flattenScreenshot(mediaUrl, step);
            const uploaded = await replaceDraftScreenshot({
              workspaceId: workspace.id,
              guideId: guide.id,
              revisionId: workingRevisionId,
              stepId: step.id,
              bytes: flattened.blob,
              width: flattened.width,
              height: flattened.height,
              redactionState: "redacted",
            });
            return { ...step, screenshotMediaId: uploaded.mediaId, ...flattened.patch };
          } finally {
            URL.revokeObjectURL(mediaUrl);
          }
        }),
      );
      setSteps(finalSteps);
      await onMediaChanged?.();
      return finalSteps;
    } finally {
      setFlattening(false);
    }
  }

  function payloadFor(transition: GuideEditorPayload["transition"], nextSteps: EditorBlock[]): GuideEditorPayload {
    return {
      guideId: guide?.id,
      revisionId: guide?.workingRevision?.id,
      title: title.trim(),
      summary: summary.trim(),
      category: category.trim(),
      tags: tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      systemReferences: systemReferences
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      steps: nextSteps.map((step) => ({ ...step, title: step.title.trim() })),
      audiences,
      source,
      privacyReviewed,
      transition,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    if (!validateDraft()) return;
    if (transition === "review" && isCaptured && !privacyReviewed) {
      setLocalError("Complete the privacy review before requesting review.");
      return;
    }

    let finalSteps = steps;
    try {
      if (transition === "review") finalSteps = await flattenIfNeeded();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "The screenshots could not be flattened.");
      return;
    }

    const payload = payloadFor(transition, finalSteps);
    try {
      const result = await onSave(payload);
      const nextSavedSnapshot = guideDraftSnapshot({
        title,
        summary,
        category,
        tags,
        systemReferences,
        steps: finalSteps,
        audiences,
        privacyReviewed,
      });
      setSavedSnapshot(nextSavedSnapshot);
      dirtyRef.current = false;
      onSaved?.(result, transition);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "The guide could not be saved.");
    }
  }

  async function shareOrReview(kind: "share" | "review") {
    setLocalError("");
    if (!validateDraft()) throw new Error("Finish the required guide fields first.");
    if (isCaptured && !privacyReviewed) {
      throw new Error("Complete the privacy review before sharing.");
    }
    if (!audiences.length && (kind === "review" || !guide?.publishedRevision)) {
      throw new Error("Choose who can see this guide before publishing or review.");
    }
    const finalSteps = await flattenIfNeeded();
    const payload = payloadFor(kind === "review" ? "review" : "draft", finalSteps);
    const result =
      kind === "share" && onShare ? await onShare(payload) : await onSave(payload);
    setSavedSnapshot(
      guideDraftSnapshot({
        title,
        summary,
        category,
        tags,
        systemReferences,
        steps: finalSteps,
        audiences,
        privacyReviewed,
      }),
    );
    dirtyRef.current = false;
    setShareOpen(false);
    onSaved?.(result, kind === "share" ? "share" : "review");
  }

  function requestClose() {
    onClose();
  }

  function continueLeaving() {
    const proceed = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setLeavePromptOpen(false);
    if (!proceed) {
      onClose();
      return;
    }
    proceed();
  }

  async function deleteGuide() {
    if (!onDelete) return;
    const wasDirty = dirtyRef.current;
    dirtyRef.current = false;
    try {
      await onDelete();
      setDeletePromptOpen(false);
    } catch (error) {
      dirtyRef.current = wasDirty;
      throw error;
    }
  }

  return (
    <main className="guide-editor-page" aria-labelledby="guide-editor-title">
      <form
        className="guide-editor"
        onSubmit={submit}
        onKeyDown={(event) => {
          // Enter inside text fields / the screenshot stage must not submit
          // the whole guide editor. Only the explicit Save / Share
          // buttons should trigger submit.
          if (event.key !== "Enter") return;
          const target = event.target as HTMLElement;
          if (target.tagName === "TEXTAREA") return;
          if (target.closest("button[type='submit']")) return;
          event.preventDefault();
        }}
      >
        <header className="editor-header">
          <div className="editor-header-context">
            <Button className="editor-back" variant="ghost" size="sm" type="button" onClick={requestClose}>
              <ArrowLeft /> Guides
            </Button>
            <span className="editor-header-divider" />
            <span className="editor-scope">{scopeLabel}</span>
            <strong
              id="guide-editor-title"
              className="editor-title-display"
              title={title || "Untitled guide"}
            >{title || "Untitled guide"}</strong>
          </div>
          <div className="editor-header-actions">
            <span className={`editor-save-state${isDirty ? " dirty" : ""}`} role={localError ? "alert" : "status"}>
              {localError || (flattening ? "Preparing screenshots…" : isDirty ? "Unsaved" : "Saved")}
            </span>
            <Button variant={guide ? "outline" : undefined} type="submit" disabled={busy || flattening} onClick={() => setTransition("draft")}>
              <Save /> Save
            </Button>
            <Button
              className="editor-share-trigger"
              variant={guide ? undefined : "outline"}
              type="button"
              disabled={busy || flattening}
              onClick={() => {
                setLocalError("");
                if (!validateDraft()) return;
                if (audiences.length === 1 && audiences[0]?.kind === "user" && isCaptured) {
                  setAudiences([{ kind: "workspace", label: "Entire workspace" }]);
                }
                setShareOpen(true);
              }}
            >
              <Share2 /> Share
              {isCaptured && !privacyReviewed ? (
                <span
                  className="editor-attention-dot"
                  aria-label="Privacy review required"
                />
              ) : null}
            </Button>
          </div>
        </header>

        {isDesktopCapture && !privacyReviewed ? (
          <div className="desktop-capture-privacy-banner" role="status">
            <TriangleAlert />
            <div>
              <strong>Review captured text as private guide content</strong>
              <span>
                Exact non-password text may already be included in step
                instructions. Sharing, review submission, export, and
                publication stay blocked until you complete the privacy review.
              </span>
            </div>
          </div>
        ) : null}

        <div className="editor-layout">
          <main className="editor-canvas">
            <section className="editor-metadata card" aria-label="Guide details">
              <div className="editor-metadata-fields">
                <div className="editor-details-title-row">
                  <label className="field editor-title-field">
                    <span>Guide title</span>
                    <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Give this guide a clear title" autoFocus={!guide} />
                  </label>
                  <span className="editor-block-count"><ListChecks /> {steps.length} {steps.length === 1 ? "block" : "blocks"}</span>
                </div>
                <label className="field field-wide">
                  <span>Purpose and expected outcome</span>
                  <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} placeholder="Explain when to use this guide and what success looks like." />
                </label>
                <div className="form-grid three">
                  <label className="field">
                    <span>Category</span>
                    <input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Access & identity" />
                  </label>
                  <label className="field">
                    <span>Tags</span>
                    <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="onboarding, support" />
                  </label>
                  <label className="field">
                    <span>Systems used</span>
                    <input value={systemReferences} onChange={(event) => setSystemReferences(event.target.value)} placeholder="Okta, Microsoft 365" />
                  </label>
                </div>
              </div>
            </section>

            <div className="editor-steps">
              <div className="editor-insert-slot">
                <button
                  className="step-insert-button"
                  type="button"
                  aria-label="Add the first step"
                  aria-expanded={insertAfterId === "start"}
                  aria-controls="insert-menu-start"
                  onClick={() => setInsertAfterId((current) => current === "start" ? null : "start")}
                >
                  <span><Plus /></span>
                </button>
                {insertAfterId === "start" ? (
                  <div id="insert-menu-start" className="step-insert-menu" role="group" aria-label="Choose a block type">
                    {STEP_KINDS.map(({ value, label, icon: Icon }) => (
                      <button className={`step-insert-option kind-${value}`} type="button" key={value} onClick={() => insertStep("start", value)}><Icon /> <span>{label}</span></button>
                    ))}
                  </div>
                ) : null}
              </div>
              {steps.map((step, index) => (
                <div className="editor-step-slot" key={step.id}>
                <article className={`step-editor step-${step.kind}`}>
                  <aside className="step-index">
                    <GripVertical />
                    <span>{index + 1}</span>
                  </aside>
                  <div className="step-editor-body">
                    <div className="step-toolbar">
                      <SelectMenu className={`toolbar-select type-${step.kind}`} value={step.kind} onChange={(kind) => updateStep(step.id, { kind })} ariaLabel={`Block ${index + 1} type`} options={STEP_KINDS.map((kind) => ({ value: kind.value, label: kind.label }))} />
                      <span className="toolbar-spacer" />
                      <button type="button" className="icon-button tiny" onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label="Move up"><ArrowUp /></button>
                      <button type="button" className="icon-button tiny" onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} aria-label="Move down"><ArrowDown /></button>
                      <button type="button" className="icon-button tiny" onClick={() => duplicateStep(index)} aria-label="Duplicate"><Copy /></button>
                      <button type="button" className="icon-button tiny danger" onClick={() => setSteps((items) => items.filter((item) => item.id !== step.id))} disabled={steps.length === 1} aria-label="Delete"><Trash2 /></button>
                    </div>
                    <StepTitleField
                      value={step.title}
                      linkable={step.kind === "action"}
                      onChange={(title) => updateStep(step.id, { title })}
                      placeholder={step.kind === "heading" ? "Section heading" : "Describe the action"}
                    />
                    {step.kind === "action" ? (
                      <div className="screenshot-editor">
                        {step.screenshotMediaId ? (
                          <ScreenshotEditor
                            workspaceId={workspace.id}
                            step={step}
                            stepLabel={step.title || `Step ${index + 1}`}
                            accentColor={workspace.settings.accentColor}
                            clickTargetColor={workspace.settings.clickTargetColor}
                            locked={Boolean(guide?.screenshotsLockedAt)}
                            privacyToolsEnabled={privacyToolsEnabled}
                            canReplace={Boolean(guide?.workingRevision || draftIds)}
                            busy={uploadingStepId === step.id}
                            onChange={(patch) => updateScreenshotState(step, patch)}
                            onReplaceFile={(file) => void handleScreenshotUpload(step, file)}
                            onRemove={() => updateScreenshotState(step, { screenshotMediaId: undefined, screenshotUrl: undefined, crop: undefined, annotations: undefined, redactions: undefined })}
                          />
                        ) : (
                          <div
                            className={`screenshot-placeholder${dragOverStepId === step.id ? " drag-over" : ""}`}
                            onDragOver={(event) => {
                              if (uploadingStepId) return;
                              event.preventDefault();
                              setDragOverStepId(step.id);
                            }}
                            onDragLeave={() => setDragOverStepId((current) => (current === step.id ? "" : current))}
                            onDrop={(event) => {
                              event.preventDefault();
                              setDragOverStepId((current) => (current === step.id ? "" : current));
                              if (uploadingStepId) return;
                              const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
                              if (file) void handleScreenshotUpload(step, file);
                            }}
                          >
                            <ImagePlus />
                            <span>Capture with the KnowHow extension, drag and drop, or upload a screenshot manually.</span>
                            <label className={`button secondary small${uploadingStepId ? " disabled" : ""}`}>
                              <ImagePlus /> {uploadingStepId === step.id ? "Uploading…" : "Upload screenshot"}
                              <input
                                className="visually-hidden"
                                type="file"
                                accept="image/png,image/jpeg"
                                disabled={Boolean(uploadingStepId)}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  event.target.value = "";
                                  if (file) void handleScreenshotUpload(step, file);
                                }}
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </article>
                <div className="editor-insert-slot">
                  <button
                    className="step-insert-button"
                    type="button"
                    aria-label={`Add a step after step ${index + 1}`}
                    aria-expanded={insertAfterId === step.id}
                    aria-controls={`insert-menu-${step.id}`}
                    onClick={() => setInsertAfterId((current) => current === step.id ? null : step.id)}
                  >
                    <span><Plus /></span>
                  </button>
                  {insertAfterId === step.id ? (
                    <div id={`insert-menu-${step.id}`} className="step-insert-menu" role="group" aria-label={`Choose a block type after step ${index + 1}`}>
                      {STEP_KINDS.map(({ value, label, icon: Icon }) => (
                        <button className={`step-insert-option kind-${value}`} type="button" key={value} onClick={() => insertStep(step.id, value)}><Icon /> <span>{label}</span></button>
                      ))}
                    </div>
                  ) : null}
                </div>
                </div>
              ))}
            </div>

            <button className="add-step-button" type="button" onClick={() => setSteps((items) => [...items, newStep()])}>
              <Plus /> Add action step
            </button>
          </main>

        </div>

        <footer className="editor-footer">
          {guide?.canDelete && onDelete ? (
            <button className="button ghost danger-button editor-delete" type="button" disabled={busy} onClick={() => setDeletePromptOpen(true)}>
              <Trash2 /> Delete guide
            </button>
          ) : null}
          <div className="editor-validation" role={localError ? "alert" : "status"}>
            {localError || (flattening ? <><Save /> Flattening screenshots…</> : isDirty ? <><Save /> Unsaved changes</> : <><Check /> Draft stays private until you share it.</>)}
          </div>
          <button className="button secondary" type="submit" disabled={busy || flattening} onClick={() => setTransition("draft")}>
            <Save /> Save private draft
          </button>
          {guide?.publishedRevision && onExport ? (
            <button className="button secondary" type="button" disabled={busy || flattening} onClick={() => setExportOpen(true)}>
              <Download /> Export
            </button>
          ) : null}
          <button
            className="button primary"
            type="button"
            disabled={busy || flattening}
            onClick={() => {
              setLocalError("");
              if (!validateDraft()) return;
              setShareOpen(true);
            }}
          >
            <Share2 /> Share
          </button>
        </footer>
      </form>
      {leavePromptOpen ? (
        <div className="editor-leave-prompt" role="alertdialog" aria-modal="true" aria-labelledby="editor-leave-title">
          <section>
            <h2 id="editor-leave-title">Leave without saving?</h2>
            <p>Your unsaved guide changes will be discarded.</p>
            <div>
              <button className="button secondary" type="button" onClick={() => {
                pendingNavigationRef.current = null;
                setLeavePromptOpen(false);
              }}>Keep editing</button>
              <button className="button danger-button" type="button" onClick={continueLeaving}>Leave editor</button>
            </div>
          </section>
        </div>
      ) : null}
      {deletePromptOpen && guide ? (
        <GuideDeleteDialog
          busy={busy}
          onCancel={() => setDeletePromptOpen(false)}
          onConfirm={deleteGuide}
        />
      ) : null}
      {shareOpen ? (
        <GuideShareDialog
          open
          title={title.trim() || "Untitled guide"}
          workspaceName={workspace.name}
          liveUrl={liveUrl}
          isLive={Boolean(guide?.publishedRevision)}
          audiences={audiences}
          groups={groups}
          members={members}
          captured={isCaptured}
          privacyReviewed={privacyReviewed}
          canShare={canShare}
          canRequestReview={Boolean(requireReviewBeforePublish)}
          busy={busy || flattening}
          onClose={() => setShareOpen(false)}
          onAudiencesChange={setAudiences}
          onPrivacyReviewedChange={setPrivacyReviewed}
          onShare={() => shareOrReview("share")}
          onRequestReview={() => shareOrReview("review")}
        />
      ) : null}
      {exportOpen && guide?.publishedRevision && onExport ? (
        <GuideExportDialog
          open
          title={title.trim() || guide.title}
          isLive={Boolean(guide.publishedRevision)}
          restricted={Boolean(
            guide.publishedRevision &&
              !guide.publishedRevision.audiences.some((audience) => audience.kind === "workspace"),
          )}
          fileExportsEnabled={fileExportsEnabled}
          canExport={canExport}
          busy={busy}
          onClose={() => setExportOpen(false)}
          onExport={onExport}
          onStartTrial={onStartTrial}
        />
      ) : null}
    </main>
  );
}
