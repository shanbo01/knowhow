import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  DELETION_CONFIRMATION,
  PILOT_WORKSPACE_SLUG,
  PUBLISHED_GUIDE_ID,
  REVIEW_GUIDE_ID,
  pilotBootstrap,
  pilotPlatformQuery,
  recoveryBootstrap,
} from "./fixtures/pilot-bootstrap";
import { installProductBackend } from "./fixtures/product-backend";

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

test.describe("critical pilot product surfaces", () => {
  test("onboarding, capture, invitation, and support remain operable", async ({
    page,
  }) => {
    const commands = await installProductBackend(page, pilotBootstrap());

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Pro trial · Ends/ })).toBeVisible();
    await expect(page.getByText("Getting started")).toBeVisible();
    await expect(page.getByText("Invite teammates")).toBeVisible();
    await expect(page.getByText("Pin the extension")).toBeVisible();
    await expectNoWcagViolations(page);

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/capture`);
    await expect(
      page.getByRole("heading", { name: "Capture a workflow" }),
    ).toBeVisible();
    await expect(page.getByText("Redaction happens before anything is uploaded")).toBeVisible();
    await expect(page.getByText("Send a private draft")).toBeVisible();

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/members`);
    await expect(
      page.getByRole("heading", { name: "Members & invitations" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Temporary support requests" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Invite teammate" }).click();
    await expect(page.getByRole("heading", { name: "Invite a teammate" })).toBeVisible();
    await expect(
      page.getByText("Paste one address per line, or separate them with commas."),
    ).toBeVisible();
    await page.getByLabel("Invitee emails").fill("new.teammate@alpha.example");
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(
      page.getByRole("dialog").getByText("Invitation sent"),
    ).toBeVisible();
    expect(commands.some((command) => command.action === "createInvite")).toBe(true);

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/support`);
    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Synthetic pilot question" }),
    ).toBeVisible();
    await expect(page.getByText("Email notices never include message content.")).toBeVisible();
  });

  test("captured editing and publication controls call governed commands", async ({
    page,
  }) => {
    const commands = await installProductBackend(page, pilotBootstrap());

    await page.goto(
      `/w/${PILOT_WORKSPACE_SLUG}/guides/${REVIEW_GUIDE_ID}/edit`,
    );
    await expect(page.getByLabel("Guide title")).toHaveValue(
      "Review the captured onboarding flow",
    );
    await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
    await page.getByLabel("Guide title").fill("Review the synthetic captured flow");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => commands.some((command) => command.action === "saveGuide"))
      .toBe(true);

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/guides`);
    await expect(page.getByRole("heading", { name: "Guides" })).toBeVisible();
    const reviewCard = page
      .locator(".guide-card")
      .filter({ hasText: "Review the captured onboarding flow" });
    await expect(reviewCard.getByRole("button", { name: "Share" })).toBeVisible();
    await reviewCard.getByRole("button", { name: "Share" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Share", exact: true }).click();
    await expect
      .poll(() => commands.some((command) => command.action === "shareGuide"))
      .toBe(true);
  });

  test("governed workspaces still review then approve and publish", async ({
    page,
  }) => {
    const bootstrap = pilotBootstrap();
    bootstrap.activeWorkspace!.workspace.settings.requireReviewBeforePublish =
      true;
    const commands = await installProductBackend(page, bootstrap);

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/settings`);
    await expect(
      page.getByRole("heading", { name: "Settings & policies" }),
    ).toBeVisible();
    await expect(
      page.getByText("Require review before sharing"),
    ).toBeVisible();

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/guides`);
    const reviewCard = page
      .locator(".guide-card")
      .filter({ hasText: "Review the captured onboarding flow" });
    await expect(
      reviewCard.getByRole("button", { name: "Approve and publish" }),
    ).toBeVisible();
    await reviewCard.getByRole("button", { name: "Approve and publish" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Approve and publish" })
      .click();
    await expect
      .poll(() => commands.some((command) => command.action === "reviewGuide"))
      .toBe(true);
    await expect
      .poll(() => commands.some((command) => command.action === "publishGuide"))
      .toBe(true);
  });

  test("published guide completion and export use the protected workflow", async ({
    page,
  }) => {
    const commands = await installProductBackend(page, pilotBootstrap());

    await page.goto(
      `/w/${PILOT_WORKSPACE_SLUG}/guides/${PUBLISHED_GUIDE_ID}?revision=published`,
    );
    await expect(
      page.getByRole("heading", { name: "Complete a synthetic access request" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Live v/ })).toHaveCount(0);
    await expect(page.getByText("0 views")).toBeVisible();
    await page.getByRole("button", { name: "Like this guide" }).click();
    await expect
      .poll(() =>
        commands.some((command) => command.action === "recordGuideReaction"),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Mark complete" }).click();
    await expect
      .poll(() =>
        commands.some((command) => command.action === "recordGuideCompletion"),
      )
      .toBe(true);

    await page.getByRole("button", { name: "Share" }).click();
    const shareDialog = page.getByRole("dialog");
    await expect(shareDialog.getByRole("button", { name: "PDF" })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await shareDialog.getByRole("button", { name: "PDF" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("synthetic-guide.pdf");
  });

  test("platform suspension, provisioning, and deletion approval are explicit", async ({
    page,
  }) => {
    const commands = await installProductBackend(page, pilotBootstrap());

    await page.goto("/platform");
    await expect(
      page.getByRole("heading", { name: "Home" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Provision organization" }).first()).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expectNoWcagViolations(page);

    await page.getByRole("button", { name: "Provision organization" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Provision an organization" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Provision an organization" }),
    ).not.toBeVisible();

    await page.goto("/platform/accounts");
    await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page
      .locator(".member-row")
      .filter({ hasText: "Alpha Operations" })
      .click();
    await expect(page.getByRole("heading", { name: "Alpha Operations" })).toBeVisible();
    await page.getByRole("button", { name: "Suspend" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Suspend" }).click();
    await expect
      .poll(() => commands.some((command) => command.action === "setWorkspaceStatus"))
      .toBe(true);

    await page.goto("/platform/ops");
    await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
    await expect(page.getByText("Self-service limit: 0")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deletion approvals" })).toBeVisible();
    await page.getByRole("button", { name: "Review deletion" }).click();
    await expect(
      page.getByRole("heading", { name: /Approve deletion.*Beta Archive/ }),
    ).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve permanent purge" });
    await expect(approve).toBeDisabled();
    await page
      .getByLabel("Type this exact confirmation phrase")
      .fill(DELETION_CONFIRMATION);
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect
      .poll(() => commands.some((command) => command.action === "approveDeletionCase"))
      .toBe(true);
  });

  test("suspended workspaces expose recovery without restoring product access", async ({
    page,
  }) => {
    await installProductBackend(page, recoveryBootstrap());

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Beta Archive" })).toBeVisible();
    await expect(page.getByText("Workspace suspended")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Revoke my extension devices" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Contact KnowHow" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
    await expectNoWcagViolations(page);
  });

  test("Free plan hides Capture and Support and explains the Pro lock", async ({
    page,
  }) => {
    const bootstrap = structuredClone(pilotBootstrap());
    const entitlements = {
      maximumUsers: 3,
      maximumCreators: 1,
      storageBytes: 1_000_000_000,
      extensionEnabled: false,
      supportEnabled: false,
      removeBranding: false,
      privacyToolsEnabled: false,
      customSubdomainEnabled: false,
      fileExportsEnabled: false,
    };
    const subscription = {
      plan: "free" as const,
      billedPlan: "free" as const,
      kind: "trial",
      status: "active",
      access: "active" as const,
      expiresAt: null,
      graceEndsAt: null,
      deletionEligibleAt: null,
      renewsAt: null,
      trialConsumed: false,
      pastDue: false,
    };
    bootstrap.workspaces[0]!.subscription = subscription;
    if (bootstrap.activeWorkspace) {
      bootstrap.activeWorkspace.entitlements = entitlements;
      bootstrap.activeWorkspace.workspace.subscription = subscription;
    }
    await installProductBackend(page, bootstrap);

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Free" })).toBeVisible();
    const workspaceNav = page.getByRole("navigation", {
      name: "Workspace navigation",
    });
    await expect(workspaceNav.getByRole("button", { name: "Capture" })).toHaveCount(0);
    await expect(workspaceNav.getByRole("button", { name: "Support" })).toHaveCount(0);

    await page.goto(`/w/${PILOT_WORKSPACE_SLUG}/capture`);
    await expect(page.getByText("Capture is on Pro")).toBeVisible();
    await expect(page.getByRole("button", { name: "Install and pair" })).toHaveCount(0);
  });

  test("platform client lists do not flash empty while loading", async ({
    page,
  }) => {
    await installProductBackend(page, pilotBootstrap());
    await page.route(
      (url) => url.pathname === "/api/knowhow/platform",
      async (route) => {
        const url = new URL(route.request().url());
        if (
          url.searchParams.get("resource") === "customers" ||
          url.searchParams.get("resource") === "accounts"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            pilotPlatformQuery(url.searchParams.get("resource"), url.searchParams),
          ),
        });
      },
    );

    await page.goto("/platform/accounts");
    await expect(page.getByText("Loading…")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No customers yet" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No customers match" })).toHaveCount(0);
    await expect(page.getByText("Alpha Operations")).toBeVisible();
  });
});
