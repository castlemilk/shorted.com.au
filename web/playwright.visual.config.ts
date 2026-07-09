import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" },
  },
  use: {
    baseURL: process.env.STORYBOOK_URL ?? "http://localhost:6007",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    // Animations are frozen via toHaveScreenshot.animations:"disabled" plus the
    // per-test freeze stylesheet — no reducedMotion needed (and no storied
    // component responds to prefers-reduced-motion anyway).
  },
  webServer: {
    command: "npx http-server storybook-static --port 6007 --silent",
    url: "http://localhost:6007/index.json",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
