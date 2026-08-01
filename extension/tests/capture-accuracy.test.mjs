import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizedClickTarget,
  normalizedFocusRegion,
} from "../src/offscreen/offscreen.js";
import { createInteractionSequencer } from "../src/core/interaction-sequence.js";

test("click points normalize independently of screenshot pixel density", () => {
  assert.deepEqual(
    normalizedClickTarget(
      { x: 320, y: 180 },
      {
        width: 1280,
        height: 720,
        devicePixelRatio: 2,
      },
      "#ef6f47",
    ),
    {
      x: 0.25,
      y: 0.25,
      radius: 0.035,
      color: "#ef6f47",
    },
  );
});

test("click targets clamp to the image boundary and reject invalid geometry", () => {
  assert.deepEqual(
    normalizedClickTarget(
      { x: -10, y: 900 },
      { width: 1000, height: 800 },
      "not-a-color",
    ),
    { x: 0, y: 1, radius: 0.035, color: "#ff5d2e" },
  );
  assert.equal(
    normalizedClickTarget(
      { x: Number.NaN, y: 10 },
      { width: 100, height: 100 },
      "#ef6f47",
    ),
    null,
  );
});

test("clicked element bounds normalize into an editable focus region", () => {
  const centered = normalizedFocusRegion(
    { x: 100, y: 50, width: 200, height: 100 },
    { width: 1000, height: 500, devicePixelRatio: 2 },
  );
  assert.equal(centered.x, 0.1);
  assert.equal(centered.y, 0.1);
  assert.ok(Math.abs(centered.width - 0.2) < Number.EPSILON);
  assert.ok(Math.abs(centered.height - 0.2) < Number.EPSILON);
  assert.deepEqual(
    normalizedFocusRegion(
      { x: -50, y: 700, width: 150, height: 200 },
      { width: 1000, height: 800 },
    ),
    { x: 0, y: 0.875, width: 0.1, height: 0.125 },
  );
  assert.equal(
    normalizedFocusRegion(
      { x: 10, y: 10, width: 0, height: 10 },
      { width: 100, height: 100 },
    ),
    null,
  );
});

test("capture uses primary pointer geometry and keeps the marker editable", async () => {
  const [contentSource, backgroundSource, offscreenSource] = await Promise.all([
    readFile(new URL("../src/content/capture.js", import.meta.url), "utf8"),
    readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
    readFile(new URL("../src/offscreen/offscreen.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    contentSource,
    /addEventListener\("pointerdown", onPointerDown, true\)/,
  );
  assert.match(
    contentSource,
    /addEventListener\("pointermove", onPointerMove, true\)/,
  );
  assert.match(
    contentSource,
    /addEventListener\("pointercancel", onPointerCancel, true\)/,
  );
  assert.match(contentSource, /addEventListener\("click", onClick, true\)/);
  assert.match(contentSource, /event\.isPrimary === false \|\| event\.button !== 0/);
  assert.match(contentSource, /x: event\.clientX/);
  assert.match(contentSource, /y: event\.clientY/);
  assert.match(contentSource, /Math\.hypot\(/);
  assert.match(contentSource, /if \(event\.detail === 0\)/);
  assert.match(contentSource, /targetRect\.x \+ targetRect\.width \/ 2/);
  assert.match(contentSource, /sendCapturedInteraction\(staged\.context\)/);
  const interactionContextSource = contentSource.slice(
    contentSource.indexOf("function targetContext"),
    contentSource.indexOf("function pageContext"),
  );
  assert.doesNotMatch(interactionContextSource, /collectMasks\(/);
  assert.match(backgroundSource, /\{ documentId: request\.documentId \}/);
  assert.match(backgroundSource, /type: "RIVET_VERIFY_DOCUMENT"/);
  assert.match(backgroundSource, /clickPoint: context\.clickPoint/);
  assert.match(backgroundSource, /function clickJobIsLatest\(request\)/);
  assert.match(backgroundSource, /interactionSequencer\.confirm\(state\.sessionId/);
  assert.match(
    backgroundSource,
    /interactionViewport:\s*context\.interactionViewport \|\| request\.viewport \|\| context\.viewport/,
  );
  assert.match(
    offscreenSource,
    /message\.interactionViewport \|\| message\.viewport/,
  );
  assert.doesNotMatch(offscreenSource, /strokeRect\(/);
  assert.match(offscreenSource, /\{ clickTarget \}/);
});

test("newer confirmed clicks supersede older queued capture jobs", () => {
  const sequencer = createInteractionSequencer();
  const firstSequence = sequencer.reserve();
  const secondSequence = sequencer.reserve();

  sequencer.confirm("session-a", secondSequence);
  sequencer.confirm("session-a", firstSequence);

  assert.equal(
    sequencer.isLatest({
      sourceEvent: "click",
      sessionId: "session-a",
      interactionSequence: firstSequence,
    }),
    false,
  );
  assert.equal(
    sequencer.isLatest({
      sourceEvent: "click",
      sessionId: "session-a",
      interactionSequence: secondSequence,
    }),
    true,
  );
  assert.equal(
    sequencer.isLatest({ sourceEvent: "navigation", sessionId: "session-a" }),
    true,
  );
});

test("interaction geometry stays normalized to its original viewport", () => {
  const interactionViewport = { width: 800, height: 600 };
  assert.deepEqual(
    normalizedClickTarget(
      { x: 400, y: 150 },
      interactionViewport,
      "#ef6f47",
    ),
    { x: 0.5, y: 0.25, radius: 0.035, color: "#ef6f47" },
  );
  const focusRegion = normalizedFocusRegion(
    { x: 200, y: 120, width: 400, height: 300 },
    interactionViewport,
  );
  assert.equal(focusRegion.x, 0.25);
  assert.equal(focusRegion.y, 0.2);
  assert.equal(focusRegion.width, 0.5);
  assert.ok(Math.abs(focusRegion.height - 0.5) < Number.EPSILON);
});

test("manifest key derives the exact development extension allowlist", async () => {
  const [manifestText, viteSource, nextSource] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../../next.config.ts", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32);
  const extensionId = Array.from(digest, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  ).join("");

  assert.equal(extensionId, "phbofjenfnnnnndghhinoldlfbpaedpo");
  assert.ok(
    viteSource.includes(
      "^chrome-extension:\\/\\/" + extensionId + "$",
    ),
  );
  assert.ok(nextSource.includes('allowedDevOrigins: ["' + extensionId + '"]'));
  assert.doesNotMatch(viteSource + nextSource, /mdljijkdccpjhbfalkcgpnooffhcnjbb/);
});

test("extension action is configured to open the side panel", async () => {
  const backgroundSource = await readFile(
    new URL("../src/background/index.js", import.meta.url),
    "utf8",
  );
  assert.match(
    backgroundSource,
    /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/,
  );
});
