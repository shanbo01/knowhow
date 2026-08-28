"use client";

import { cn } from "@/lib/utils";

export type UsageTone = "ok" | "warn" | "full";

export function usageTone(used: number, maximum: number): UsageTone {
  if (maximum <= 0) return "ok";
  const ratio = used / maximum;
  if (ratio >= 1) return "full";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

/**
 * A single entitlement limit with how much of it the workspace has spent.
 * Turns amber at 80% and red once full, so the limit is visible before a save
 * is refused rather than only at the moment it fails.
 */
export function UsageMeter({
  label,
  used,
  maximum,
  format = (value) => String(value),
  className,
}: {
  label: string;
  used: number;
  maximum: number;
  format?: (value: number) => string;
  className?: string;
}) {
  const tone = usageTone(used, maximum);
  const percent =
    maximum > 0 ? Math.min(100, Math.round((used / maximum) * 100)) : 0;
  return (
    <div className={cn("usage-meter", className)} data-tone={tone}>
      <div className="usage-meter-head">
        <span className="usage-meter-label">{label}</span>
        <span className="usage-meter-value">
          {format(used)} / {format(maximum)}
        </span>
      </div>
      <div
        className="usage-meter-track"
        role="meter"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={maximum}
      >
        <span className="usage-meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
