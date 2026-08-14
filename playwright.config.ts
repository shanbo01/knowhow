import { defineConfig, devices } from "@playwright/test";

const configuredBaseUrl = process.env.KNOWHOW_E2E_BASE_URL?.trim();
if (configuredBaseUrl) {
  const url = new URL(configuredBaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("KNOWHOW_E2E_BASE_URL must be an exact local origin.");
  }
}
const baseUrl = configuredBaseUrl || "http://localhost:3001";

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
    baseURL: baseUrl,
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
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: configuredBaseUrl
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
          KNOWHOW_REGISTRATION_MODE: "open",
          NEXT_PUBLIC_KNOWHOW_REGISTRATION_MODE: "open",
          APPWRITE_ENDPOINT: "http://localhost/v1",
          APPWRITE_PROJECT_ID: "local-e2e-placeholder",
          APPWRITE_API_KEY: "local-e2e-placeholder-not-a-real-key",
          KNOWHOW_ALLOWED_ORIGINS: "http://localhost:3001",
        },
      },
});
