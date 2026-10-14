import { test, expect, type Locator, type Page } from "./helpers/test";
import { cloudflareTestingBypassHeadersFor } from "./helpers/cloudflare-testing-bypass";

/**
 * Stock page tab routes: /shorts/[stockCode] and its six tabs, and where the
 * page puts its content. The layout tests hold the page to the acceptance
 * numbers of docs/superpowers/specs/2026-10-10-stock-page-visible-first-design.md
 * (section 2, G1-G7); each says which goal a number is.
 *
 * Run it against a PRODUCTION build served by `next start`, never `next dev`:
 * the cache and prefetch assertions are about what the production server does,
 * and the cache test reads `x-nextjs-cache`, which only `next start` sets
 * (Vercel reports the same fact as `x-vercel-cache`).
 *
 * The suite reads LIVE public data: the server fetches BHP, the picks page and
 * the chart's prices from the public API as every local build does, so it needs
 * network access and a stock the API knows. There is no webServer block in the
 * Playwright config; the server must already be running.
 *
 *   cd web
 *   SKIP_ENV_VALIDATION=1 NEXT_PUBLIC_API_URL=https://api.shorted.com.au \
 *     npx next build
 *   SKIP_ENV_VALIDATION=1 SHORTS_SERVICE_ENDPOINT=https://api.shorted.com.au \
 *     NEXT_PUBLIC_API_URL=https://api.shorted.com.au \
 *     MARKET_DATA_API_URL=https://api.shorted.com.au npm run start   # :3020, the config's baseURL
 *   # In another shell, with the Playwright runner on Node 22 (see below):
 *   npx playwright test e2e/stock-tabs.spec.ts --project=chromium --workers=1 --reporter=list
 *
 * What each of those is for, and what happens without it:
 * - SKIP_ENV_VALIDATION=1 on `next start` as well as `next build`:
 *   next.config.mjs loads src/env.js, and a server started without it exits
 *   with "Invalid environment variables" (NEXTAUTH_SECRET, NEXTAUTH_URL, ...).
 * - NEXT_PUBLIC_API_URL at BUILD (it is inlined into the client bundle) and at
 *   start.
 * - SHORTS_SERVICE_ENDPOINT, NEXT_PUBLIC_API_URL and MARKET_DATA_API_URL at
 *   START. Without them the server's reads go to localhost:9091 and :8090,
 *   loadStockOrFail fails the render, and the tabs degrade or answer 500.
 * - Run the Playwright runner on Node 22. Playwright 1.52 hangs on Node 24.19
 *   (the runner idles at 0% CPU with no worker, even for `--list`); the
 *   server itself ran fine on Node 24.19.
 * - Leave BASE_URL (and E2E_TEST) unset, or the suite is aimed somewhere other
 *   than localhost:3020. Never point it at production.
 * - The browser's own requests (the chart's price and short series) go through
 *   the Next rewrites to api.shorted.com.au, and the edge rate limits them.
 *   Export TF_VAR_rate_limit_testing_bypass_secret, that one variable from the
 *   repo-root .env and never the whole file, before the Playwright run:
 *   helpers/test.ts sends it as the trusted-test header to localhost and our
 *   own origins only, and playwright.config.ts adds the user agent marker.
 *   Without it the chart tests can meet a 429 and fail for that.
 * - That header only clears the edge. The API itself still caps an anonymous
 *   address at 30 calls a minute, and this file's own page loads spend it. The
 *   tests that need a page's data (both of a chart's series, a Short interest
 *   page that has loaded) wait out a refused call (waitOutRateLimit), which can
 *   take most of a minute; the others measure what does not depend on it.
 * - Pass --reporter=list when running by hand. The config's html reporter
 *   serves its report after a failure and holds the shell until it is closed.
 * - The phone tap test needs a touch context; it asks for one itself.
 * - The thread test needs a community store holding one BHP thread, or it
 *   SKIPS ("no thread to open"): start the server with
 *   COMMUNITY_STORE_DRIVER=postgres and DATABASE_URL set to a scratch Postgres
 *   with migration 000072 applied and one active BHP thread row.
 * - The levels test SKIPS, with its reason, while the Strategy page shows the
 *   price-only note: the API (or this build, without PR 1's generated client)
 *   has no price_features yet. A skip is invisible in CI, so after PR 1 is
 *   live and main is merged into this branch, run it with
 *   `-g "strategy tab"` and open a triggered stock's Strategy tab by hand to
 *   see at least one level. It fails on any other cause of a missing level.
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

// COLD, for a wait that may also sit out a refused call's Retry-After (up to a
// minute) before the API answers (see waitOutRateLimit).
const THROTTLED = { timeout: 90_000 };

// The caption the Strategy chart prints when the fit carries no price features
// (PRICE_ONLY_NOTE in src/@/components/strategy/strategy-levels.ts). A spec
// imports nothing from the app, so this is a copy; a Jest test
// (strategy-levels.test.ts) fails when the two differ.
const PRICE_ONLY_NOTE = "Levels unavailable for this stock right now; showing price only.";

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// The two windows the layout tests measure.
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const VIEWPORTS = [PHONE, DESKTOP];

// Where a chart's series come from (use-stock-chart-data.ts and the query hooks
// under it): the price history through the market-data route, the short series
// through the Connect StockService. Both are POSTs whose JSON body names the
// stock and the period.
const PRICE_SERIES_PATH = "/api/market-data/historical";
const SHORT_SERIES_PATH = "/shorts.v1alpha1.StockService/GetStockData";

const stockNav = (page: Page) => page.getByRole("navigation", { name: "Stock sections" });

// The bar's list of tabs, the one thing in the bar that scrolls sideways. It
// says which edges have more tabs behind them (data-scroll-start / -end) and
// draws a fade on those.
const tabList = (page: Page) => stockNav(page).locator(":scope > div");

// The fade, as the browser computes it ("none" when there is none).
const fadeOf = (list: Locator) =>
  list.evaluate((el) => {
    const style = getComputedStyle(el);
    return style.maskImage || style.getPropertyValue("-webkit-mask-image") || "none";
  });

// The price charts: the Overview's and Short interest's. The Strategy tab's
// levels chart is a StockChart too, so it has a [data-chart-container] of its
// own. It sits inside [data-strategy-chart] and is not one of these.
const priceCharts = (page: Page) =>
  page.locator("[data-chart-container]:not([data-strategy-chart] [data-chart-container])");

// A period button. Its text is lower case ("6m") and shown in capitals by CSS.
const periodButton = (page: Page, label: string) =>
  page.getByRole("group", { name: "Period" }).getByRole("button", { name: new RegExp(`^${label}$`, "i") });

async function boxOf(locator: Locator): Promise<{ top: number; bottom: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("expected the element to have a box");
  return { top: box.y, bottom: box.y + box.height };
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

/**
 * The API lets an anonymous address make 30 calls a minute (X-RateLimit-Limit on
 * a response says so), and this file's own page loads spend them. A call refused
 * with a 429 is not asked for again: the Overview's chart draws one series, and
 * Short interest, which opens on the short view, draws none. A test about what a
 * page does once it has its data (the strip's height, a query cache that has to
 * hold the series, a layout that must not move as the data arrives) must see
 * that data, so answer the page from the API only once the API has answered:
 * wait out the Retry-After, and ask again. The price series is the same API
 * behind a Next rewrite (PRICE_SERIES_PATH) and is refused the same way, so it is
 * answered the same way.
 */
