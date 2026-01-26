import { test, expect } from "@playwright/test";

test.describe("Stock Search Facets E2E Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/stocks");
    await page.waitForLoadState("networkidle");
  });

  test("should display filter controls", async ({ page }) => {
    // Check for industry dropdown
    await expect(page.locator("button").filter({ hasText: "Select Industry" })).toBeVisible();
    
    // Check for market cap dropdown
    await expect(page.locator("button").filter({ hasText: "Market Cap" })).toBeVisible();
  });

  test("should filter by industry", async ({ page }) => {
    // Type search query first to get results
    const searchInput = page.locator('input[placeholder*="Search stocks by code"]');
    await searchInput.fill("a"); // Broad search
    
    // Open industry dropdown
    await page.locator("button").filter({ hasText: "Select Industry" }).click();
    
    // Select 'Banks' from the dropdown content
    await page.getByRole('option', { name: 'Banks' }).click();
    
    // Check that filter badge appears
    await expect(page.locator('.bg-secondary').filter({ hasText: 'Banks' })).toBeVisible();
    
    // URL should be updated
    expect(page.url()).toContain("industry=Banks");
  });

  test("should filter by market cap", async ({ page }) => {
    // Type search query
    const searchInput = page.locator('input[placeholder*="Search stocks by code"]');
    await searchInput.fill("a");
    
    // Open market cap dropdown
    await page.locator("button").filter({ hasText: "Market Cap" }).click();
    
    // Select 'Large Cap'
    await page.getByRole('option', { name: 'Large Cap' }).click();
    
    // Check that filter badge appears
    await expect(page.locator('.bg-secondary').filter({ hasText: 'Large Cap' })).toBeVisible();
    
    // URL should be updated
    expect(page.url()).toContain("marketCap=large");
  });

  test("should clear filters", async ({ page }) => {
    // Apply a filter
    await page.locator("button").filter({ hasText: "Select Industry" }).click();
    await page.getByRole('option', { name: 'Mining' }).click();
    
    // Check for clear button
    const clearButton = page.locator("button").filter({ hasText: "Clear all" });
    await expect(clearButton).toBeVisible();
    
    // Click clear
    await clearButton.click();
    
    // Check badge is gone
    await expect(page.locator('.bg-secondary').filter({ hasText: 'Mining' })).not.toBeVisible();
    
    // URL should be clean
    expect(page.url()).not.toContain("industry=Mining");
  });

  test("should persist filters on reload", async ({ page }) => {
    // Apply a filter via URL
    await page.goto("/stocks?industry=Technology&tag=tech");
    await page.waitForLoadState("networkidle");
    
    // Check badges are present
    await expect(page.locator('.bg-secondary').filter({ hasText: 'Technology' })).toBeVisible();
    await expect(page.locator('.border-input').filter({ hasText: 'tech' })).toBeVisible();
    
    // Check dropdown value
    await expect(page.locator("button").filter({ hasText: "Technology" })).toBeVisible();
  });
});

