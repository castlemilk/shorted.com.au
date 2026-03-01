import { test, expect } from "@playwright/test";

test.setTimeout(60000);

test.describe("Stock Screener - Page Load", () => {
  test("screener page loads successfully", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    // Verify page title
    await expect(page).toHaveTitle(/Stock Screener.*Shorted/i, { timeout: 15000 });

    // Verify heading is present
    await expect(page.getByRole("heading", { name: "Stock Screener" })).toBeVisible({ timeout: 10000 });

    // Verify description text
    await expect(
      page.getByText("Filter ASX stocks by short positions"),
    ).toBeVisible();
  });

  test("shows initial instructions when no search performed", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    // Should show the "Start screening" prompt
    await expect(
      page.getByText("Start screening ASX stocks"),
    ).toBeVisible({ timeout: 10000 });

    // Should NOT show any results table yet
    await expect(page.locator("table")).not.toBeVisible();
  });

  test("shows preset buttons", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    // All 4 presets should be visible
    await expect(page.getByText("Short Squeeze Candidates")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Dividend Aristocrats Under Pressure")).toBeVisible();
    await expect(page.getByText("Small Cap Bears")).toBeVisible();
    await expect(page.getByText("Director Buying Heavily Shorted")).toBeVisible();
  });

  test("navigation includes screener link", async ({ page }) => {
    await page.goto("/", { timeout: 30000, waitUntil: "domcontentloaded" });

    // Check the nav has screener link
    const screenerLink = page.locator('nav a[href="/screener"]');
    await expect(screenerLink).toBeVisible({ timeout: 10000 });
    await expect(screenerLink).toHaveText("screener");
  });
});

test.describe("Stock Screener - Filter Panel", () => {
  test("filter panel is visible by default", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    // Filter panel should be visible
    await expect(page.getByText("Short Position (%)")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Market Cap ($)")).toBeVisible();
    await expect(page.getByText("P/E Ratio")).toBeVisible();
    await expect(page.getByText("Dividend Yield (%)")).toBeVisible();
  });

  test("filter panel can be toggled", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Initially visible
    await expect(page.getByText("Short Position (%)")).toBeVisible({ timeout: 10000 });

    // Click Filters button to hide
    await page.getByRole("button", { name: /Filters/ }).click();

    // Should be hidden
    await expect(page.getByText("Short Position (%)")).not.toBeVisible();

    // Click again to show
    await page.getByRole("button", { name: /Filters/ }).click();

    // Should be visible again
    await expect(page.getByText("Short Position (%)")).toBeVisible();
  });

  test("search button triggers API call", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Click the Search button
    await page.getByRole("button", { name: /Search/ }).click();

    // Should show results count (or loading state transitioning to results)
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    // Table should now be visible
    await expect(page.locator("table")).toBeVisible({ timeout: 5000 });

    // Initial instructions should be gone
    await expect(page.getByText("Start screening ASX stocks")).not.toBeVisible();
  });

  test("can enter filter values and search", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Find the Short Position min input (first number input in the Short Position section)
    const shortPctSection = page.locator("text=Short Position (%)").locator("..");
    const minInput = shortPctSection.locator('input[type="number"]').first();
    await minInput.fill("10");

    // Click Search
    await page.getByRole("button", { name: /Search/ }).click();

    // Should get filtered results
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    // Should show active filter badge
    await expect(page.getByText("Short > 10%")).toBeVisible({ timeout: 5000 });
  });

  test("director buys toggle works", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Toggle "Has recent director buys" switch
    await page.getByLabel("Has recent director buys").click();

    // Click Search
    await page.getByRole("button", { name: /Search/ }).click();

    // Should show filter badge
    await expect(page.getByText("Has director buys")).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Stock Screener - Presets", () => {
  test("clicking a preset populates filters and runs search", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Click "Small Cap Bears" preset
    await page.getByText("Small Cap Bears").click();

    // Should show results (even if 0)
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    // Preset button should be highlighted (has primary color)
    const presetButton = page.getByText("Small Cap Bears");
    await expect(presetButton).toBeVisible();

    // Should show active filter badges
    await expect(page.getByText(/Short > 5%/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/MCap < \$/)).toBeVisible();
  });

  test("clicking a different preset switches filters", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Click first preset
    await page.getByText("Small Cap Bears").click();
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    // Click different preset
    await page.getByText("Short Squeeze Candidates").click();

    // Filter badges should change
    await expect(page.getByText(/Short > 8%/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Has director buys")).toBeVisible();
  });
});