async function waitOutRateLimit(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/shorts.v1alpha1.") || url.pathname === PRICE_SERIES_PATH,
    async (route) => {
      try {
        // This route runs before the fixture's, so it sends the trusted-test
        // header itself (only to our own origins).
        const request = route.request();
        const headers = { ...request.headers(), ...cloudflareTestingBypassHeadersFor(request.url()) };
        let response = await route.fetch({ headers });
        for (let retry = 0; response.status() === 429 && retry < 3; retry++) {
          const seconds = Number(response.headers()["retry-after"]);
          await new Promise((resolve) => setTimeout(resolve, (seconds > 0 ? seconds : 20) * 1000 + 250));
          response = await route.fetch({ headers });
        }
        await route.fulfill({ response });
      } catch (error) {
        // The test is over and the page with it.
        if (!page.isClosed()) throw error;
      }
    },
  );
}

/**
 * Where the first block under the tab bar starts, in px from the top of the
 * viewport. Not every sibling after the bar is one: the scripts are
 * display:none, and the crawlers' summary is sr-only, which is out of the flow,
 * so neither takes a place on the page.
 */
async function firstBlockTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Stock sections"]');
    for (let el = nav?.nextElementSibling ?? null; el; el = el.nextElementSibling) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.position === "absolute" || style.position === "fixed") continue;
      const box = el.getBoundingClientRect();
      if (box.height > 0) return box.top;
    }
    throw new Error("nothing visible follows the tab bar");
  });
}

