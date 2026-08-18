import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureOrigin = `http://127.0.0.1:${process.env.KNOWHOW_E2E_PORT || "43117"}`;

async function installRecorder(page, theme, options = {}) {
  await page.goto(
    `${fixtureOrigin}/e2e/fixtures/${
      options.fixture || `capture-${theme}.html`
    }`,
  );
  await page.evaluate(() => {
    const listeners = [];
    const messages = [];
    let frameSequence = 0;
    const runtime = {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
          globalThis.__khContentListener = listener;
        },
      },
      async sendMessage(message) {
        const menu = document.querySelector("#menu");
        messages.push({
          ...message,
          menuOpenAtSend: Boolean(menu && !menu.hidden),
          revealedAtSend: document.querySelectorAll(
            ".knowhow-blur-revealed",
          ).length,
          captureUiVisibleAtSend: [...document.querySelectorAll(
            "[data-knowhow-ui],[data-knowhow-overlay=element-picker]",
          )].some((element) => getComputedStyle(element).visibility !== "hidden"),
        });
        if (message.type === "PREPARE_CAPTURE_FRAME") {
          frameSequence += 1;
          return {
            ok: true,
            frameId: `frame-${frameSequence}`,
            capturedAtMs: Date.now(),
            navigationKey: message.navigationKey,
          };
        }
        return { ok: true };
      },
    };
    globalThis.chrome = { runtime };
    globalThis.__khMessages = messages;
    globalThis.__khRuntimeListeners = listeners;
  });
  await page.addStyleTag({
    path: resolve(extensionRoot, "src", "content", "capture.css"),
  });
  await page.addScriptTag({
    path: resolve(extensionRoot, "src", "content", "blur-geometry.js"),
  });
  await page.addScriptTag({
    path: resolve(extensionRoot, "src", "content", "page-settled.js"),
  });
  await page.addScriptTag({
    path: resolve(extensionRoot, "src", "content", "capture.js"),
  });
  await page.evaluate(
    ({ policy, status }) =>
      new Promise((resolveConfiguration) => {
        globalThis.__khContentListener(
          {
            type: "KNOWHOW_CONFIGURE",
            sessionId: "playwright-session",
            status,
            documentId: "playwright-document",
            navigationKey: "fixture-route",
            policy,
          },
          {},
          resolveConfiguration,
        );
      }),
    {
      status: options.status || "recording",
      policy: {
        smartBlurEnabled: true,
        redactEmails: true,
        redactFormFields: true,
        showRecordingIndicator: false,
        ...options.policy,
      },
    },
  );
  if ((options.status || "recording") === "recording") {
    await page.waitForFunction(() =>
      globalThis.__khMessages.some(
        (message) => message.type === "PREPARE_CAPTURE_FRAME",
      ),
    );
  }
}

function messagesOfType(page, type) {
  return page.evaluate(
    (messageType) =>
      globalThis.__khMessages.filter(
        (message) => message.type === messageType,
      ),
    type,
  );
}

async function clickThroughPicker(page, selector) {
  const bounds = await page.locator(selector).boundingBox();
  expect(bounds).toBeTruthy();
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
}

