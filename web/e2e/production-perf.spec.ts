/**
 * Production Performance & Crawlability Assessment
 *
 * Runs against a real deployment (production or preview) to verify:
 * 1. SSR content is present in raw HTML (crawlability for search engines & LLMs)
 * 2. Core Web Vitals are within acceptable thresholds
 * 3. Backend cache is functioning (warm-up effect)
 *
 * Usage:
 *   npm run perf:prod                       # against production
 *   BASE_URL=http://localhost:3020 npx playwright test e2e/production-perf.spec.ts --project=chromium
 */
import { test, expect } from "@playwright/test";
import {
  injectCWVCollector,
  collectCWV,
  formatMetrics,
  type PageMetrics,
} from "./helpers/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROD_URL =
  process.env.BASE_URL || "https://shorted.com.au";
const BACKEND_URL =
  process.env.SHORTS_BACKEND_URL ||
  "https://shorts-234770780438.australia-southeast2.run.app";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

// Stock pages to test — high-traffic, always have data
const TEST_STOCKS = ["BHP", "CBA"];

// CWV thresholds (aligned with Lighthouse CI config)
const THRESHOLDS = {
  fcp: 3000, // ms — "acceptable" ceiling
  lcp: 4000, // ms — "acceptable" ceiling
  cls: 0.25, // score
};

// ---------------------------------------------------------------------------
// Group 1: SSR Crawlability
// ---------------------------------------------------------------------------

