"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  GripVertical,
  Heading2,
  ImagePlus,
  ListChecks,
  Plus,
  Save,
  Send,
  ShieldCheck,
  StickyNote,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { replaceDraftScreenshot } from "../../lib/rivet-client";
import type {
  Audience,
  Guide,
  EditorBlock,
  EditorBlockKind,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceSettings,
  WorkspaceSummary,
} from "../../lib/rivet-types";
import { AuthorizedMedia } from "./authorized-media";
import { SelectMenu } from "./select-menu";

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

type GuideEditorProps = {
  guide: Guide | null;
  workspace: WorkspaceSummary & { settings: WorkspaceSettings };
  groups: WorkspaceGroup[];
  members: WorkspaceMember[];
  busy: boolean;
  onClose: () => void;
  onSave: (payload: GuideEditorPayload) => Promise<void>;
  onMediaChanged?: () => Promise<unknown>;
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

const ANNOTATION_KINDS = ["click", "arrow", "box", "text"] as const;

function titleCaseAnnotation(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

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
  const source = revision?.steps.length ? revision.steps : [newStep()];
  return source.map((step) => {
    if (!step.crop) return step;
    const isNormalized = Math.max(
      step.crop.x,
      step.crop.y,
      step.crop.width,
      step.crop.height,
    ) <= 1;
    if (!isNormalized) return step;
    return {
      ...step,
      crop: {
        x: step.crop.x * 100,
        y: step.crop.y * 100,
        width: step.crop.width * 100,
        height: step.crop.height * 100,
      },
    };
  });
}

function normalizedCoordinate(value: number | undefined, fallback: number) {
  const numeric = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(1, Math.max(0, numeric > 1 ? numeric / 100 : numeric));
}

export function ScreenshotAnnotationPreview({
  step,
  accentColor,
  clickTargetColor,
}: {
  step: EditorBlock;
  accentColor: string;
  clickTargetColor: string;
}) {
  const cropScale = step.crop && Math.max(
    step.crop.x,
    step.crop.y,
    step.crop.width,
    step.crop.height,
  ) <= 1 ? 100 : 1;
  return <>
    {step.crop ? <span className="annotation-preview-crop" style={{ left: `${Math.max(0, step.crop.x * cropScale)}%`, top: `${Math.max(0, step.crop.y * cropScale)}%`, width: `${Math.max(0, step.crop.width * cropScale)}%`, height: `${Math.max(0, step.crop.height * cropScale)}%` }} /> : null}
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
      const position = { left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` };
      if (annotation.kind === "arrow") {
        return <svg className="annotation-preview-arrow" key={annotation.id} viewBox="0 0 100 100" preserveAspectRatio="none" style={position}><line x1="4" y1="96" x2="88" y2="12" stroke={color} strokeWidth="7" vectorEffect="non-scaling-stroke" /><polyline points="62,12 88,12 88,38" fill="none" stroke={color} strokeWidth="7" vectorEffect="non-scaling-stroke" /></svg>;
      }
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

export function GuideEditor({
  guide,
  workspace,
  groups,
  members,
  busy,
  onClose,
  onSave,
  onMediaChanged,
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
  const [transition, setTransition] = useState<"draft" | "review">("draft");

  const source = revision?.source ?? "manual";
  const isCaptured = source === "browser-capture";
  const isWorkspaceAudience = audiences.some((item) => item.kind === "workspace");

  const restrictedLabels = useMemo(
    () =>
      audiences
        .filter((item) => item.kind !== "workspace")
        .map((item) => item.label)
        .filter(Boolean),
    [audiences],
  );

  function updateStep(id: string, patch: Partial<EditorBlock>) {
    setSteps((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function addAnnotation(step: EditorBlock, kind: typeof ANNOTATION_KINDS[number]) {
    const isClick = kind === "click";
    updateStep(step.id, {
      annotations: [
        ...(step.annotations ?? []),
        {
          id: newId("annotation"),
          kind,
          x: isClick ? 0.5 : 0.1,
          y: isClick ? 0.5 : 0.1,
          width: isClick ? 0.035 : 0.25,
          height: isClick ? 0.035 : 0.15,
          ...(kind === "text" ? { text: "Annotation" } : {}),
          color: isClick
            ? workspace.settings.clickTargetColor
            : workspace.settings.accentColor,
        },
      ],
    });
    if (isCaptured) setPrivacyReviewed(false);
  }

  function updateAnnotation(
    step: EditorBlock,
    annotationId: string,
    patch: Partial<NonNullable<EditorBlock["annotations"]>[number]>,
  ) {
    updateStep(step.id, {
      annotations: (step.annotations ?? []).map((annotation) =>
        annotation.id === annotationId ? { ...annotation, ...patch } : annotation,
      ),
    });
    if (isCaptured) setPrivacyReviewed(false);
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
      const x = step.crop.x / 100;
      const y = step.crop.y / 100;
      const width = step.crop.width / 100;
      const height = step.crop.height / 100;
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

    await onSave({
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
      steps: steps.map((step) => step.crop ? {
        ...step,
        crop: {
          x: step.crop.x / 100,
          y: step.crop.y / 100,
          width: step.crop.width / 100,
          height: step.crop.height / 100,
        },
      } : step),
      audiences,
      source,
      privacyReviewed,
      transition,
    });
  }

  return (
    <div className="editor-overlay" role="dialog" aria-modal="true" aria-labelledby="guide-editor-title">
      <form className="guide-editor" onSubmit={submit}>
        <header className="editor-header">
          <div>
            <div className="eyebrow-row">
              <span className="eyebrow">{guide ? "Guide editor" : "New guide"}</span>
              {guide?.publishedRevision && !guide.workingRevision ? (
                <span className="editor-note">Saving creates a new draft; v{guide.publishedRevision.number} stays live</span>
              ) : null}
            </div>
            <input
              id="guide-editor-title"
              className="editor-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Give this guide a clear title"
              autoFocus
            />
          </div>
          <button className="icon-button" type="button" aria-label="Close editor" onClick={onClose}>
            <X />
          </button>
        </header>

        <div className="editor-layout">
          <main className="editor-canvas">
            <section className="editor-metadata card">
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
            </section>

            <div className="steps-heading">
              <div>
                <p className="eyebrow">Document</p>
                <h2>{steps.length} {steps.length === 1 ? "block" : "blocks"}</h2>
              </div>
              <div className="add-block-menu">
                {STEP_KINDS.map(({ value, label, icon: Icon }) => (
                  <button className="button subtle small" type="button" key={value} onClick={() => setSteps((items) => [...items, newStep(value)])}>
                    <Icon /> {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="editor-steps">
              {steps.map((step, index) => (
                <article className={`step-editor step-${step.kind}`} key={step.id}>
                  <aside className="step-index">
                    <GripVertical />
                    <span>{index + 1}</span>
                  </aside>
                  <div className="step-editor-body">
                    <div className="step-toolbar">
                      <SelectMenu className="toolbar-select" value={step.kind} onChange={(kind) => updateStep(step.id, { kind })} ariaLabel={`Block ${index + 1} type`} options={STEP_KINDS.map((kind) => ({ value: kind.value, label: kind.label }))} />
                      <span className="toolbar-spacer" />
                      <button type="button" className="icon-button tiny" onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label="Move up"><ArrowUp /></button>
                      <button type="button" className="icon-button tiny" onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} aria-label="Move down"><ArrowDown /></button>
                      <button type="button" className="icon-button tiny" onClick={() => duplicateStep(index)} aria-label="Duplicate"><Copy /></button>
                      <button type="button" className="icon-button tiny danger" onClick={() => setSteps((items) => items.filter((item) => item.id !== step.id))} disabled={steps.length === 1} aria-label="Delete"><Trash2 /></button>
                    </div>
                    <input className="step-title-input" value={step.title} onChange={(event) => updateStep(step.id, { title: event.target.value })} placeholder={step.kind === "heading" ? "Section heading" : "Describe the action"} />
                    {step.kind !== "heading" ? (
                      <textarea className="step-description-input" value={step.description} onChange={(event) => updateStep(step.id, { description: event.target.value })} placeholder={step.kind === "warning" ? "Explain the risk and how to proceed safely." : "Add the details, checks, and expected result."} rows={3} />
                    ) : null}
                    {step.kind === "action" ? (
                      <div className="screenshot-editor">
                        {step.screenshotMediaId || step.screenshotUrl ? (
                          <div className="screenshot-preview-stack">
                            {step.screenshotMediaId ? <AuthorizedMedia compact workspaceId={workspace.id} mediaId={step.screenshotMediaId} alt={`Redacted screenshot for ${step.title || `step ${index + 1}`}`} overlay={<ScreenshotAnnotationPreview step={step} accentColor={workspace.settings.accentColor} clickTargetColor={workspace.settings.clickTargetColor} />} /> : null}
                            <div className="screenshot-actions">
                              <label className={`button secondary small${!guide?.workingRevision || uploadingStepId ? " disabled" : ""}`}>
                                <ImagePlus /> {uploadingStepId === step.id ? "Replacing…" : "Replace redacted image"}
                                <input
                                  className="visually-hidden"
                                  type="file"
                                  accept="image/png,image/jpeg"
                                  disabled={!guide?.workingRevision || Boolean(uploadingStepId)}
                                  onChange={async (event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (!file || !guide?.workingRevision) return;
                                    if (!window.confirm("Confirm this replacement has been reviewed and redacted locally. Rivet will rasterize it before upload and require privacy review again.")) return;
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
                                      });
                                      updateStep(step.id, { screenshotMediaId: result.mediaId, screenshotUrl: undefined, crop: undefined });
                                      if (isCaptured) setPrivacyReviewed(false);
                                      await onMediaChanged?.();
                                    } catch (error) {
                                      setLocalError(error instanceof Error ? error.message : "The screenshot could not be replaced.");
                                    } finally {
                                      setUploadingStepId("");
                                    }
                                  }}
                                />
                              </label>
                              <button type="button" className="text-button" onClick={() => { updateStep(step.id, { screenshotMediaId: undefined, screenshotUrl: undefined, crop: undefined }); if (isCaptured) setPrivacyReviewed(false); }}>Remove</button>
                            </div>
                            {!guide?.workingRevision ? <small>Save a private draft before replacing its screenshot.</small> : null}
                          </div>
                        ) : (
                          <div className="screenshot-placeholder">
                            <ImagePlus />
                            <span>Captured screenshots appear here after local redaction.</span>
                          </div>
                        )}
                        {step.screenshotMediaId ? (
                          <div className="crop-grid" aria-label="Screenshot crop">
                            {(["x", "y", "width", "height"] as const).map((key) => (
                              <label className="field compact" key={key}>
                                <span>{key.toUpperCase()} %</span>
                                <input type="number" min={key === "width" || key === "height" ? 1 : 0} max="100" value={step.crop?.[key] ?? (key === "width" || key === "height" ? 100 : 0)} onChange={(event) => { updateStep(step.id, { crop: { x: step.crop?.x ?? 0, y: step.crop?.y ?? 0, width: step.crop?.width ?? 100, height: step.crop?.height ?? 100, [key]: Number(event.target.value) } }); if (isCaptured) setPrivacyReviewed(false); }} />
                              </label>
                            ))}
                          </div>
                        ) : null}
                        {step.screenshotMediaId ? (
                          <div className="annotation-editor">
                            <div className="annotation-heading">
                              <div><strong>Visual annotations</strong><small>Coordinates are percentages in the editor and saved as normalized values.</small></div>
                              <div className="annotation-add-actions">
                                {ANNOTATION_KINDS.map((kind) => <button className="button subtle small" type="button" key={kind} onClick={() => addAnnotation(step, kind)}><Plus /> {kind === "click" ? "Click target" : kind}</button>)}
                              </div>
                            </div>
                            {(step.annotations ?? []).length ? <div className="annotation-list">{(step.annotations ?? []).map((annotation, annotationIndex) => {
                              const fallbackColor = annotation.kind === "click" ? workspace.settings.clickTargetColor : workspace.settings.accentColor;
                              const color = /^#[0-9a-f]{6}$/i.test(annotation.color ?? "") ? annotation.color! : fallbackColor;
                              return <div className="annotation-row" key={annotation.id}>
                                <div className="annotation-row-heading"><div className="field compact"><span>Type</span><SelectMenu className="form-select compact-select" value={annotation.kind} onChange={(kind) => updateAnnotation(step, annotation.id, { kind, color: kind === "click" ? workspace.settings.clickTargetColor : color })} ariaLabel={`Annotation ${annotationIndex + 1} type`} options={ANNOTATION_KINDS.map((kind) => ({ value: kind, label: kind === "click" ? "Click target" : titleCaseAnnotation(kind) }))} /></div><label className="field compact annotation-color"><span>Color</span><input type="color" value={color} onChange={(event) => updateAnnotation(step, annotation.id, { color: event.target.value })} /></label><button className="icon-button tiny danger" type="button" aria-label={`Remove annotation ${annotationIndex + 1}`} onClick={() => { updateStep(step.id, { annotations: (step.annotations ?? []).filter((item) => item.id !== annotation.id) }); if (isCaptured) setPrivacyReviewed(false); }}><Trash2 /></button></div>
                                <div className="annotation-coordinates">{(["x", "y", "width", "height"] as const).map((key) => <label className="field compact" key={key}><span>{annotation.kind === "click" && key === "width" ? "Radius" : key.toUpperCase()} %</span><input type="number" min={key === "x" || key === "y" ? 0 : 0.1} max={annotation.kind === "click" && key === "width" ? 25 : 100} step="0.1" value={Math.round(((annotation[key] ?? (key === "x" || key === "y" ? 0 : 0.08)) * 100) * 10) / 10} onChange={(event) => updateAnnotation(step, annotation.id, { [key]: Number(event.target.value) / 100 })} /></label>)}</div>
                                {annotation.kind === "text" ? <label className="field compact"><span>Annotation text</span><input maxLength={500} value={annotation.text ?? ""} onChange={(event) => updateAnnotation(step, annotation.id, { text: event.target.value })} /></label> : null}
                              </div>;
                            })}</div> : <p className="annotation-empty">Add a click target, arrow, box, or text label to this screenshot.</p>}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>

            <button className="add-step-button" type="button" onClick={() => setSteps((items) => [...items, newStep()])}>
              <Plus /> Add action step
            </button>
          </main>

          <aside className="editor-sidebar">
            <section className="card sidebar-card">
              <p className="eyebrow">Audience</p>
              <h3>Who receives the published version?</h3>
              <label className="choice-row emphasized">
                <input type="checkbox" checked={isWorkspaceAudience} onChange={(event) => setWorkspaceAudience(event.target.checked)} />
                <span><strong>Entire workspace</strong><small>All active members of {workspace.name}</small></span>
              </label>
              {!isWorkspaceAudience ? (
                <>
                  <div className="choice-section">
                    <span className="field-label">Groups</span>
                    {groups.map((group) => (
                      <label className="choice-row" key={group.id}>
                        <input type="checkbox" checked={audiences.some((item) => item.kind === "group" && item.subjectId === group.id)} onChange={() => toggleAudience("group", group.id, group.name)} />
                        <span><strong>{group.name}</strong><small>{group.sensitive ? "Sensitive group" : `${group.memberCount} members`}</small></span>
                      </label>
                    ))}
                  </div>
                  <details className="audience-people">
                    <summary>Named people</summary>
                    {members.filter((member) => member.status === "active").map((member) => (
                      <label className="choice-row" key={member.id}>
                        <input type="checkbox" checked={audiences.some((item) => item.kind === "user" && item.subjectId === member.userId)} onChange={() => toggleAudience("user", member.userId, member.name || member.email)} />
                        <span><strong>{member.name || member.email}</strong><small>{member.email}</small></span>
                      </label>
                    ))}
                  </details>
                </>
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
                <span className="brand-preview-logo">{workspace.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{workspace.name}</strong><small>Click targets use workspace styling</small></span>
              </div>
            </section>
          </aside>
        </div>

        <footer className="editor-footer">
          <div className="editor-validation" role={localError ? "alert" : "status"}>
            {localError || <><Check /> Changes remain private until published.</>}
          </div>
          <button className="button secondary" type="submit" disabled={busy} onClick={() => setTransition("draft")}>
            <Save /> Save private draft
          </button>
          <button className="button primary" type="submit" disabled={busy || (isCaptured && !privacyReviewed)} onClick={() => setTransition("review")}>
            <Send /> Request review
          </button>
        </footer>
      </form>
    </div>
  );
}
