"use client";

import { cn } from "@/lib/utils";

export type ProductBrandProps = {
  className?: string;
  id?: string;
  markOnly?: boolean;
  compact?: boolean;
};

export function ProductBrand({
  className,
  id,
  markOnly = false,
  compact = false,
}: ProductBrandProps) {
  return (
    <span id={id} className={cn("product-brand", compact && "product-brand-compact", className)}>
      <span className="product-brand-mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M6 5v14M6 12h5.1M11.1 12l5-6M11.1 12l6 7"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
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