test.describe("SSR Crawlability", () => {
  test.describe.configure({ mode: "parallel" });

  test("Homepage contains stock data in HTML", async ({ request }) => {
    const start = Date.now();
    const res = await request.get(`${PROD_URL}/`);
    const ttfb = Date.now() - start;

    expect(res.status()).toBe(200);
    const html = await res.text();

    // The sr-only TopShortsFallback table must be present
    expect(html).toContain("sr-only");
    expect(html).toContain("Most Shorted ASX Stocks");

    // Should contain stock codes as links inside the fallback table
    // Format: <td><a href="/shorts/DMP">DMP</a></td>
    const stockLinkPattern = /href="\/shorts\/[A-Z]{3,4}">[A-Z]{3,4}<\/a>/;
    expect(html).toMatch(stockLinkPattern);

    // Should contain short percentage values (e.g. "15.66" + "%")
    expect(html).toMatch(/\d{1,2}\.\d{1,2}/);

    // Structured data must be present
    expect(html).toContain("application/ld+json");

    console.log(`  Homepage SSR verified (TTFB: ${ttfb}ms)`);
  });

  test("Top 100 page contains stock rankings in HTML", async ({
    request,
  }) => {
    const start = Date.now();
    const res = await request.get(`${PROD_URL}/top`);
    const ttfb = Date.now() - start;

    expect(res.status()).toBe(200);
    const html = await res.text();

    // Page should contain structured data with ItemList
    expect(html).toContain("application/ld+json");

    // Should have the page heading
    expect(html).toMatch(/Top\s+100|Most\s+Shorted/i);

    // Structured data should contain stock URLs
    expect(html).toContain("/shorts/");

    console.log(`  Top 100 SSR verified (TTFB: ${ttfb}ms)`);
  });

  for (const code of TEST_STOCKS) {
    test(`Stock detail page contains ${code} data in HTML`, async ({
      request,
    }) => {
      const start = Date.now();
      const res = await request.get(`${PROD_URL}/shorts/${code}`);
      const ttfb = Date.now() - start;

      expect(res.status()).toBe(200);
      const html = await res.text();

      // Page title / heading should include the stock code
      expect(html).toContain(code);

      // Company name should appear (SSR profile component)
      // At minimum the meta tags should have the stock code
      expect(html.toLowerCase()).toContain(code.toLowerCase());

      // Structured data for the stock
      expect(html).toContain("application/ld+json");

      // Breadcrumb navigation
      expect(html).toContain("BreadcrumbList");

      // LLM meta tags (stock:ticker and ai:* tags)
      expect(html).toMatch(/stock:ticker|ai:content-type/);

      console.log(`  ${code} detail SSR verified (TTFB: ${ttfb}ms)`);
    });
  }

  test("Industry page contains sector data in HTML", async ({
    request,
  }) => {
    const start = Date.now();
    const res = await request.get(`${PROD_URL}/industry`);
    const ttfb = Date.now() - start;

    expect(res.status()).toBe(200);
    const html = await res.text();

    // Should contain industry names (common ASX industries)
    const industryPatterns = [
      /Mining|Financial|Energy|Materials|Health/i,
    ];
    const matchesAny = industryPatterns.some((p) => p.test(html));
    expect(matchesAny).toBe(true);

    // Should contain links to individual industry pages
    expect(html).toContain("/industry/");

    // Should contain stock count indicators (React hydration comments between number and text)
    // Format: 50<!-- --> stocks tracked
    expect(html).toMatch(/\d+.{0,20}stock/i);

    console.log(`  Industry SSR verified (TTFB: ${ttfb}ms)`);
  });

  test("Market page contains date listings in HTML", async ({
    request,
  }) => {
    const start = Date.now();
    const res = await request.get(`${PROD_URL}/market`);
    const ttfb = Date.now() - start;

    expect(res.status()).toBe(200);
    const html = await res.text();

    // Should contain links to date-specific pages
    expect(html).toContain("/market/");

    // Should contain recent year
    expect(html).toMatch(/202[5-9]/);

    // Should contain day-of-week abbreviations (server-rendered date cards)
    expect(html).toMatch(/Mon|Tue|Wed|Thu|Fri/);

    console.log(`  Market SSR verified (TTFB: ${ttfb}ms)`);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Core Web Vitals
// ---------------------------------------------------------------------------

test.describe("Core Web Vitals", () => {
  // Run sequentially to avoid resource contention skewing metrics
  test.describe.configure({ mode: "serial" });

  const results: Array<{ page: string; metrics: PageMetrics }> = [];

  test("Homepage CWV within thresholds", async ({ page }) => {
    await injectCWVCollector(page);

    await page.goto("/", { waitUntil: "networkidle" });

    // Wait for meaningful content — hero or table
    await page
      .locator("h1, table tbody tr")
      .first()
      .waitFor({ state: "visible", timeout: 15000 });

    const m = await collectCWV(page);
    results.push({ page: "/", metrics: m });
    console.log(`  ${formatMetrics("Homepage", m)}`);

    if (m.fcp > 0) expect(m.fcp).toBeLessThan(THRESHOLDS.fcp);
    if (m.lcp > 0) expect(m.lcp).toBeLessThan(THRESHOLDS.lcp);
    expect(m.cls).toBeLessThan(THRESHOLDS.cls);
  });

  test("Top 100 page CWV within thresholds", async ({ page }) => {
    await injectCWVCollector(page);

    await page.goto("/top", { waitUntil: "networkidle" });

    await page
      .locator("h1, [data-testid]")
      .first()
      .waitFor({ state: "visible", timeout: 15000 });

    const m = await collectCWV(page);
    results.push({ page: "/top", metrics: m });
    console.log(`  ${formatMetrics("Top 100", m)}`);

    if (m.fcp > 0) expect(m.fcp).toBeLessThan(THRESHOLDS.fcp);
    if (m.lcp > 0) expect(m.lcp).toBeLessThan(THRESHOLDS.lcp);
    expect(m.cls).toBeLessThan(THRESHOLDS.cls);
  });

  test("Stock detail page CWV within thresholds", async ({ page }) => {
    await injectCWVCollector(page);

    await page.goto("/shorts/BHP", { waitUntil: "networkidle" });

    // Wait for company profile or heading
    await page
      .locator("h1, h2, [data-testid]")
      .first()
      .waitFor({ state: "visible", timeout: 15000 });

    const m = await collectCWV(page);
    results.push({ page: "/shorts/BHP", metrics: m });
    console.log(`  ${formatMetrics("Stock detail (BHP)", m)}`);

    if (m.fcp > 0) expect(m.fcp).toBeLessThan(THRESHOLDS.fcp);
    if (m.lcp > 0) expect(m.lcp).toBeLessThan(THRESHOLDS.lcp);
    expect(m.cls).toBeLessThan(THRESHOLDS.cls);
  });

  test("Industry page CWV within thresholds", async ({ page }) => {
    await injectCWVCollector(page);

    await page.goto("/industry", { waitUntil: "networkidle" });

    await page
      .locator("h1")
      .first()
      .waitFor({ state: "visible", timeout: 15000 });

    const m = await collectCWV(page);
    results.push({ page: "/industry", metrics: m });
    console.log(`  ${formatMetrics("Industry", m)}`);

    if (m.fcp > 0) expect(m.fcp).toBeLessThan(THRESHOLDS.fcp);
    if (m.lcp > 0) expect(m.lcp).toBeLessThan(THRESHOLDS.lcp);
    expect(m.cls).toBeLessThan(THRESHOLDS.cls);
  });

  // Print summary table after all CWV tests
  test.afterAll(() => {
    if (results.length === 0) return;
    console.log("\n  ┌─────────────────────┬────────┬────────┬────────┬───────┐");
    console.log("  │ Page                │ TTFB   │ FCP    │ LCP    │ CLS   │");
    console.log("  ├─────────────────────┼────────┼────────┼────────┼───────┤");
    for (const r of results) {
      const pg = r.page.padEnd(19);
      const ttfb = `${r.metrics.ttfb}ms`.padStart(6);
      const fcp = `${r.metrics.fcp}ms`.padStart(6);
      const lcp = `${r.metrics.lcp}ms`.padStart(6);
      const cls = `${r.metrics.cls}`.padStart(5);
      console.log(`  │ ${pg} │ ${ttfb} │ ${fcp} │ ${lcp} │ ${cls} │`);
    }
    console.log("  └─────────────────────┴────────┴────────┴────────┴───────┘\n");
  });
});

// ---------------------------------------------------------------------------
// Group 3: ISR Cache Behaviour
// ---------------------------------------------------------------------------

test.describe("ISR Cache Behaviour", () => {
  // With 1-day ISR + on-demand revalidation, pages should almost always be cached.
  // Cold misses only occur after an explicit revalidation call or first-ever request.

  test("Homepage serves from edge cache (HIT)", async ({ request }) => {
    // First request — should already be cached from prior traffic or warm-cache cron
    const start1 = Date.now();
    const res1 = await request.get(`${PROD_URL}/`);
    const ms1 = Date.now() - start1;
    expect(res1.status()).toBe(200);

    // Second request — definitively cached
    const start2 = Date.now();
    const res2 = await request.get(`${PROD_URL}/`);
    const ms2 = Date.now() - start2;
    expect(res2.status()).toBe(200);

    const xVercelCache = res2.headers()["x-vercel-cache"] || "";
    console.log(
      `  Homepage: req1=${ms1}ms, req2=${ms2}ms, x-vercel-cache: ${xVercelCache}`,
    );

    // On Vercel, the second request should be a cache HIT
    if (PROD_URL.includes("shorted.com.au") || PROD_URL.includes("vercel")) {
      expect(["HIT", "STALE"]).toContain(xVercelCache);
    }
  });

  test("Stock page ISR serves cached content", async ({ request }) => {
    const start = Date.now();
    const res = await request.get(`${PROD_URL}/shorts/BHP`);
    const ms = Date.now() - start;

    expect(res.status()).toBe(200);

    // Check cache-related headers
    const cacheControl = res.headers()["cache-control"] || "";
    const xVercelCache = res.headers()["x-vercel-cache"] || "";

    console.log(
      `  BHP page: ${ms}ms, cache-control: ${cacheControl}, x-vercel-cache: ${xVercelCache}`,
    );

    // With 1-day ISR, stock pages should almost always be HIT or STALE
    if (PROD_URL.includes("shorted.com.au") || PROD_URL.includes("vercel")) {
      expect(xVercelCache).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Group 4: Backend Cache Stats
// ---------------------------------------------------------------------------

test.describe("Backend Cache Stats", () => {
  test.skip(!INTERNAL_SECRET, "INTERNAL_SERVICE_SECRET not set — skipping backend cache tests");

  test("Cache hit rate is healthy", async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/api/debug/perf`, {
      headers: {
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();

    const cache = data.cache;
    console.log(`  Uptime: ${data.uptime}`);
    console.log(
      `  Cache — entries: ${cache.entries}, hits: ${cache.hits}, misses: ${cache.misses}, stale: ${cache.staleServes}`,
    );
    console.log(`  Hit rate: ${(cache.hitRate * 100).toFixed(1)}%`);

    if (cache.byPrefix) {
      console.log("  By prefix:");
      for (const [prefix, stats] of Object.entries(cache.byPrefix)) {
        const s = stats as { count: number; fresh: number; stale: number };
        console.log(
          `    ${prefix}: ${s.count} entries (${s.fresh} fresh, ${s.stale} stale)`,
        );
      }
    }

    // After the crawlability + CWV tests above, there should be cache entries
    expect(cache.entries).toBeGreaterThan(0);
  });
});
