"use client";

import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Download,
  Eye,
  Globe2,
  History,
  Link2,
  LockKeyhole,
  RotateCcw,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { EditorBlock, Guide, GuideRevisionView } from "../../lib/knowhow-types";
import type { GuideRevisionMode } from "../../lib/workspace-routes";
import { AuthorizedMedia } from "./authorized-media";
import { ScreenshotAnnotationPreview } from "./guide-editor";
import { WorkspaceLogo } from "./workspace-logo";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function formatDate(value?: string, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(date);
}

function titleCase(value: string) {
  return value
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={`status-badge status-${status.toLowerCase()}`}
      variant="outline"
    >
      {titleCase(status)}
    </Badge>
  );
}

export type GuideReaderViewProps = {
  guide: Guide;
  revision: GuideRevisionView;
  revisionMode: GuideRevisionMode;
  workspaceId: string;
  workspaceName: string;
  logoKey?: string | null;
  accentColor?: string;
  clickTargetColor?: string;
  liveUrl?: string;
  canExport?: boolean;
  canRestore?: boolean;
  busy?: boolean;
  interactive?: boolean;
  compact?: boolean;
  hideChrome?: boolean;
  maxSteps?: number;
  headingId?: string;
  renderScreenshot?: (step: EditorBlock, index: number) => ReactNode;
  onClose?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onRevisionChange?: (revision: GuideRevisionMode) => void;
  onExport?: (format: "pdf" | "pptx" | "html" | "markdown") => void;
  onRestore?: (revisionId: string) => void;
  onPublishedViewed?: () => void;
  onComplete?: () => void;
  onShare?: () => void;
  onReact?: (reaction: "like" | "dislike" | "clear") => void;
};

