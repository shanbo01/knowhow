import "../content/blur-geometry.js";
import {
  getCaptureFrame,
  promoteCaptureFrame,
  putCapturedStep,
  putCaptureFrame,
} from "../core/capture-store.js";
import { contextualCrop } from "../core/presentation.js";

const geometry = globalThis.__KNOWHOW_BLUR_GEOMETRY__;
if (
  !geometry?.normalizeAndMergeMasks ||
  !geometry.maskRadius ||
  !geometry.privacySampleSize
) {
  throw new Error("KnowHow blur geometry did not initialize.");
}

let privacySampleCanvas;
let privacySoftenedCanvas;

function privacyScratch(kind) {
  if (kind === "sample") {
    privacySampleCanvas ||= document.createElement("canvas");
    return privacySampleCanvas;
  }
  privacySoftenedCanvas ||= document.createElement("canvas");
  return privacySoftenedCanvas;
}

function canvasBlob(canvas, type = "image/jpeg", quality = 0.86) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Canvas encoding failed.")),
      type,
      quality,
    );
  });
}

function validColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""))
    ? value
    : "#d97706";
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedClickTarget(clickPoint, viewport, color) {
  const x = Number(clickPoint?.x);
  const y = Number(clickPoint?.y);
  const visual = viewport?.visualViewport;
  const offsetX = Number(visual?.offsetX) || 0;
  const offsetY = Number(visual?.offsetY) || 0;
  const width = Number(visual?.width || viewport?.width);
  const height = Number(visual?.height || viewport?.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: clamp((x - offsetX) / width, 0, 1),
    y: clamp((y - offsetY) / height, 0, 1),
    radius: 0.035,
    color: validColor(color),
  };
}

