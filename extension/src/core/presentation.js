function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finitePositive(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizedPoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

function normalizedRegion(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const left = clamp(x, 0, 1);
  const top = clamp(y, 0, 1);
  const right = clamp(x + width, left, 1);
  const bottom = clamp(y + height, top, 1);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Keeps `value` inside an interval whose ends may arrive in either order. */
function clampBetween(value, first, second) {
  return clamp(value, Math.min(first, second), Math.max(first, second));
}

export const CROP_ASPECT_RATIO = 16 / 9;
export const CROP_MAX_ZOOM = 2.6;

/**
 * Produce a contextual frame around the clicked control: tight enough that a
 * small button fills the reader's eye, wide enough that the surrounding
 * interface still tells them where they are. The raw screenshot stays
 * untouched; this crop is presentation metadata that remains editable in the
 * app editor.
 *
 * The crop keeps a predictable 16:9 presentation ratio in *pixel* terms, so
 * `width` and `height` are normalized against differently shaped screenshots
 * rather than being equal fractions.
 */
export function contextualCrop(step, options = {}) {
  const {
    aspectRatio = CROP_ASPECT_RATIO,
    maxZoom = CROP_MAX_ZOOM,
    minContextX = 0.1,
    minContextY = 0.13,
    contextRatio = 0.85,
  } = options;
  const imageWidth = finitePositive(step?.imageWidth);
  const imageHeight = finitePositive(step?.imageHeight);
  const imageAspect = imageWidth / imageHeight;
  const focus = normalizedRegion(step?.focusRegion);
  const click = normalizedPoint(step?.clickTarget);
  if (!focus && !click) return { x: 0, y: 0, width: 1, height: 1 };

  const widestForRatio = Math.min(1, aspectRatio / imageAspect);
  const heightForWidth = (width) => (width * imageAspect) / aspectRatio;
  const widthForHeight = (height) => (height * aspectRatio) / imageAspect;

  const target = focus || {
    x: click.x,
    y: click.y,
    width: 0,
    height: 0,
  };
  const neededWidth = target.width + Math.max(minContextX, target.width * contextRatio) * 2;
  const neededHeight = target.height + Math.max(minContextY, target.height * contextRatio) * 2;
  const closestWidth = Math.min(widestForRatio, 1 / Math.max(1, maxZoom));
  const width = clampBetween(
    Math.max(neededWidth, widthForHeight(neededHeight), closestWidth),
    closestWidth,
    widestForRatio,
  );
  const height = clamp(heightForWidth(width), 0.01, 1);

  const center = click || {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  let x = clamp(center.x - width / 2, 0, Math.max(0, 1 - width));
  let y = clamp(center.y - height / 2, 0, Math.max(0, 1 - height));
  if (focus) {
    // Centering on the click point alone can push a wide or tall target
    // partly out of frame. Slide the crop back until the whole control fits.
    x = clampBetween(
      x,
      clamp(focus.x + focus.width - width, 0, Math.max(0, 1 - width)),
      clamp(focus.x, 0, Math.max(0, 1 - width)),
    );
    y = clampBetween(
      y,
      clamp(focus.y + focus.height - height, 0, Math.max(0, 1 - height)),
      clamp(focus.y, 0, Math.max(0, 1 - height)),
    );
  }
  return { x, y, width, height };
}

export function projectClickToCrop(clickTarget, crop) {
  if (!clickTarget || !crop) return null;
  const x = Number(clickTarget.x);
  const y = Number(clickTarget.y);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < crop.x ||
    x > crop.x + crop.width ||
    y < crop.y ||
    y > crop.y + crop.height
  ) {
    return null;
  }
  const radius = Number(clickTarget.radius);
  return {
    x: (x - crop.x) / crop.width,
    y: (y - crop.y) / crop.height,
    // Radii arrive as a fraction of the screenshot; re-express them against the
    // crop so the ring keeps covering the same control after zooming in.
    radius:
      (Number.isFinite(radius) && radius > 0 ? radius : 0.035) / crop.width,
    color: clickTarget.color,
  };
}

/**
 * Clip a region normalized to the full screenshot into crop-relative
 * coordinates. Returns null when the region is entirely outside the crop, so
 * callers never render an off-frame blur.
 */
export function projectRegionToCrop(region, crop) {
  const normalized = normalizedRegion(region);
  if (!normalized || !crop) return null;
  const left = Math.max(normalized.x, crop.x);
  const top = Math.max(normalized.y, crop.y);
  const right = Math.min(normalized.x + normalized.width, crop.x + crop.width);
  const bottom = Math.min(normalized.y + normalized.height, crop.y + crop.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: (left - crop.x) / crop.width,
    y: (top - crop.y) / crop.height,
    width: (right - left) / crop.width,
    height: (bottom - top) / crop.height,
  };
}

export function thumbnailGeometry(step) {
  const crop = normalizedRegion(step?.crop) || contextualCrop(step);
  const isNavigation = step?.sourceEvent === "navigation";
  const clickTarget = isNavigation
    ? null
    : projectClickToCrop(step?.clickTarget || null, crop);
  const redactions = (
    Array.isArray(step?.pendingRedactions) ? step.pendingRedactions : []
  )
    .filter((region) => region?.applied !== true)
    .map((region) => projectRegionToCrop(region, crop))
    .filter(Boolean);
  const imageWidth = finitePositive(step?.imageWidth);
  const imageHeight = finitePositive(step?.imageHeight);
  return {
    crop,
    clickTarget,
    redactions,
    aspectRatio: (imageWidth * crop.width) / (imageHeight * crop.height),
    image: {
      left: (-crop.x / crop.width) * 100,
      top: (-crop.y / crop.height) * 100,
      width: (1 / crop.width) * 100,
    },
  };
}
