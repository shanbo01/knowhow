import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const offscreenSource = await readFile(
  new URL("../src/offscreen/offscreen.js", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/core/capture-store.js", import.meta.url),
  "utf8",
);
const liveBlurSource = await readFile(
  new URL("../src/content/capture.css", import.meta.url),
  "utf8",
);
const geometrySource = await readFile(
  new URL("../src/content/blur-geometry.js", import.meta.url),
  "utf8",
);
const captureSource = await readFile(
  new URL("../src/content/capture.js", import.meta.url),
  "utf8",
);

test("stored screenshots destroy character-scale information before persistence", () => {
  assert.match(offscreenSource, /geometry\.privacySampleSize\(expanded\.width, expanded\.height/);
  assert.match(geometrySource, /function privacySampleSize\(/);
  assert.match(
    geometrySource,
    /sampleWidth = Math\.min\(sampleWidth, 4\)/,
  );
  assert.match(offscreenSource, /imageSmoothingQuality = "low"/);
  assert.match(offscreenSource, /imageSmoothingEnabled = false/);
  assert.match(offscreenSource, /washPrivacySample/);
  assert.match(
    offscreenSource,
    /paintPermanentBlur\(context, canvas, region, viewport\)/,
  );
  assert.ok(
    offscreenSource.indexOf(
      "paintPermanentBlur(context, canvas, region, message.viewport)",
    ) < offscreenSource.indexOf("const compressed = await compressCanvas("),
    "privacy rasterization must happen before encoding and storage",
  );
});

test("raw screenshot material is disposed and cannot enter IndexedDB", () => {
  assert.match(offscreenSource, /message\.dataUrl = null/);
  assert.match(offscreenSource, /ephemeralBlob = null/);
  assert.match(offscreenSource, /canvas\.width = 1/);
  assert.match(offscreenSource, /softened\.width = 1/);
  assert.doesNotMatch(storeSource, /dataUrl/);
  assert.doesNotMatch(storeSource, /raw(?:Image|Screenshot|Pixels)/i);
});

test("live blur frosts page pixels in tight rects instead of gray circular slabs", () => {
  assert.match(offscreenSource, /saturate\(72%\) contrast\(95%\)/);
  assert.match(offscreenSource, /globalAlpha = layer\.alpha/);
  assert.match(offscreenSource, /roundedClip/);
  assert.match(offscreenSource, /const halo = 0/);
  assert.match(offscreenSource, /geometry\.maskRadius\(/);
  assert.doesNotMatch(offscreenSource, /fillRect\(/);
  assert.doesNotMatch(
    offscreenSource,
    /min\(core\.width, core\.height\) \* 0\.5/,
  );
  assert.match(liveBlurSource, /\[data-knowhow-blurred\]:not\(\.knowhow-blur-revealed\)/);
  assert.match(liveBlurSource, /filter:\s*blur\(8px\)\s*!important/);
  assert.match(liveBlurSource, /backdrop-filter:\s*blur\(6px\)/);
  assert.match(liveBlurSource, /--knowhow-blur-halo: 0px/);
  assert.match(liveBlurSource, /overflow: hidden/);
  assert.match(liveBlurSource, /background: rgba\(72, 72, 78, 0\.9\)/);
  assert.doesNotMatch(liveBlurSource, /background-color: rgba\(88, 88, 94, 0\.88\)/);
  assert.match(liveBlurSource, /transition:\s*none/);
  assert.doesNotMatch(liveBlurSource, /transition:\s*opacity 120ms/);
  assert.match(liveBlurSource, /\.knowhow-blur-revealed[^}]*opacity:\s*0/s);
  assert.match(geometrySource, /padding: 1/);
  assert.match(geometrySource, /function maskRadius\(/);
  assert.match(
    geometrySource,
    /if \(!COMPACT_REASONS\.has\(rect\?\.reason\)\) return 2/,
  );
  assert.match(captureSource, /tr, \[role=row\]/);
  assert.match(captureSource, /textMasksInElement\(row, "table-row"\)/);
  assert.doesNotMatch(captureSource, /rectFor\(row, "table-row"\)/);
  assert.match(captureSource, /function clipToOverflowAncestors\(/);
  assert.match(captureSource, /function clipAgainstOccludingChrome\(/);
  assert.match(
    liveBlurSource,
    /\[data-knowhow-overlay="smart-blur-preview"\]\[data-knowhow-scroller\]/,
  );
  assert.match(captureSource, /function ensureScrollerOverlayRoot\(/);
  assert.match(captureSource, /geometry\.maskRadius\(mask\)/);
  assert.match(captureSource, /lastOverlaySignature/);
  assert.doesNotMatch(geometrySource, /"table-row"/);
  assert.doesNotMatch(
    captureSource,
    /addEventListener\("scroll", \(\) => noteVisualChange/,
  );
  assert.match(captureSource, /const maxWait = 24/);
  assert.match(captureSource, /KNOWHOW_WAKE_SMART_BLUR/);
  assert.match(captureSource, /scheduleBlurPreview\(liveOverlayScrolling \? 80 : 48\)/);
  assert.match(captureSource, /function showPrivacyVeil\(/);
  assert.match(captureSource, /function blurRevealRow\(/);
  assert.match(offscreenSource, /if \(region\.cover === "filter"\) continue/);
  assert.match(liveBlurSource, /\[data-knowhow-overlay="privacy-veil"\]/);
  assert.match(captureSource, /cover: mask.host \? "filter" : "overlay"/);
  assert.match(captureSource, /function tightBlurHost\(/);
  assert.match(captureSource, /function isLeafBlurHost\(/);
  assert.match(captureSource, /svg,\[role=img\]/);
  assert.match(captureSource, /function exclusionCoversMask\(/);
  assert.doesNotMatch(
    captureSource.slice(
      captureSource.indexOf("function exclusionCoversMask"),
      captureSource.indexOf("function collectMasks"),
    ),
    /password-field/,
  );
  assert.match(
    captureSource.slice(
      captureSource.indexOf("function formFieldMasks"),
      captureSource.indexOf("function rangeFindings"),
    ),
    /if \(state.policy.redactFormFields === true\)/,
  );
  assert.match(
    captureSource.slice(
      captureSource.indexOf("function embeddedFrameMasks"),
      captureSource.indexOf("function isInboxStyleRow"),
    ),
    /redactImages !== true/,
  );
  assert.doesNotMatch(captureSource, /redactCommonNames === true/);
  assert.match(captureSource, /Unblur elements/);
  assert.match(captureSource, /\["redactEmails", "Email"\]/);
  assert.match(captureSource, /\["redactAllNumbers", "Number"\]/);
  assert.doesNotMatch(captureSource, /Hover to reveal on this page/);
  assert.doesNotMatch(captureSource, /areas covered on this screen/);
  assert.match(captureSource, /KNOWHOW_WAIT_PAGE_SETTLED/);
  assert.match(
    captureSource,
    /if \(!liveOverlayScrolling\) schedulePreparedFrame\(0\)/,
  );
  assert.match(captureSource, /function inPage\(/);
  assert.match(captureSource, /function selectLiveHosts\(/);
  assert.match(captureSource, /MAX_LIVE_HOSTS = 240/);
  assert.match(captureSource, /"src",\s*"srcset"/);
  assert.match(captureSource, /\[role=tab\]/);
  assert.match(captureSource, /lastSerializableMasks/);
  assert.match(captureSource, /function serializableMasks\(/);
  assert.match(captureSource, /filter\(maskIntersectsViewport\)/);
  assert.match(geometrySource, /const hosted = rect\?\.host != null/);
  assert.doesNotMatch(
    captureSource.slice(
      captureSource.indexOf("function optionalSurfaceMasks"),
      captureSource.indexOf("const manualSelections"),
    ),
    /if \(!visible\(row\)/,
  );
  assert.match(captureSource, /data-knowhow-blurred/);
  assert.match(captureSource, /function syncElementBlurs\(/);
  assert.match(geometrySource, /left\.host !== right\.host/);
  assert.match(captureSource, /clipToOverflowAncestors\(box, owner\)/);
  assert.doesNotMatch(captureSource, /surroundContents/);
});

test("live and baked masks share radius and destroy glyph-scale samples", async () => {
  await import("../src/content/blur-geometry.js");
  const geometry = globalThis.__KNOWHOW_BLUR_GEOMETRY__;
  assert.equal(
    geometry.maskRadius({ reason: "long-text", width: 800, height: 18 }),
    2,
  );
  assert.equal(
    geometry.maskRadius({ reason: "image", width: 180, height: 180 }),
    8,
  );
  assert.equal(
    geometry.maskRadius({ reason: "image", width: 48, height: 48 }),
    24,
  );
  const textSample = geometry.privacySampleSize(800, 18, {
    surface: false,
    cssScale: 2,
  });
  assert.ok(textSample.width <= 4);
  assert.ok(textSample.height <= 2);
});
