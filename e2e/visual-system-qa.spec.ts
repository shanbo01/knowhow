import { expect, test, type Page } from "@playwright/test";
import {
  PILOT_WORKSPACE_SLUG,
  PUBLISHED_GUIDE_ID,
  REVIEW_GUIDE_ID,
  pilotBootstrap,
} from "./fixtures/pilot-bootstrap";
import { installProductBackend } from "./fixtures/product-backend";

const enabled = process.env.VISUAL_QA === "1";
const screenshotRoot = "outputs/visual-qa";

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: `${screenshotRoot}/${name}.png`,
    fullPage: true,
  });
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((nextTheme) => {
    window.localStorage.setItem("knowhow-theme", nextTheme);
    // Workspace chrome overwrites next-themes from this per-user key, then
    // falls back to bootstrap.viewer.themePreference (light in the pilot fixture).
    window.localStorage.setItem("knowhow-theme:user_owner", nextTheme);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    document.documentElement.classList.toggle("light", nextTheme === "light");
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
}

async function expectAppliedTheme(page: Page, theme: "light" | "dark") {
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.dataset.theme ?? ""),
    )
    .toBe(theme);
  const background = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim(),
  );
  expect(background).toBe(theme === "dark" ? "#0e0e0c" : "#f5f4f0");
}

test.describe("visual system QA", () => {
  test.skip(!enabled, "Set VISUAL_QA=1 to capture visual-system screenshots.");

  for (const theme of ["light", "dark"] as const) {
    test(`workspace surfaces in ${theme} theme`, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chrome",
        "Capture workspace screenshots once on desktop Chrome.",
      );
      await setTheme(page, theme);
      await installProductBackend(page, pilotBootstrap());
      const slug = PILOT_WORKSPACE_SLUG;
      const routes: Array<[string, string, string | RegExp]> = [
        [`/w/${slug}`, "home", "Dashboard"],
        [`/w/${slug}/guides`, "guides", "Guides"],
        [`/w/${slug}/guides/new`, "guide-new", "Untitled guide"],
        [
          `/w/${slug}/guides/${PUBLISHED_GUIDE_ID}?revision=published`,
          "guide-reader",
          "Complete a synthetic access request",
        ],
        [
          `/w/${slug}/guides/${REVIEW_GUIDE_ID}/edit`,
          "guide-editor",
          "Review the captured onboarding flow",
        ],
        [`/w/${slug}/capture`, "capture", "Capture a workflow"],
        [`/w/${slug}/groups`, "groups", "Groups"],
        [`/w/${slug}/members`, "members", "Members & invitations"],
        [`/w/${slug}/support`, "support", "Support"],
        [`/w/${slug}/organization`, "organization", "Alpha Operations"],
        [`/w/${slug}/vault`, "vault", "Vault"],
        [`/w/${slug}/settings`, "settings", "Settings & policies"],
      ];

      for (const [path, name, heading] of routes) {
        await page.goto(path);
        const ready =
          name === "guide-new" || name === "guide-editor"
            ? page.getByText(heading).first()
            : page.getByRole("heading", { name: heading }).first();
        await expect(ready).toBeVisible({ timeout: 15_000 });
        await expectAppliedTheme(page, theme);
        await expectNoHorizontalOverflow(page);
        await shot(page, `w-${name}-${theme}-1440`);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/w/${slug}`);
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      await expectAppliedTheme(page, theme);
      await expectNoHorizontalOverflow(page);
      await shot(page, `w-home-${theme}-390`);

      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(`/w/${slug}/guides`);
      await expect(page.getByRole("heading", { name: "Guides" })).toBeVisible();
      await expectAppliedTheme(page, theme);
      await expectNoHorizontalOverflow(page);
      await shot(page, `w-guides-${theme}-768`);
    });
  }

  test("public landing, legal, auth, and extension popup", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chrome",
      "Capture public screenshots once on desktop Chrome.",
    );

    await page.goto("/");
    await expect(page.locator("main").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "landing-hero-1440");
    await page.locator("#how").scrollIntoViewIfNeeded();
    await shot(page, "landing-how-1440");
    await page.locator("#product").scrollIntoViewIfNeeded();
    await shot(page, "landing-product-1440");
    await page.locator("#pricing").scrollIntoViewIfNeeded();
    await shot(page, "landing-pricing-1440");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator("main").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "landing-hero-390");
    await page.locator("#pricing").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await shot(page, "landing-pricing-390");

    await page.setViewportSize({ width: 1440, height: 900 });
    for (const path of ["/privacy", "/terms", "/contact", "/trust", "/security", "/extension"]) {
      await page.goto(path);
      await expect(page.locator("main").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot(page, `${path.slice(1)}-1440`);
    }

    await page.goto("/app?mode=sign-in");
    await expect(page.getByRole("heading", { name: "Sign in to KnowHow" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, "auth-sign-in-1440");

    await page.getByRole("button", { name: "Create account" }).first().click();
    await expect(
      page.getByRole("heading", { name: /create your knowhow account/i }),
    ).toBeVisible();
    await shot(page, "auth-sign-up-1440");

    await page.goto(`file://${process.cwd().replaceAll("\\", "/")}/extension/src/popup/popup.html`);
    await expect(page.getByRole("button", { name: /start capture/i })).toBeVisible();
    await shot(page, "extension-popup");
  });
});
