"use client";

import { useMemo, useRef, type CSSProperties, type PointerEvent } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const PRESETS = [
  "#e85d24",
  "#c65321",
  "#ef4444",
  "#0f766e",
  "#2563eb",
  "#111216",
  "#d6d3d1",
];

type Hsv = { h: number; s: number; v: number };

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value: string) {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.slice(1).toLowerCase()}`;
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

export function isValidHexColor(value: string) {
  return normalizeHex(value) !== null;
}

function hexToHsv(hex: string): Hsv {
  const value = parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToHex({ h, s, v }: Hsv) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (channel: number) =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hueFill(h: number) {
  return `hsl(${Math.round(h)} 100% 50%)`;
}

export function HexColorPicker({
  value,
  onChange,
  label,
  hint,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  ariaLabel: string;
}) {
  const parsed = normalizeHex(value);
  const hsv = useMemo(() => hexToHsv(parsed ?? "#e85d24"), [parsed]);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  function commit(next: Hsv | string) {
    const hex = typeof next === "string" ? normalizeHex(next) : hsvToHex(next);
    if (hex) onChange(hex);
  }

  function moveSv(event: PointerEvent<HTMLDivElement>) {
    const node = svRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    commit({
      h: hsv.h,
      s: clamp((event.clientX - rect.left) / rect.width),
      v: clamp(1 - (event.clientY - rect.top) / rect.height),
    });
  }

  function moveHue(event: PointerEvent<HTMLDivElement>) {
    const node = hueRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    commit({
      h: clamp((event.clientX - rect.left) / rect.width) * 360,
      s: hsv.s,
      v: hsv.v,
    });
  }

  function beginDrag(
    event: PointerEvent<HTMLDivElement>,
    move: (event: PointerEvent<HTMLDivElement>) => void,
  ) {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = false;
  }

  return (
    <div className="color-picker">
      <Popover
        onOpenChange={(open, details) => {
          if (!open && draggingRef.current) details.cancel();
        }}
      >
        <PopoverTrigger
          type="button"
          className="color-picker-swatch"
          style={{ "--swatch": parsed ?? value } as CSSProperties}
          aria-label={ariaLabel}
        />
        <PopoverContent
          align="start"
          sideOffset={8}
          initialFocus={false}
          className="color-picker-panel w-[13.75rem] gap-3 p-3"
        >
          <div
            ref={svRef}
            className="color-picker-sv"
            style={{ backgroundColor: hueFill(hsv.h) }}
            onPointerDown={(event) => beginDrag(event, moveSv)}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                moveSv(event);
              }
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className="color-picker-sv-white" />
            <span className="color-picker-sv-black" />
            <span
              className="color-picker-knob"
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                background: parsed ?? value,
              }}
            />
          </div>
          <div
            ref={hueRef}
            className="color-picker-hue"
            onPointerDown={(event) => beginDrag(event, moveHue)}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                moveHue(event);
              }
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span
              className="color-picker-hue-knob"
              style={{ left: `${(hsv.h / 360) * 100}%` }}
            />
          </div>
          <div className="color-picker-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={
                  parsed === preset
                    ? "color-picker-preset is-active"
                    : "color-picker-preset"
                }
                style={{ background: preset }}
                aria-label={`Use ${preset}`}
                onClick={() => commit(preset)}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <span className="color-picker-meta">
        <span className="color-picker-label">{label}</span>
        <input
          className="color-picker-hex"
          value={value}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-label={`${label} hex`}
          aria-invalid={!parsed}
          aria-describedby={!parsed ? `${ariaLabel.replace(/\s+/g, "-").toLowerCase()}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {!parsed ? (
          <small className="form-error" id={`${ariaLabel.replace(/\s+/g, "-").toLowerCase()}-error`}>
            Enter a 3- or 6-digit hex color.
          </small>
        ) : hint ? <small>{hint}</small> : null}
      </span>
    </div>
  );
}