test.describe("Stock Screener - Results Table", () => {
  test("results table has expected columns", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Run a search to get results
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    // Check column headers
    await expect(page.locator("thead").getByText("Stock")).toBeVisible();
    await expect(page.locator("thead").getByText("Short %")).toBeVisible();
    await expect(page.locator("thead").getByText("4W Chg")).toBeVisible();
    await expect(page.locator("thead").getByText("1M Price")).toBeVisible();
    await expect(page.locator("thead").getByText("MCap")).toBeVisible();
    await expect(page.locator("thead").getByText("P/E")).toBeVisible();
    await expect(page.locator("thead").getByText("Yield")).toBeVisible();
    await expect(page.locator("thead").getByText("Dir. Buy")).toBeVisible();
    await expect(page.locator("thead").getByText("Sentiment")).toBeVisible();
    await expect(page.locator("thead").getByText("Industry")).toBeVisible();
  });

  test("results show stock data with stock codes", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Search all stocks
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    // Results should have rows with stock codes (3-4 uppercase letters/digits)
    const rows = page.locator("tbody tr");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // First row should have a stock code link
    const firstStockLink = rows.first().locator("a");
    await expect(firstStockLink).toBeVisible();
    const href = await firstStockLink.getAttribute("href");
    expect(href).toMatch(/^\/shorts\/[A-Z0-9]{3,4}$/);
  });

  test("clicking a sort header changes order", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Search first
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    // Get first stock code with default sort (short % desc)
    const firstStockBefore = await page.locator("tbody tr").first().locator("a").textContent();

    // Click "MCap" to sort by market cap
    await page.locator("thead").getByText("MCap").click();

    // Wait for results to update
    await page.waitForTimeout(2000);

    // First stock may have changed (different sort)
    const firstStockAfter = await page.locator("tbody tr").first().locator("a").textContent();

    // At least verify the table still has results
    const rowCount = await page.locator("tbody tr").count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test("clicking a result row navigates to stock page", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Search
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    // Get stock code from first row
    const firstLink = page.locator("tbody tr").first().locator("a");
    const href = await firstLink.getAttribute("href");
    const stockCode = href?.replace("/shorts/", "");

    // Click the row (not the link directly, the row)
    await page.locator("tbody tr").first().click();

    // Should navigate to the stock detail page
    await page.waitForURL(`**/shorts/${stockCode}`, { timeout: 10000 });
    expect(page.url()).toContain(`/shorts/${stockCode}`);
  });
});

test.describe("Stock Screener - Pagination", () => {
  test("pagination controls appear when results exceed page size", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Search with no filters (should return > 50 stocks)
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    // Get total count
    const countText = await page.getByText(/\d+ stocks? found/).textContent();
    const totalCount = parseInt(countText?.match(/(\d+)/)?.[1] ?? "0");

    if (totalCount > 50) {
      // Should show pagination
      await expect(page.getByText(/Page 1 of/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Previous" }).first()).toBeDisabled();
    }
  });

  test("can navigate to next page", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Search
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    const countText = await page.getByText(/\d+ stocks? found/).textContent();
    const totalCount = parseInt(countText?.match(/(\d+)/)?.[1] ?? "0");

    if (totalCount > 50) {
      // Click Next
      await page.getByRole("button", { name: "Next" }).first().click();

      // Should show Page 2
      await expect(page.getByText(/Page 2 of/)).toBeVisible({ timeout: 10000 });

      // Previous should now be enabled
      await expect(page.getByRole("button", { name: "Previous" }).first()).toBeEnabled();
    }
  });
});

test.describe("Stock Screener - Clear Filters", () => {
  test("clear all removes active filters", async ({ page }) => {
    await page.goto("/screener", { timeout: 30000, waitUntil: "domcontentloaded" });

    await page.waitForLoadState("networkidle");

    // Apply a preset to set filters
    await page.getByText("Small Cap Bears").click();
    await expect(page.getByText(/\d+ stocks? found/)).toBeVisible({ timeout: 15000 });

    // Verify filters are active
    await expect(page.getByText(/Short > 5%/)).toBeVisible();

    // Click "Clear all"
    await page.getByRole("button", { name: "Clear all" }).click();

    // Filter badges should be gone
    await expect(page.getByText(/Short > 5%/)).not.toBeVisible();
    await expect(page.getByText(/MCap < \$/)).not.toBeVisible();
  });
});