interface LayoutShiftRecord {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
  /** What moved, for a failure message: the element, where it was and where it went. */
  moved: string[];
}

/**
 * Records every layout shift the page makes, from the start of its first load,
 * for layoutShifts() to read. Call it before the first goto: the observer has
 * to exist before the page's own scripts run.
 */
async function recordLayoutShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ShiftEntry = PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: Array<{ node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
    };
    const rect = (r: DOMRectReadOnly) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    const shifts: LayoutShiftRecord[] = [];
    const keep = (entries: PerformanceEntryList) => {
      for (const entry of entries as ShiftEntry[]) {
        shifts.push({
          value: entry.value,
          startTime: entry.startTime,
          hadRecentInput: entry.hadRecentInput,
          moved: (entry.sources ?? []).map(
            (s) => `${s.node?.nodeName ?? "?"}.${(s.node instanceof Element ? s.node.getAttribute("class") ?? "" : "").slice(0, 40)} ${rect(s.previousRect)} -> ${rect(s.currentRect)}`,
          ),
        });
      }
    };
    const observer = new PerformanceObserver((list) => keep(list.getEntries()));
    observer.observe({ type: "layout-shift", buffered: true });
    // Entries the observer has queued but not yet handed over.
    const flush = () => keep(observer.takeRecords());
    (window as unknown as Record<string, unknown>).__e2eLayoutShifts = { shifts, flush };
  });
}

/** The shifts recorded since `since` (performance.now() ms; 0 is the whole load). */
async function layoutShifts(page: Page, since = 0): Promise<LayoutShiftRecord[]> {
  return page.evaluate((from) => {
    const store = (window as unknown as Record<string, { shifts: LayoutShiftRecord[]; flush: () => void }>).__e2eLayoutShifts;
    if (!store) throw new Error("recordLayoutShifts() was not called before the page loaded");
    store.flush();
    return store.shifts.filter((s) => s.startTime >= from);
  }, since);
}

// Cumulative layout shift as the web vitals count it leaves out the shifts that
// follow an input (a click, a tap). A test about what an input itself does to
// the page has to count them.
const shiftTotal = (shifts: LayoutShiftRecord[], { includeInput = false } = {}) =>
  shifts.filter((s) => includeInput || !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0);

const describeShifts = (shifts: LayoutShiftRecord[]) =>
  shifts.map((s) => `${s.value.toFixed(4)}${s.hadRecentInput ? " after input" : ""}: ${s.moved.join("; ")}`).join(" | ") || "none";

