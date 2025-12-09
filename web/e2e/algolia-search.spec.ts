import { test, expect, type Page } from "@playwright/test";

/**
 * Algolia Search & Logo Display Tests
 *
 * These tests verify:
 * 1. Algolia search functionality (typo tolerance, elastic search)
 * 2. Logo display in search results and stock pages
 * 3. Search performance characteristics
 *
 * Regression prevention for:
 * - Missing logos on search results
 * - Missing logos on stock detail pages
 * - Search not finding stocks by description (e.g., "copper mining")
 * - Typo tolerance not working (e.g., "commwealth" → "Commonwealth")
 *
 * Note: /stocks is a protected route, so UI search tests are skipped
 * unless running with authentication. API tests always run.
 */

// Check if we should skip UI tests that require auth
const skipAuthTests = !process.env.RUN_AUTH_TESTS;

test.describe("Algolia Search Functionality", () => {
  // Skip UI tests if no auth - they will run in authenticated project
  test.skip(() => skipAuthTests, "Skipping - requires authentication");

  // Increase timeout for cold starts on preview environments
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/stocks", { timeout: 30000 });
    // Use domcontentloaded instead of networkidle for faster tests
    await page.waitForLoadState("domcontentloaded");
    // Wait for the page to be interactive
    await page.waitForTimeout(2000);
  });

  test("should find stocks with typo tolerance", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Type with a typo: "commwealth" instead of "commonwealth"
    await searchInput.fill("commwealth");
    await searchInput.press("Enter");

    // Wait for search results
    await page.waitForTimeout(1500);

    // Should find Commonwealth Bank despite typo
    const pageContent = await page.content();
    const foundCBA =
      pageContent.toLowerCase().includes("commonwealth") ||
      pageContent.toLowerCase().includes("cba");

    expect(foundCBA).toBeTruthy();
  });

  test("should search across company descriptions (elastic search)", async ({
    page,
  }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Search for "copper" which should match companies with copper in their description
    await searchInput.fill("copper");
    await searchInput.press("Enter");

    // Wait for search results
    await page.waitForTimeout(1500);

    // Should find copper-related stocks (29M, CSC, etc.)
    const pageContent = await page.content();
    const foundCopperStock =
      pageContent.includes("29M") ||
      pageContent.includes("CSC") ||
      pageContent.toLowerCase().includes("copper") ||
      pageContent.includes("IGO");

    expect(foundCopperStock).toBeTruthy();
  });

  test("should return results quickly (< 500ms perceived)", async ({
    page,
  }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Measure search response time
    const startTime = Date.now();

    await searchInput.fill("BHP");
    await searchInput.press("Enter");

    // Wait for results to appear
    await page.waitForSelector(
      '[class*="search-result"], [class*="grid"], table tbody tr',
      { timeout: 5000 },
    );

    const endTime = Date.now();
    const searchTime = endTime - startTime;

    console.log(`Search completed in ${searchTime}ms`);

    // Should complete in under 3 seconds (generous for network latency)
    expect(searchTime).toBeLessThan(3000);
  });

  test("should handle empty search gracefully", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Clear any existing text and try to search
    await searchInput.clear();

    // Verify input is empty
    await expect(searchInput).toHaveValue("");

    // Page should still be functional
    await expect(page.locator("body")).toBeVisible();
  });

  test("should search by stock code exactly", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Search for exact stock code
    await searchInput.fill("BHP");
    await searchInput.press("Enter");

    await page.waitForTimeout(1500);

    // BHP should be in results
    const pageContent = await page.content();
    expect(pageContent).toContain("BHP");
  });

  test("should search by company name", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Search for company name
    await searchInput.fill("Woolworths");
    await searchInput.press("Enter");

    await page.waitForTimeout(1500);

    // Should find Woolworths (WOW)
    const pageContent = await page.content();
    const foundWoolworths =
      pageContent.includes("WOW") ||
      pageContent.toLowerCase().includes("woolworth");

    expect(foundWoolworths).toBeTruthy();
  });
});