for (const theme of ["light", "dark"]) {
  test(`${theme}: dropdown steps use the correct pre-action visual state`, async ({
    page,
  }) => {
    await installRecorder(page, theme);

    await page.locator("#dropdown").click();
    await expect(page.locator("#menu")).toBeVisible();
    let stages = await messagesOfType(page, "STAGE_INTERACTION");
    expect(stages.at(-1).menuOpenAtSend).toBe(false);
    expect(stages.at(-1).frameId).toBeTruthy();

    const preparedAfterTrigger = (
      await messagesOfType(page, "PREPARE_CAPTURE_FRAME")
    ).length;
    await page.waitForFunction(
      (count) =>
        globalThis.__khMessages.filter(
          (message) => message.type === "PREPARE_CAPTURE_FRAME",
        ).length > count,
      preparedAfterTrigger,
    );
    await page.locator("#option").click();
    await expect(page.locator("#menu")).toBeHidden();
    stages = await messagesOfType(page, "STAGE_INTERACTION");
    expect(stages.at(-1).menuOpenAtSend).toBe(true);

    const preparedAfterOption = (
      await messagesOfType(page, "PREPARE_CAPTURE_FRAME")
    ).length;
    await page.waitForFunction(
      (count) =>
        globalThis.__khMessages.filter(
          (message) => message.type === "PREPARE_CAPTURE_FRAME",
        ).length > count,
      preparedAfterOption,
    );
    await page.locator("#following").click();
    stages = await messagesOfType(page, "STAGE_INTERACTION");
    expect(stages.at(-1).menuOpenAtSend).toBe(false);

    const commits = await messagesOfType(page, "COMMIT_INTERACTION");
    const commitIds = commits.map((message) => message.interactionId);
    expect(new Set(commitIds).size).toBe(3);
    for (const interactionId of new Set(commitIds)) {
      expect(commitIds.filter((id) => id === interactionId)).toHaveLength(2);
    }
    const prepared = await messagesOfType(page, "PREPARE_CAPTURE_FRAME");
    expect(prepared.length).toBeGreaterThan(0);
    expect(stages.every((message) => !message.captureUiVisibleAtSend)).toBe(
      true,
    );
  });

  test(`${theme}: picker multi-select blocks page actions and follows replacement DOM`, async ({
    page,
  }) => {
    await installRecorder(page, theme);
    const stagesBefore = (await messagesOfType(page, "STAGE_INTERACTION")).length;

    await page.locator("[data-knowhow-blur-trigger]").click();
    await page.locator("[data-knowhow-manual-count]").click();
    await clickThroughPicker(page, "#manual-one");
    await clickThroughPicker(page, "#manual-two");
    await clickThroughPicker(page, "#manual-two");
    await clickThroughPicker(page, "#manual-two");
    await page.locator("[data-knowhow-picker-undo]").click();
    await clickThroughPicker(page, "#manual-two");

    await page.evaluate(() => {
      const current = document.querySelector("#manual-one");
      const replacement = current.cloneNode(true);
      current.replaceWith(replacement);
    });
    await expect
      .poll(() =>
        page.locator('[data-knowhow-mask-reason="manual-element"]').count(),
      )
      .toBeGreaterThan(0);

    await page.locator("[data-knowhow-picker-clear]").click();
    await clickThroughPicker(page, "#manual-one");
    await clickThroughPicker(page, "#manual-two");
    await clickThroughPicker(page, "#shadow-host button");
    await page.locator("[data-primary]").click();
    await expect(page.locator("[data-knowhow-manual-count]")).toHaveText(
      "3 chosen elements",
    );
    expect(
      await page.evaluate(() => ({ ...globalThis.fixtureActions })),
    ).toEqual({ manualOne: 0, manualTwo: 0, shadow: 0 });
    expect((await messagesOfType(page, "STAGE_INTERACTION")).length).toBe(
      stagesBefore,
    );

    await page.evaluate(
      () =>
        new Promise((resolveReset) => {
          globalThis.__khContentListener(
            {
              type: "KNOWHOW_RESET_PAGE_SESSION",
              navigationKey: "fixture-route-2",
            },
            {},
            resolveReset,
          );
        }),
    );
    await expect(page.locator("[data-knowhow-manual-count]")).toHaveText(
      "Choose other elements",
    );
  });

  test(`${theme}: hover reveals live covers and hover-prepare leaves them in place`, async ({
    page,
  }) => {
    await installRecorder(page, theme);
    await expect(
      page.locator('[data-knowhow-mask-reason="password-field"]'),
    ).toBeVisible();
    const blurBounds = await page
      .locator('[data-knowhow-mask-reason="password-field"]')
      .boundingBox();
    await page.mouse.move(
      blurBounds.x + blurBounds.width / 2,
      blurBounds.y + blurBounds.height / 2,
    );
    await expect(page.locator(".knowhow-blur-revealed")).toHaveCount(1);
    const preparedBefore = (
      await messagesOfType(page, "PREPARE_CAPTURE_FRAME")
    ).length;
    await page.evaluate(() => {
      document.querySelector("#result").textContent = `changed-${Date.now()}`;
    });
    await page.waitForFunction(
      (count) =>
        globalThis.__khMessages.filter(
          (message) => message.type === "PREPARE_CAPTURE_FRAME",
        ).length > count,
      preparedBefore,
    );
    const prepared = await messagesOfType(page, "PREPARE_CAPTURE_FRAME");
    expect(prepared.at(-1).revealedAtSend).toBe(1);
    await expect(page.locator(".knowhow-blur-revealed")).toHaveCount(1);
    await expect(
      page.locator('[data-knowhow-mask-reason="password-field"]'),
    ).toBeVisible();
  });
}

