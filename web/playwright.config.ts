import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auth state file path
const AUTH_FILE = path.join(__dirname, ".auth/user.json");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html"], ["list"]],

  use: {
    // Support testing against:
    // 1. Vercel preview deployments (BASE_URL=https://pr-123.vercel.app)
    // 2. Local development server (default)
    baseURL:
      process.env.BASE_URL ||
      (process.env.E2E_TEST ? "http://localhost:3001" : "http://localhost:3020"),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",

    // Add backend URLs as extra context for tests
    extraHTTPHeaders: process.env.SHORTS_URL
      ? {
          "X-Test-Shorts-URL": process.env.SHORTS_URL,
          "X-Test-Market-Data-URL": process.env.MARKET_DATA_URL || "",
        }
      : {},
  },

  projects: [
    // ============================================
    // Setup Project - runs once to authenticate
    // ============================================
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },

    // ============================================
    // Authenticated Tests - require login
    // ============================================
    {
      name: "chromium-authenticated",
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_FILE,
      },
      dependencies: ["setup"],
      // Match .authenticated.spec.ts OR any test when RUN_AUTH_TESTS is set
      testMatch: process.env.RUN_AUTH_TESTS
        ? /.*\.spec\.ts/
        : /.*\.(authenticated|protected)\.spec\.ts/,
      testIgnore: /auth\.setup\.ts/,
    },

    // ============================================
    // Public Tests - no auth required
    // ============================================
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [
        /auth\.setup\.ts/,
        /.*\.(authenticated|protected)\.spec\.ts/,
      ],
    },

    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: [
        /auth\.setup\.ts/,
        /.*\.(authenticated|protected)\.spec\.ts/,
      ],
    },

    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: [
        /auth\.setup\.ts/,
        /.*\.(authenticated|protected)\.spec\.ts/,
      ],
    },

    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
      testIgnore: [
        /auth\.setup\.ts/,
        /.*\.(authenticated|protected)\.spec\.ts/,
      ],
    },

    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
      testIgnore: [
        /auth\.setup\.ts/,
        /.*\.(authenticated|protected)\.spec\.ts/,
      ],
    },
  ],

  // Don't auto-start webserver - we'll manage it separately
  // webServer: {
  //   command: 'npm run build && npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