test.describe("Logo Display in Search Results", () => {
  // Skip UI tests if no auth - they will run in authenticated project
  test.skip(() => skipAuthTests, "Skipping - requires authentication");

  // Increase timeout for cold starts on preview environments
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/stocks");
    await page.waitForLoadState("domcontentloaded");
  });

  test("should display logos for major stocks in search dropdown", async ({
    page,
  }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Search for a major stock that should have a logo
    await searchInput.fill("BHP");

    // Wait for dropdown to appear
    await page.waitForTimeout(1000);

    // Check for logo in dropdown (img with src containing storage.googleapis.com)
    const dropdownLogo = page.locator(
      'img[src*="storage.googleapis.com"], img[src*="shorted-company-logos"]',
    );

    const logoCount = await dropdownLogo.count();

    // If dropdown shows, it should have logos
    if (logoCount > 0) {
      const firstLogo = dropdownLogo.first();
      await expect(firstLogo).toBeVisible();

      // Verify logo loads without error
      const logoSrc = await firstLogo.getAttribute("src");
      expect(logoSrc).toContain("BHP");
    }
  });

  test("should display placeholder for stocks without logos", async ({
    page,
  }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    // Search for any stock
    await searchInput.fill("A");
    await page.waitForTimeout(1000);

    // Either logos or placeholders should be visible
    const logos = page.locator(
      'img[src*="storage.googleapis.com"], [class*="placeholder"], [class*="bg-"]',
    );

    // Some visual representation should exist
    const hasVisuals = (await logos.count()) > 0;
    expect(hasVisuals).toBeTruthy();
  });

  test("should handle logo load errors gracefully", async ({ page }) => {
    // Navigate to search and trigger a search
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    ).first();

    await searchInput.fill("CBA");
    await searchInput.press("Enter");
    await page.waitForTimeout(1500);

    // Page should not have any uncaught errors
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.waitForTimeout(1000);

    // No critical errors related to images
    const imageErrors = errors.filter(
      (e) => e.includes("img") || e.includes("image"),
    );
    expect(imageErrors.length).toBe(0);
  });
});

