import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { BootstrapResponse } from "../lib/knowhow-types";
import {
  DELETION_CONFIRMATION,
  PILOT_WORKSPACE_SLUG,
  PUBLISHED_GUIDE_ID,
  REVIEW_GUIDE_ID,
  pilotBootstrap,
  recoveryBootstrap,
} from "./fixtures/pilot-bootstrap";

type RecordedCommand = {
  action: string;
  payload: Record<string, unknown>;
};

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

async function installProductBackend(
  page: Page,
  bootstrap: BootstrapResponse,
) {
  const commands: RecordedCommand[] = [];

  await page.route("**/api/auth/health", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: bootstrap.viewer.id,
          email: bootstrap.viewer.email,
          name: bootstrap.viewer.name,
          emailVerification: true,
          mfa: true,
        },
      }),
    }),
  );
  await page.route("**/api/auth/mfa/requirement", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"required":true,"enabled":true}',
    }),
  );
  await page.route(
    (url) => url.pathname === "/api/knowhow/export",
    async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"jobId":"export_synthetic","status":"ready","pollAfterMs":0}',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: {
          "content-disposition": 'attachment; filename="synthetic-guide.pdf"',
        },
        body: "%PDF-1.4\n% synthetic browser rehearsal\n",
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/knowhow",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(bootstrap),
        });
        return;
      }

      const command = route.request().postDataJSON() as RecordedCommand;
      commands.push(command);
      const response =
        command.action === "createInvite"
          ? { token: "signed.synthetic.invitation" }
          : command.action === "saveGuide"
            ? {
                guideId: REVIEW_GUIDE_ID,
                revisionId: "revision_review_1",
              }
            : {};
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    },
  );

  return commands;
}

test.describe("critical pilot product surfaces", () => {
  test("onboarding, capture, invitation, and support remain operable", async ({
    page,
  }) => {
    const commands = await installProductBackend(page, pilotBootstrap());

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Getting started")).toBeVisible();
    await expect(page.getByText("0 of 7")).toBeVisible();
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
    await page.getByRole("button", { name: "Create invitation" }).click();
    await expect(page.getByText("Invitation ready")).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Request review" })).toBeVisible();
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
    await expect(reviewCard.getByRole("button", { name: "Approve" })).toBeVisible();
    await reviewCard.getByRole("button", { name: "Publish" }).click();
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
    await page.getByRole("button", { name: "Mark complete" }).click();
    await expect
      .poll(() =>
        commands.some((command) => command.action === "recordGuideCompletion"),
      )
      .toBe(true);

    await page.getByRole("button", { name: "Export" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "PDF" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("synthetic-guide.pdf");
  });

  test("platform suspension, provisioning, and deletion approval are explicit", async ({
    page,
  }) => {
    const commands = await installProductBackend(page, pilotBootstrap());

    await page.goto("/platform");
    await expect(
      page.getByRole("heading", { name: "Platform administration" }),
    ).toBeVisible();
    await expect(page.getByText("Self-service limit: 0")).toBeVisible();
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
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await page.goto("/platform/accounts");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    const activeWorkspaceRow = page
      .locator(".platform-row")
      .filter({ hasText: "Alpha Operations" });
    await activeWorkspaceRow.getByRole("button", { name: "Workspace actions" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "Suspend" }).click();
    await expect
      .poll(() => commands.some((command) => command.action === "setWorkspaceStatus"))
      .toBe(true);

    await page.goto("/platform/ops");
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
});
