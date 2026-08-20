"use client";

import { cn } from "@/lib/utils";
import { BrandMarkGlyph } from "@/app/components/brand-mark-glyph";

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
        <BrandMarkGlyph />
      </span>
      {!markOnly ? (
        <span className="product-brand-copy">
          <strong>knowhow</strong>
          {!compact ? <small>Governed operations</small> : null}
        </span>
      ) : null}
    </span>
  );
}