test("permanent blur destroys fine detail while retaining color and feathering", async ({
  page,
}) => {
  await page.goto(`${fixtureOrigin}/e2e/fixtures/capture-light.html`);
  const metrics = await page.evaluate(async (origin) => {
    const { paintPermanentBlur } = await import(
      `${origin}/src/offscreen/offscreen.js`
    );
    document.body.replaceChildren();
    document.body.style.cssText =
      "margin:0;display:grid;place-items:center;min-height:100vh;background:#eef2f7";
    const canvas = document.createElement("canvas");
    canvas.id = "privacy-raster";
    canvas.width = 480;
    canvas.height = 160;
    canvas.style.cssText = "width:480px;height:160px";
    document.body.append(canvas);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#e85d04";
    context.fillRect(80, 40, 160, 80);
    context.fillStyle = "#2563eb";
    context.fillRect(240, 40, 160, 80);
    for (let x = 84; x < 397; x += 4) {
      context.fillStyle = x % 8 ? "rgba(255,255,255,.58)" : "rgba(0,0,0,.58)";
      context.fillRect(x, 48, 2, 64);
    }
    context.fillStyle = "rgba(0,0,0,.86)";
    context.font = "700 16px sans-serif";
    context.fillText("ACCOUNT 9238  EMAIL", 92, 88);
    context.fillText("PRIVATE 5510", 266, 88);

    const before = context.getImageData(0, 0, canvas.width, canvas.height);
    paintPermanentBlur(context, canvas, {
      x: 80 / canvas.width,
      y: 40 / canvas.height,
      width: 320 / canvas.width,
      height: 80 / canvas.height,
    });
    const after = context.getImageData(0, 0, canvas.width, canvas.height);

    function regionStats(image, left, top, width, height) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let luminance = 0;
      let luminanceSquared = 0;
      let count = 0;
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          const offset = (y * image.width + x) * 4;
          const r = image.data[offset];
          const g = image.data[offset + 1];
          const b = image.data[offset + 2];
          const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
          red += r;
          green += g;
          blue += b;
          luminance += value;
          luminanceSquared += value * value;
          count += 1;
        }
      }
      const mean = luminance / count;
      return {
        color: [red / count, green / count, blue / count],
        deviation: Math.sqrt(Math.max(0, luminanceSquared / count - mean * mean)),
      };
    }

    function meanDifference(left, right, x, y, width, height) {
      let difference = 0;
      let count = 0;
      for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
          const offset = (row * left.width + column) * 4;
          difference +=
            Math.abs(left.data[offset] - right.data[offset]) +
            Math.abs(left.data[offset + 1] - right.data[offset + 1]) +
            Math.abs(left.data[offset + 2] - right.data[offset + 2]);
          count += 3;
        }
      }
      return difference / count;
    }

    const beforeCore = regionStats(before, 92, 50, 296, 60);
    const afterCore = regionStats(after, 92, 50, 296, 60);
    const leftColor = regionStats(after, 104, 58, 100, 44).color;
    const rightColor = regionStats(after, 276, 58, 100, 44).color;
    return {
      detailRatio: afterCore.deviation / beforeCore.deviation,
      colorDistance: Math.hypot(
        leftColor[0] - rightColor[0],
        leftColor[1] - rightColor[1],
        leftColor[2] - rightColor[2],
      ),
      leftSaturation: Math.max(...leftColor) - Math.min(...leftColor),
      rightSaturation: Math.max(...rightColor) - Math.min(...rightColor),
      coreDifference: meanDifference(before, after, 92, 50, 296, 60),
      haloDifference: meanDifference(before, after, 78, 56, 2, 48),
      outsideDifference: meanDifference(before, after, 70, 56, 4, 48),
    };
  }, fixtureOrigin);

  expect(metrics.detailRatio).toBeLessThan(0.45);
  expect(metrics.colorDistance).toBeGreaterThan(45);
  expect(metrics.leftSaturation).toBeGreaterThan(25);
  expect(metrics.rightSaturation).toBeGreaterThan(25);
  expect(metrics.coreDifference).toBeGreaterThan(10);
  expect(metrics.haloDifference).toBe(0);
  expect(metrics.outsideDifference).toBe(0);
  await expect(page.locator("#privacy-raster")).toHaveScreenshot(
    "permanent-blur.png",
    { animations: "disabled", maxDiffPixelRatio: 0.01 },
  );
});

