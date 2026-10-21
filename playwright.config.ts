import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.browser.ts",
  fullyParallel: true,
  workers: 2,
  use: {
    browserName: "chromium",
    viewport: { width: 1000, height: 800 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  }
});
