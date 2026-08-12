import { defineConfig, devices } from "@playwright/test";

const externalBaseUrl = process.env.KNOWHOW_E2E_BASE_URL?.trim();
if (process.env.KNOWHOW_REQUIRE_CONTROLLED_REHEARSAL === "1") {
  if (!/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(externalBaseUrl ?? "")) {
    throw new Error("Controlled rehearsal requires an exact HTTPS Site origin.");
  }
  let controlledUrl: URL;
  try {
    controlledUrl = new URL(externalBaseUrl ?? "");
  } catch {
    throw new Error("Controlled rehearsal requires a valid HTTPS Site origin.");
  }
  if (
    controlledUrl.protocol !== "https:" ||
    controlledUrl.pathname !== "/" ||
    controlledUrl.username ||
    controlledUrl.password ||
    controlledUrl.port ||
    controlledUrl.search ||
    controlledUrl.hash
  ) {
    throw new Error("Controlled rehearsal requires an exact HTTPS Site origin.");
  }
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./outputs/playwright",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "outputs/playwright-report", open: "never" }]]
    : "list",
  use: {
    baseURL: externalBaseUrl || "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "edge",
      use: { ...devices["Desktop Chrome"], channel: "msedge" },
    },
    {
      name: "mobile-chromium",
      testIgnore: /controlled-rehearsal\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3001",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          KNOWHOW_ENVIRONMENT: "development",
          NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "development",
          APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
          APPWRITE_PROJECT_ID: "local-e2e-placeholder",
          APPWRITE_API_KEY: "local-e2e-placeholder-not-a-real-key",
          KNOWHOW_ALLOWED_ORIGINS: "http://localhost:3001",
        },
      },
});