test("hover class changes keep the prepared click frame through a same-tab pushState", async ({
  page,
}) => {
  await installRecorder(page, "light");
  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  const support = page.locator("#support");
  await support.hover();
  await expect(support).toHaveClass(/hovered/);
  await support.click();
  await expect(page.locator("#result")).toHaveText("Support");
  const stages = await messagesOfType(page, "STAGE_INTERACTION");
  expect(stages.at(-1)?.frameId).toBeTruthy();
  expect(stages.at(-1)?.context?.sanitizedUrl || "").not.toMatch(/\[redacted\]/);
});

test("double-click, right-click, keyboard, rapid clicks, and drags normalize exactly once", async ({
  page,
}) => {
  await installRecorder(page, "light");

  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  await page.locator("#manual-one").dblclick();
  await expect
    .poll(async () => (await messagesOfType(page, "UPGRADE_INTERACTION")).length)
    .toBe(1);
  let stages = await messagesOfType(page, "STAGE_INTERACTION");
  let commits = await messagesOfType(page, "COMMIT_INTERACTION");
  expect(stages).toHaveLength(2);
  expect(new Set(commits.map((message) => message.interactionId))).toEqual(
    new Set([stages[0].interactionId]),
  );
  expect(await messagesOfType(page, "CANCEL_INTERACTION")).toHaveLength(1);

  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  await page.locator("#manual-two").click({ button: "right" });
  stages = await messagesOfType(page, "STAGE_INTERACTION");
  expect(stages).toHaveLength(1);
  expect(stages[0].sourceEvent).toBe("contextmenu");
  commits = await messagesOfType(page, "COMMIT_INTERACTION");
  expect(new Set(commits.map((message) => message.interactionId))).toEqual(
    new Set([stages[0].interactionId]),
  );

  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  await page.locator("#following").focus();
  await page.keyboard.press("Enter");
  stages = await messagesOfType(page, "STAGE_INTERACTION");
  expect(stages).toHaveLength(1);
  expect(stages[0].context.clickPoint).toEqual({
    x: expect.any(Number),
    y: expect.any(Number),
  });

  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  const first = await page.locator("#manual-one").boundingBox();
  const second = await page.locator("#manual-two").boundingBox();
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
  stages = await messagesOfType(page, "STAGE_INTERACTION");
  expect(new Set(stages.map((message) => message.interactionId)).size).toBe(2);

  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  await page.mouse.move(first.x + 12, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width - 12, first.y + first.height / 2);
  await page.mouse.up();
  expect(await messagesOfType(page, "STAGE_INTERACTION")).toHaveLength(1);
  expect(await messagesOfType(page, "CANCEL_INTERACTION")).toHaveLength(1);
  expect(await messagesOfType(page, "COMMIT_INTERACTION")).toHaveLength(0);
});

