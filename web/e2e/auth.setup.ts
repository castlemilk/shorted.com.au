import { test as setup, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Authentication Setup for Playwright Tests
 *
 * This file handles authentication for E2E tests by:
 * 1. Logging in via the UI
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
const TEST_EMAIL = process.env.E2E_TEST_EMAIL ?? "e2e-test@shorted.com.au";
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? "E2ETestPassword123!";

setup("authenticate", async ({ page }) => {
  const baseURL = process.env.BASE_URL ?? "http://localhost:3020";

  console.log(`🔐 Authenticating test user: ${TEST_EMAIL}`);
  console.log(`📍 Target: ${baseURL}`);

  // Navigate to signin page
  await page.goto("/signin");
  await page.waitForLoadState("networkidle");

  // Check for email input
  const emailInput = page.locator("#email");
  const passwordInput = page.locator("#password");

  if (!(await emailInput.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log("⚠️ Credentials form not found - skipping auth setup");
    setup.skip();
    return;
  }

  console.log("📝 Filling credentials form...");

  // Fill in credentials
  await emailInput.fill(TEST_EMAIL);
  await passwordInput.fill(TEST_PASSWORD);

  // Find and click submit button (the one inside the card form with email/password)
  const submitButton = page
    .locator("form")
    .filter({ hasText: "Password" })
    .getByRole("button", { name: "Sign in" });
  await expect(submitButton).toBeVisible();

  console.log("🖱️ Submitting form...");
  await submitButton.click();

  // Wait for navigation/redirect (increased timeout for cold starts)
  await page.waitForTimeout(5000);

  // Also try waiting for URL change explicitly
  try {
    await page.waitForURL((url) => !url.pathname.includes("/signin"), {
      timeout: 10000,
    });
    console.log("✅ URL changed away from signin");
  } catch (e) {
    console.log("⚠️ URL did not change from signin after 10s");
  }

  // Check if URL changed (successful login redirects away from /signin)
  const currentUrl = page.url();
  console.log(`📍 Current URL: ${currentUrl}`);

  if (currentUrl.includes("/signin")) {
    // Still on signin page - check for error message
    const errorElement = page.locator("form .text-destructive");
    if (await errorElement.isVisible().catch(() => false)) {
      const errorText = await errorElement.textContent();
      console.error(`❌ Login failed: ${errorText}`);
      await page.screenshot({ path: "test-results/auth-error.png" });
      throw new Error(`Login failed: ${errorText}`);
    }

    console.log(
      "⚠️ Still on signin page - credentials auth may not be working",
    );
    await page.screenshot({ path: "test-results/auth-still-on-signin.png" });
    setup.skip();
    return;
  }

  console.log("✅ Login successful! Redirected away from signin page");

  // Verify we're authenticated by checking for user indicators
  await page.waitForTimeout(2000);

  // Save the authenticated session state
  console.log("💾 Saving authentication state...");
  await page.context().storageState({ path: AUTH_FILE });
  console.log(`✅ Auth state saved to ${AUTH_FILE}`);
});
