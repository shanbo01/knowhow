"use client";

import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  GripVertical,
  Heading2,
  ImagePlus,
  ListChecks,
  Plus,
  Search,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadAuthorizedMediaUrl, replaceDraftScreenshot } from "../../lib/knowhow-client";
import type { NavigationGuard } from "../../lib/navigation-guard";
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
import { ScreenshotEditor } from "./screenshot-editor";
import { SelectMenu } from "./select-menu";
import { GuideDeleteDialog } from "./guide-delete-dialog";
import { WorkspaceLogo } from "./workspace-logo";
import { Button } from "@/components/ui/button";

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
  source: "manual" | "browser-capture";
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
  onClose: () => void;
  onSave: (payload: GuideEditorPayload) => Promise<GuideSaveResult>;
  onSaved?: (result: GuideSaveResult, transition: GuideEditorPayload["transition"]) => void;
  onMediaChanged?: () => Promise<unknown>;
  onDelete?: () => Promise<void>;
  onRegisterNavigationGuard: (guard: NavigationGuard | null) => void;
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
    title: kind === "heading" ? "Section heading" : "New step",
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
  return revision?.audiences.length
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
  onClose,
  onSave,
  onSaved,
  onMediaChanged,
  onDelete,
  onRegisterNavigationGuard,
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
    Boolean(revision?.privacyReviewedAt) || revision?.source !== "browser-capture",
  );
  const [localError, setLocalError] = useState("");
  const [uploadingStepId, setUploadingStepId] = useState("");
  const [dragOverStepId, setDragOverStepId] = useState("");
  const [transition, setTransition] = useState<"draft" | "review">("draft");
  const [flattening, setFlattening] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [insertAfterId, setInsertAfterId] = useState<string | "start" | null>(null);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [deletePromptOpen, setDeletePromptOpen] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");

  const source = revision?.source ?? "manual";
  const isCaptured = source === "browser-capture";
  const isWorkspaceAudience = audiences.some((item) => item.kind === "workspace");
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

  const restrictedLabels = useMemo(
    () =>
      audiences
        .filter((item) => item.kind !== "workspace")
        .map((item) => item.label)
        .filter(Boolean),
    [audiences],
  );
  const filteredGroups = useMemo(() => {
    const query = groupSearch.trim().toLocaleLowerCase();
    if (!query) return groups;
    return groups.filter((group) => `${group.name} ${group.description ?? ""}`.toLocaleLowerCase().includes(query));
  }, [groupSearch, groups]);
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLocaleLowerCase();
    const activeMembers = members.filter((member) => member.status === "active");
    if (!query) return activeMembers;
    return activeMembers.filter((member) => `${member.name ?? ""} ${member.email}`.toLocaleLowerCase().includes(query));
  }, [memberSearch, members]);

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

  async function handleScreenshotUpload(step: EditorBlock, file: File) {
    if (!guide?.workingRevision) return;
    setUploadingStepId(step.id);
    setLocalError("");
    try {
      const raster = await rasterizeReplacement(file);
      const result = await replaceDraftScreenshot({
        workspaceId: workspace.id,
        guideId: guide.id,
        revisionId: guide.workingRevision.id,
        stepId: step.id,
        bytes: raster.blob,
        width: raster.width,
        height: raster.height,
        redactionState: guide.screenshotsLockedAt ? "redacted" : "pending",
      });
      updateScreenshotState(step, {
        screenshotMediaId: result.mediaId,
        screenshotUrl: undefined,
        crop: undefined,
        annotations: undefined,
        redactions: undefined,
      });
      await onMediaChanged?.();
    } catch (error) {
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

  function setWorkspaceAudience(enabled: boolean) {
    if (enabled) {
      setAudiences([{ kind: "workspace", label: "Entire workspace" }]);
      return;
    }
    setAudiences([]);
  }

  function toggleAudience(kind: "group" | "user", subjectId: string, label: string) {
    setAudiences((items) => {
      const withoutWorkspace = items.filter((item) => item.kind !== "workspace");
      const exists = withoutWorkspace.some(
        (item) => item.kind === kind && item.subjectId === subjectId,
      );
      return exists
        ? withoutWorkspace.filter(
            (item) => !(item.kind === kind && item.subjectId === subjectId),
          )
        : [...withoutWorkspace, { kind, subjectId, label }];
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    if (title.trim().length < 3) {
      setLocalError("Give the guide a clear title.");
      return;
    }
    if (!summary.trim()) {
      setLocalError("Add a short purpose or outcome.");
      return;
    }
    if (!steps.length || steps.some((step) => !step.title.trim())) {
      setLocalError("Every step needs a title.");
      return;
    }
    for (const step of steps) {
      if (!step.crop) continue;
      const { x, y, width, height } = step.crop;
      if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
        setLocalError("Each screenshot crop must stay inside the image boundary.");
        return;
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
          return;
        }
        if (annotation.color && !/^#[0-9a-f]{6}$/i.test(annotation.color)) {
          setLocalError("Each screenshot annotation needs a valid six-digit color.");
          return;
        }
      }
    }
    if (!audiences.length) {
      setLocalError("Select at least one audience before saving.");
      return;
    }
    if (transition === "review" && isCaptured && !privacyReviewed) {
      setLocalError("Complete the privacy review before requesting review.");
      return;
    }

    let finalSteps = steps;
    if (transition === "review" && !guide?.screenshotsLockedAt && steps.some(needsFlattening)) {
      if (!guide?.workingRevision) {
        setLocalError("Save a private draft before requesting review.");
        return;
      }
      const workingRevisionId = guide.workingRevision.id;
      setFlattening(true);
      try {
        finalSteps = await Promise.all(
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
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : "The screenshots could not be flattened for review.");
        return;
      } finally {
        setFlattening(false);
      }
    }

    const payload: GuideEditorPayload = {
      guideId: guide?.id,
      revisionId: guide?.workingRevision?.id,
      title: title.trim(),
      summary: summary.trim(),
      category: category.trim(),
      tags: tags.split(",").map((item) => item.trim()).filter(Boolean),
      systemReferences: systemReferences
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      steps: finalSteps,
      audiences,
      source,
      privacyReviewed,
      transition,
    };
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
      // Navigation can happen synchronously after the save callback. Update
      // the ref now so a route replacement is never mistaken for a discard.
      dirtyRef.current = false;
      onSaved?.(result, transition);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "The guide could not be saved.");
    }
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
          // the whole guide editor. Only the explicit Save / Request review
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
            <span className="editor-scope">Private</span>
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
            <Button variant="outline" type="submit" disabled={busy || flattening} onClick={() => setTransition("draft")}>
              <Save /> Save
            </Button>
            <Button type="submit" disabled={busy || flattening || (isCaptured && !privacyReviewed)} onClick={() => setTransition("review")}>
              <Send /> Request review
            </Button>
            <Button className={`editor-inspector-trigger${inspectorOpen ? " active" : ""}`} variant="ghost" type="button" onClick={() => setInspectorOpen((open) => !open)} aria-expanded={inspectorOpen} aria-controls="guide-editor-inspector">
              <SlidersHorizontal /> Settings
              {isCaptured && !privacyReviewed ? <span className="editor-attention-dot" aria-label="Privacy review required" /> : null}
            </Button>
          </div>
        </header>

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
                    <input className="step-title-input" value={step.title} onChange={(event) => updateStep(step.id, { title: event.target.value })} placeholder={step.kind === "heading" ? "Section heading" : "Describe the action"} />
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
                            canReplace={Boolean(guide?.workingRevision)}
                            busy={uploadingStepId === step.id}
                            onChange={(patch) => updateScreenshotState(step, patch)}
                            onReplaceFile={(file) => void handleScreenshotUpload(step, file)}
                            onRemove={() => updateScreenshotState(step, { screenshotMediaId: undefined, screenshotUrl: undefined, crop: undefined, annotations: undefined, redactions: undefined })}
                          />
                        ) : (
                          <div
                            className={`screenshot-placeholder${dragOverStepId === step.id ? " drag-over" : ""}`}
                            onDragOver={(event) => {
                              if (!guide?.workingRevision || uploadingStepId) return;
                              event.preventDefault();
                              setDragOverStepId(step.id);
                            }}
                            onDragLeave={() => setDragOverStepId((current) => (current === step.id ? "" : current))}
                            onDrop={(event) => {
                              event.preventDefault();
                              setDragOverStepId((current) => (current === step.id ? "" : current));
                              if (!guide?.workingRevision || uploadingStepId) return;
                              const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
                              if (file) void handleScreenshotUpload(step, file);
                            }}
                          >
                            <ImagePlus />
                            <span>Capture with the KnowHow extension, drag and drop, or upload a screenshot manually.</span>
                            <label className={`button secondary small${!guide?.workingRevision || uploadingStepId ? " disabled" : ""}`}>
                              <ImagePlus /> {uploadingStepId === step.id ? "Uploading…" : "Upload screenshot"}
                              <input
                                className="visually-hidden"
                                type="file"
                                accept="image/png,image/jpeg"
                                disabled={!guide?.workingRevision || Boolean(uploadingStepId)}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  event.target.value = "";
                                  if (file) void handleScreenshotUpload(step, file);
                                }}
                              />
                            </label>
                            {!guide?.workingRevision ? <small>Save a private draft before uploading a screenshot.</small> : null}
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

          {inspectorOpen ? <button className="editor-inspector-backdrop" type="button" aria-label="Close guide settings" onClick={() => setInspectorOpen(false)} /> : null}
          <aside id="guide-editor-inspector" className={`editor-sidebar${inspectorOpen ? " open" : ""}`} aria-label="Guide settings">
            <div className="editor-sidebar-heading">
              <div><span className="eyebrow">Guide settings</span><strong>Access and privacy</strong></div>
              <button className="icon-button" type="button" aria-label="Close guide settings" onClick={() => setInspectorOpen(false)}><X /></button>
            </div>
            <section className="card sidebar-card">
              <p className="eyebrow">Audience</p>
              <h3>Who receives the published version?</h3>
              <label className="choice-row emphasized">
                <input type="checkbox" checked={isWorkspaceAudience} onChange={(event) => setWorkspaceAudience(event.target.checked)} />
                <span><strong>Entire workspace</strong><small>All active members of {workspace.name}</small></span>
              </label>
              {!isWorkspaceAudience ? (
                <div className="audience-picker-scroll">
                  <div className="choice-section">
                    <span className="field-label">Groups</span>
                    <label className="audience-search">
                      <Search />
                      <input value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="Search groups" aria-label="Search groups" />
                    </label>
                    <div className="audience-option-list">
                      {filteredGroups.map((group) => (
                        <label className="choice-row" key={group.id}>
                          <input type="checkbox" checked={audiences.some((item) => item.kind === "group" && item.subjectId === group.id)} onChange={() => toggleAudience("group", group.id, group.name)} />
                          <span><strong>{group.name}</strong><small>{group.sensitive ? "Sensitive group" : `${group.memberCount} members`}</small></span>
                        </label>
                      ))}
                      {!filteredGroups.length ? <p className="audience-empty">No matching groups</p> : null}
                    </div>
                  </div>
                  <details className="audience-people" open>
                    <summary>Named people</summary>
                    <label className="audience-search">
                      <Search />
                      <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Search people" aria-label="Search people" />
                    </label>
                    <div className="audience-option-list">
                      {filteredMembers.map((member) => (
                        <label className="choice-row" key={member.id}>
                          <input type="checkbox" checked={audiences.some((item) => item.kind === "user" && item.subjectId === member.userId)} onChange={() => toggleAudience("user", member.userId, member.name || member.email)} />
                          <span><strong>{member.name || member.email}</strong><small>{member.email}</small></span>
                        </label>
                      ))}
                      {!filteredMembers.length ? <p className="audience-empty">No matching people</p> : null}
                    </div>
                  </details>
                </div>
              ) : null}
              {!audiences.length ? <p className="inline-warning"><TriangleAlert /> No audience selected</p> : null}
              {restrictedLabels.length ? <p className="privacy-caption"><ShieldCheck /> Restricted to {restrictedLabels.join(", ")}</p> : null}
            </section>

            {isCaptured ? (
              <section className="card sidebar-card privacy-review-card">
                <p className="eyebrow">Required gate</p>
                <h3>Privacy review</h3>
                <p>Confirm every screenshot is redacted and contains only information this audience may see.</p>
                <label className="choice-row emphasized">
                  <input type="checkbox" checked={privacyReviewed} onChange={(event) => setPrivacyReviewed(event.target.checked)} />
                  <span><strong>I reviewed every capture</strong><small>Required before review or publication</small></span>
                </label>
              </section>
            ) : null}

            <section className="card sidebar-card">
              <p className="eyebrow">Brand preview</p>
              <div className="brand-preview" style={{ "--preview-accent": "var(--accent)" } as React.CSSProperties}>
                <WorkspaceLogo workspaceId={workspace.id} workspaceName={workspace.name} logoKey={workspace.settings.logoUrl} size="md" />
                <span><strong>{workspace.name}</strong><small>Click targets use workspace styling</small></span>
              </div>
            </section>
            {guide?.canDelete && onDelete ? (
              <button className="button ghost danger-button editor-delete" type="button" disabled={busy} onClick={() => setDeletePromptOpen(true)}>
                <Trash2 /> Delete guide
              </button>
            ) : null}
          </aside>
        </div>

        <footer className="editor-footer">
          {guide?.canDelete && onDelete ? (
            <button className="button ghost danger-button editor-delete" type="button" disabled={busy} onClick={() => setDeletePromptOpen(true)}>
              <Trash2 /> Delete guide
            </button>
          ) : null}
          <div className="editor-validation" role={localError ? "alert" : "status"}>
            {localError || (flattening ? <><Save /> Flattening screenshots for review…</> : isDirty ? <><Save /> Unsaved changes</> : <><Check /> Changes remain private until published.</>)}
          </div>
          <button className="button secondary" type="submit" disabled={busy || flattening} onClick={() => setTransition("draft")}>
            <Save /> Save private draft
          </button>
          <button className="button primary" type="submit" disabled={busy || flattening || (isCaptured && !privacyReviewed)} onClick={() => setTransition("review")}>
            <Send /> Request review
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
          title={title.trim() || guide.title}
          busy={busy}
          onCancel={() => setDeletePromptOpen(false)}
          onConfirm={deleteGuide}
        />
      ) : null}
    </main>
  );
}
