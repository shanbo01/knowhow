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

/**
 * Produce a Scribe-style contextual frame around the clicked control while
 * retaining a predictable 16:9 presentation ratio. The raw screenshot stays
 * untouched; this crop is presentation metadata that remains editable.
 */
export function contextualCrop(
  step,
  { aspectRatio = 16 / 9, preferredWidth = 0.72, padding = 0.12 } = {},
) {
  const imageWidth = finitePositive(step?.imageWidth);
  const imageHeight = finitePositive(step?.imageHeight);
  const imageAspect = imageWidth / imageHeight;
  const focus = normalizedRegion(step?.focusRegion);
  const click = normalizedPoint(step?.clickTarget);
  if (!focus && !click) return { x: 0, y: 0, width: 1, height: 1 };

  const center = click || {
    x: focus.x + focus.width / 2,
    y: focus.y + focus.height / 2,
  };
  const maximumWidthForRatio = Math.min(1, aspectRatio / imageAspect);
  const requiredForFocusWidth = focus ? focus.width + padding * 2 : 0;
  const requiredForFocusHeight = focus
    ? ((focus.height + padding * 2) * aspectRatio) / imageAspect
    : 0;
  const cropWidth = clamp(
    Math.max(preferredWidth, requiredForFocusWidth, requiredForFocusHeight),
    Math.min(0.42, maximumWidthForRatio),
    maximumWidthForRatio,
  );
  const cropHeight = clamp(
    (cropWidth * imageAspect) / aspectRatio,
    0.01,
    1,
  );
  return {
    x: clamp(center.x - cropWidth / 2, 0, 1 - cropWidth),
    y: clamp(center.y - cropHeight / 2, 0, 1 - cropHeight),
    width: cropWidth,
    height: cropHeight,
  };
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
  return {
    x: (x - crop.x) / crop.width,
    y: (y - crop.y) / crop.height,
    color: clickTarget.color,
  };
}

export function thumbnailGeometry(step) {
  const crop = step?.crop || contextualCrop(step);
  const clickTarget =
    step?.sourceEvent === "navigation"
      ? null
      : projectClickToCrop(step?.clickTarget || null, crop);
  const imageWidth = finitePositive(step?.imageWidth);
  const imageHeight = finitePositive(step?.imageHeight);
  return {
    crop,
    clickTarget,
    aspectRatio: (imageWidth * crop.width) / (imageHeight * crop.height),
    image: {
      left: ((-crop.x / crop.width) * 100) + 0,
      top: ((-crop.y / crop.height) * 100) + 0,
      width: (1 / crop.width) * 100,
    },
  };
}
