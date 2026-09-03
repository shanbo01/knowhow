"use client";

/**
 * The small shared pieces every workspace surface builds on — a modal frame, an
 * empty state, a status pill, a progress bar, a pager, and the plan dialog that
 * explains an entitlement refusal.
 *
 * They were defined halfway down the single component file that held every
 * view, which is how a fix to one dialog kept missing the identical one a few
 * thousand lines away. Sitting here they belong to all of the surfaces rather
 * than to whichever one happened to be nearest.
 */
import { type ReactNode } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { SelectMenu } from "../select-menu";
import type {
  BootstrapResponse,
} from "../../../lib/knowhow-types";
import { ProBadge } from "../pro-badge";
import { UsageMeter } from "../plan-usage";
import { formatDate, PLAN_FEATURES, titleCase } from "./formatting";

export function PlanDialog({
  subscription,
  entitlements,
  metrics,
  busy,
  onClose,
  onStartTrial,
  onSelectPro,
  onRequestEnterprise,
}: {
  subscription?: NonNullable<BootstrapResponse["activeWorkspace"]>["workspace"]["subscription"];
  entitlements: NonNullable<BootstrapResponse["activeWorkspace"]>["entitlements"];
  metrics: NonNullable<BootstrapResponse["activeWorkspace"]>["metrics"];
  busy: boolean;
  onClose: () => void;
  onStartTrial: () => Promise<void>;
  onSelectPro: () => Promise<void>;
  onRequestEnterprise: () => Promise<void>;
}) {
  const plan = subscription?.plan ?? "free";
  const trialAvailable = plan === "free" && subscription?.trialConsumed !== true;
  return (
    <Modal title="Workspace plan" eyebrow="Billing" onClose={onClose}>
      <div className="modal-form">
        <p>
          You are on <strong>{plan === "pro_trial" ? "Pro trial" : plan === "pro" ? "Pro" : plan === "enterprise" ? "Enterprise" : "Free"}</strong>
          {subscription?.expiresAt && plan !== "free"
            ? ` until ${formatDate(subscription.expiresAt)}`
            : null}
          . Pro and Enterprise share the same product. Enterprise is for higher usage.
        </p>
        <p className="privacy-caption">
          Online billing is not available yet. Contact sales and we will follow up
          before making any paid plan change.
        </p>
        <section className="plan-usage-section">
          <h3 className="plan-section-heading">This workspace</h3>
          <UsageMeter
            label="Guides"
            used={metrics.guides}
            maximum={entitlements.maximumGuides}
          />
          <UsageMeter
            label="People"
            used={metrics.members}
            maximum={entitlements.maximumUsers}
          />
          <p className="privacy-caption">
            Archiving a guide frees its slot. Creators are capped at{" "}
            {entitlements.maximumCreators}.
          </p>
        </section>
        <section className="plan-feature-section">
          <h3 className="plan-section-heading">Features</h3>
          <ul className="plan-feature-list">
            {PLAN_FEATURES.map((feature) => {
              const included = Boolean(entitlements[feature.key]);
              return (
                <li key={feature.id} data-included={included}>
                  <span>{feature.label}</span>
                  {included ? (
                    <span className="plan-feature-included">Included</span>
                  ) : (
                    <span className="plan-feature-locked">
                      <span className="plan-feature-note">
                        {feature.freeNote}
                      </span>
                      <ProBadge size="sm" />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <footer className="modal-footer plan-dialog-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Close
          </button>
          {trialAvailable ? (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void onStartTrial()}
            >
              Start 14-day Pro trial
            </button>
          ) : null}
          {plan === "free" || plan === "pro_trial" ? (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void onSelectPro()}
            >
              Contact sales about Pro
            </button>
          ) : null}
          {plan !== "enterprise" ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void onRequestEnterprise()}
            >
              Request Enterprise
            </button>
          ) : null}
        </footer>
      </div>
    </Modal>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={`status-badge status-${status.toLowerCase()}`}
      variant="outline"
    >
      {titleCase(status)}
    </Badge>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof BookOpen;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({
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
        className={cn(
          "kh-dialog-content",
          wide && "kh-dialog-wide sm:max-w-3xl",
        )}
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

export function DashboardProgress({
  value,
  label,
  tone = "neutral",
}: {
  value: number;
  label: string;
  tone?: "neutral" | "accent" | "muted";
}) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div
      className={`dashboard-progress dashboard-progress-${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalized}
    >
      <span style={{ width: `${normalized}%` }} />
    </div>
  );
}

export function ListPagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = total ? safePage * pageSize + 1 : 0;
  const end = Math.min(total, (safePage + 1) * pageSize);

  return (
    <div className="list-pagination" aria-label="List pagination">
      <span>
        Showing {start}–{end} of {total}
      </span>
      <div>
        <SelectMenu
          className="display-limit-select"
          value={String(pageSize)}
          onChange={(value) => onPageSizeChange(Number(value))}
          ariaLabel="Items per page"
          options={[5, 10, 25, 50].map((value) => ({
            value: String(value),
            label: `${value} per page`,
          }))}
        />
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          disabled={safePage === 0}
          onClick={() => onPageChange(safePage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <span>
          Page {safePage + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => onPageChange(safePage + 1)}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

