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
 * Paints an actually resampled redaction into the destination canvas.
 * Downsampling is the privacy guarantee; the second, filtered pass only
 * softens the enlarged samples so the result reads visually as a blur.
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
    destinationRect.width,
    destinationRect.height,
    blockSize,
  );
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
  context.filter = `blur(${Math.max(2, Math.min(10, blockSize * 0.32))}px)`;
  context.globalAlpha = 0.9;
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
