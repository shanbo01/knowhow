import { ShieldCheck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("empty-state", compact && "empty-state-compact")}>
      <span className="empty-icon" aria-hidden="true">
        <Icon />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function PolicyNote({
  icon: Icon = ShieldCheck,
  children,
  tone = "neutral",
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  tone?: "neutral" | "warning";
  className?: string;
}) {
  return (
    <div className={cn("policy-note", `policy-note-${tone}`, className)}>
      <Icon aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}