export function normalizedFocusRegion(targetRect, viewport) {
  const x = Number(targetRect?.x);
  const y = Number(targetRect?.y);
  const regionWidth = Number(targetRect?.width);
  const regionHeight = Number(targetRect?.height);
  const viewportWidth = Number(viewport?.width);
  const viewportHeight = Number(viewport?.height);
  if (
    ![x, y, regionWidth, regionHeight, viewportWidth, viewportHeight].every(
      Number.isFinite,
    ) ||
    regionWidth <= 0 ||
    regionHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return null;
  }
  const left = clamp(x / viewportWidth, 0, 1);
  const top = clamp(y / viewportHeight, 0, 1);
  const right = clamp((x + regionWidth) / viewportWidth, left, 1);
  const bottom = clamp((y + regionHeight) / viewportHeight, top, 1);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function normalizedRedactions(rects, viewport) {
  const width = Math.max(1, Number(viewport?.width) || 1);
  const height = Math.max(1, Number(viewport?.height) || 1);
  return geometry
    .normalizeAndMergeMasks(rects, { width, height }, { padding: 0 })
    .map((rect, index) => {
      const x = clamp(rect.x / width, 0, 1);
      const y = clamp(rect.y / height, 0, 1);
      return {
        id: `applied_${index}_${Math.round(rect.x)}_${Math.round(rect.y)}`,
        x,
        y,
        width: clamp(rect.width / width, 0, 1 - x),
        height: clamp(rect.height / height, 0, 1 - y),
        applied: true,
        reason: rect.reason,
        ...(rect.cover === "filter" || rect.cover === "overlay"
          ? { cover: rect.cover }
          : {}),
        ...(rect.manual === true ? { manual: true } : {}),
      };
    })
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

function washPrivacySample(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const amount = 0.52;
  const gray = 82;
  const keep = 1 - amount;
  const pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = pixels[index] * keep + gray * amount;
    pixels[index + 1] = pixels[index + 1] * keep + gray * amount;
    pixels[index + 2] = pixels[index + 2] * keep + gray * amount;
  }
  context.putImageData(image, 0, 0);
}

function roundedClip(context, rect, radius) {
  context.beginPath();
  if (radius > 0) {
    context.roundRect(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      Math.min(radius, rect.width / 2, rect.height / 2),
    );
  } else {
    context.rect(rect.x, rect.y, rect.width, rect.height);
  }
  context.clip();
}

/**
 * Permanently removes useful character detail while retaining the colors and
 * luminance of the covered surface. Downsampling is the privacy boundary.
 * The bake stays ink-tight: no halo is painted outside the mask, and the
 * corner radius matches the live Smart Blur preview.
 */
export function paintPermanentBlur(context, canvas, region, viewport) {
  const core = {
    x: Math.floor(region.x * canvas.width),
    y: Math.floor(region.y * canvas.height),
    width: Math.ceil(region.width * canvas.width),
    height: Math.ceil(region.height * canvas.height),
  };
  if (core.width <= 0 || core.height <= 0) return;

  const halo = 0;
  const blurRadius = 8;
  const sampleMargin = halo + blurRadius;
  const expanded = {
    x: Math.max(0, core.x - sampleMargin),
    y: Math.max(0, core.y - sampleMargin),
    width:
      Math.min(canvas.width, core.x + core.width + sampleMargin) -
      Math.max(0, core.x - sampleMargin),
    height:
      Math.min(canvas.height, core.y + core.height + sampleMargin) -
      Math.max(0, core.y - sampleMargin),
  };

  const cssWidth = Math.max(1, Number(viewport?.width) || canvas.width);
  const cssHeight = Math.max(1, Number(viewport?.height) || canvas.height);
  const cssScale = canvas.width / cssWidth;
  const surface =
    region.manual === true ||
    geometry.isSurfaceReason?.(region.reason) === true;
  const sampleSize = geometry.privacySampleSize(expanded.width, expanded.height, {
    surface,
    cssScale,
  });
  const sample = privacyScratch("sample");
  sample.width = sampleSize.width;
  sample.height = sampleSize.height;
  const sampleContext = sample.getContext("2d", { alpha: false });
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.imageSmoothingQuality = "low";
  sampleContext.drawImage(
    canvas,
    expanded.x,
    expanded.y,
    expanded.width,
    expanded.height,
    0,
    0,
    sample.width,
    sample.height,
  );
  washPrivacySample(sampleContext, sample.width, sample.height);

  const softened = privacyScratch("softened");
  softened.width = Math.max(1, expanded.width);
  softened.height = Math.max(1, expanded.height);
  const softenedContext = softened.getContext("2d");
  softenedContext.imageSmoothingEnabled = false;
  softenedContext.filter = `blur(${blurRadius}px) saturate(72%) contrast(95%)`;
  softenedContext.drawImage(sample, 0, 0, softened.width, softened.height);
  softenedContext.filter = "none";

  const radius =
    geometry.maskRadius({
      width: region.width * cssWidth,
      height: region.height * cssHeight,
      reason: region.reason,
      manual: region.manual,
    }) * cssScale;

  const layers = [{ inset: 0, alpha: 1 }];
  for (const layer of layers) {
    const rect = {
      x: Math.max(expanded.x, core.x + layer.inset),
      y: Math.max(expanded.y, core.y + layer.inset),
      width: 0,
      height: 0,
    };
    const right = Math.min(
      expanded.x + expanded.width,
      core.x + core.width - layer.inset,
    );
    const bottom = Math.min(
      expanded.y + expanded.height,
      core.y + core.height - layer.inset,
    );
    rect.width = Math.max(0, right - rect.x);
    rect.height = Math.max(0, bottom - rect.y);
    if (!rect.width || !rect.height) continue;
    context.save();
    context.globalAlpha = layer.alpha;
    roundedClip(context, rect, radius);
    context.drawImage(softened, expanded.x, expanded.y);
    context.restore();
  }

  sample.width = 1;
  sample.height = 1;
  softened.width = 1;
  softened.height = 1;
}

async function compressCanvas(canvas, maxBytes) {
  let working = canvas;
  let blob = await canvasBlob(working, "image/jpeg", 0.86);
  let attempts = 0;
  while (blob.size > maxBytes && attempts < 3) {
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(640, Math.round(working.width * 0.8));
    smaller.height = Math.max(360, Math.round(working.height * 0.8));
    smaller
      .getContext("2d", { alpha: false })
      .drawImage(working, 0, 0, smaller.width, smaller.height);
    if (working !== canvas) {
      working.width = 1;
      working.height = 1;
    }
    working = smaller;
    blob = await canvasBlob(working, "image/jpeg", 0.76 - attempts * 0.1);
    attempts += 1;
  }
  return { blob, canvas: working };
}

async function renderPrivateRaster(message) {
  let bitmap;
  let canvas;
  let compressedCanvas;
  let ephemeralBlob;
  try {
    ephemeralBlob = await (await fetch(message.dataUrl)).blob();
    bitmap = await createImageBitmap(ephemeralBlob);
    const maximumWidth = 1920;
    const scale = Math.min(1, maximumWidth / bitmap.width);
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const redactions = normalizedRedactions(
      message.masks || [],
      message.viewport,
    );
    for (const region of redactions) {
      if (region.cover === "filter") continue;
      paintPermanentBlur(context, canvas, region, message.viewport);
    }

    const compressed = await compressCanvas(
      canvas,
      Number(message.limits?.maxScreenshotBytes) || 2_000_000,
    );
    compressedCanvas = compressed.canvas;
    if (compressed.blob.size > Number(message.limits?.maxScreenshotBytes)) {
      throw new Error("Redacted screenshot exceeds the local size limit.");
    }

    const bakedRedactions = redactions.filter(
      (region) => region.cover !== "filter",
    );
    return {
      imageBlob: compressed.blob,
      imageWidth: compressedCanvas.width,
      imageHeight: compressedCanvas.height,
      pendingRedactions: bakedRedactions,
      automaticMaskCount: redactions.filter(
        (region) => region.manual !== true,
      ).length,
      manualMaskCount: redactions.filter((region) => region.manual === true)
        .length,
    };
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    if (compressedCanvas && compressedCanvas !== canvas) {
      compressedCanvas.width = 1;
      compressedCanvas.height = 1;
    }
    ephemeralBlob = null;
    message.dataUrl = null;
  }
}

function presentationPatch(message, imageWidth, imageHeight) {
  const clickTarget = normalizedClickTarget(
    message.clickPoint,
    message.interactionViewport || message.viewport,
    message.clickTargetColor,
  );
  const focusRegion = normalizedFocusRegion(
    message.targetRect,
    message.interactionViewport || message.viewport,
  );
  const crop = contextualCrop({
    clickTarget,
    focusRegion,
    imageWidth,
    imageHeight,
  });
  return {
    ...(clickTarget ? { clickTarget } : {}),
    ...(focusRegion ? { focusRegion } : {}),
    ...(clickTarget || focusRegion ? { crop } : {}),
  };
}

async function processScreenshot(message) {
  const raster = await renderPrivateRaster(message);
  const step = {
    ...message.step,
    ...presentationPatch(message, raster.imageWidth, raster.imageHeight),
    ...raster,
    updatedAt: new Date().toISOString(),
  };
  await putCapturedStep(step);
  return {
    ok: true,
    bytes: raster.imageBlob.size,
    automaticMaskCount: raster.automaticMaskCount,
    manualMaskCount: raster.manualMaskCount,
    pendingRedactionCount: raster.pendingRedactions.length,
  };
}

async function processCaptureFrame(message) {
  const raster = await renderPrivateRaster(message);
  await putCaptureFrame({
    ...message.frame,
    ...raster,
    createdAtMs: Number(message.frame?.createdAtMs) || Date.now(),
    updatedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    frameId: message.frame.id,
    bytes: raster.imageBlob.size,
    automaticMaskCount: raster.automaticMaskCount,
    manualMaskCount: raster.manualMaskCount,
  };
}

async function commitCaptureFrame(message) {
  const frame = await getCaptureFrame(message.sessionId, message.frameId);
  if (!frame) {
    throw new Error("The pre-action screenshot is no longer available.");
  }
  const step = {
    ...message.step,
    ...presentationPatch(message, frame.imageWidth, frame.imageHeight),
  };
  await promoteCaptureFrame(message.sessionId, message.frameId, step);
  return { ok: true, stepId: step.id };
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;
    const operation =
      message.type === "KNOWHOW_PROCESS_SCREENSHOT"
        ? processScreenshot(message)
        : message.type === "KNOWHOW_PROCESS_CAPTURE_FRAME"
          ? processCaptureFrame(message)
          : message.type === "KNOWHOW_COMMIT_CAPTURE_FRAME"
            ? commitCaptureFrame(message)
            : null;
    if (!operation) return false;
    operation
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Redaction failed.",
        }),
      );
    return true;
  });
}
