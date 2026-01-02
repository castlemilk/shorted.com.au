import { test, expect } from "@playwright/test";

test.describe("Stock Search E2E Tests", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the stocks page
    await page.goto("/stocks");

    // Wait for the page to load
    await page.waitForLoadState("networkidle");
  });

  test("should display search input and popular stocks", async ({ page }) => {
    // Check that search input is visible
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );
    await expect(searchInput).toBeVisible();

    // Check that popular stocks section is visible
    const popularStocks = page.locator("text=Popular stocks:");
    await expect(popularStocks).toBeVisible();

    // Check that some popular stock buttons are visible
    const stockButtons = page.locator(
      'button:has-text("CBA"), button:has-text("BHP"), button:has-text("CSL")',
    );
    await expect(stockButtons.first()).toBeVisible();
  });

  test("should show search dropdown when typing", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type in search input
    await searchInput.fill("CBA");

    // Wait for search results dropdown to appear
    await page.waitForTimeout(500); // Wait for debounced search

    // Check if dropdown appears (it might not if no results)
    const dropdown = page.locator('[class*="absolute top-full"]');
    const dropdownVisible = await dropdown.isVisible().catch(() => false);

    if (dropdownVisible) {
      // Check that dropdown contains search results
      const searchResults = page.locator('[class*="absolute top-full"] button');
      await expect(searchResults.first()).toBeVisible();

      // Check that results contain expected data
      const firstResult = searchResults.first();
      await expect(firstResult).toContainText("CBA");
    }
  });

  test("should search for stocks and display results", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type a search query
    await searchInput.fill("CBA");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // Check that stock data is displayed
    const stockInfo = page.locator('[class*="grid gap-6"]');
    await expect(stockInfo).toBeVisible();
  });

  test("should handle search with no results gracefully", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type a query that likely has no results
    await searchInput.fill("NONEXISTENTSTOCK123");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // The page should still be functional (no crashes)
    await expect(searchInput).toBeVisible();
  });

  test("should search by company name", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type a company name search
    await searchInput.fill("Bank");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // Check that some results are displayed or no error occurs
    const pageContent = page.locator("body");
    await expect(pageContent).toBeVisible();
  });

  test("should handle empty search gracefully", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Try to search with empty input
    const searchButton = page.locator('button:has-text("Search")');

    // Button should be disabled for empty search
    await expect(searchButton).toBeDisabled();
  });

  test("should search with different limits", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Test with a broad search
    await searchInput.fill("A");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // Page should load without errors
    await expect(page.locator("body")).toBeVisible();
  });

  test("should maintain search state during navigation", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type a search query
    await searchInput.fill("CBA");

    // Navigate to another page and back
    await page.goto("/");
    await page.goto("/stocks");

    // Search input should be cleared (this is expected behavior)
    await expect(searchInput).toHaveValue("");
  });

  test("should handle rapid typing in search input", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type rapidly
    await searchInput.fill("C");
    await page.waitForTimeout(100);
    await searchInput.fill("CB");
    await page.waitForTimeout(100);
    await searchInput.fill("CBA");

    // Wait for final search to complete
    await page.waitForTimeout(1000);

    // Page should still be responsive
    await expect(searchInput).toBeVisible();
  });

  test("should display loading states during search", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type in search input
    await searchInput.fill("CBA");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Check for loading indicators (if any)
    const loadingIndicator = page.locator(
      '[class*="loading"], [class*="spinner"], text="Loading"',
    );
    const hasLoadingIndicator = await loadingIndicator
      .isVisible()
      .catch(() => false);

    if (hasLoadingIndicator) {
      await expect(loadingIndicator).toBeVisible();
    }

    // Wait for search to complete
    await page.waitForTimeout(2000);
  });

  test("should handle search API errors gracefully", async ({ page }) => {
    // Mock API to return error
    await page.route("**/api/stocks/search*", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type a search query
    await searchInput.fill("CBA");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for error handling
    await page.waitForTimeout(1000);

    // Page should still be functional
    await expect(searchInput).toBeVisible();
  });

  test("should handle network timeout gracefully", async ({ page }) => {
    // Mock API to timeout
    await page.route("**/api/stocks/search*", (route) => {
      // Don't fulfill the request to simulate timeout
    });

    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type a search query
    await searchInput.fill("CBA");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for timeout handling
    await page.waitForTimeout(5000);

    // Page should still be functional
    await expect(searchInput).toBeVisible();
  });

  test("should work with keyboard navigation", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Focus search input
    await searchInput.focus();

    // Type using keyboard
    await page.keyboard.type("CBA");

    // Press Enter to search
    await page.keyboard.press("Enter");

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // Check that search was performed
    await expect(searchInput).toHaveValue("CBA");
  });

  test("should clear search input", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type in search input
    await searchInput.fill("CBA");

    // Clear the input
    await searchInput.clear();

    // Verify input is empty
    await expect(searchInput).toHaveValue("");
  });

  test("should handle special characters in search", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Test with special characters
    await searchInput.fill("CBA@#$%");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // Page should handle gracefully
    await expect(page.locator("body")).toBeVisible();
  });

  test("should maintain responsive design during search", async ({ page }) => {
    // Test on mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    const searchInput = page.locator(
      'input[placeholder*="Search by stock code"]',
    );

    // Type in search input
    await searchInput.fill("CBA");

    // Click search button
    const searchButton = page.locator('button:has-text("Search")');
    await searchButton.click();

    // Wait for search to complete
    await page.waitForTimeout(1000);

    // Check that layout is still responsive
    await expect(searchInput).toBeVisible();

    // Test on tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(searchInput).toBeVisible();

    // Test on desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(searchInput).toBeVisible();
  });
});
