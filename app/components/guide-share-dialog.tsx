"use client";

import { Check, Link2, Send, Share2 } from "lucide-react";
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
import { PolicyNote } from "./workspace-patterns";

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
  onClose,
  onAudiencesChange,
  onPrivacyReviewedChange,
  onShare,
  onRequestReview,
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
  onClose: () => void;
  onAudiencesChange: (audiences: Audience[]) => void;
  onPrivacyReviewedChange: (value: boolean) => void;
  onShare: () => Promise<void>;
  onRequestReview?: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const shareBlocked =
    busy ||
    !audiences.length ||
    (captured && !privacyReviewed) ||
    !canShare;

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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="kh-dialog-content kh-dialog-wide sm:max-w-xl">
        <DialogHeader className="kh-dialog-header">
          <div>
            <p className="eyebrow">Audience & live link</p>
            <DialogTitle>Who can follow {title || "this guide"}?</DialogTitle>
          </div>
        </DialogHeader>
        <div className="share-dialog-body">
          <p className="share-dialog-lead">
            Choose who can open the live guide. Recipients must be signed in
            and included in this audience.
          </p>
          <PolicyNote icon={Link2}>
            Copying the link does not grant access.
          </PolicyNote>
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
                <Share2 /> {isLive ? "Update audience" : "Publish"}
              </Button>
            </div>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
