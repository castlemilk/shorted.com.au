import { test, expect } from "@playwright/test";

/**
 * Content Paint Tests
 *
 * These tests verify that critical UI sections actually render visible content
 * after client-side hydration. They catch "silent empty" regressions where a
 * page loads without errors but key sections render nothing — the exact class
 * of bug that's invisible to smoke tests and React error detection.
 *
 * Each test waits for hydration, then asserts that specific content sections
 * contain visible child elements (not just that the page didn't crash).
 *
 * Run against local dev:
 *   npx playwright test e2e/content-paint.spec.ts --project=chromium
 *
 * Run against production:
 *   BASE_URL=https://shorted.com.au npx playwright test e2e/content-paint.spec.ts --project=chromium
 */

// Allow generous timeout for cold starts + dynamic imports + API calls
test.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Stock Detail Page — Overview Tab Content Paint
// ---------------------------------------------------------------------------
test.describe("Stock Detail — Content Paint", () => {
  const testStocks = ["BHP", "CBA"];

  for (const code of testStocks) {
    test(`${code} overview tab renders chart cards`, async ({ page }) => {
      await page.goto(`/shorts/${code}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Wait for client-side hydration and dynamic imports to settle
      // StockTabs is loaded via dynamic({ ssr: false }), charts are also dynamic
      await page.waitForTimeout(5_000);

      // The overview tab is the default — verify its key content sections rendered.
      // These card titles come from the server-rendered page content passed as
      // overviewContent prop to StockTabs.

      // 1. "Short Position Trends" card must be visible
      const shortTrendsCard = page.getByText("Short Position Trends");
      await expect(shortTrendsCard).toBeVisible({
        timeout: 15_000,
      });

      // 2. "Historical Price Data" card must be visible
      const priceDataCard = page.getByText("Historical Price Data");
      await expect(priceDataCard).toBeVisible({
        timeout: 15_000,
      });
    });

    test(`${code} overview tab has chart SVGs or loading skeletons`, async ({
      page,
    }) => {
      await page.goto(`/shorts/${code}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Wait for charts to load (dynamic imports + API data)
      await page.waitForTimeout(8_000);

      // The overview tab should contain charts (SVG elements) or at minimum
      // loading skeletons. We look for SVGs inside the tab panel area, or
      // any canvas/chart-related elements.
      const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
      await expect(activePanel).toBeVisible({ timeout: 10_000 });

      // Charts render as SVGs, or show skeleton/pulse divs while loading
      const chartElements = activePanel.locator(
        "svg, canvas, [class*='animate-pulse'], [class*='skeleton']"
      );
      const count = await chartElements.count();

      expect(
        count,
        "Overview tab has no chart SVGs or loading skeletons — charts failed to render"
      ).toBeGreaterThanOrEqual(1);
    });

    test(`${code} tab switching renders content`, async ({ page }) => {
      await page.goto(`/shorts/${code}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      await page.waitForTimeout(5_000);

      // Click through each tab and verify it has non-trivial content
      const tabs = [
        {
          name: "Overview",
          mustContain: ["Short Position Trends", "Historical Price Data"],
        },
        { name: "News", mustContain: [] }, // News may have no articles — just check it doesn't crash
        { name: "Financials", mustContain: [] },
        { name: "Peers", mustContain: [] },
      ];

      for (const tab of tabs) {
        // Click the tab trigger
        const trigger = page.getByRole("tab", { name: tab.name });
        if ((await trigger.count()) === 0) continue;

        await trigger.click();
        await page.waitForTimeout(2_000);

        // Get the active tab panel content
        const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
        await expect(activePanel).toBeVisible({ timeout: 10_000 });

        // Panel should not be empty (should have at least some child elements)
        const panelText = await activePanel.textContent({ timeout: 5_000 });

        // For tabs with required content, verify it's there
        for (const text of tab.mustContain) {
          expect(
            panelText,
            `Tab "${tab.name}" is missing expected content: "${text}"`
          ).toContain(text);
        }

        // For all tabs: the panel should have SOME content (not completely blank)
        // Allow for "no data" messages, loading states, etc. — just not empty
        const childElements = await activePanel.locator("> *").count();
        expect(
          childElements,
          `Tab "${tab.name}" panel is completely empty — no children rendered`
        ).toBeGreaterThan(0);
      }
    });
  }

  test("stock page company profile section renders", async ({ page }) => {
    await page.goto("/shorts/BHP", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await page.waitForTimeout(3_000);

    // CompanyProfile is rendered above tabs — it should always be visible
    // Look for stock code in the main heading (h1 contains company name like "Bhp Group")
    await expect(page.locator("h1").first()).toBeVisible({
      timeout: 10_000,
    });

    // Company stats section should have some content
    // (rendered in a separate grid column on desktop)
    const pageText = await page.locator("body").textContent({ timeout: 5_000 });

    // Should contain at minimum: stock code + some short position related text
    expect(pageText).toContain("BHP");
    const hasShortData =
      /short/i.test(pageText!) || /shorted/i.test(pageText!) || /%/.test(pageText!);
    expect(
      hasShortData,
      "Stock page has no short position data visible"
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Homepage — Content Paint
// ---------------------------------------------------------------------------
test.describe("Homepage — Content Paint", () => {
  test("homepage renders stock data (not just layout)", async ({ page }) => {
    await page.goto("/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Wait for client hydration
    await page.waitForTimeout(5_000);

    const pageText = await page.locator("body").textContent({ timeout: 15_000 });

    // Homepage must show actual stock codes (3-4 letter uppercase)
    const stockCodes = pageText!.match(/\b[A-Z]{3,4}\b/g) ?? [];
    expect(
      stockCodes.length,
      "Homepage has no stock codes — data section may not have rendered"
    ).toBeGreaterThan(5);

    // Homepage must show percentage values
    const percentages = pageText!.match(/\d+\.\d+%/g) ?? [];
    expect(
      percentages.length,
      "Homepage has no percentage values — short position data not rendered"
    ).toBeGreaterThan(0);
  });

  test("Browse by Industry section renders", async ({ page }) => {
    await page.goto("/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await page.waitForTimeout(3_000);

    // Browse by Industry section should be present
    const browseSection = page.getByText("Browse by Industry");
    // This is a server-rendered section — it should appear quickly
    if ((await browseSection.count()) > 0) {
      await expect(browseSection).toBeVisible();

      // Should have industry links
      const industryLinks = page.locator('a[href^="/industry/"]');
      const count = await industryLinks.count();
      expect(
        count,
        "Browse by Industry has no industry links"
      ).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Industry Pages — Content Paint
// ---------------------------------------------------------------------------
test.describe("Industry Pages — Content Paint", () => {
  test("industry index renders industry cards", async ({ page }) => {
    await page.goto("/industry", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await page.waitForTimeout(3_000);

    // Should show "Short Positions by Industry" heading
    await expect(
      page.getByText("Short Positions by Industry")
    ).toBeVisible({ timeout: 10_000 });

    // Should render multiple industry cards with links
    const industryCards = page.locator('a[href^="/industry/"]');
    const count = await industryCards.count();
    expect(
      count,
      "Industry index page has no industry cards — data failed to render"
    ).toBeGreaterThan(10);

    // Cards should contain stock count info ("X stocks tracked")
    const pageText = await page.locator("body").textContent({ timeout: 5_000 });
    expect(pageText).toMatch(/\d+ stocks tracked/);
  });

  test("industry detail page renders stock table", async ({ page }) => {
    await page.goto("/industry/materials", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await page.waitForTimeout(3_000);

    const pageText = await page.locator("body").textContent({ timeout: 15_000 });

    // Should not be a 404/500
    const isError =
      (pageText!.includes("404") && pageText!.toLowerCase().includes("not found")) ||
      (pageText!.includes("500") && pageText!.toLowerCase().includes("internal"));

    if (!isError) {
      // Should have stock codes visible
      const stockCodes = pageText!.match(/\b[A-Z]{3,4}\b/g) ?? [];
      expect(
        stockCodes.length,
        "Industry detail page has no stock codes — table failed to render"
      ).toBeGreaterThan(3);

      // Should show percentage data
      const percentages = pageText!.match(/\d+\.\d+%/g) ?? [];
      expect(
        percentages.length,
        "Industry detail page has no short position percentages"
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Screener — Content Paint
// ---------------------------------------------------------------------------
test.describe("Screener — Content Paint", () => {
  test("screener renders filter controls and results", async ({ page }) => {
    await page.goto("/screener", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Wait for client hydration + initial data load
    await page.waitForTimeout(8_000);

    const pageText = await page.locator("body").textContent({ timeout: 15_000 });

    // Screener should show stock results
    const stockCodes = pageText!.match(/\b[A-Z]{3,4}\b/g) ?? [];
    expect(
      stockCodes.length,
      "Screener has no stock codes — results table failed to render"
    ).toBeGreaterThan(3);
  });
});
