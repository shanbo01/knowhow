"use client";

import { useState, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PlatformAccountRecord,
  PlatformDeletionCase,
  PlatformSubscriptionSummary,
} from "../../../lib/knowhow-types";
import { formatDate, messageFromError } from "./platform-format";

function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={cn("kh-dialog-content", wide && "kh-dialog-wide sm:max-w-3xl")}
      >
        <DialogHeader className="kh-dialog-header">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <DialogTitle>{title}</DialogTitle>
          </div>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export type CommercialMode =
  | "trial"
  | "extend"
  | "convert"
  | "overrides";

export function CommercialDialog({
  mode,
  account,
  subscription,
  busy,
  onClose,
  onGrantTrial,
  onExtend,
  onConvert,
  onOverride,
}: {
  mode: CommercialMode;
  account: { id: string; name: string };
  subscription: PlatformSubscriptionSummary | null;
  busy: boolean;
  onClose: () => void;
  onGrantTrial: (days: number, reason: string) => Promise<unknown>;
  onExtend: (expiresAt: string, reason: string) => Promise<unknown>;
  onConvert: (input: {
    plan: "free" | "pro" | "enterprise";
    manualReference: string;
    expiresAt: string | null;
    complimentary: boolean;
    reason: string;
  }) => Promise<unknown>;
  onOverride: (input: {
    maximumUsers?: number;
    maximumCreators?: number;
    storageGb?: number;
    expiresAt: string;
    reason: string;
  }) => Promise<unknown>;
}) {
  const [openedAt] = useState(() => Date.now());
  const extensionBase = Math.max(
    openedAt,
    subscription?.expiresAt ? Date.parse(subscription.expiresAt) : openedAt,
  );
  const [days, setDays] = useState("14");
  const [reason, setReason] = useState("");
  const [expiryDate, setExpiryDate] = useState(
    new Date(extensionBase + 14 * 86_400_000).toISOString().slice(0, 10),
  );
  const [plan, setPlan] = useState<"free" | "pro" | "enterprise">("pro");
  const [manualReference, setManualReference] = useState("");
  const [complimentary, setComplimentary] = useState(false);
  const [seats, setSeats] = useState("");
  const [creators, setCreators] = useState("");
  const [storageGb, setStorageGb] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const toEndOfDayIso = (value: string) =>
    new Date(`${value}T23:59:59.000Z`).toISOString();
  const title =
    mode === "trial"
      ? `Grant Pro trial · ${account.name}`
      : mode === "extend"
        ? `Extend · ${account.name}`
        : mode === "overrides"
          ? `Limit override · ${account.name}`
          : `Change plan · ${account.name}`;

  return (
    <Modal title={title} eyebrow="MFA-protected commercial change" onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setWorking(true);
          setError("");
          try {
            if (mode === "trial") {
              await onGrantTrial(Number(days), reason.trim());
            } else if (mode === "extend") {
              await onExtend(toEndOfDayIso(expiryDate), reason.trim());
            } else if (mode === "overrides") {
              await onOverride({
                maximumUsers: seats ? Number(seats) : undefined,
                maximumCreators: creators ? Number(creators) : undefined,
                storageGb: storageGb ? Number(storageGb) : undefined,
                expiresAt: toEndOfDayIso(expiryDate),
                reason: reason.trim(),
              });
            } else {
              await onConvert({
                plan,
                manualReference: manualReference.trim() || "manual-operator",
                expiresAt: plan === "free" || !expiryDate ? null : toEndOfDayIso(expiryDate),
                complimentary,
                reason: reason.trim(),
              });
            }
            onClose();
          } catch (nextError) {
            setError(messageFromError(nextError));
          } finally {
            setWorking(false);
          }
        }}
      >
        {mode === "trial" ? (
          <label className="field">
            <span>Trial length (days)</span>
            <input
              type="number"
              min={1}
              max={90}
              required
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </label>
        ) : null}
        {mode === "convert" ? (
          <>
            <label className="field">
              <span>Plan</span>
              <select
                value={plan}
                onChange={(event) =>
                  setPlan(event.target.value as "free" | "pro" | "enterprise")
                }
              >
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
                <option value="free">Free (revoke paid access)</option>
              </select>
            </label>
            {plan !== "free" ? (
              <label className="field">
                <span>Contract or invoice reference</span>
                <input
                  required
                  minLength={3}
                  value={manualReference}
                  onChange={(event) => setManualReference(event.target.value)}
                  placeholder="INV-104 or partner-comp"
                />
              </label>
            ) : null}
            <label className="choice-row">
              <input
                type="checkbox"
                checked={complimentary}
                onChange={(event) => setComplimentary(event.target.checked)}
              />
              <span>Complimentary / VIP — hide from conversion queues</span>
            </label>
          </>
        ) : null}
        {mode === "overrides" ? (
          <>
            <label className="field">
              <span>Seat limit</span>
              <input
                type="number"
                min={1}
                value={seats}
                onChange={(event) => setSeats(event.target.value)}
                placeholder="Leave blank to keep"
              />
            </label>
            <label className="field">
              <span>Creator limit</span>
              <input
                type="number"
                min={1}
                value={creators}
                onChange={(event) => setCreators(event.target.value)}
                placeholder="Leave blank to keep"
              />
            </label>
            <label className="field">
              <span>Storage (GB)</span>
              <input
                type="number"
                min={1}
                value={storageGb}
                onChange={(event) => setStorageGb(event.target.value)}
                placeholder="Leave blank to keep"
              />
            </label>
          </>
        ) : null}
        {mode === "extend" || mode === "convert" || mode === "overrides" ? (
          <label className="field">
            <span>{mode === "convert" && plan === "free" ? "Optional expiry" : "Expiry"}</span>
            <input
              type="date"
              required={mode !== "convert" || plan !== "free"}
              value={expiryDate}
              onChange={(event) => setExpiryDate(event.target.value)}
            />
          </label>
        ) : null}
        <label className="field">
          <span>Reason (audited)</span>
          <textarea
            required
            minLength={8}
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this change is being made"
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || working}>
            {working || busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
            Confirm
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

export function DeletionApprovalDialog({
  item,
  confirmationText,
  workspaceName,
  busy,
  onClose,
  onApprove,
}: {
  item: PlatformDeletionCase;
  confirmationText: string;
  workspaceName: string;
  busy: boolean;
  onClose: () => void;
  onApprove: (caseId: string, confirmation: string) => Promise<unknown>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={`Approve deletion · ${workspaceName}`}
      eyebrow="Irreversible platform-owner control"
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setWorking(true);
          setError("");
          try {
            await onApprove(item.id, confirmation);
            onClose();
          } catch (nextError) {
            setError(messageFromError(nextError));
          } finally {
            setWorking(false);
          }
        }}
      >
        <div className="destructive-warning" role="alert">
          <CircleAlert />
          <span>
            <strong>This queues permanent tenant purge.</strong>
            <small>
              The retention period ended {formatDate(item.eligibleAt, true)}.
            </small>
          </span>
        </div>
        <label className="field">
          <span>Type this exact confirmation phrase</span>
          <code className="confirmation-phrase">{confirmationText}</code>
          <input
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-footer">
          <span />
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="submit"
            disabled={busy || working || confirmation !== confirmationText}
          >
            {working || busy ? <LoaderCircle className="spin" /> : <Trash2 />}
            Approve permanent purge
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

export function QueryPager({
  nextCursor,
  stack,
  onPrev,
  onNext,
}: {
  nextCursor: string | null;
  stack: Array<string | undefined>;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (stack.length <= 1 && !nextCursor) return null;
  return (
    <div className="list-pagination" aria-label="List pagination">
      <span />
      <div>
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          disabled={stack.length <= 1}
          onClick={onPrev}
          aria-label="Previous page"
        >
          ‹
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          disabled={!nextCursor}
          onClick={onNext}
          aria-label="Next page"
        >
          ›
        </Button>
      </div>
    </div>
  );
}

export function PlatformModal(props: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return <Modal {...props} />;
}

export type { PlatformAccountRecord };