test.describe("stock page tabs", () => {
  test.describe.configure({ timeout: 120_000 });

  // waitOutRateLimit's handler can still be fetching when a test ends: a tab's
  // own call, in flight as the last assertion passes. The closing page then
  // fails that fetch, and Playwright failed a test whose every assertion had
  // passed ("every tab is a route", on the News tab's event timeline).
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("every tab is a route; charts live on Overview and Short interest; settings survive; back returns", async ({ page }) => {
    // Every series request the chart makes: a return that draws from the query
    // cache makes none, one that asks the API again makes two.
    const seriesRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === "POST" && (pathname === PRICE_SERIES_PATH || pathname === SHORT_SERIES_PATH)) {
        seriesRequests.push(`${pathname} ${request.postData() ?? ""}`);
      }
    });

    await waitOutRateLimit(page);
    await page.goto(`/shorts/${CODE}`);
    const nav = stockNav(page);
    await expect(nav.getByRole("link")).toHaveCount(7);
    await expect(priceCharts(page)).toHaveCount(1, COLD);
    await expect(priceCharts(page)).toBeVisible();

    // Settings survive. The period is the stock's: choose 6M here (the default
    // is 1Y), read a tab with no chart, and come back by the tab bar.
    const sixMonths = periodButton(page, "6M");
    await expect(sixMonths).toHaveAttribute("aria-pressed", "false");
    await Promise.all([
      ...[PRICE_SERIES_PATH, SHORT_SERIES_PATH].map((path) =>
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === path && (response.request().postData() ?? "").includes('"6m"'),
          THROTTLED,
        ),
      ),
      sixMonths.click(),
    ]);
    await expect(sixMonths).toHaveAttribute("aria-pressed", "true");

    await nav.getByRole("link", { name: "Financials" }).click();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/financials$`), COLD);
    await expect(priceCharts(page)).toHaveCount(0);
    const requestsBeforeReturn = seriesRequests.length;
    await nav.getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}$`), COLD);
    await expect(priceCharts(page)).toBeVisible(COLD);
    await expect(sixMonths).toHaveAttribute("aria-pressed", "true");
    // The chart is drawn and the choice is back. A request the return would
    // make leaves with the mount; give it time to be seen.
    await page.waitForTimeout(1_500);
    expect(
      seriesRequests.slice(requestsBeforeReturn),
      "coming back to Overview asked the API for the chart's series again",
    ).toEqual([]);

    // Charts live on Overview and Short interest only.
    for (const [label, segment] of TABS) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/${segment}$`), COLD);
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
      if (segment === "short-interest") {
        await expect(priceCharts(page)).toBeVisible(COLD);
        // The other chart tab shares the stock's period.
        await expect(sixMonths).toHaveAttribute("aria-pressed", "true");
      } else {
        await expect(priceCharts(page), `${label} carries no price chart`).toHaveCount(0);
      }
    }
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/news$`));
    await expect(nav.getByRole("link", { name: "News" })).toHaveAttribute("aria-current", "page");
    await expect(priceCharts(page)).toHaveCount(0);
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

  // The chart's code is the chunk that holds data-chart-capture, a string only
  // StockChart writes (the build gate web/scripts/stock-chart-chunks.mjs looks
  // for the same one). That gate reads the client manifests; this reads what
  // the browser downloads, which is where a fetch started by module code shows
  // up and a manifest does not. One such fetch put the chart back on Financials
  // and Community (stock-chart-panel-lazy.tsx). The Overview comes last, never
  // having been visited: its chart must still arrive, or the marker has moved
  // and the rest proves nothing.
  test("a tab without a chart downloads none of the chart's code; the Overview does", async ({ page }) => {
    const downloaded: string[] = [];
    const reads: Promise<void>[] = [];
    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith("/_next/static/") || !pathname.endsWith(".js")) return;
      reads.push(
        response
          .text()
          .then((body) => {
            if (body.includes("data-chart-capture")) downloaded.push(pathname);
          })
          .catch(() => undefined),
      );
    });
    const visit = async (path: string) => {
      downloaded.length = 0;
      const response = await page.goto(path);
      expect(response?.status(), `${path} answered`).toBe(200);
      await page.waitForLoadState("networkidle");
      await Promise.all(reads.splice(0));
      return [...downloaded];
    };

    for (const segment of ["financials", "company", "news", "community"]) {
      expect(await visit(`/shorts/${CODE}/${segment}`), `${segment} downloaded the chart's code`).toEqual([]);
    }
    expect(await visit(`/shorts/${CODE}`), "the Overview downloaded no chart code: has the marker moved?").not.toEqual([]);
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
    // leaves the link's left edge outside the bar.
    for (const [label, segment] of [
      ["Financials", "financials"],
      ["Community", "community"],
    ] as const) {
      await page.goto(`/shorts/${CODE}/${segment}`);
      await expect(nav.getByRole("link", { name: label }), `${label}, loaded cold`).toBeInViewport({ ratio: 1 });
    }
  });

  // At 360px and 375px the first three tabs fill the row and the fourth starts
  // past the edge (x=368 at both), so nothing peeks out of a bar whose scrollbar
  // is hidden: the fade on the edge that can scroll is the only cue that
  // Financials, Company, News and Community exist. The state is read from the
  // bar's own attributes, and the fade from its computed style.
  test("360px: the tab bar fades the edge it can scroll to, and the fade follows the scroll", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/shorts/${CODE}`);
    const list = tabList(page);

    // At rest: more tabs behind the end, none behind the start. The attribute
    // is set once the bar has hydrated and been measured, so waiting for it is
    // waiting for the page.
    await expect(list).toHaveAttribute("data-scroll-end", "true", COLD);
    await expect(list).not.toHaveAttribute("data-scroll-start");
    expect(await fadeOf(list), "the end fade is drawn, not just announced").toContain("linear-gradient");
    const overflow = await list.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(overflow.scrollWidth, "the tabs overflow the bar").toBeGreaterThan(overflow.clientWidth);

    // Scrolled to the end: the last tab is in, and the fade moves to the start.
    const before = await fadeOf(list);
    await list.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(list).toHaveAttribute("data-scroll-start", "true");
    await expect(list).not.toHaveAttribute("data-scroll-end");
    await expect(stockNav(page).getByRole("link", { name: "Community" })).toBeInViewport({ ratio: 1 });
    const atEnd = await fadeOf(list);
    expect(atEnd, "the fade is on the other edge now").toContain("linear-gradient");
    expect(atEnd, "the fade is on the other edge now").not.toBe(before);

    // Part of the way back: tabs behind both edges.
    await list.evaluate((el) => {
      el.scrollLeft = 150;
    });
    await expect(list).toHaveAttribute("data-scroll-start", "true");
    await expect(list).toHaveAttribute("data-scroll-end", "true");

    // And back at the start, as at rest.
    await list.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect(list).toHaveAttribute("data-scroll-end", "true");
    await expect(list).not.toHaveAttribute("data-scroll-start");
    expect(await fadeOf(list)).toBe(before);
  });

  test("1280px: a tab bar that fits draws no fade", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`/shorts/${CODE}`);
    // The chart's arrival says the page has hydrated, so the bar has been
    // measured: an absent attribute is not just an unhydrated one.
    await expect(priceCharts(page)).toBeVisible(COLD);
    const list = tabList(page);
    await expect(list).not.toHaveAttribute("data-scroll-end");
    await expect(list).not.toHaveAttribute("data-scroll-start");
    expect(await fadeOf(list)).toBe("none");
  });

  test("the chrome leaves the content in the first screen", async ({ page }) => {
    // Signed out, so the sign-in banner is in play, and after hydration. Soft
    // assertions: one run names every number that is out.
    const nav = stockNav(page);
    const measured = [
      ["Overview", `/shorts/${CODE}`],
      ["Financials", `/shorts/${CODE}/financials`],
      ["News", `/shorts/${CODE}/news`],
    ] as const;

    // The network never goes quiet for long (the community teaser's own fetch
    // can hold it busy for half a minute), so "settled" is a sign on the page.
    // On the Overview it is the chart's arrival. On the other tabs it is what
    // the tab prints that its loading state does not: Financials' first heading
    // after the bar, News' h1 (both are in the server HTML, so a measurement
    // taken before them could be of the route's loading skeleton). Only a tab
    // with no such sign falls back to a second's wait (the layout-shift test
    // shows nothing moves after that).
    const tabHeading: Record<string, Locator | undefined> = {
      Financials: page.locator(
        'xpath=//nav[@aria-label="Stock sections"]/following::*[self::h1 or self::h2 or self::h3][1]',
      ),
      News: page.getByRole("heading", { level: 1 }).first(),
    };
    async function settled(label: string, path: string) {
      await page.goto(path);
      const heading = tabHeading[label];
      if (heading) await expect(heading, `${label}: its own heading`).toBeVisible(COLD);
      else await page.waitForTimeout(1_000);
      if (label === "Overview") await expect(priceCharts(page)).toBeVisible(COLD);
    }

    // G1, G3: on a phone the tab bar and the content under it are in the first
    // screen, and so is the whole of the Overview's chart.
    await page.setViewportSize(PHONE);
    for (const [label, path] of measured) {
      await settled(label, path);
      expect.soft((await boxOf(nav)).top, `390px ${label}: the tab bar's top`).toBeLessThanOrEqual(340);
      expect.soft(await firstBlockTop(page), `390px ${label}: where the content starts`).toBeLessThanOrEqual(400);
      if (label === "Overview") {
        const chart = await boxOf(priceCharts(page));
        expect.soft(chart.top, "390px Overview: the chart's top").toBeLessThanOrEqual(480);
        expect.soft(chart.bottom, "390px Overview: the chart's bottom").toBeLessThanOrEqual(PHONE.height);
      }
    }

    // G2, G3: the same on a desktop window.
    await page.setViewportSize(DESKTOP);
    for (const [label, path] of measured) {
      await settled(label, path);
      expect.soft((await boxOf(nav)).top, `1280px ${label}: the tab bar's top`).toBeLessThanOrEqual(280);
      expect.soft(await firstBlockTop(page), `1280px ${label}: where the content starts`).toBeLessThanOrEqual(340);
      if (label === "Overview") {
        const chart = await boxOf(priceCharts(page));
        expect.soft(chart.top, "1280px Overview: the chart's top").toBeLessThanOrEqual(420);
        expect.soft(chart.bottom, "1280px Overview: the chart's bottom").toBeLessThanOrEqual(DESKTOP.height);
      }
    }

    // G4: the Strategy tab's levels chart, a StockChart of its own inside
    // [data-strategy-chart], starts within 800px on a phone.
    await page.setViewportSize(PHONE);
    await page.goto(`/shorts/${CODE}/strategy`);
    const levels = page.locator("[data-strategy-chart] [data-chart-container]");
    await expect(levels).toBeVisible(COLD);
    expect.soft((await boxOf(levels)).top, "390px Strategy: the levels chart's top").toBeLessThanOrEqual(800);
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px: the tab bar docks and a docked switch keeps the new tab under it`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/shorts/${CODE}`);
      const nav = stockNav(page);
      // The Overview at its full height, so there is a page to scroll.
      await expect(priceCharts(page)).toBeVisible(COLD);

      // G5. Docked, the bar sits under the site header: 64px, less the pixel
      // its border overlaps.
      const expectDocked = async (when: string) => {
        const { top } = await boxOf(nav);
        expect(top, `${when}: the tab bar's top`).toBeGreaterThanOrEqual(60);
        expect(top, `${when}: the tab bar's top`).toBeLessThanOrEqual(66);
      };
      await page.evaluate(() => window.scrollTo(0, 1200));
      await expectDocked("scrolled to 1200");

      // A switch while docked keeps the bar docked, and the new tab starts
      // right under it, not behind it and not a screen below.
      await nav.getByRole("link", { name: "Company" }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/company$`), COLD);
      await expectDocked("after the switch to Company");
      const { bottom } = await boxOf(nav);
      const start = await firstBlockTop(page);
      expect(start, "the new tab starts under the bar").toBeGreaterThanOrEqual(bottom);
      expect(start, "the new tab starts at the bar").toBeLessThanOrEqual(bottom + 40);

      // From the top of the page the bar is not docked: a click scrolls nothing.
      await page.evaluate(() => window.scrollTo(0, 0));
      await nav.getByRole("link", { name: "Financials" }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/financials$`), COLD);
      expect(await scrollY(page), "a switch from the top of the page").toBe(0);

      // Part of the way down, but not yet docked: a bar that was not docked
      // does not move, and neither does the page.
      await page.evaluate(() => window.scrollTo(0, 100));
      expect(await scrollY(page)).toBe(100);
      const undockedTop = (await boxOf(nav)).top;
      await nav.getByRole("link", { name: "Short interest" }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/short-interest$`), COLD);
      expect(await scrollY(page), "a switch before the bar docks").toBe(100);
      expect((await boxOf(nav)).top, "the tab bar's top after a switch before it docks").toBe(undockedTop);
    });
  }

  // WCAG 2.2 SC 2.4.11, Focus Not Obscured. The docked bar is translucent and
  // blurred, so a control the keyboard reaches in the band under it (64 to 109px)
  // would be an unreadable smear. The bar scrolls such a control clear when the
  // page has hydrated. CSS scroll-padding-top is not the cure: it makes Tab across
  // the docked tab links scroll the page to the top, which the second test holds.
  test.describe("focus under the docked bar", () => {
    test.use({ viewport: DESKTOP });

    test("a link the keyboard reaches under the docked bar is scrolled clear of it", async ({ page }) => {
      await page.goto(`/shorts/${CODE}`);
      // The chart's arrival says the page has hydrated, so the bar is listening.
      await expect(priceCharts(page)).toBeVisible(COLD);
      const nav = stockNav(page);
      const link = page.getByRole("link", { name: /History & FAQ/ });

      // A key press, so the focus that follows is a keyboard's (:focus-visible).
      // Tab moves focus to the first control and the page to the top, so the
      // page is placed after it.
      await page.keyboard.press("Tab");
      // Dock the bar, with the link at 80px: under the bar, clear of the header.
      await link.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 80));
      const bar = await boxOf(nav);
      expect(bar.top, "the tab bar is docked").toBeGreaterThanOrEqual(60);
      expect(bar.top, "the tab bar is docked").toBeLessThanOrEqual(66);
      const placed = await boxOf(link);
      expect(placed.top, "the link starts under the bar").toBeLessThan(bar.bottom);
      expect(placed.bottom, "the link is on screen").toBeGreaterThan(bar.top);

      await link.focus();
      await expect(link).toBeFocused();
      await expect
        .poll(async () => (await boxOf(link)).top, {
          message: "the focused link is scrolled out from under the tab bar",
        })
        .toBeGreaterThanOrEqual(bar.bottom);
      expect((await boxOf(nav)).top, "the bar stays docked").toBeLessThanOrEqual(66);
    });

    test("Tab across the docked tab links does not move the page", async ({ page }) => {
      await page.goto(`/shorts/${CODE}`);
      await expect(priceCharts(page)).toBeVisible(COLD);
      const nav = stockNav(page);
      const links = nav.getByRole("link");
      await expect(links).toHaveCount(7);

      await page.evaluate(() => window.scrollTo(0, 1200));
      expect((await boxOf(nav)).top, "the tab bar is docked").toBeLessThanOrEqual(66);
      await links.first().focus();
      const docked = await scrollY(page);
      expect(docked, "the page is scrolled").toBeGreaterThan(0);

      for (let i = 1; i < 7; i++) {
        await page.keyboard.press("Tab");
        await expect(links.nth(i)).toBeFocused();
        expect(await scrollY(page), `Tab onto tab link ${i + 1} moved the page`).toBe(docked);
      }
    });
  });

  test.describe("touch input", () => {
    test.use({ viewport: PHONE, hasTouch: true });

    test("a phone tap pins the readout without moving the plot", async ({ page }) => {
      // Throttled: a refused call is waited out (up to a minute, up to three
      // times) before the chart has both its series.
      test.setTimeout(180_000);
      await waitOutRateLimit(page);
      await recordLayoutShifts(page);
      await page.goto(`/shorts/${CODE}`);
      const plot = page.locator("svg:has([data-chart-capture])");
      await expect(plot).toBeVisible(COLD);
      // Both series are in the strip, so there is a second reading to pin. The
      // strip's height does not wait for it: the combined view holds the second
      // series' row from the first render (readoutReserveSeries).
      await expect(page.locator("[data-chart-readout] [data-readout-entry]")).toHaveCount(2, THROTTLED);

      const topBefore = (await boxOf(plot)).top;
      const capture = page.locator("[data-chart-capture]");
      const captureBox = await capture.boundingBox();
      if (!captureBox) throw new Error("the plot has no box to tap");
      const tappedAt = await page.evaluate(() => performance.now());
      // The left third of the plot, halfway down.
      await capture.tap({ position: { x: captureBox.width / 6, y: captureBox.height / 2 } });

      const readout = page.locator("[data-chart-readout][data-pinned]");
      await expect(readout).toBeVisible();
      await expect(readout).toHaveAttribute("data-readout-state", "pinned");
      // A reflow caused by the pin would follow the render by a frame or two.
      await page.waitForTimeout(500);
      expect((await boxOf(plot)).top, "the plot's top after the tap").toBe(topBefore);
      // Counted with the shifts that follow an input: a tap is the input that
      // would explain, and so hide, a strip that grew on a pin.
      const shifts = await layoutShifts(page, tappedAt);
      expect(shiftTotal(shifts, { includeInput: true }), `layout shift after the tap: ${describeShifts(shifts)}`).toBe(0);
    });
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px: first load and a tab switch shift nothing`, async ({ page }) => {
      // Throttled, and it sits out two 3 s settles on top of the waits.
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await waitOutRateLimit(page);
      await recordLayoutShifts(page);
      // The sign-in slot as the document stands when it has been parsed. The
      // banner cannot have mounted: it waits for hydration and the session read.
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const slot = document.querySelector(".login-slot");
          (window as unknown as Record<string, unknown>).__e2eSlotAtParse = slot
            ? {
                height: slot.getBoundingClientRect().height,
                bannerMounted: slot.querySelector("button") !== null,
                reserved: document.documentElement.classList.contains("anon"),
              }
            : null;
        });
      });

      await page.goto(`/shorts/${CODE}`, { waitUntil: "domcontentloaded" });
      const atParse = await page.evaluate(
        () => (window as unknown as Record<string, { height: number; bannerMounted: boolean; reserved: boolean } | null>).__e2eSlotAtParse,
      );
      expect(atParse, "the sign-in slot is in the server HTML").not.toBeNull();
      expect(atParse?.reserved, "html.anon is set before first paint, so critical CSS reserves the slot").toBe(true);
      expect(atParse?.bannerMounted, "the banner had not mounted when the document was parsed").toBe(false);

      // The load has settled when the chart is drawn with both its series (the
      // strip held the second one's row from the first render, so its arrival
      // moves nothing; it is the data that is waited for) and the banner is in;
      // the late arrivals get three more seconds.
      await expect(priceCharts(page)).toBeVisible(COLD);
      await expect(page.locator("[data-chart-readout] [data-readout-entry]")).toHaveCount(2, THROTTLED);
      const slot = page.locator(".login-slot");
      await expect(slot.getByRole("button", { name: "Close" })).toBeVisible(COLD);
      await page.waitForLoadState("load");
      await page.waitForTimeout(3_000);
      const loadShifts = await layoutShifts(page);
      // D3: the slot held the banner's place, to the pixel.
      expect.soft(
        (await slot.boundingBox())?.height,
        "the sign-in slot's height once the banner has mounted, against its height when the document was parsed",
      ).toBeCloseTo(atParse?.height ?? NaN, 1);

      const switchedAt = await page.evaluate(() => performance.now());
      await stockNav(page).getByRole("link", { name: "Short interest" }).click();
      await expect(page).toHaveURL(new RegExp(`/shorts/${CODE}/short-interest$`), COLD);
      await expect(priceCharts(page)).toBeVisible(THROTTLED);
      await page.waitForTimeout(3_000);
      const switchShifts = await layoutShifts(page, switchedAt);

      // G7: under 0.02 each, counted as the web vitals count them.
      expect.soft(shiftTotal(loadShifts), `layout shift on first load: ${describeShifts(loadShifts)}`).toBeLessThan(0.02);
      expect.soft(shiftTotal(switchShifts), `layout shift on the switch to Short interest: ${describeShifts(switchShifts)}`).toBeLessThan(0.02);
    });
  }

  // Dismissing the banner renders it null. Its frame (the bordered wrapper the
  // Overview draws round it) is `empty:hidden`, so a 2px sliver of border is not
  // left above the grid; html.anon comes off, so the slot's reservation goes too.
  test("dismissing the sign-in banner leaves nothing of its slot behind", async ({ page }) => {
    await page.goto(`/shorts/${CODE}`);
    const slot = page.locator(".login-slot");
    const close = slot.getByRole("button", { name: "Close" });
    await expect(close).toBeVisible(COLD);
    const slotHeight = () => slot.evaluate((el) => el.getBoundingClientRect().height);
    expect(await slotHeight(), "the slot holds the banner while it is shown").toBeGreaterThan(40);

    await close.click();
    await expect(slot.getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect.poll(slotHeight, { message: "the sign-in slot's height after Close" }).toBe(0);
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
    // The chart prints either its levels or, when the fit carried no price
    // features, the price-only note. Wait for one of the two, so a page that
    // shows neither fails here rather than being read as one of them.
    const level = page.locator("[data-chart-level]").first();
    const priceOnly = page.getByText(PRICE_ONLY_NOTE, { exact: true });
    await expect(
      level.or(priceOnly),
      `${code}: the strategy tab drew neither a level nor the price-only note`,
    ).toBeVisible({ timeout: 15000 });
    // The note means the page never got price_features: the API this build
    // reads predates PR 1, or this tree lacks PR 1's generated client (which is
    // what decodes the field). That is the only cause that skips; anything else
    // that leaves no level still fails below. A skip does not show in CI, so the
    // post-deploy checklist (spec section 6) has the same check by hand.
    test.skip(
      await priceOnly.isVisible(),
      `${code}: the Strategy page shows the price-only note, so PR 1's price features are not reaching it yet (is PR 1 live on the API, and is its generated client in this build? merge main after PR 1 lands, then re-run)`,
    );
    await expect(
      level,
      `${code}: the strategy tab drew no level and no price-only note either`,
    ).toBeVisible();
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
    // else: a leftover wrapper leaves a single tab bar. Community is not a chart
    // tab, so no chart is on the page at all.
    await expect(page.locator("main")).toHaveCount(1);
    const nav = page.getByRole("navigation", { name: "Stock sections" });
    await expect(nav).toHaveCount(1);
    await expect(page.locator("[data-chart-container]")).toHaveCount(0);
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
