import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoWcagViolations(page: Page, disableRules: string[] = []) {
  const builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
  if (disableRules.length) builder.disableRules(disableRules);
  const results = await builder.analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test.describe("public product surface", () => {
  for (const path of [
    "/",
    "/extension",
    "/trust",
    "/security",
    "/privacy",
    "/terms",
    "/contact",
  ]) {
    test(`${path} renders without WCAG A/AA violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("main").first()).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Application error");
      await expectNoWcagViolations(
        page,
        path === "/" ? ["color-contrast"] : [],
      );
      const horizontalOverflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      expect(horizontalOverflow).toBe(false);
    });
  }

  test("marketing header opens the workspace when a session exists", async ({
    page,
  }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "owner-resume",
            email: "owner@example.test",
            name: "Workspace owner",
            emailVerification: true,
            mfa: true,
          },
        }),
      }),
    );
    await page.goto("/pricing");
    await expect(
      page.getByRole("link", { name: "Open workspace" }).first(),
    ).toBeVisible();
    const plans = page.getByRole("region", { name: "KnowHow plans" });
    await expect(plans.getByRole("heading", { name: "Free" })).toBeVisible();
    await expect(plans.getByRole("heading", { name: "Pro" })).toBeVisible();
    await expect(plans.getByRole("heading", { name: "Enterprise" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /start free trial/i }).first(),
    ).toBeVisible();
  });

  test("marketing exposes free-trial account creation but no public checkout", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /start free trial/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Footer navigation" }).getByRole("link", { name: "Contact" }),
    ).toBeVisible();
    await expect(page.getByText(/private-beta software/i)).toHaveCount(0);
    await expect(page.getByText(/buy now|checkout/i)).toHaveCount(0);
  });

  test("public navigation reaches product, pricing, trust, and auth entry points", async ({
    page,
  }) => {
    await page.goto("/");

    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Product" })
      .click();
    await expect(page).toHaveURL(/#product/);
    await expect(
      page.getByRole("heading", { name: /this time, the answer is already there/i }),
    ).toBeVisible();

    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Pricing" })
      .click();
    await expect(page).toHaveURL(/#pricing/);

    await page.goto("/trust");
    await expect(
      page.getByRole("heading", { level: 1, name: /private by architecture/i }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Sign in" }).first().click();
    await expect(page).toHaveURL(/\/app\?mode=sign-in$/);
    await expect(
      page.getByRole("heading", { name: "Sign in to KnowHow" }),
    ).toBeVisible();
  });

  test("register and trial routes enter account creation", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(page).toHaveURL(/\/app\?mode=sign-up&plan=free$/);
    await expect(
      page.getByRole("heading", { name: /create your knowhow account/i }),
    ).toBeVisible();

    await page.goto("/start-trial");
    await expect(page).toHaveURL(/\/app\?mode=sign-up&plan=pro_trial$/);
    await expect(
      page.getByRole("heading", { name: /create your knowhow account/i }),
    ).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test("sitemap lists public marketing routes and robots protects product surfaces", async ({
    request,
  }) => {
    const sitemapResponse = await request.get("/sitemap.xml");
    expect(sitemapResponse.ok()).toBe(true);
    const sitemap = await sitemapResponse.text();
    expect(sitemap).toContain("/trust</loc>");
    expect(sitemap).not.toContain("/product</loc>");
    expect(sitemap).not.toContain("/app</loc>");

    const robotsResponse = await request.get("/robots.txt");
    expect(robotsResponse.ok()).toBe(true);
    const robots = await robotsResponse.text();
    expect(robots).toContain("Disallow: /app");
    expect(robots).toContain("Disallow: /w/");
    expect(robots).toContain("Sitemap:");
  });
});
test.describe("governed authentication", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"ok":true}',
      }),
    );
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"code":"AUTH_REQUIRED"}',
      }),
    );
  });

  test("ordinary visitors can create an account", async ({
    page,
  }) => {
    await page.goto("/app");
    await expect(
      page.getByRole("heading", { name: "Sign in to KnowHow" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /forgot password/i })).toBeVisible();
    await page.getByRole("button", { name: "Create account" }).first().click();
    await expect(
      page.getByRole("heading", { name: /create your knowhow account/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/after you verify your email/i),
    ).toBeVisible();
    await expect(page.getByText("8 characters minimum")).toBeVisible();
    await expect(page.locator('input[name="password"]')).toHaveAttribute(
      "minlength",
      "8",
    );
    await expect(page.getByLabel("Private-beta access code")).toHaveCount(0);
    await expectNoWcagViolations(page);
  });

  test("a signed invitation enables the exact invited-account form", async ({
    page,
  }) => {
    await page.goto("/app?invite=test.signed.invitation.credential");
    await expect(page.getByText("Workspace invitation detected")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create invited account" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create invited account" }).click();
    await expect(page.getByText("8 characters minimum")).toBeVisible();
    await expect(page.locator('input[name="password"]')).toHaveAttribute(
      "minlength",
      "8",
    );
    await expectNoWcagViolations(page);
  });

  test("sign-in requires the Appwrite second factor and exposes recovery", async ({
    page,
  }) => {
    const requestedFactors: string[] = [];
    await page.route("**/api/auth/sign-in", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mfaRequired: true,
          factors: ["totp", "recoveryCode"],
        }),
      }),
    );
    await page.route("**/api/auth/mfa/challenge", async (route) => {
      const body = route.request().postDataJSON() as { factor: string };
      requestedFactors.push(body.factor);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ challengeId: `challenge-${body.factor}` }),
      });
    });

    await page.goto("/app");
    await page.getByLabel("Work email").fill("owner@example.test");
    await page.getByLabel("Password").fill("Correct-Horse-Pilot-2026");
    await page
      .locator("form")
      .getByRole("button", { name: /^sign in$/i })
      .click();

    await expect(
      page.getByRole("heading", { name: "Enter your authenticator code" }),
    ).toBeVisible();
    await expect(page.getByLabel("Authentication code")).toHaveAttribute(
      "autocomplete",
      "one-time-code",
    );
    await expectNoWcagViolations(page);

    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await expect(
      page.getByRole("heading", { name: "Enter a recovery code" }),
    ).toBeVisible();
    expect(requestedFactors).toEqual(["totp", "recoveryCode"]);
    await expectNoWcagViolations(page);
  });

  test("verified users are not forced into authenticator setup", async ({
    page,
  }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "owner-resume",
            email: "owner@example.test",
            name: "Workspace owner",
            emailVerification: true,
            mfa: false,
          },
        }),
      }),
    );
    await page.route("**/api/knowhow", (route) => {
      if (route.request().method() !== "GET") {
        return route.fallback();
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          viewer: {
            id: "owner-resume",
            email: "owner@example.test",
            name: "Workspace owner",
            emailVerified: true,
            mfaEnabled: false,
            platformAdministrator: false,
          },
          workspaces: [],
          activeWorkspace: null,
          organizations: [],
        }),
      });
    });

    await page.goto("/app");
    await expect(
      page.getByRole("heading", { name: "Add an authenticator app" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Build the home for your team's know-how.",
      }),
    ).toBeVisible();
    await expectNoWcagViolations(page);
  });
});
