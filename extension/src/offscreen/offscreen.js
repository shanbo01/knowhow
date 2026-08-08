import { putCapturedStep } from "../core/capture-store.js";
import { buildPendingRedactionRegions } from "../core/redaction.js";

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
    : "#ff5d2e";
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedClickTarget(clickPoint, viewport, color) {
  const x = Number(clickPoint?.x);
  const y = Number(clickPoint?.y);
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
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
    x: clamp(x / width, 0, 1),
    y: clamp(y / height, 0, 1),
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

async function processScreenshot(message) {
  let bitmap;
  let canvas;
  let compressedCanvas;
  try {
    const rawBlob = await (await fetch(message.dataUrl)).blob();
    bitmap = await createImageBitmap(rawBlob);
    const maximumWidth = 1920;
    const scale = Math.min(1, maximumWidth / bitmap.width);
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // Redactions are no longer baked into pixels here. The masked regions
    // are captured as normalized, reversible metadata; the author reviews
    // and (un)blurs them in the app editor. They only become permanent once
    // the guide's first review submission flattens the pixels server-side.
    const redactions = buildPendingRedactionRegions({
      rects: message.masks || [],
      viewport: message.viewport,
      padding: 5,
    });

    const compressed = await compressCanvas(
      canvas,
      Number(message.limits?.maxScreenshotBytes) || 2_000_000,
    );
    compressedCanvas = compressed.canvas;
    if (compressed.blob.size > Number(message.limits?.maxScreenshotBytes)) {
      throw new Error("Redacted screenshot exceeds the local size limit.");
    }

    const clickTarget = normalizedClickTarget(
      message.clickPoint,
      message.interactionViewport || message.viewport,
      message.clickTargetColor,
    );
    const focusRegion = normalizedFocusRegion(
      message.targetRect,
      message.interactionViewport || message.viewport,
    );
    await putCapturedStep({
      ...message.step,
      ...(clickTarget ? { clickTarget } : {}),
      ...(focusRegion ? { focusRegion } : {}),
      imageBlob: compressed.blob,
      imageWidth: compressedCanvas.width,
      imageHeight: compressedCanvas.height,
      pendingRedactions: redactions,
      automaticMaskCount: 0,
      manualMaskCount: 0,
      updatedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      bytes: compressed.blob.size,
      automaticMaskCount: 0,
      pendingRedactionCount: redactions.length,
    };
  } finally {
    if (bitmap) bitmap.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    if (compressedCanvas && compressedCanvas !== canvas) {
      compressedCanvas.width = 1;
      compressedCanvas.height = 1;
    }
    message.dataUrl = null;
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      message?.target !== "offscreen" ||
      message.type !== "KNOWHOW_PROCESS_SCREENSHOT"
    ) {
      return false;
    }
    processScreenshot(message)
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
