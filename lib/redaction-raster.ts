export type RasterRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MIN_SAMPLE_DIMENSION = 2;

/**
 * Redaction previews deliberately retain far fewer samples than the source.
 * The result therefore stays obscured even when a browser ignores its
 * optional canvas blur filter.
 */
export function redactionSampleDimensions(
  width: number,
  height: number,
  blockSize: number,
) {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
  const safeBlockSize = Number.isFinite(blockSize) ? Math.max(4, blockSize) : 4;
  return {
    width: Math.max(
      1,
      Math.min(safeWidth, Math.max(MIN_SAMPLE_DIMENSION, Math.ceil(safeWidth / safeBlockSize))),
    ),
    height: Math.max(
      1,
      Math.min(safeHeight, Math.max(MIN_SAMPLE_DIMENSION, Math.ceil(safeHeight / safeBlockSize))),
    ),
  };
}

/**
 * How coarse a redaction is, in source-image pixels. Shared so the editor's
 * live preview and the flattened result resolve to the same grid: a preview
 * that is smoother or blockier than what gets baked is a preview that lies
 * about what the reader will see.
 */
export function redactionBlockSize(cropWidth: number, cropHeight: number) {
  const width = Number.isFinite(cropWidth) ? cropWidth : 0;
  const height = Number.isFinite(cropHeight) ? cropHeight : 0;
  return Math.max(12, Math.min(width, height) * 0.02);
}

/**
 * Paints an actually resampled redaction into the destination canvas.
 * Downsampling is the privacy guarantee; the second, filtered pass only
 * softens the enlarged samples so the result reads visually as a blur.
 *
 * `blockSize` is measured in *source* pixels, so the same region resolves to
 * the same number of samples whether it is being drawn at screen size for the
 * editor or at full size for the bake.
 */
export function paintRasterRedaction(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceRect: RasterRect,
  destinationRect: RasterRect,
  blockSize: number,
  scratch: HTMLCanvasElement,
) {
  if (
    sourceRect.width <= 0 ||
    sourceRect.height <= 0 ||
    destinationRect.width <= 0 ||
    destinationRect.height <= 0
  ) {
    return;
  }

  const sample = redactionSampleDimensions(
    sourceRect.width,
    sourceRect.height,
    blockSize,
  );
  // The softening pass is cosmetic and has to be expressed in destination
  // pixels. When the destination is the full-size raster this is 1 and the
  // baked result is unchanged; when it is a scaled-down editor preview it
  // keeps the softness proportional instead of over-blurring the preview.
  const destinationScale =
    sourceRect.width > 0 ? destinationRect.width / sourceRect.width : 1;
  scratch.width = sample.width;
  scratch.height = sample.height;
  const scratchContext = scratch.getContext("2d");
  if (!scratchContext) return;

  scratchContext.clearRect(0, 0, sample.width, sample.height);
  scratchContext.imageSmoothingEnabled = true;
  scratchContext.imageSmoothingQuality = "high";
  scratchContext.drawImage(
    source,
    sourceRect.x,
    sourceRect.y,
    sourceRect.width,
    sourceRect.height,
    0,
    0,
    sample.width,
    sample.height,
  );

  context.save();
  context.beginPath();
  context.rect(
    destinationRect.x,
    destinationRect.y,
    destinationRect.width,
    destinationRect.height,
  );
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    scratch,
    0,
    0,
    sample.width,
    sample.height,
    destinationRect.x,
    destinationRect.y,
    destinationRect.width,
    destinationRect.height,
  );

  // This pass is cosmetic. If `filter` is unsupported, the resampled first
  // pass above still guarantees the selected pixels are not reproduced.
  context.filter = `blur(${Math.max(2, Math.min(14, blockSize * 0.44 * destinationScale))}px) saturate(72%) contrast(95%)`;
  context.globalAlpha = 0.96;
  context.drawImage(
    scratch,
    0,
    0,
    sample.width,
    sample.height,
    destinationRect.x,
    destinationRect.y,
    destinationRect.width,
    destinationRect.height,
  );
  context.restore();
}
