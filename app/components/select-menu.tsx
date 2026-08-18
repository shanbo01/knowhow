"use client";

import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectMenuOption<T extends string = string> = {
  value: T;
  label: string;
};

type SelectMenuProps<T extends string> = {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  leading?: ReactNode;
  renderValue?: (option: SelectMenuOption<T>) => ReactNode;
  align?: "start" | "end";
  contentClassName?: string;
};

/**
 * Compatibility wrapper for the app's existing select call sites. The custom
 * positioned listbox has been replaced with the shadcn/Base UI Select, which
 * owns keyboard navigation, focus restoration, collision handling, and
 * accessible option semantics.
 */
export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  disabled = false,
  leading,
  renderValue,
  align = "start",
  contentClassName,
}: SelectMenuProps<T>) {
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (typeof nextValue === "string") onChange(nextValue as T);
      }}
    >
      <div className={cn("select-menu", className)}>
        <SelectTrigger aria-label={ariaLabel} className="kh-select-trigger">
          {leading ? <span className="kh-select-leading" aria-hidden="true">{leading}</span> : null}
          {renderValue && selected ? (
            <span className="kh-select-value">{renderValue(selected)}</span>
          ) : (
            <SelectValue className="kh-select-value" placeholder="Select">
              {selected?.label ?? "Select"}
            </SelectValue>
          )}
        </SelectTrigger>
        <SelectContent align={align} className={cn("kh-select-options", contentClassName)} aria-label={ariaLabel}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="kh-select-option">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </div>
    </Select>
  );
}
