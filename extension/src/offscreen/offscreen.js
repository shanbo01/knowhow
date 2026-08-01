import { putCapturedStep } from "../core/capture-store.js";
import {
  buildSolidRedactionPlan,
  scaleRect,
} from "../core/redaction.js";

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

    const plan = buildSolidRedactionPlan({
      rects: message.masks || [],
      viewport: message.viewport,
      bitmap: { width: canvas.width, height: canvas.height },
      padding: 5,
    });
    context.fillStyle = "#111827";
    for (const rect of plan) {
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }

    if (message.targetRect) {
      const target = scaleRect(
        message.targetRect,
        message.viewport,
        { width: canvas.width, height: canvas.height },
      );
      context.strokeStyle = validColor(message.clickTargetColor);
      context.lineWidth = Math.max(4, canvas.width / 450);
      context.setLineDash([]);
      context.strokeRect(
        target.x - 3,
        target.y - 3,
        target.width + 6,
        target.height + 6,
      );
    }

    const compressed = await compressCanvas(
      canvas,
      Number(message.limits?.maxScreenshotBytes) || 2_000_000,
    );
    compressedCanvas = compressed.canvas;
    if (compressed.blob.size > Number(message.limits?.maxScreenshotBytes)) {
      throw new Error("Redacted screenshot exceeds the local size limit.");
    }

    await putCapturedStep({
      ...message.step,
      imageBlob: compressed.blob,
      imageWidth: compressedCanvas.width,
      imageHeight: compressedCanvas.height,
      automaticMaskCount: plan.length,
      manualMaskCount: 0,
      updatedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      bytes: compressed.blob.size,
      automaticMaskCount: plan.length,
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.target !== "offscreen" ||
    message.type !== "RIVET_PROCESS_SCREENSHOT"
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
