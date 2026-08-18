"use client";

import { Check, Download, Link2, LoaderCircle, Send, Share2 } from "lucide-react";
import { useState } from "react";
import type {
  Audience,
  WorkspaceGroup,
  WorkspaceMember,
} from "../../lib/knowhow-types";
import { GuideAudiencePicker } from "./guide-audience-picker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type GuideExportFormatChoice = "pdf" | "pptx" | "html" | "markdown";

const FILE_EXPORTS: Array<[GuideExportFormatChoice, string]> = [
  ["pdf", "PDF"],
  ["pptx", "PowerPoint"],
  ["html", "HTML"],
];

const EXPORT_LABELS: Record<GuideExportFormatChoice, string> = {
  pdf: "PDF",
  pptx: "PowerPoint",
  html: "HTML",
  markdown: "Markdown",
};

export function GuideShareDialog({
  open,
  title,
  workspaceName,
  liveUrl,
  isLive,
  audiences,
  groups,
  members,
  captured,
  privacyReviewed,
  canShare,
  canRequestReview,
  busy,
  fileExportsEnabled,
  canExport,
  onClose,
  onAudiencesChange,
  onPrivacyReviewedChange,
  onShare,
  onRequestReview,
  onExport,
  onStartTrial,
}: {
  open: boolean;
  title: string;
  workspaceName: string;
  liveUrl: string;
  isLive: boolean;
  audiences: Audience[];
  groups: WorkspaceGroup[];
  members: WorkspaceMember[];
  captured: boolean;
  privacyReviewed: boolean;
  canShare: boolean;
  canRequestReview: boolean;
  busy: boolean;
  fileExportsEnabled: boolean;
  canExport: boolean;
  onClose: () => void;
  onAudiencesChange: (audiences: Audience[]) => void;
  onPrivacyReviewedChange: (value: boolean) => void;
  onShare: () => Promise<void>;
  onRequestReview?: () => Promise<void>;
  onExport?: (format: GuideExportFormatChoice) => Promise<void>;
  onStartTrial?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<GuideExportFormatChoice | null>(
    null,
  );
  const shareBlocked =
    busy ||
    !audiences.length ||
    (captured && !privacyReviewed) ||
    !canShare;
  const exportBlocked = busy || !isLive || !onExport || Boolean(exporting);

  async function copyLink() {
    if (!liveUrl) return;
    await navigator.clipboard.writeText(liveUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Share failed.");
    }
  }

  async function exportGuide(format: GuideExportFormatChoice) {
    if (!onExport) return;
    setError("");
    setExporting(format);
    try {
      await onExport(format);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="kh-dialog-content kh-dialog-wide sm:max-w-xl">
        <DialogHeader className="kh-dialog-header">
          <div>
            <p className="eyebrow">Share</p>
            <DialogTitle>{title || "Untitled guide"}</DialogTitle>
          </div>
        </DialogHeader>
        <div className="share-dialog-body">
          <p className="share-dialog-lead">
            Share the live link over email or chat. Recipients must be signed
            in and included in this audience.
          </p>
          <GuideAudiencePicker
            workspaceName={workspaceName}
            audiences={audiences}
            groups={groups}
            members={members}
            onChange={onAudiencesChange}
          />
          {captured ? (
            <label className="choice-row emphasized">
              <input
                type="checkbox"
                checked={privacyReviewed}
                onChange={(event) =>
                  onPrivacyReviewedChange(event.target.checked)
                }
              />
              <span>
                <strong>I reviewed every capture</strong>
                <small>Required before this guide can go live</small>
              </span>
            </label>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="modal-footer share-dialog-footer">
            {canRequestReview && onRequestReview ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy || !audiences.length || (captured && !privacyReviewed)}
                onClick={() => void run(onRequestReview)}
              >
                <Send /> Send for review
              </Button>
            ) : (
              <span />
            )}
            <div className="share-dialog-primary">
              <Button
                variant="outline"
                type="button"
                disabled={!isLive || !liveUrl}
                onClick={() => void copyLink()}
              >
                {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy link"}
              </Button>
              <Button
                type="button"
                disabled={shareBlocked}
                onClick={() => void run(onShare)}
              >
                <Share2 /> {isLive ? "Update sharing" : "Share"}
              </Button>
            </div>
          </footer>
          <section className="share-dialog-section" aria-label="Export">
            <h3>Export</h3>
            {fileExportsEnabled && canExport ? (
              <>
                <p className="share-dialog-lead">
                  Download a file copy of the published guide. Live links keep
                  audience checks.
                </p>
                {exporting ? (
                  <p className="share-dialog-lead" role="status">
                    Preparing {EXPORT_LABELS[exporting]}…
                  </p>
                ) : null}
                <div className="share-export-grid">
                  {FILE_EXPORTS.map(([format, label]) => (
                    <Button
                      key={format}
                      variant="outline"
                      type="button"
                      disabled={exportBlocked}
                      onClick={() => void exportGuide(format)}
                    >
                      {exporting === format ? (
                        <LoaderCircle className="spin" />
                      ) : (
                        <Download />
                      )}{" "}
                      {label}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    type="button"
                    disabled={exportBlocked}
                    onClick={() => void exportGuide("markdown")}
                  >
                    {exporting === "markdown" ? (
                      <LoaderCircle className="spin" />
                    ) : (
                      <Download />
                    )}{" "}
                    Markdown
                  </Button>
                </div>
              </>
            ) : fileExportsEnabled ? (
              <p className="share-dialog-lead">
                Export is turned off for this restricted guide.
              </p>
            ) : (
              <div className="share-export-paywall">
                <p className="share-dialog-lead">
                  PDF, PowerPoint, and HTML exports are included on Pro. Copy
                  the live link on Free, or download Markdown.
                </p>
                {onExport ? (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={exportBlocked}
                    onClick={() => void exportGuide("markdown")}
                  >
                    {exporting === "markdown" ? (
                      <LoaderCircle className="spin" />
                    ) : (
                      <Download />
                    )}{" "}
                    Markdown
                  </Button>
                ) : null}
                {onStartTrial ? (
                  <Button type="button" onClick={onStartTrial}>
                    Start Pro trial
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
