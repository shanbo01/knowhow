"use client";

import { Check, Link2, Send, Share2, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type {
  Audience,
  WorkspaceGroup,
  WorkspaceMember,
} from "../../lib/knowhow-types";
import {
  GuideAudiencePicker,
  isAnyoneWithLink,
  isEntireWorkspace,
} from "./guide-audience-picker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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

  // One reason, stated next to the button it disables. A greyed-out Publish
  // with the explanation somewhere up the page is the thing people get stuck on.
  const blockedReason = !canShare
    ? "You do not have permission to share this guide."
    : !audiences.length && !isLive
      ? "Choose who can see it before publishing."
      : captured && !privacyReviewed
        ? "Confirm the privacy review before publishing."
        : "";
  const shareBlocked = busy || Boolean(blockedReason);
  const reviewBlocked =
    busy ||
    !audiences.length ||
    (captured && !privacyReviewed);
  const linkToken = audiences.find((audience) => audience.kind === "link")
    ?.subjectId;
  const effectiveLiveUrl = linkToken
    ? `${typeof window === "undefined" ? "" : window.location.origin}/share/${encodeURIComponent(linkToken)}`
    : audiences.length
      ? liveUrl
      : "";

  async function copyLink() {
    if (!effectiveLiveUrl) return;
    await navigator.clipboard.writeText(effectiveLiveUrl);
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="kh-dialog-content kh-dialog-wide share-dialog sm:max-w-xl">
        <DialogHeader className="kh-dialog-header">
          <div>
            <p className="eyebrow">Audience &amp; live link</p>
            <DialogTitle>Who can follow {title || "this guide"}?</DialogTitle>
          </div>
        </DialogHeader>

        <div className="share-dialog-body">
          <p className="share-dialog-lead">
            {isAnyoneWithLink(audiences)
              ? "Anyone who receives the unlisted link can view this guide without signing in."
              : audiences.length
                ? "Choose the workspace members who can open the live guide."
                : "This guide is private and visible only to people who can edit it."}
          </p>

          <GuideAudiencePicker
            workspaceName={workspaceName}
            audiences={audiences}
            groups={groups}
            members={members}
            allowPrivate={isLive}
            onChange={onAudiencesChange}
          />

          {captured ? (
            <label
              className="choice-row emphasized privacy-gate privacy-review-card"
              data-pending={!privacyReviewed || undefined}
            >
              <input
                type="checkbox"
                checked={privacyReviewed}
                onChange={(event) =>
                  onPrivacyReviewedChange(event.target.checked)
                }
              />
              <span className="privacy-review-icon"><ShieldCheck /></span>
              <span>
                <strong>I reviewed every capture</strong>
                <small>
                  Every screenshot is redacted and contains only what this
                  audience may see. Required before the guide can go live.
                </small>
              </span>
            </label>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="share-dialog-footer">
          <p className="share-dialog-status" role="status">
            {blockedReason ? (
              <>
                <ShieldAlert /> {blockedReason}
              </>
            ) : isLive ? (
              audiences.length ? (
                <><Check /> Live — updating changes who can open it.</>
              ) : (
                <><ShieldCheck /> Not shared — only editors can open it.</>
              )
            ) : (
              <>
                <Check /> Ready to publish to{" "}
                {isAnyoneWithLink(audiences)
                  ? "anyone with the link"
                  : isEntireWorkspace(audiences)
                  ? "the whole workspace"
                  : `${audiences.length} ${audiences.length === 1 ? "audience" : "audiences"}`}
                .
              </>
            )}
          </p>
          <div className="share-dialog-actions">
            {canRequestReview && onRequestReview ? (
              <Button
                variant="ghost"
                type="button"
                disabled={reviewBlocked}
                onClick={() => void run(onRequestReview)}
              >
                <Send /> Send for review
              </Button>
            ) : null}
            <Button
              variant="outline"
              type="button"
              disabled={!isLive || !effectiveLiveUrl}
              onClick={() => void copyLink()}
            >
              {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy link"}
            </Button>
            <Button
              type="button"
              disabled={shareBlocked}
              onClick={() => void run(onShare)}
            >
              <Share2 /> {isLive ? (audiences.length ? "Update access" : "Stop sharing") : "Publish"}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
