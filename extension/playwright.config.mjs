import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../outputs/playwright-extension",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  webServer: {
    command: "node e2e/fixture-server.mjs",
    url: "http://127.0.0.1:43117/e2e/fixtures/capture-light.html",
    reuseExistingServer: true,
    timeout: 10_000,
  },
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
  ],
});
