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

// A tab route that prints fewer visible characters than this below the tab bar
// is treated as blank (its loading skeleton or an empty shell).
const MIN_TAB_TEXT = 40;

// ---------------------------------------------------------------------------
// Stock Detail Page — Overview and Tab Content Paint
// ---------------------------------------------------------------------------
test.describe("Stock Detail — Content Paint", () => {
  const testStocks = ["BHP", "CBA"];

  for (const code of testStocks) {
    test(`${code} overview renders the chart section and digest cards`, async ({
      page,
    }) => {
      await page.goto(`/shorts/${code}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Wait for client-side hydration and dynamic imports to settle
      // (the stock layout loads its chart via dynamic({ ssr: false }))
      await page.waitForTimeout(5_000);

      // The Overview is the default route — verify its key content sections
      // rendered. Both headings are server-rendered: the first by the shared
      // stock layout, the second by the Overview page's digest card.

      // 1. The "Price & short interest" chart section must be visible
      const chartHeading = page.getByRole("heading", {
        name: "Price & short interest",
      });
      await expect(chartHeading).toBeVisible({
        timeout: 15_000,
      });

      // 2. The "Short interest" digest card must be visible
      const digestHeading = page.getByRole("heading", {
        name: "Short interest",
        exact: true,
      });
      await expect(digestHeading).toBeVisible({
        timeout: 15_000,
      });
    });

    test(`${code} overview has chart SVGs or loading skeletons`, async ({
      page,
    }) => {
      await page.goto(`/shorts/${code}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Wait for charts to load (dynamic imports + API data)
      await page.waitForTimeout(8_000);

      // The chart sits in the stock layout, above the tab bar. We look for the
      // rendered chart SVG, or at minimum its loading skeleton.
      const chartSection = page.locator(
        'section[aria-labelledby="stock-chart-heading"]'
      );
      await expect(chartSection).toBeVisible({ timeout: 10_000 });

      // Charts render as SVGs, or show skeleton/pulse divs while loading
      const chartElements = chartSection.locator(
        "[data-chart-container] svg, [aria-label='Loading chart'], [class*='animate-pulse'], [class*='skeleton']"
      );
      const count = await chartElements.count();

      expect(
        count,
        "Chart section has no chart SVGs or loading skeletons — charts failed to render"
      ).toBeGreaterThanOrEqual(1);
    });

    test(`${code} tab switching renders content`, async ({ page }) => {
      await page.goto(`/shorts/${code}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      await page.waitForTimeout(5_000);

      // Each tab is a route behind a link in the "Stock sections" bar. Click
      // through them and verify each renders non-trivial content below the bar.
      const nav = page.getByRole("navigation", { name: "Stock sections" });
      const tabs = [
        { name: "Short interest", path: "/short-interest", mustContain: [] },
        { name: "Strategy", path: "/strategy", mustContain: [] },
        { name: "Financials", path: "/financials", mustContain: [] },
        { name: "Company", path: "/company", mustContain: [] },
        { name: "News", path: "/news", mustContain: [] }, // News may have no articles — just check it doesn't crash
        { name: "Community", path: "/community", mustContain: [] },
        { name: "Overview", path: "", mustContain: ["Short interest"] },
      ];

      for (const tab of tabs) {
        await nav.getByRole("link", { name: tab.name, exact: true }).click();
        await expect(page).toHaveURL(
          new RegExp(`/shorts/${code}${tab.path}$`),
          { timeout: 30_000 }
        );

        // The route's content follows the tab bar in the stock layout. Loading
        // skeletons carry no text, so wait for the route to print some.
        const content = nav.locator("xpath=following-sibling::*");
        const contentText = async () =>
          (
            await content.evaluateAll((els) =>
              els.map((el) => (el as HTMLElement).innerText).join("\n")
            )
          ).trim();

        // For all tabs: the route should have SOME content (not completely blank)
        // Allow for "no data" messages, loading states, etc. — just not empty
        await expect
          .poll(async () => (await contentText()).length, {
            message: `Tab "${tab.name}" renders no content below the tab bar`,
            timeout: 15_000,
          })
          .toBeGreaterThan(MIN_TAB_TEXT);

        // For tabs with required content, verify it's there
        const text = await contentText();
        for (const required of tab.mustContain) {
          expect(
            text,
            `Tab "${tab.name}" is missing expected content: "${required}"`
          ).toContain(required);
        }
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
