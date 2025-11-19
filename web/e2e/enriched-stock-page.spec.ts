import { test, expect } from "@playwright/test";

/**
 * E2E Test for Enriched Stock Page
 * 
 * Tests the full user flow for viewing enriched company data:
 * - Page loads successfully
 * - Enriched company sections are visible
 * - Tags, key people, and financial reports are displayed
 * - Links and interactions work correctly
 */

test.describe("Enriched Stock Page - WES (Wesfarmers)", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to a stock that has enriched data
    await page.goto("/shorts/WES");
  });

  test("should display stock page with all main sections", async ({ page }) => {
    // Check page title
    await expect(page).toHaveTitle(/WES.*Stock Analysis/i);

    // Check main sections are present
    await expect(page.getByText("Short Position Trends")).toBeVisible();
    await expect(page.getByText("Historical Price Data")).toBeVisible();
  });

  test("should display enriched company tags", async ({ page }) => {
    // Wait for enriched section to load
    await page.waitForSelector('[data-testid="company-tags"], text=conglomerate', {
      timeout: 10000,
    });

    // Check that tags are visible (Wesfarmers has tags: conglomerate, retail, etc.)
    const tags = page.locator('[data-testid="company-tag"]');
    await expect(tags.first()).toBeVisible();
    
    // Should have multiple tags
    const tagCount = await tags.count();
    expect(tagCount).toBeGreaterThan(0);
  });

  test("should display enhanced company summary", async ({ page }) => {
    // Look for the enhanced summary
    await page.waitForSelector('text=Company Overview', {
      timeout: 10000,
    });

    // Summary should mention Wesfarmers
    const summary = page.locator('text=/Wesfarmers/i');
    await expect(summary).toBeVisible();
  });

  test("should display key people section", async ({ page }) => {
    // Wait for key people section
    await page.waitForSelector('text=Key People', {
      timeout: 10000,
    });

    // Should show CEO (Rob Scott for Wesfarmers)
    const ceo = page.locator('text=/CEO|Chief Executive/i');
    await expect(ceo).toBeVisible();
  });

  test("should display risk factors if available", async ({ page }) => {
    // Check if risk factors section exists
    const riskSection = page.locator('text=Risk Factors');
    
    if (await riskSection.isVisible()) {
      // Should have at least one risk factor listed
      const riskItems = page.locator('[data-testid="risk-factor-item"]');
      const count = await riskItems.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("should display recent developments if available", async ({ page }) => {
    // Check if recent developments section exists
    const recentDevSection = page.locator('text=Recent Developments');
    
    if (await recentDevSection.isVisible()) {
      // Should have content
      const content = await recentDevSection.textContent();
      expect(content).not.toBeNull();
    }
  });

  test("should handle stock without enriched data gracefully", async ({ page }) => {
    // Navigate to a stock that likely doesn't have enriched data yet
    await page.goto("/shorts/ZZZZZ");

    // Should show fallback message
    await expect(
      page.getByText(/enriched.*data not available|check back soon/i)
    ).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe("Enriched Stock Page - BHP", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/shorts/BHP");
  });

  test("should display BHP enriched data", async ({ page }) => {
    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check for BHP-specific content
    await expect(page.getByText(/BHP|mining/i)).toBeVisible();

    // Should have mining-related tags
    await page.waitForSelector('text=/mining|resources|iron ore|copper/i', {
      timeout: 10000,
    });
  });

  test("should display competitive advantages", async ({ page }) => {
    // BHP should have competitive advantages section
    const advSection = page.locator('text=Competitive Advantages');
    
    if (await advSection.isVisible()) {
      // Should mention scale or operations
      await expect(page.getByText(/scale|operations|diversified/i)).toBeVisible();
    }
  });
});

test.describe("Enriched Data Integration", () => {
  test("should load enriched data without blocking main content", async ({ page }) => {
    await page.goto("/shorts/WES");

    // Main charts should load first
    await expect(page.getByText("Short Position Trends")).toBeVisible({
      timeout: 5000,
    });

    // Enriched data can load after (Suspense boundary)
    // This tests that slow enriched data doesn't block the page
    await expect(page.getByText(/Company Overview|Key People/i)).toBeVisible({
      timeout: 15000,
    });
  });

  test("should handle navigation between enriched and non-enriched stocks", async ({ page }) => {
    // Start with enriched stock
    await page.goto("/shorts/WES");
    await expect(page.getByText("Company Overview")).toBeVisible({
      timeout: 10000,
    });

    // Navigate to potentially non-enriched stock
    await page.goto("/shorts/ABC");
    
    // Page should still work
    await expect(page.getByText("Short Position Trends")).toBeVisible();
  });
});

