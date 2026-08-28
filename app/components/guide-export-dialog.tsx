"use client";

import { Download, FileDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProBadge, ProUpsell } from "./pro-badge";
import { PolicyNote } from "./workspace-patterns";

export type GuideExportFormatChoice = "pdf" | "pptx" | "html" | "markdown";

const EXPORTS: Array<{
  format: GuideExportFormatChoice;
  label: string;
  requiresFileExportEntitlement: boolean;
}> = [
  { format: "pdf", label: "PDF", requiresFileExportEntitlement: true },
  { format: "pptx", label: "PowerPoint", requiresFileExportEntitlement: true },
  { format: "html", label: "HTML", requiresFileExportEntitlement: true },
  { format: "markdown", label: "Markdown", requiresFileExportEntitlement: false },
];

export function GuideExportDialog({
  open,
  title,
  restricted,
  fileExportsEnabled,
  canExport,
  busy,
  onClose,
  onExport,
  onStartTrial,
}: {
  open: boolean;
  title: string;
  restricted: boolean;
  fileExportsEnabled: boolean;
  canExport: boolean;
  busy: boolean;
  onClose: () => void;
  onExport: (format: GuideExportFormatChoice) => Promise<void>;
  onStartTrial?: () => void;
}) {
  const [exporting, setExporting] = useState<GuideExportFormatChoice | null>(null);
  const [error, setError] = useState("");

  const blockedReason = restricted && !canExport
      ? "Workspace policy does not allow exports of audience-restricted guides."
      : !canExport
        ? "Export is unavailable for your access, plan, workspace policy, or this guide state."
        : "";

  async function exportGuide(format: GuideExportFormatChoice) {
    if (blockedReason) return;
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
      <DialogContent className="kh-dialog-content sm:max-w-lg">
        <DialogHeader className="kh-dialog-header">
          <div>
            <p className="eyebrow">Export</p>
            <DialogTitle>{title || "Untitled guide"}</DialogTitle>
          </div>
        </DialogHeader>
        <div className="modal-form guide-export-dialog">
          <PolicyNote icon={FileDown} className="export-policy-note">
            Exports are static copies. Live links keep audience checks.
          </PolicyNote>
          {blockedReason ? <p className="export-disabled-reason">{blockedReason}</p> : null}
          <div className="share-export-grid">
            {EXPORTS.map(({ format, label, requiresFileExportEntitlement }) => {
              const planLocked = requiresFileExportEntitlement && !fileExportsEnabled;
              return (
                <Button
                  key={format}
                  variant="outline"
                  type="button"
                  disabled={busy || Boolean(exporting) || Boolean(blockedReason) || planLocked}
                  aria-describedby={planLocked ? "file-export-plan-note" : undefined}
                  onClick={() => void exportGuide(format)}
                >
                  {exporting === format ? <LoaderCircle className="spin" /> : <Download />}
                  {label}
                  {planLocked ? <ProBadge size="sm" className="ml-auto" /> : null}
                </Button>
              );
            })}
          </div>
          {!fileExportsEnabled ? (
            <ProUpsell id="file-export-plan-note" onUpgrade={onStartTrial}>
              PDF, PowerPoint, and HTML are included on Pro. Markdown remains
              available when policy permits.
            </ProUpsell>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <footer className="modal-footer export-dialog-footer">
            <span />
            <Button className="export-close-button" variant="outline" type="button" onClick={onClose}>Close</Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
