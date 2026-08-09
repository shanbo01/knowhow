"use client";

import { Boxes } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProductBrandProps = {
  className?: string;
  id?: string;
  markOnly?: boolean;
  compact?: boolean;
};

/**
 * The temporary product identity lives in one place. When the final logo is
 * ready, replace the mark and wordmark inside this component rather than
 * updating every app surface.
 */
export function ProductBrand({
  className,
  id,
  markOnly = false,
  compact = false,
}: ProductBrandProps) {
  return (
    <span id={id} className={cn("product-brand", compact && "product-brand-compact", className)}>
      <span className="product-brand-mark" aria-hidden="true">
        <Boxes />
      </span>
      {!markOnly ? (
        <span className="product-brand-copy">
          <strong>KnowHow</strong>
          {!compact ? <small>Governed operations</small> : null}
        </span>
      ) : null}
    </span>
  );
}
