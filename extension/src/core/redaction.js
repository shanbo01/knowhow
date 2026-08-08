const EMAIL_PATTERN =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_PATTERN =
  /(?:\+?\d[\d\s().-]{7,}\d)/g;
const FINANCIAL_PATTERN =
  /(?:\b\d[ -]*?){13,19}\b/g;
const LONG_ID_PATTERN =
  /\b(?=[A-Z0-9-]{8,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,}\b/gi;
const ANY_NUMBER_PATTERN = /\d+/g;
const COMMON_NAME_PATTERN =
  /\b[A-Z][a-z]{1,30}(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]{1,30}(?:[-'][A-Z]?[a-z]+)?\b/g;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedRegionFromPoints(start, end, bounds) {
  const width = Math.max(1, finite(bounds?.width, 1));
  const height = Math.max(1, finite(bounds?.height, 1));
  const startX = clamp(finite(start?.x), 0, width);
  const startY = clamp(finite(start?.y), 0, height);
  const endX = clamp(finite(end?.x), 0, width);
  const endY = clamp(finite(end?.y), 0, height);
  return {
    x: Math.min(startX, endX) / width,
    y: Math.min(startY, endY) / height,
    width: Math.abs(endX - startX) / width,
    height: Math.abs(endY - startY) / height,
  };
}

export function scaleNormalizedRegion(region, bounds) {
  const width = Math.max(1, finite(bounds?.width, 1));
  const height = Math.max(1, finite(bounds?.height, 1));
  const x = clamp(finite(region?.x), 0, 1);
  const y = clamp(finite(region?.y), 0, 1);
  const normalizedWidth = clamp(finite(region?.width), 0, 1 - x);
  const normalizedHeight = clamp(finite(region?.height), 0, 1 - y);
  return {
    x: x * width,
    y: y * height,
    width: normalizedWidth * width,
    height: normalizedHeight * height,
  };
}

export function normalizeRect(rect, bounds, padding = 0) {
  const width = Math.max(0, finite(bounds?.width));
  const height = Math.max(0, finite(bounds?.height));
  const left = Math.max(0, finite(rect?.x) - padding);
  const top = Math.max(0, finite(rect?.y) - padding);
  const right = Math.min(
    width,
    finite(rect?.x) + Math.max(0, finite(rect?.width)) + padding,
  );
  const bottom = Math.min(
    height,
    finite(rect?.y) + Math.max(0, finite(rect?.height)) + padding,
  );
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    reason: rect?.reason || "manual",
  };
}

function intersectsOrTouches(left, right, gap = 3) {
  return !(
    left.x + left.width + gap < right.x ||
    right.x + right.width + gap < left.x ||
    left.y + left.height + gap < right.y ||
    right.y + right.height + gap < left.y
  );
}

function union(left, right) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const farX = Math.max(left.x + left.width, right.x + right.width);
  const farY = Math.max(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: farX - x,
    height: farY - y,
    reason:
      left.reason === right.reason ? left.reason : "multiple-sensitive-items",
  };
}

export function mergeRects(rects, gap = 3) {
  const merged = [];
  for (const candidate of rects.filter(
    (rect) => rect.width > 0 && rect.height > 0,
  )) {
    let current = { ...candidate };
    let index = 0;
    while (index < merged.length) {
      if (intersectsOrTouches(current, merged[index], gap)) {
        current = union(current, merged[index]);
        merged.splice(index, 1);
      } else {
        index += 1;
      }
    }
    merged.push(current);
  }
  return merged;
}

export function scaleRect(rect, viewport, bitmap) {
  const viewportWidth = Math.max(1, finite(viewport?.width, 1));
  const viewportHeight = Math.max(1, finite(viewport?.height, 1));
  const scaleX = Math.max(0, finite(bitmap?.width)) / viewportWidth;
  const scaleY = Math.max(0, finite(bitmap?.height)) / viewportHeight;
  return {
    ...rect,
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

export function buildSolidRedactionPlan({
  rects = [],
  viewport,
  bitmap,
  padding = 4,
}) {
  const normalized = rects.map((rect) =>
    normalizeRect(rect, viewport, padding),
  );
  return mergeRects(normalized).map((rect) =>
    scaleRect(rect, viewport, bitmap),
  );
}

/**
 * Computes non-destructive pending redaction regions (0-1 normalized,
 * relative to the final screenshot image) instead of baking pixels. These
 * become reversible blur overlays in the app editor until the guide's first
 * review submission flattens them permanently.
 */
export function buildPendingRedactionRegions({ rects = [], viewport, padding = 4 }) {
  const width = Math.max(1, finite(viewport?.width, 1));
  const height = Math.max(1, finite(viewport?.height, 1));
  const normalized = rects.map((rect) => normalizeRect(rect, viewport, padding));
  return mergeRects(normalized).map((rect, index) => ({
    id: `pending_${index}_${Math.round(rect.x)}_${Math.round(rect.y)}`,
    x: clamp(rect.x / width, 0, 1),
    y: clamp(rect.y / height, 0, 1),
    width: clamp(rect.width / width, 0, 1),
    height: clamp(rect.height / height, 0, 1),
    applied: false,
  }));
}

export function detectSensitiveRanges(text, options = {}) {
  const input = String(text || "");
  const findings = [];
  const detectors = [
    [options.redactEmails !== false, "email", EMAIL_PATTERN],
    [options.redactPhoneNumbers !== false, "phone", PHONE_PATTERN],
    [
      options.redactFinancialNumbers !== false,
      "financial-number",
      FINANCIAL_PATTERN,
    ],
    [options.redactIds !== false, "identifier", LONG_ID_PATTERN],
    [options.redactAllNumbers === true, "number", ANY_NUMBER_PATTERN],
    [options.redactCommonNames === true, "common-name", COMMON_NAME_PATTERN],
  ];

  for (const [enabled, reason, pattern] of detectors) {
    if (!enabled) continue;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(input))) {
      findings.push({
        start: match.index,
        end: match.index + match[0].length,
        reason,
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }

  return findings.sort((left, right) => left.start - right.start);
}

export function sanitizeCapturedText(text, options = {}, maxLength = 500) {
  const input = String(text || "").replace(/\s+/g, " ").trim();
  if (!input) return "";
  const findings = detectSensitiveRanges(input, options);
  if (!findings.length) return input.slice(0, maxLength);

  let output = "";
  let cursor = 0;
  for (const finding of findings) {
    if (finding.start < cursor) continue;
    output += input.slice(cursor, finding.start);
    output += "[redacted]";
    cursor = finding.end;
  }
  output += input.slice(cursor);
  return output.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function sanitizeCapturedLabel(text, options = {}) {
  return sanitizeCapturedText(text, options, 100);
}
