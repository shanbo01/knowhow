export type LogoRaster = {
  /** Trimmed raster as a data URL, or the source URL when trimming was skipped. */
  url: string;
  /** Aspect ratio of the trimmed artwork. */
  ratio: number;
  /**
   * Colour painted behind and around the mark. For artwork exported onto a
   * flat backdrop this is that same colour, so plate and mark read as one
   * shape rather than a rectangle pasted onto the chrome. `null` only when the
   * raster could not be measured.
   */
  plate: string | null;
};

/** Analysis runs on a thumbnail: display sizes never exceed ~52 CSS pixels. */
const ANALYSIS_MAX = 256;
const OUTPUT_MAX = 512;
/** Squared RGB distance beyond which a pixel counts as artwork, not backdrop. */
const COLOR_TOLERANCE_SQUARED = 22 * 22 * 3;
const ALPHA_FLOOR = 16;
/** Share of border pixels that must agree before we trust a flat backdrop. */
const UNIFORM_BORDER_SHARE = 0.85;
/** Breathing room re-added around the trimmed box, as a share of the long edge. */
const BLEED_SHARE = 0.015;
/** A box this close to the full raster is already tight; leave the bytes alone. */
const ALREADY_TIGHT_COVERAGE = 0.97;
/** Plates for transparent artwork, picked against the ink so both themes work. */
const LIGHT_PLATE = "rgb(255 255 255)";
const DARK_PLATE = "rgb(16 19 24)";
/** Relative luminance below which artwork counts as dark ink. */
const DARK_INK_LUMINANCE = 0.5;

type Rgb = { r: number; g: number; b: number };

type Backdrop =
  | { kind: "none" }
  | { kind: "transparent" }
  | { kind: "flat"; color: Rgb };

function distanceSquared(pixels: Uint8ClampedArray, offset: number, color: Rgb) {
  const dr = pixels[offset] - color.r;
  const dg = pixels[offset + 1] - color.g;
  const db = pixels[offset + 2] - color.b;
  return dr * dr + dg * dg + db * db;
}

function borderOffsets(width: number, height: number) {
  const offsets: number[] = [];
  for (let x = 0; x < width; x += 1) {
    offsets.push(x * 4, ((height - 1) * width + x) * 4);
  }
  for (let y = 1; y < height - 1; y += 1) {
    offsets.push(y * width * 4, (y * width + width - 1) * 4);
  }
  return offsets;
}

/**
 * Reads the backdrop off the raster's outer ring. Uploaded logos are usually
 * either a transparent PNG or flat artwork exported onto white, and the ring
 * is the cheapest place to tell those apart.
 */
function detectBackdrop(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Backdrop {
  const offsets = borderOffsets(width, height);
  if (!offsets.length) return { kind: "none" };

  let transparent = 0;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (const offset of offsets) {
    if (pixels[offset + 3] < ALPHA_FLOOR) {
      transparent += 1;
      continue;
    }
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }

  if (transparent / offsets.length >= UNIFORM_BORDER_SHARE) {
    return { kind: "transparent" };
  }

  let dominant: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (!dominant) return { kind: "none" };

  const color: Rgb = {
    r: Math.round(dominant.r / dominant.count),
    g: Math.round(dominant.g / dominant.count),
    b: Math.round(dominant.b / dominant.count),
  };
  // Count every ring pixel near that colour rather than only its own bucket,
  // so a flat backdrop straddling two quantisation buckets still reads as one.
  let matching = 0;
  for (const offset of offsets) {
    if (
      pixels[offset + 3] >= ALPHA_FLOOR &&
      distanceSquared(pixels, offset, color) <= COLOR_TOLERANCE_SQUARED
    ) {
      matching += 1;
    }
  }
  if (matching / offsets.length < UNIFORM_BORDER_SHARE) return { kind: "none" };
  return { kind: "flat", color };
}

/**
 * Mean relative luminance of the artwork itself. A logo shipped as a
 * transparent PNG has no backdrop to inherit, and its ink is just as often
 * near-black as near-white, so the plate has to be chosen from the mark.
 */
function inkLuminance(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  backdrop: Backdrop,
) {
  let total = 0;
  let counted = 0;
  for (let offset = 0; offset < width * height * 4; offset += 4) {
    const alpha = pixels[offset + 3];
    const isContent =
      backdrop.kind === "flat"
        ? alpha >= ALPHA_FLOOR &&
          distanceSquared(pixels, offset, backdrop.color) > COLOR_TOLERANCE_SQUARED
        : alpha >= ALPHA_FLOOR;
    if (!isContent) continue;
    total +=
      (0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]) /
      255;
    counted += 1;
  }
  return counted ? total / counted : 1;
}

function contentBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  backdrop: Backdrop,
) {
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3];
      const isContent =
        backdrop.kind === "flat"
          ? alpha >= ALPHA_FLOOR &&
            distanceSquared(pixels, offset, backdrop.color) > COLOR_TOLERANCE_SQUARED
          : alpha >= ALPHA_FLOOR;
      if (!isContent) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < left || bottom < top) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function scaledCanvas(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The workspace logo could not be decoded."));
    image.src = url;
  });
}

/**
 * Crops the dead margin baked into an uploaded logo and reports the backdrop
 * it was exported onto. Brand logos are routinely delivered as artwork centred
 * in a much larger canvas; drawn as-is into a chrome-sized box, the mark ends
 * up a fraction of the space it was given, floating in a plain rectangle.
 *
 * Every failure path falls back to the untouched source: a logo that cannot be
 * measured still renders, just without the trim.
 */
export async function normalizeLogoRaster(sourceUrl: string): Promise<LogoRaster> {
  const image = await loadImage(sourceUrl);
  const naturalWidth = image.naturalWidth || 1;
  const naturalHeight = image.naturalHeight || 1;
  const untrimmed: LogoRaster = {
    url: sourceUrl,
    ratio: naturalWidth / naturalHeight,
    plate: null,
  };

  const analysis = scaledCanvas(naturalWidth, naturalHeight, ANALYSIS_MAX);
  const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
  if (!analysisContext) return untrimmed;
  analysisContext.drawImage(image, 0, 0, analysis.width, analysis.height);

  let pixels: Uint8ClampedArray;
  try {
    pixels = analysisContext.getImageData(0, 0, analysis.width, analysis.height).data;
  } catch {
    // A tainted canvas only costs us the trim, never the logo itself.
    return untrimmed;
  }

  const backdrop = detectBackdrop(pixels, analysis.width, analysis.height);
  if (backdrop.kind === "none") return untrimmed;
  // Every measurable logo gets a plate. Artwork on a flat backdrop keeps its
  // own colour so plate and mark stay one shape; transparent artwork is given
  // whichever neutral its ink reads against, since the surrounding chrome can
  // be light or dark and the mark cannot adapt to both.
  const plate =
    backdrop.kind === "flat"
      ? `rgb(${backdrop.color.r} ${backdrop.color.g} ${backdrop.color.b})`
      : inkLuminance(pixels, analysis.width, analysis.height, backdrop) < DARK_INK_LUMINANCE
        ? LIGHT_PLATE
        : DARK_PLATE;

  const bounds = contentBounds(pixels, analysis.width, analysis.height, backdrop);
  if (!bounds) return { ...untrimmed, plate };

  const bleed = Math.round(Math.max(analysis.width, analysis.height) * BLEED_SHARE);
  const left = Math.max(0, bounds.left - bleed);
  const top = Math.max(0, bounds.top - bleed);
  const right = Math.min(analysis.width, bounds.left + bounds.width + bleed);
  const bottom = Math.min(analysis.height, bounds.top + bounds.height + bleed);
  const coverage =
    ((right - left) * (bottom - top)) / (analysis.width * analysis.height);
  if (coverage >= ALREADY_TIGHT_COVERAGE) return { ...untrimmed, plate };

  // Map the box found on the thumbnail back onto the full-resolution raster.
  const scaleX = naturalWidth / analysis.width;
  const scaleY = naturalHeight / analysis.height;
  const cropWidth = Math.max(1, (right - left) * scaleX);
  const cropHeight = Math.max(1, (bottom - top) * scaleY);

  const output = scaledCanvas(cropWidth, cropHeight, OUTPUT_MAX);
  const outputContext = output.getContext("2d");
  if (!outputContext) return { ...untrimmed, plate };
  // Left unpainted for transparent artwork: the CSS plate shows through, so the
  // same trimmed raster still works if the plate is ever overridden.
  if (backdrop.kind === "flat") {
    outputContext.fillStyle = plate;
    outputContext.fillRect(0, 0, output.width, output.height);
  }
  outputContext.drawImage(
    image,
    left * scaleX,
    top * scaleY,
    cropWidth,
    cropHeight,
    0,
    0,
    output.width,
    output.height,
  );

  try {
    return { url: output.toDataURL("image/png"), ratio: cropWidth / cropHeight, plate };
  } catch {
    return { ...untrimmed, plate };
  }
}