test("pointerdown captures without hover and hides live blur before staging", async ({
  page,
}) => {
  await installRecorder(page, "light");
  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  await page.locator("#icon-only").click();
  const stages = await messagesOfType(page, "STAGE_INTERACTION");
  expect(stages).toHaveLength(1);
  expect(stages[0].revealedAtSend).toBe(0);
  expect(stages[0].captureUiVisibleAtSend).toBe(false);
  expect(stages[0].context.title).toBe("Click this button");
});

test("a delayed same-tab pushState does not mint another interaction", async ({
  page,
}) => {
  await installRecorder(page, "light");
  await page.evaluate(() => {
    globalThis.__khMessages.length = 0;
  });
  await page.locator("#delayed-nav").click();
  await expect(page.locator("#result")).toHaveText("Later", { timeout: 4_000 });
  const stages = await messagesOfType(page, "STAGE_INTERACTION");
  expect(stages).toHaveLength(1);
  expect(stages[0].context.title).toBe('Click "Open later"');
  const commits = await messagesOfType(page, "COMMIT_INTERACTION");
  expect(new Set(commits.map((message) => message.interactionId))).toEqual(
    new Set([stages[0].interactionId]),
  );
});

test("preparing does not attach live blur until the page is armed", async ({
  page,
}) => {
  await installRecorder(page, "dark", {
    fixture: "capture-inbox.html",
    status: "preparing",
    policy: {
      redactEmails: false,
      redactFormFields: false,
      redactTableRows: true,
    },
  });
  await expect(page.locator("[data-knowhow-blurred], .knowhow-blur-region")).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise((resolveStatus) => {
        globalThis.__khContentListener(
          { type: "KNOWHOW_SET_STATUS", status: "paused" },
          {},
          resolveStatus,
        );
      }),
  );
  await expect(
    page.locator("[data-knowhow-blurred], .knowhow-blur-region"),
  ).not.toHaveCount(0);
});