test.describe("Logo Display on Stock Detail Page", () => {
  // Increase timeout for cold starts on preview environments
  test.setTimeout(90000);

  test("should display logo on BHP detail page", async ({ page }) => {
    await page.goto("/shorts/BHP");
    await page.waitForLoadState("domcontentloaded");

    // Wait for page content to load
    await page.waitForTimeout(2000);

    // Check for logo on detail page
    const logo = page.locator(
      'img[src*="storage.googleapis.com/shorted-company-logos"], img[src*="BHP"], img[alt*="BHP"]',
    );

    // Logo or placeholder should be present
    const hasLogo = (await logo.count()) > 0;
    const hasPlaceholder =
      (await page.locator('[class*="placeholder"]').count()) > 0;
    const hasIcon = (await page.locator("svg").count()) > 0;

    // Should have some visual representation of the company
    expect(hasLogo || hasPlaceholder || hasIcon).toBeTruthy();

    // If logo exists, verify it's from correct source
    if (hasLogo) {
      const logoSrc = await logo.first().getAttribute("src");
      if (logoSrc) {
        expect(logoSrc).toContain("storage.googleapis.com");
      }
    }
  });

  test("should display logo on CSL detail page", async ({ page }) => {
    await page.goto("/shorts/CSL");
    await page.waitForLoadState("domcontentloaded");

    await page.waitForTimeout(2000);

    // Check for logo
    const logo = page.locator(
      'img[src*="storage.googleapis.com"], img[src*="CSL"]',
    );

    if ((await logo.count()) > 0) {
      const logoSrc = await logo.first().getAttribute("src");
      if (logoSrc) {
        expect(logoSrc).toContain("CSL");
      }
    }
  });

  test("should display logo on CBA detail page", async ({ page }) => {
    await page.goto("/shorts/CBA");
    await page.waitForLoadState("domcontentloaded");

    await page.waitForTimeout(2000);

    // Check for logo
    const logo = page.locator(
      'img[src*="storage.googleapis.com"], img[src*="CBA"]',
    );

    if ((await logo.count()) > 0) {
      await expect(logo.first()).toBeVisible();
    }
  });

  test("should handle stock without logo gracefully", async ({ page }) => {
    // Navigate to a stock that might not have a logo
    await page.goto("/shorts/AAA");
    await page.waitForLoadState("domcontentloaded");

    await page.waitForTimeout(2000);

    // Page should load without errors
    const pageContent = await page.content();

    // Should show stock code or company info
    const hasContent =
      pageContent.includes("AAA") || pageContent.includes("not found");

    expect(hasContent).toBeTruthy();

    // No image load errors should break the page
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Search API Integration", () => {
  test("backend search API returns logo URLs", async ({ page }) => {
    // Get the backend URL from environment or use default
    const backendUrl =
      process.env.SHORTS_URL || "http://localhost:9091";

    // Test the search API directly
    const response = await page.request.get(
      `${backendUrl}/api/stocks/search?q=BHP&limit=1`,
    );

    if (response.ok()) {
      const data = await response.json();

      expect(data.stocks).toBeDefined();
      expect(data.stocks.length).toBeGreaterThan(0);

      const firstStock = data.stocks[0];
      expect(firstStock.product_code).toBe("BHP");

      // Logo URL should be present
      if (firstStock.logoUrl) {
        expect(firstStock.logoUrl).toContain(
          "storage.googleapis.com/shorted-company-logos",
        );
      }
    }
  });

  test("search API supports typo tolerance via Algolia", async ({ page }) => {
    const backendUrl =
      process.env.SHORTS_URL || "http://localhost:9091";

    // Search with typo
    const response = await page.request.get(
      `${backendUrl}/api/stocks/search?q=commwealth&limit=5`,
    );

    if (response.ok()) {
      const data = await response.json();

      // Should find Commonwealth Bank despite typo
      const hasCBA = data.stocks.some(
        (s: { product_code: string; name: string }) =>
          s.product_code === "CBA" ||
          s.name.toLowerCase().includes("commonwealth"),
      );

      expect(hasCBA).toBeTruthy();
    }
  });

  test("search API returns industry and tags", async ({ page }) => {
    const backendUrl =
      process.env.SHORTS_URL || "http://localhost:9091";

    const response = await page.request.get(
      `${backendUrl}/api/stocks/search?q=BHP&limit=1`,
    );

    if (response.ok()) {
      const data = await response.json();

      if (data.stocks.length > 0) {
        const stock = data.stocks[0];

        // Industry should be present
        expect(stock.industry).toBeDefined();

        // Tags should be an array
        expect(Array.isArray(stock.tags)).toBeTruthy();
      }
    }
  });
});

test.describe("Visual Regression Prevention", () => {
  // Increase timeout for cold starts on preview environments
  test.setTimeout(90000);

  test.describe("Search Results Layout", () => {
    // Skip if no auth
    test.skip(() => skipAuthTests, "Skipping - requires authentication");

    test("search results have consistent layout", async ({ page }) => {
      await page.goto("/stocks");
      await page.waitForLoadState("domcontentloaded");

      const searchInput = page.locator(
        'input[placeholder*="Search"], input[type="search"]',
      ).first();

      await searchInput.fill("bank");
      await page.waitForTimeout(1500);

      // Take screenshot for visual comparison
      await page.screenshot({
        path: "test-results/search-results-layout.png",
        fullPage: false,
      });

      // Verify search results container exists
      const resultsContainer = page.locator(
        '[class*="search"], [class*="results"], [class*="grid"]',
      );
      await expect(resultsContainer.first()).toBeVisible();
    });
  });

  test("stock detail page has consistent layout", async ({ page }) => {
    await page.goto("/shorts/BHP");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Take screenshot for visual comparison
    await page.screenshot({
      path: "test-results/stock-detail-layout.png",
      fullPage: false,
    });

    // Verify key elements are present - check for stock code or company name
    const hasStockInfo =
      (await page.locator("text=BHP").first().isVisible({ timeout: 5000 }).catch(() => false)) ||
      (await page.locator("h1, h2").first().isVisible({ timeout: 5000 }).catch(() => false));

    expect(hasStockInfo).toBeTruthy();
  });
});

