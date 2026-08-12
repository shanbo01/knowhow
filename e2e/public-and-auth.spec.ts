import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoWcagViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test.describe("public pilot surface", () => {
  for (const path of [
    "/",
    "/internal-it",
    "/how-it-works",
    "/extension",
    "/security",
    "/pricing",
    "/request-demo",
    "/request-pilot",
    "/privacy",
    "/terms",
    "/contact",
  ]) {
    test(`${path} renders without WCAG A/AA violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Application error");
      await expectNoWcagViolations(page);
      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(horizontalOverflow).toBe(false);
    });
  }

  test("marketing exposes pilot calls to action but no public checkout", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /request a pilot/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /request a demo/i }).first()).toBeVisible();
    await expect(page.getByText(/invitation-only design-partner pilots/i)).toBeVisible();
    await expect(page.getByText(/buy now|start free trial|checkout/i)).toHaveCount(0);
  });
});

test.describe("invitation-only authentication", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/health", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
    );
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: '{"code":"AUTH_REQUIRED"}' }),
    );
  });

  test("ordinary visitors can sign in but cannot self-register", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Sign in to KnowHow" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create invited account" })).toHaveCount(0);
    await expectNoWcagViolations(page);
  });

  test("a signed invitation enables the exact invited-account form", async ({ page }) => {
    await page.goto("/app?invite=test.signed.invitation.credential");
    await expect(page.getByRole("button", { name: "Create invited account" })).toBeVisible();
    await page.getByRole("button", { name: "Create invited account" }).click();
    await expect(page.getByText("12 characters minimum")).toBeVisible();
    await expect(page.locator('input[name="password"]')).toHaveAttribute("minlength", "12");
    await expectNoWcagViolations(page);
  });

  test("sign-in requires the Appwrite second factor and exposes recovery", async ({ page }) => {
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
    await page.locator("form").getByRole("button", { name: /^sign in$/i }).click();

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

  test("a completed authenticator setup resumes at verification", async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "owner-resume",
            email: "owner@example.test",
            name: "Pilot owner",
            emailVerification: true,
            mfa: false,
          },
        }),
      }),
    );
    await page.route("**/api/auth/mfa/requirement", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          required: true,
          enabled: false,
          factors: { totp: true, recoveryCode: true },
        }),
      }),
    );
    await page.route("**/api/auth/mfa/enroll/start", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, resumed: true }),
      }),
    );
    await page.route("**/api/auth/mfa/challenge", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ challengeId: "challenge-resumed-totp" }),
      }),
    );

    await page.goto("/app");
    await expect(
      page.getByRole("heading", { name: "Add an authenticator app" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Begin secure setup" }).click();

    await expect(
      page.getByRole("heading", { name: "Enter your authenticator code" }),
    ).toBeVisible();
    await expect(page.getByLabel("Authentication code")).toHaveAttribute(
      "autocomplete",
      "one-time-code",
    );
    await expectNoWcagViolations(page);
  });
});