test("table rows cover ink, not the whole row, and stay clipped under chrome", async ({
  page,
}) => {
  await installRecorder(page, "dark", {
    fixture: "capture-inbox.html",
    policy: {
      redactEmails: false,
      redactFormFields: false,
      redactTableRows: true,
    },
  });
  await expect(page.locator("[data-knowhow-blurred], .knowhow-blur-region")).not.toHaveCount(0);
  await expect(
    page.locator("[role=row]").last().locator("[data-knowhow-blurred]"),
  ).not.toHaveCount(0);
  const belowFold = await page.evaluate(() => {
    const list = document.querySelector("#inbox-list");
    const last = [...document.querySelectorAll("[role=row]")].at(-1);
    if (!list || !last) return null;
    const listBox = list.getBoundingClientRect();
    const lastBox = last.getBoundingClientRect();
    return {
      lastTop: lastBox.top,
      listBottom: listBox.bottom,
      alreadyBlurred: last.querySelectorAll("[data-knowhow-blurred]").length > 0,
    };
  });
  expect(belowFold).toBeTruthy();
  expect(belowFold.lastTop).toBeGreaterThan(belowFold.listBottom);
  expect(belowFold.alreadyBlurred).toBeTruthy();

  const row = await page.locator("[role=row]").first().boundingBox();
  const checkbox = await page.locator("[role=row] input").first().boundingBox();
  const masks = await page
    .locator("[data-knowhow-blurred], .knowhow-blur-region")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
  expect(row).toBeTruthy();
  expect(checkbox).toBeTruthy();
  expect(masks.every((mask) => mask.width < row.width * 0.9)).toBeTruthy();
  const checkboxCenter = {
    x: checkbox.x + checkbox.width / 2,
    y: checkbox.y + checkbox.height / 2,
  };
  expect(
    masks.some(
      (mask) =>
        checkboxCenter.x >= mask.x &&
        checkboxCenter.x <= mask.x + mask.width &&
        checkboxCenter.y >= mask.y &&
        checkboxCenter.y <= mask.y + mask.height,
    ),
  ).toBeFalsy();

  const rowHosts = page.locator("[role=row]").nth(2).locator("[data-knowhow-blurred]");
  await expect(rowHosts).not.toHaveCount(0);
  await page.locator("[role=row] .sender").nth(2).hover();
  await expect(
    page.locator("[role=row]").nth(2).locator(".knowhow-blur-revealed"),
  ).toHaveCount(await rowHosts.count());

  const glued = await page.evaluate(() => {
    const list = document.querySelector("#inbox-list");
    const region = [
      ...document.querySelectorAll("[data-knowhow-blurred], .knowhow-blur-region"),
    ].find((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.y > 220 &&
        rect.y < 560 &&
        getComputedStyle(node).visibility !== "hidden"
      );
    });
    if (!list || !region) return null;
    const before = region.getBoundingClientRect().y;
    list.scrollTop += 80;
    const after = region.getBoundingClientRect().y;
    return { before, after };
  });
  expect(glued).toBeTruthy();
  expect(glued.before - glued.after).toBeGreaterThan(60);

  await page.locator("#inbox-list").evaluate((element) => {
    element.scrollTop = 420;
  });
  await page.waitForFunction(() => {
    const header = document.querySelector("header")?.getBoundingClientRect();
    const tabs = document
      .querySelector("[role=tablist]")
      ?.getBoundingClientRect();
    if (!header || !tabs) return false;
    const chromeBottom = Math.max(header.bottom, tabs.bottom);
    const overlays = [...document.querySelectorAll(".knowhow-blur-region")];
    const hosts = [...document.querySelectorAll("[data-knowhow-blurred]")];
    if (!overlays.length && !hosts.length) return false;
    return overlays.every((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= chromeBottom - 2 || rect.bottom <= header.top + 2;
    });
  });
});

test("master Smart Blur with every menu detector off covers nothing", async ({
  page,
}) => {
  await installRecorder(page, "dark", {
    policy: {
      smartBlurEnabled: true,
      redactEmails: false,
      redactPhoneNumbers: false,
      redactFinancialNumbers: false,
      redactIds: false,
      redactAllNumbers: false,
      redactFormFields: false,
      redactImages: false,
      redactTableRows: false,
      redactLongText: false,
    },
  });
  await expect(page.locator("#secret")).toBeVisible();
  await expect(page.locator("#nested-frame")).toBeVisible();
  await expect(
    page.locator("[data-knowhow-blurred], .knowhow-blur-region"),
  ).toHaveCount(0);
});

test("prepare screenshot hides live blur without tearing the overlay down", async ({
  page,
}) => {
  await installRecorder(page, "dark");
  await expect(
    page.locator('[data-knowhow-mask-reason="password-field"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-knowhow-blurred="password-field"]'),
  ).toHaveCount(1);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.__khContentListener(
          { type: "KNOWHOW_PREPARE_SCREENSHOT" },
          {},
          resolve,
        );
      }),
  );
  await expect(
    page.locator('[data-knowhow-overlay="smart-blur-preview"]'),
  ).toHaveCSS("visibility", "hidden");
  await expect(
    page.locator('[data-knowhow-mask-reason="password-field"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-knowhow-blurred="password-field"]'),
  ).toHaveCount(1);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.__khContentListener(
          { type: "KNOWHOW_RESTORE_PRIVACY_PREVIEW" },
          {},
          resolve,
        );
      }),
  );
  await expect(
    page.locator('[data-knowhow-overlay="smart-blur-preview"]'),
  ).not.toHaveCSS("visibility", "hidden");
});
