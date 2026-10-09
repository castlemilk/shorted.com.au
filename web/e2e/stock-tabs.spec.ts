import { test, expect, type Page } from "@playwright/test";

/**
 * Stock page tab routes: /shorts/[stockCode] and its six tabs.
 *
 * Run it against a PRODUCTION build served by `next start`, never `next dev`:
 * the cache and prefetch assertions are about what the production server does,
 * and the cache test reads `x-nextjs-cache`, which only `next start` sets
 * (Vercel reports the same fact as `x-vercel-cache`).
 *
 *   cd web && SKIP_ENV_VALIDATION=1 npx next build
 *   npm run start                      # serves :3020, the config's baseURL
 *   npx playwright test e2e/stock-tabs.spec.ts --project=chromium
 */

const CODE = "BHP";
const TABS = [
  ["Short interest", "short-interest"],
  ["Strategy", "strategy"],
  ["Financials", "financials"],
  ["Company", "company"],
  ["News", "news"],
  ["Community", "community"],
] as const;

// A first visit to a tab is an on-demand ISR render (several API reads) behind
// the click, and the chart waits on two more fetches, so the first assertion
// on each of those gets longer than the 5 s default.
const COLD = { timeout: 30_000 };

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("stock page tabs", () => {
  test.describe.configure({ timeout: 120_000 });

  test("every tab is a route; the chart node survives; back returns to the previous tab", async ({ page }) => {
    await page.goto(`/shorts/${CODE}`);
    const nav = page.getByRole("navigation", { name: "Stock sections" });
    await expect(nav.getByRole("link")).toHaveCount(7);
    const chart = page.locator("[data-chart-container] svg").first();
    await expect(chart).toBeVisible(COLD);
    // Tag the live DOM node: a remount would lose the property.
    await chart.evaluate((el) => { (el as HTMLElement).dataset.e2eMarker = "mounted-once"; });
    const marker = () => chart.evaluate((el) => (el as HTMLElement).dataset.e2eMarker);
    for (const [label, segment] of TABS) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/${segment}$`), COLD);
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
      expect(await marker()).toBe("mounted-once");
    }
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/news$`));
    await expect(nav.getByRole("link", { name: "News" })).toHaveAttribute("aria-current", "page");
    expect(await marker()).toBe("mounted-once");
  });

  test("no tab route is requested before the visitor shows intent", async ({ page }) => {
    const tabRequests: string[] = [];
    page.on("request", (r) => {
      if (new RegExp(`/shorts/${CODE}/(${TABS.map(([, s]) => s).join("|")})`).test(r.url())) tabRequests.push(r.url());
    });
    await page.goto(`/shorts/${CODE}`);
    await page.waitForLoadState("networkidle");
    expect(tabRequests).toEqual([]);
    await page.getByRole("navigation", { name: "Stock sections" }).getByRole("link", { name: "Financials" }).hover();
    await expect
      .poll(() => tabRequests.some((url) => url.includes(`/shorts/${CODE}/financials`)), { timeout: 5000 })
      .toBe(true);
  });

  test("390px: the tab bar scrolls instead of widening the page, and a tap navigates", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shorts/${CODE}`);
    // Measure once the chart has painted: a late-hydrating wide element is
    // what would push the page past the viewport.
    await expect(page.locator("[data-chart-container] svg").first()).toBeVisible(COLD);
    expect(await horizontalOverflow(page)).toBe(0);
    const nav = page.getByRole("navigation", { name: "Stock sections" });
    await nav.getByRole("link", { name: "Strategy" }).click();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/strategy$`), COLD);
    expect(await horizontalOverflow(page)).toBe(0);
    await expect(nav.getByRole("link", { name: "Strategy" })).toBeInViewport();
    // Playwright scrolls a link into view to click it, so the click above says
    // nothing about the bar's own scrolling: load a tab cold and the bar must
    // bring the active link into view by itself, the whole link (ratio 1), not
    // a sliver. Two tabs, because they fail differently. The last one
    // (Community) clamps at the end of the track, so it passes for any large
    // scroll target. One in the middle (Financials) is where the target has to
    // be exact: an offset measured from the wrong ancestor overshoots and
    // leaves the link's left edge outside the bar. The bar sits below the first
    // screen on a phone, so scroll the page down to it first; that moves the
    // page, not the bar's own list.
    for (const [label, segment] of [
      ["Financials", "financials"],
      ["Community", "community"],
    ] as const) {
      await page.goto(`/shorts/${CODE}/${segment}`);
      await nav.scrollIntoViewIfNeeded();
      await expect(nav.getByRole("link", { name: label }), `${label}, loaded cold`).toBeInViewport({ ratio: 1 });
    }
  });

  test("a legacy ?tab= link answers with a permanent redirect to the tab route", async ({ request }) => {
    const res = await request.get(`/shorts/${CODE}?tab=financials`, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    // Next forwards the query string on a redirect, so compare the path only.
    expect(new URL(res.headers()["location"] ?? "", "http://localhost").pathname).toBe(`/shorts/${CODE}/financials`);
    // An unmapped value and ?tab=overview (which would redirect to itself) both render the Overview.
    for (const value of ["foo", "overview"]) {
      const none = await request.get(`/shorts/${CODE}?tab=${value}`, { maxRedirects: 0, timeout: 60_000 });
      expect(none.status(), `?tab=${value}`).toBe(200);
    }
  });

  test("a tab URL carries a self canonical and the stock's social image", async ({ page }) => {
    await page.goto(`/shorts/${CODE}/financials`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/shorts/${CODE}/financials$`));
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(og).toBeTruthy();
    // The stock's own card, not a site-wide default.
    expect(og).toContain(`/shorts/${CODE}/opengraph-image`);
    await expect(page).toHaveTitle(new RegExp(`${CODE} Financials`));
  });

  test("the strategy tab of a currently triggered stock draws at least one level", async ({ page }) => {
    test.setTimeout(240_000);
    // The picks page is ISR over live data. When the API is slow it renders a
    // "temporarily unavailable" page that is kept for a minute, so go back for
    // it rather than fail on it. A row, not the first /shorts/ link: that may
    // be a link in the site chrome.
    const firstPick = page.locator('tr[data-status] a[href^="/shorts/"]').first();
    await expect(async () => {
      await page.goto("/picks/minervini-trend-template");
      await expect(firstPick).toBeVisible({ timeout: 2_000 });
    }, "the picks page lists no stock").toPass({ timeout: 120_000, intervals: [1_000, 30_000, 60_000] });
    const href = await firstPick.getAttribute("href");
    expect(href).toBeTruthy();
    const code = href!.split("/")[2]!;
    await page.goto(`/shorts/${code}/strategy`);
    await expect(page.locator("[data-strategy-chart]")).toBeVisible(COLD);
    await expect(page.getByRole("region", { name: /Minervini/ })).toBeVisible();
    // No level with "Levels unavailable" under the chart means the page never
    // got price_features: the API this build reads predates PR 1, or this tree
    // lacks PR 1's generated client (which is what decodes the field).
    await expect(
      page.locator("[data-chart-level]").first(),
      `${code}: the strategy tab drew no level (is PR 1 deployed to the API, and its generated client in this build?)`,
    ).toBeVisible({ timeout: 15000 });
  });

  test("a community thread renders under the stock chrome once", async ({ page }) => {
    await page.goto(`/shorts/${CODE}/community`);
    // The list is fetched by the client: let it settle before deciding there is
    // nothing to open, or this skips on every run.
    await expect(page.getByText("Loading community activity...")).toBeHidden(COLD);
    const thread = page.locator(`a[href^="/shorts/${CODE}/community/"]`).first();
    if ((await thread.count()) === 0) test.skip(true, "no thread to open");
    const title = (await thread.innerText()).trim();
    await thread.click();
    // A <Link> navigates on the client once its RSC payload arrives, so click()
    // returns first, and the counts below already hold on the list page (same
    // layout): wait for the thread route, and for what only it prints, before
    // counting anything. Only the thread view has the "Back to ... community"
    // link and a Comments heading; the list page has neither.
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/community/[^/]+$`), COLD);
    await expect(page.getByRole("link", { name: `Back to ${CODE} community` })).toBeVisible(COLD);
    await expect(page.getByRole("heading", { name: "Comments", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    // The chrome appears once. Only DashboardLayout renders <main>, so a wrapper
    // the thread page still carries shows up as a second one here and nowhere
    // else: a leftover wrapper leaves a single tab bar and a single chart.
    await expect(page.locator("main")).toHaveCount(1);
    const nav = page.getByRole("navigation", { name: "Stock sections" });
    await expect(nav).toHaveCount(1);
    await expect(page.locator("[data-chart-container]")).toHaveCount(1);
    // Community stays the active tab beneath it.
    await expect(nav.getByRole("link", { name: "Community" })).toHaveAttribute("aria-current", "page");
  });

  test("each of the seven tab URLs is served from the ISR cache on the second request", async ({ request }) => {
    const paths = [`/shorts/${CODE}`, ...TABS.map(([, segment]) => `/shorts/${CODE}/${segment}`)];
    expect(paths).toHaveLength(7);
    for (const path of paths) {
      // The first request renders the page on demand (or finds the entry an
      // earlier test left); the second must not render it again. A tab that
      // silently renders per request answers 200 every time and never says HIT.
      // Soft assertions: one bad tab must not hide the others.
      const first = await request.get(path, { timeout: 60_000 });
      expect.soft(first.status(), `${path}: first request`).toBe(200);
      const second = await request.get(path, { timeout: 60_000 });
      expect.soft(second.status(), `${path}: second request`).toBe(200);
      expect.soft(second.headers()["x-nextjs-cache"], `${path}: second request`).toBe("HIT");
    }
  });
});
