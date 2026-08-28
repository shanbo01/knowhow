import type { EditorBlock } from "./knowhow-types";
import { paintRasterRedaction, redactionBlockSize } from "./redaction-raster";

export type FlattenedScreenshot = {
  blob: Blob;
  width: number;
  height: number;
  patch: Pick<EditorBlock, "crop" | "annotations" | "redactions">;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A guide's screenshots need pixel-flattening exactly once, the first time
 * its working revision is submitted for review: any crop framing and any
 * still-reversible blur regions must be baked into the raster before the
 * guide's `screenshotsLockedAt` is set server-side.
 */
export function needsFlattening(block: EditorBlock): boolean {
  const crop = block.crop;
  const hasCrop = Boolean(
    crop && (crop.width < 0.999 || crop.height < 0.999 || crop.x > 0.001 || crop.y > 0.001),
  );
  const hasUnappliedRedaction = (block.redactions ?? []).some((region) => !region.applied);
  return hasCrop || hasUnappliedRedaction;
}

/**
 * Bakes the current crop framing and any pending (non-destructive) blur
 * regions into a fresh raster, ported from the extension's retired
 * review.js `drawBlur`/crop pipeline. Annotation and redaction coordinates
 * are remapped from full-source-image space into the new, cropped image's
 * own coordinate space; regions that fall entirely outside the crop are
 * dropped since they're no longer visible.
 */
export async function flattenScreenshot(
  imageUrl: string,
  block: EditorBlock,
): Promise<FlattenedScreenshot> {
  const sourceBlob = await fetch(imageUrl).then((response) => response.blob());
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const crop = block.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const cropX = Math.round(crop.x * bitmap.width);
    const cropY = Math.round(crop.y * bitmap.height);
    const cropWidth = Math.max(1, Math.round(crop.width * bitmap.width));
    const cropHeight = Math.max(1, Math.round(crop.height * bitmap.height));

    const canvas = document.createElement("canvas");
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the screenshot.");
    context.drawImage(bitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const blurPx = redactionBlockSize(cropWidth, cropHeight);
    const redactionScratch = document.createElement("canvas");
    for (const region of block.redactions ?? []) {
      if (region.applied) continue;
      const left = clamp((region.x - crop.x) / crop.width, 0, 1);
      const top = clamp((region.y - crop.y) / crop.height, 0, 1);
      const right = clamp((region.x + region.width - crop.x) / crop.width, 0, 1);
      const bottom = clamp((region.y + region.height - crop.y) / crop.height, 0, 1);
      const destX = left * cropWidth;
      const destY = top * cropHeight;
      const destWidth = (right - left) * cropWidth;
      const destHeight = (bottom - top) * cropHeight;
      if (destWidth <= 0 || destHeight <= 0) continue;
      paintRasterRedaction(
        context,
        bitmap,
        {
          x: cropX + destX,
          y: cropY + destY,
          width: destWidth,
          height: destHeight,
        },
        { x: destX, y: destY, width: destWidth, height: destHeight },
        blurPx,
        redactionScratch,
      );
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (next) => (next ? resolve(next) : reject(new Error("The screenshot could not be encoded."))),
        "image/jpeg",
        0.92,
      );
    });

    const annotations = (block.annotations ?? [])
      .map((annotation) => ({
        ...annotation,
        x: (annotation.x - crop.x) / crop.width,
        y: (annotation.y - crop.y) / crop.height,
        width: annotation.width !== undefined ? annotation.width / crop.width : undefined,
        height: annotation.height !== undefined ? annotation.height / crop.height : undefined,
      }))
      .filter((annotation) => annotation.x >= -0.005 && annotation.y >= -0.005 && annotation.x <= 1.005 && annotation.y <= 1.005)
      .map((annotation) => ({
        ...annotation,
        x: clamp(annotation.x, 0, 1),
        y: clamp(annotation.y, 0, 1),
      }));

    const redactions = (block.redactions ?? [])
      .map((region) => ({
        ...region,
        x: clamp((region.x - crop.x) / crop.width, 0, 1),
        y: clamp((region.y - crop.y) / crop.height, 0, 1),
        width: clamp(region.width / crop.width, 0, 1),
        height: clamp(region.height / crop.height, 0, 1),
        applied: true,
      }))
      .filter((region) => region.width > 0.002 && region.height > 0.002);

    return {
      blob,
      width: cropWidth,
      height: cropHeight,
      patch: { crop: undefined, annotations, redactions },
    };
  } finally {
    bitmap.close();
  }
}