export function GuideReaderView({
  guide,
  revision,
  revisionMode,
  workspaceId,
  workspaceName,
  logoKey = null,
  accentColor = "#ff5a12",
  clickTargetColor = "#ff5a12",
  liveUrl = "",
  canExport = false,
  canRestore = false,
  busy = false,
  interactive = true,
  compact = false,
  hideChrome = false,
  maxSteps,
  headingId,
  renderScreenshot,
  onClose,
  onEdit,
  onDelete,
  onRevisionChange,
  onExport,
  onPublishedViewed,
  onComplete,
  onRestore,
  onShare,
  onReact,
}: GuideReaderViewProps) {
  const run = (fn?: () => void) => {
    if (!interactive || !fn) return;
    fn();
  };
  const [pending, setPending] = useState<{
    guideId: string;
    reaction: "like" | "dislike" | null;
    likes: number;
    dislikes: number;
  } | null>(null);
  const viewCount = guide.viewCount ?? 0;
  const showRevisionToggle = Boolean(
    guide.workingRevision && guide.publishedRevision,
  );
  const reaction =
    pending?.guideId === guide.id
      ? pending.reaction
      : (guide.viewerReaction ?? null);
  const likes =
    pending?.guideId === guide.id ? pending.likes : (guide.likeCount ?? 0);
  const dislikes =
    pending?.guideId === guide.id ? pending.dislikes : (guide.dislikeCount ?? 0);

  function chooseReaction(next: "like" | "dislike") {
    if (!interactive) return;
    const payload = reaction === next ? "clear" : next;
    const nextReaction = payload === "clear" ? null : payload;
    const nextLikes =
      likes + (nextReaction === "like" ? 1 : 0) - (reaction === "like" ? 1 : 0);
    const nextDislikes =
      dislikes +
      (nextReaction === "dislike" ? 1 : 0) -
      (reaction === "dislike" ? 1 : 0);
    setPending({
      guideId: guide.id,
      reaction: nextReaction,
      likes: nextLikes,
      dislikes: nextDislikes,
    });
    onReact?.(payload);
  }

  const titleId = headingId ?? (interactive ? "guide-reader-title" : undefined);
  const steps = typeof maxSteps === "number" ? revision.steps.slice(0, maxSteps) : revision.steps;
  const Root = interactive ? "main" : "div";

  return (
    <Root className="guide-reader-page" aria-labelledby={titleId}>
      {hideChrome ? null : (
      <header className="guide-reader-header">
        <div className="guide-reader-header-inner">
          <div className="reader-nav-context">
            <button
              className="button ghost small"
              type="button"
              aria-disabled={!interactive}
              onClick={() => run(onClose)}
            >
              <ArrowLeft /> Guides
            </button>
            <span className="reader-header-divider" />
            <span className="reader-workspace">
              <WorkspaceLogo
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                logoKey={logoKey}
                size="sm"
              />
              <span>
                <strong>{workspaceName}</strong>
                <small>Revision {revision.number}</small>
              </span>
            </span>
          </div>
          <div className="viewer-toolbar">
            {showRevisionToggle ? (
            <div className="revision-toggle">
              {guide.workingRevision ? (
                <button
                  type="button"
                  className={revisionMode === "working" ? "active" : ""}
                  aria-disabled={!interactive}
                  onClick={() => run(() => onRevisionChange?.("working"))}
                >
                  Working {guide.workingRevision.status}
                </button>
              ) : null}
              {guide.publishedRevision ? (
                <button
                  type="button"
                  className={revisionMode === "published" ? "active" : ""}
                  aria-disabled={!interactive}
                  onClick={() =>
                    run(() => {
                      onRevisionChange?.("published");
                      onPublishedViewed?.();
                    })
                  }
                >
                  Live v{guide.publishedRevision.number}
                </button>
              ) : null}
            </div>
            ) : null}
            <div className="viewer-actions">
              {onShare ? (
                <button
                  className="button primary small"
                  type="button"
                  aria-disabled={!interactive}
                  onClick={() => run(onShare)}
                >
                  <Share2 /> Share
                </button>
              ) : guide.publishedRevision ? (
                <button
                  className="button ghost small"
                  type="button"
                  aria-disabled={!interactive}
                  onClick={() =>
                    run(() => {
                      if (liveUrl) void navigator.clipboard.writeText(liveUrl);
                    })
                  }
                >
                  <Link2 /> Copy live link
                </button>
              ) : null}
              {canExport && guide.publishedRevision && interactive ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="button secondary small"
                    type="button"
                  >
                    <Download /> Export
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="export-menu">
                    <DropdownMenuItem onClick={() => onExport?.("pdf")}>
                      PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport?.("pptx")}>
                      PowerPoint
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport?.("html")}>
                      HTML
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExport?.("markdown")}>
                      Markdown
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {guide.canEdit ? (
                <button
                  className="button secondary small"
                  type="button"
                  aria-disabled={!interactive}
                  onClick={() => run(onEdit)}
                >
                  Edit draft
                </button>
              ) : null}
              {guide.canDelete && onDelete ? (
                <button
                  className="button ghost small danger-button"
                  type="button"
                  disabled={busy}
                  aria-disabled={!interactive}
                  onClick={() => run(onDelete)}
                >
                  <Trash2 /> Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      )}
      <div className="guide-viewer">
        <header className="document-header card">
          <div className="document-meta">
            <StatusBadge status={revision.status} />
            {guide.restricted ? (
              <span>
                <LockKeyhole /> Restricted audience
              </span>
            ) : (
              <span>
                <Globe2 /> Entire workspace
              </span>
            )}
          </div>
          <h1 id={titleId}>{revision.title}</h1>
          <p>{revision.summary}</p>
          <div className="document-facts">
            <span>{revision.category || "Uncategorized"}</span>
            <span>{revision.steps.length} blocks</span>
            <span>By {revision.authorName}</span>
            {revision.publishedAt ? (
              <span>Published {formatDate(revision.publishedAt)}</span>
            ) : null}
          </div>
          {guide.publishedRevision ? (
            <div className="guide-engagement">
              <span className="guide-view-count">
                <Eye /> {viewCount} {viewCount === 1 ? "view" : "views"}
              </span>
              <button
                className={reaction === "like" ? "active" : ""}
                type="button"
                aria-pressed={reaction === "like"}
                aria-label="Like this guide"
                disabled={!interactive}
                onClick={() => chooseReaction("like")}
              >
                <ThumbsUp /> {likes}
              </button>
              <button
                className={reaction === "dislike" ? "active" : ""}
                type="button"
                aria-pressed={reaction === "dislike"}
                aria-label="Dislike this guide"
                disabled={!interactive}
                onClick={() => chooseReaction("dislike")}
              >
                <ThumbsDown /> {dislikes}
              </button>
            </div>
          ) : null}
        </header>
        <div className="document-steps">
          {steps.map((step, index) => (
            <section
              className={`document-step document-${step.kind}`}
              key={step.id}
            >
              {step.kind === "action" ? (
                <span className="document-step-number">{index + 1}</span>
              ) : null}
              <div className="document-step-body">
                <h2>{step.title}</h2>
                {step.description ? <p>{step.description}</p> : null}
                {renderScreenshot ? (
                  <figure className="authorized-media">
                    <div className="authorized-media-frame">
                      <div className="authorized-media-stage kh-reader-shot">
                        {renderScreenshot(step, index)}
                        <div className="authorized-media-overlay" aria-hidden="true">
                          <ScreenshotAnnotationPreview
                            step={step}
                            accentColor={accentColor}
                            clickTargetColor={clickTargetColor}
                            showCropOutline={false}
                          />
                        </div>
                      </div>
                    </div>
                  </figure>
                ) : step.screenshotMediaId ? (
                  <AuthorizedMedia
                    workspaceId={workspaceId}
                    mediaId={step.screenshotMediaId}
                    alt={`Redacted screenshot for ${step.title}`}
                    crop={step.crop}
                    overlay={
                      <ScreenshotAnnotationPreview
                        step={step}
                        accentColor={accentColor}
                        clickTargetColor={clickTargetColor}
                        showCropOutline={false}
                      />
                    }
                  />
                ) : null}
              </div>
            </section>
          ))}
        </div>
        {revisionMode === "published" && guide.publishedRevision && onComplete ? (
          <div className="guide-complete-row">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              aria-disabled={!interactive}
              onClick={() => run(onComplete)}
            >
              <CheckCircle2 /> Mark complete
            </button>
          </div>
        ) : null}
        {!compact && guide.revisionHistory?.length ? (
          <section className="revision-history">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Governance trail</p>
                <h2>Revision history</h2>
              </div>
              <History />
            </div>
            {guide.revisionHistory.map((item) => (
              <div className="history-row" key={item.id}>
                <span className="history-number">v{item.number}</span>
                <span>
                  <strong>{titleCase(item.status)}</strong>
                  <small>
                    Created by {item.authorName} ·{" "}
                    {formatDate(item.createdAt, true)}
                  </small>
                </span>
                {item.reviewedAt ? (
                  <span className="history-check">
                    <Check /> Reviewed
                  </span>
                ) : null}
                {item.publishedAt ? (
                  <span className="history-check">
                    <Globe2 /> {formatDate(item.publishedAt)}
                  </span>
                ) : null}
                {canRestore && !guide.workingRevision && interactive ? (
                  <button
                    className="button ghost small"
                    disabled={busy}
                    type="button"
                    onClick={() => onRestore?.(item.id)}
                  >
                    <RotateCcw /> Restore as draft
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </Root>
  );
}
