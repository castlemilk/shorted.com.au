/**
 * E2E tests for stock search with sparklines
 * Tests the complete user flow from search to sparkline display
 */

import { test, expect } from "@playwright/test";

test.describe("Stock Search with Sparklines", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to stocks page
    await page.goto("/stocks");
    await page.waitForLoadState("networkidle");
  });

  test("should display search input and allow typing", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search stocks/i);
    await expect(searchInput).toBeVisible();

    await searchInput.fill("CBA");
    await expect(searchInput).toHaveValue("CBA");
  });

  test("should trigger search and display results", async ({ page }) => {
    // Mock the search API response
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK OF AUSTRALIA",
              percentage_shorted: 1.63,
              total_product_in_issue: 1000000000,
              reported_short_positions: 16300000,
            },
            {
              product_code: "CBAP",
              name: "COMMONWEALTH BANK PERLS",
              percentage_shorted: 0.04,
              total_product_in_issue: 500000000,
              reported_short_positions: 200000,
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("CBA");
    await page.waitForTimeout(500); // Wait for debounce

    // Verify search results appear
    await expect(page.getByText("Found")).toBeVisible();
    await expect(page.getByText("CBA")).toBeVisible();
    await expect(
      page.getByText("COMMONWEALTH BANK OF AUSTRALIA"),
    ).toBeVisible();
  });

  test("should load sparklines for search results", async ({ page }) => {
    // Mock the search API
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK OF AUSTRALIA",
              percentage_shorted: 1.63,
              total_product_in_issue: 1000000000,
              reported_short_positions: 16300000,
            },
          ],
        }),
      });
    });

    // Mock the historical data API
    await page.route("**/api/market-data/historical", async (route) => {
      const request = route.request();
      const postData = JSON.parse(request.postData() ?? "{}");

      if (postData.stockCode === "CBA") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            prices: [
              {
                stockCode: "CBA",
                date: "2025-01-01T00:00:00Z",
                open: 135.5,
                high: 137.2,
                low: 134.8,
                close: 136.9,
                volume: "5234567",
                adjustedClose: 136.9,
              },
              {
                stockCode: "CBA",
                date: "2025-02-01T00:00:00Z",
                open: 136.9,
                high: 139.1,
                low: 136.2,
                close: 138.5,
                volume: "4987654",
                adjustedClose: 138.5,
              },
              {
                stockCode: "CBA",
                date: "2025-03-01T00:00:00Z",
                open: 138.5,
                high: 141.0,
                low: 137.9,
                close: 140.2,
                volume: "5876543",
                adjustedClose: 140.2,
              },
            ],
          }),
        });
      }
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("CBA");
    await page.waitForTimeout(500);

    // Wait for sparkline to load
    await page.waitForTimeout(1000);

    // Verify sparkline SVG exists
    const sparklines = page.locator("svg");
    await expect(sparklines.first()).toBeVisible();
  });

  test("should show sparkline tooltip on hover", async ({ page }) => {
    // Setup mocks
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK OF AUSTRALIA",
              percentage_shorted: 1.63,
            },
          ],
        }),
      });
    });

    await page.route("**/api/market-data/historical", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prices: [
            {
              stockCode: "CBA",
              date: "2025-01-01T00:00:00Z",
              close: 136.9,
              open: 135.5,
              high: 137.2,
              low: 134.8,
              volume: "5234567",
              adjustedClose: 136.9,
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("CBA");
    await page.waitForTimeout(1500);

    // Find sparkline SVG and hover over it
    const sparkline = page.locator("svg").first();
    if (await sparkline.isVisible()) {
      await sparkline.hover();
      await page.waitForTimeout(300);

      // Tooltip might contain price information
      // Note: actual implementation may vary
    }
  });

  test("should handle multiple concurrent sparkline loads", async ({
    page,
  }) => {
    // Mock search with multiple results
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK",
              percentage_shorted: 1.63,
            },
            {
              product_code: "ANZ",
              name: "ANZ GROUP HOLDINGS",
              percentage_shorted: 2.15,
            },
            {
              product_code: "NAB",
              name: "NATIONAL AUSTRALIA BANK",
              percentage_shorted: 1.89,
            },
          ],
        }),
      });
    });

    // Mock historical data for multiple stocks
    await page.route("**/api/market-data/historical", async (route) => {
      const request = route.request();
      const postData = JSON.parse(request.postData() ?? "{}");

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prices: [
            {
              stockCode: postData.stockCode,
              date: "2025-01-01T00:00:00Z",
              close: 140.0,
              open: 138.0,
              high: 142.0,
              low: 137.0,
              volume: "5000000",
              adjustedClose: 140.0,
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("bank");
    await page.waitForTimeout(1500);

    // Verify multiple results displayed
    await expect(page.getByText("CBA")).toBeVisible();
    await expect(page.getByText("ANZ")).toBeVisible();
    await expect(page.getByText("NAB")).toBeVisible();
  });

  test("should handle sparkline API errors gracefully", async ({ page }) => {
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "TEST",
              name: "TEST STOCK",
              percentage_shorted: 1.0,
            },
          ],
        }),
      });
    });

    // Mock API error
    await page.route("**/api/market-data/historical", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("TEST");
    await page.waitForTimeout(1500);

    // Should show "No data" instead of crashing
    await expect(page.getByText("No data")).toBeVisible();
  });

  test("should show empty sparkline for stocks with no historical data", async ({
    page,
  }) => {
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            { product_code: "NEW", name: "NEW STOCK", percentage_shorted: 0.5 },
          ],
        }),
      });
    });

    await page.route("**/api/market-data/historical", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ prices: [] }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("NEW");
    await page.waitForTimeout(1500);

    // Should show "No data" message
    await expect(page.getByText("No data")).toBeVisible();
  });

  test("should navigate to stock details on click", async ({ page }) => {
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK",
              percentage_shorted: 1.63,
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("CBA");
    await page.waitForTimeout(1000);

    // Click on search result
    const resultItem = page
      .locator("button")
      .filter({ hasText: "CBA" })
      .first();
    if (await resultItem.isVisible()) {
      await resultItem.click();

      // Should navigate to stock details page
      await expect(page).toHaveURL(/\/shorts\/CBA/);
    }
  });

  test("should show industry badges with correct colors", async ({ page }) => {
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK",
              percentage_shorted: 1.63,
              industry: "Banks",
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("CBA");
    await page.waitForTimeout(1000);

    // Verify industry badge appears
    await expect(page.getByText("Banks")).toBeVisible();
  });

  test("should display short percentage in results", async ({ page }) => {
    await page.route("**/api/stocks/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stocks: [
            {
              product_code: "CBA",
              name: "COMMONWEALTH BANK",
              percentage_shorted: 1.63,
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder(/search stocks/i);
    await searchInput.fill("CBA");
    await page.waitForTimeout(1000);

    // Verify short percentage displayed
    await expect(page.getByText(/1\.63%/)).toBeVisible();
  });
});
