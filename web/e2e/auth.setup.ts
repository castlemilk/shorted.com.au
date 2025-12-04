import { test as setup, expect } from "@playwright/test";
import path from "path";

/**
 * Authentication Setup for Playwright Tests
 *
 * This file handles authentication for E2E tests by:
 * 1. Logging in via the UI or API
 * 2. Saving the authenticated session state
 * 3. Reusing the session across all tests
 *
 * Test credentials can be configured via environment variables:
 * - E2E_TEST_EMAIL
 * - E2E_TEST_PASSWORD
 *
 * Or use the static test account for development.
 */

const AUTH_FILE = path.join(__dirname, "../.auth/user.json");

// Test user credentials - use env vars in CI, fallback to static test user
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || "e2e-test@shorted.com.au";
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || "E2ETestPassword123!";

setup("authenticate", async ({ page }) => {
  // Check if we're testing against a preview/production environment
  const baseURL = process.env.BASE_URL || "http://localhost:3020";

  console.log(`🔐 Authenticating test user: ${TEST_EMAIL}`);
  console.log(`📍 Target: ${baseURL}`);

  // Navigate to signin page
  await page.goto("/signin");

  // Wait for the signin form to load
  await page.waitForLoadState("networkidle");

  // Check if there's a credentials form (email/password)
  const emailInput = page
    .locator('input[type="email"], input[name="email"]')
    .first();
  const passwordInput = page
    .locator('input[type="password"], input[name="password"]')
    .first();

  const hasCredentialsForm = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);

  if (hasCredentialsForm) {
    console.log("📝 Found credentials form, logging in...");

    // Fill in credentials
    await emailInput.fill(TEST_EMAIL);
    await passwordInput.fill(TEST_PASSWORD);

    // Find and click submit button
    const submitButton = page
      .locator('button[type="submit"]')
      .or(page.getByRole("button", { name: /sign in|login|submit/i }))
      .first();

    await submitButton.click();

    // Wait for redirect after login (either to home or dashboard)
    await page.waitForURL(
      (url) => !url.pathname.includes("/signin"),
      { timeout: 15000 }
    ).catch(async () => {
      // Check if there's an error message
      const errorMessage = await page.locator('[role="alert"], .error, [class*="error"]').textContent().catch(() => null);
      if (errorMessage) {
        console.error(`❌ Login failed: ${errorMessage}`);
      }
      throw new Error("Login redirect did not occur - authentication may have failed");
    });

    console.log("✅ Login successful!");
  } else {
    // Check for Google OAuth button
    const googleButton = page.getByRole("button", { name: /google|continue with google/i });

    if (await googleButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("⚠️ Only Google OAuth available - cannot automate OAuth login");
      console.log("💡 To enable automated testing:");
      console.log("   1. Enable the Credentials provider with a test user, or");
      console.log("   2. Manually authenticate once and save the session state");

      // For CI, we'll skip auth-dependent tests
      // For local dev, provide instructions
      setup.skip();
      return;
    }

    console.log("❌ No login form found");
    setup.skip();
    return;
  }

  // Verify we're authenticated by checking for user indicators
  await expect(
    page.locator('[data-testid="user-menu"]')
      .or(page.getByRole("button", { name: /logout|sign out|account/i }))
      .or(page.locator('[class*="user"], [class*="avatar"]'))
  ).toBeVisible({ timeout: 10000 });

  console.log("💾 Saving authentication state...");

  // Save the authenticated session state
  await page.context().storageState({ path: AUTH_FILE });

  console.log(`✅ Auth state saved to ${AUTH_FILE}`);
});

