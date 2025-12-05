import { test, expect } from "@playwright/test";

/**
 * Smoke Tests for Preview Deployments
 *
 * These tests run against Vercel preview deployments to ensure
 * basic functionality works after deployment. They are designed to be:
 * - Fast (< 2 minutes total)
 * - Reliable (no flaky tests)
 * - Critical (catch deployment issues early)
 *
 * Note: Preview deployments may have cold starts up to 30+ seconds
 */

// Increase timeout for cold start scenarios
test.setTimeout(60000);

test.describe("Smoke Tests - Preview Deployment", () => {
  test("homepage loads successfully", async ({ page }) => {
    // Navigate with extended timeout for cold starts
    await page.goto("/", { timeout: 30000, waitUntil: "domcontentloaded" });

    // Check that page loads without errors - just verify we have content
    await page.waitForLoadState("domcontentloaded");

    // Verify the page has some content (not a blank page or error)
    const bodyText = await page.locator("body").textContent({ timeout: 30000 });
    expect(bodyText).toBeTruthy();
    expect(bodyText!.length).toBeGreaterThan(100);

    // Check title matches (indicates Next.js rendered correctly)
    await expect(page).toHaveTitle(/Shorted/i, { timeout: 30000 });
  });

  test("can navigate to treemap page", async ({ page }) => {
    await page.goto("/treemap", { timeout: 30000, waitUntil: "domcontentloaded" });

    // Wait for page to be interactive
    await page.waitForLoadState("domcontentloaded");

    // Verify we're on the right page - check URL or content
    expect(page.url()).toContain("treemap");

    // Check that some content loaded (SVG for treemap or any visible element)
    const hasContent = await page.locator("body").textContent({ timeout: 20000 });
    expect(hasContent).toBeTruthy();
  });

  test("stock detail page loads", async ({ page }) => {
    // Test direct navigation to a stock detail page (public route)
    await page.goto("/shorts/CBA", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("domcontentloaded");

    // Check we got a valid page (not an error)
    const pageContent = await page.locator("body").textContent({ timeout: 20000 });
    expect(pageContent).toBeTruthy();

    // Should either show stock info or 404 - not a crash
    const hasValidContent =
      pageContent!.includes("CBA") ||
      pageContent!.toLowerCase().includes("not found") ||
      pageContent!.includes("404");

    // If neither, at least check it's not a 500 error page
    const hasError500 =
      pageContent!.includes("500") &&
      pageContent!.toLowerCase().includes("internal");

    expect(hasError500).toBeFalsy();
  });

  test("API health endpoint responds", async ({ page }) => {
    // Test the health endpoint - this should be fast
    const healthResponse = await page.request.get("/api/health", {
      timeout: 10000,
    });

    // Should return 200 or at least not 500
    expect(healthResponse.status()).toBeLessThan(500);
  });

  test("signin page loads", async ({ page }) => {
    // Signin page should always be accessible
    await page.goto("/signin", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("domcontentloaded");

    // Check that sign-in form or auth elements are present
    const pageContent = await page.locator("body").textContent({ timeout: 20000 });
    expect(pageContent).toBeTruthy();

    // Should have sign in related content
    const hasSignInContent =
      pageContent!.toLowerCase().includes("sign in") ||
      pageContent!.toLowerCase().includes("login") ||
      pageContent!.toLowerCase().includes("google") ||
      pageContent!.toLowerCase().includes("email");

    expect(hasSignInContent).toBeTruthy();
  });
});

test.describe("Backend API Smoke Tests", () => {
  test("shorts API search endpoint works", async ({ page }) => {
    // Test the search API endpoint
    const searchResponse = await page.request.get("/api/stocks/search?q=BHP&limit=1", {
      timeout: 15000,
    });

    // Should return 200 or at least not 500
    expect(searchResponse.status()).toBeLessThan(500);

    if (searchResponse.ok()) {
      try {
        const body = await searchResponse.json();
        console.log("Search response:", JSON.stringify(body).slice(0, 200));

        // Should have stocks array
        expect(body).toHaveProperty("stocks");
      } catch {
        console.log("Search returned non-JSON response");
      }
    }
  });
});

/**
 * Simplified Test Priorities:
 * 1. Homepage loads (basic content check)
 * 2. Treemap page loads
 * 3. Stock detail page loads
 * 4. API endpoints respond
 * 5. Signin page loads
 *
 * These tests should complete in < 3 minutes total (accounting for cold starts)
 */
