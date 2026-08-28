"use client";

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Marks a feature the workspace does not have yet. Render it only when the
 * entitlement is missing — an entitled workspace should never see plan chrome
 * on a feature it already pays for.
 */
export function ProBadge({
  className,
  size = "default",
  label = "Pro",
}: {
  className?: string;
  size?: "default" | "sm";
  label?: string;
}) {
  return (
    <span className={cn("pro-badge", className)} data-size={size}>
      <Sparkles aria-hidden />
      <span>{label}</span>
    </span>
  );
}

/**
 * The explanatory block under a locked feature: what Pro adds, and the action
 * that starts an upgrade. `onUpgrade` is omitted for members who cannot change
 * the workspace plan, which leaves the copy without a dead-end button.
 */
export function ProUpsell({
  children,
  id,
  className,
  onUpgrade,
  upgradeLabel = "Start Pro trial",
}: {
  children: React.ReactNode;
  id?: string;
  className?: string;
  onUpgrade?: () => void;
  upgradeLabel?: string;
}) {
  return (
    <div className={cn("pro-upsell", className)} id={id}>
      <span className="pro-upsell-icon">
        <Sparkles aria-hidden />
      </span>
      <div className="pro-upsell-copy">
        <p>{children}</p>
        {onUpgrade ? (
          <button type="button" className="pro-upsell-action" onClick={onUpgrade}>
            {upgradeLabel}
          </button>
        ) : (
          <p className="pro-upsell-hint">
            Ask a workspace administrator to upgrade.
          </p>
        )}
      </div>
    </div>
  );
}
