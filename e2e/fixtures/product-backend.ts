import type { Page } from "@playwright/test";
import type { BootstrapResponse } from "../../lib/knowhow-types";
import { REVIEW_GUIDE_ID, pilotPlatformQuery } from "./pilot-bootstrap";

export type RecordedCommand = {
  action: string;
  payload: Record<string, unknown>;
};

export async function installProductBackend(
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
  await page.route(
    (url) => url.pathname === "/api/knowhow/platform",
    async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          pilotPlatformQuery(
            url.searchParams.get("resource"),
            url.searchParams,
          ),
        ),
      });
    },
  );

  return commands;
}
