(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    padding: 1,
    horizontalGap: 6,
    verticalOverlap: 0.55,
    mergeWaste: 1.35,
    minimumSide: 3,
  });

  const SURFACE_REASONS = new Set([
    "embedded-frame",
    "form-field",
    "password-field",
    "image",
    "manual-element",
  ]);
  const COMPACT_REASONS = new Set([
    "embedded-frame",
    "form-field",
    "password-field",
    "image",
  ]);

  function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function area(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function contains(outer, inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
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
        left.reason === right.reason
          ? left.reason
          : "multiple-sensitive-items",
      ...(left.manual === true || right.manual === true ? { manual: true } : {}),
      ...(left.selectionId && left.selectionId === right.selectionId
        ? { selectionId: left.selectionId }
        : {}),
      ...(left.host != null && left.host === right.host ? { host: left.host } : {}),
      ...(left.cover && left.cover === right.cover ? { cover: left.cover } : {}),
    };
  }

  function horizontalGap(left, right) {
    if (left.x <= right.x + right.width && right.x <= left.x + left.width) {
      return 0;
    }
    return Math.min(
      Math.abs(left.x - (right.x + right.width)),
      Math.abs(right.x - (left.x + left.width)),
    );
  }

  function verticalOverlapRatio(left, right) {
    const overlap =
      Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y);
    return Math.max(0, overlap) / Math.max(1, Math.min(left.height, right.height));
  }

  function isSurface(rect) {
    return rect.manual === true || SURFACE_REASONS.has(rect.reason);
  }

  function canMerge(left, right, options) {
    if (left.host !== right.host) return false;
    if (contains(left, right) || contains(right, left)) return true;
    if (isSurface(left) || isSurface(right)) return false;
    if (horizontalGap(left, right) > options.horizontalGap) return false;
    if (verticalOverlapRatio(left, right) < options.verticalOverlap) return false;
    const combined = union(left, right);
    return area(combined) <= (area(left) + area(right)) * options.mergeWaste;
  }

  function normalize(rect, bounds, options) {
    const width = Math.max(1, finite(bounds?.width, 1));
    const height = Math.max(1, finite(bounds?.height, 1));
    const rectWidth = Math.max(0, finite(rect?.width));
    const rectHeight = Math.max(0, finite(rect?.height));
    if (
      rectWidth <= options.minimumSide ||
      rectHeight <= options.minimumSide
    ) {
      return null;
    }
    // Tight hosts keep their layout box even when it sits below the fold so
    // live `filter: blur()` can be attached before the node scrolls in.
    // Overlay fallbacks still clip to the screenshot viewport.
    const hosted = rect?.host != null;
    const paddedLeft = finite(rect?.x) - options.padding;
    const paddedTop = finite(rect?.y) - options.padding;
    const paddedRight = finite(rect?.x) + rectWidth + options.padding;
    const paddedBottom = finite(rect?.y) + rectHeight + options.padding;
    const left = hosted ? paddedLeft : clamp(paddedLeft, 0, width);
    const top = hosted ? paddedTop : clamp(paddedTop, 0, height);
    const right = hosted ? paddedRight : clamp(paddedRight, left, width);
    const bottom = hosted ? paddedBottom : clamp(paddedBottom, top, height);
    if (right <= left || bottom <= top) return null;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      reason: String(rect?.reason || "sensitive-content").slice(0, 64),
      ...(rect?.manual === true ? { manual: true } : {}),
      ...(typeof rect?.selectionId === "string" && rect.selectionId
        ? { selectionId: rect.selectionId.slice(0, 80) }
        : {}),
      ...(rect?.host != null ? { host: rect.host } : {}),
      ...(rect?.cover === "filter" || rect?.cover === "overlay"
        ? { cover: rect.cover }
        : {}),
    };
  }

  function normalizeAndMergeMasks(rects = [], bounds = {}, overrides = {}) {
    const options = { ...DEFAULTS, ...overrides };
    const merged = [];
    for (const source of Array.isArray(rects) ? rects : []) {
      const mask = normalize(source, bounds, options);
      if (!mask) continue;
      let current = mask;
      let index = 0;
      while (index < merged.length) {
        if (canMerge(current, merged[index], options)) {
          current = union(current, merged.splice(index, 1)[0]);
          index = 0;
        } else {
          index += 1;
        }
      }
      merged.push(current);
    }
    return merged.sort((left, right) => left.y - right.y || left.x - right.x);
  }

  function maskRadius(rect) {
    if (!COMPACT_REASONS.has(rect?.reason)) return 2;
    const side = Math.min(finite(rect?.width), finite(rect?.height));
    if (side <= 64) return Math.max(2, side * 0.5);
    return Math.min(8, Math.max(2, finite(rect?.height) * 0.2));
  }

  /**
   * Screenshot bitmaps are device pixels. A /16 resample on a 2x capture still
   * leaves character-scale samples, so text stays readable. Size the scratch
   * relative to CSS pixels and cap text so a wide inbox row cannot keep glyphs.
   */
  function privacySampleSize(
    width,
    height,
    { surface = false, cssScale = 1 } = {},
  ) {
    const scale = Math.max(0.5, finite(cssScale, 1));
    const block = Math.max(24, (surface ? 24 : 40) * scale);
    let sampleWidth = Math.max(1, Math.ceil(Math.max(1, width) / block));
    let sampleHeight = Math.max(1, Math.ceil(Math.max(1, height) / block));
    if (!surface) {
      sampleWidth = Math.min(sampleWidth, 4);
      sampleHeight = Math.min(sampleHeight, 2);
    }
    return { width: sampleWidth, height: sampleHeight };
  }

  globalThis.__KNOWHOW_BLUR_GEOMETRY__ = Object.freeze({
    defaults: DEFAULTS,
    surfaceReasons: SURFACE_REASONS,
    compactReasons: COMPACT_REASONS,
    isSurfaceReason(reason) {
      return SURFACE_REASONS.has(reason);
    },
    maskRadius,
    privacySampleSize,
    normalizeAndMergeMasks,
  });
})();
