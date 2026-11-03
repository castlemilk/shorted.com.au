import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "./helpers/test";
import { cloudflareTestingBypassHeadersFor } from "./helpers/cloudflare-testing-bypass";

/**
 * The chart surfaces that take the Indicators menu (CLAUDE.md, "Share & embed"; the
 * Discord Activity in docs/discord-bot.md): the Activity, the share page, the stock
 * page's chart, and the public /embed/chart, which offers none. Like stock-tabs.spec.ts
 * it reads LIVE public data, and it runs against `next dev`, not a build; no workflow runs it.
 *
 *   cd web
 *   SKIP_ENV_VALIDATION=1 NEXT_PUBLIC_API_URL=https://api.shorted.com.au \
 *     SHORTS_SERVICE_ENDPOINT=https://api.shorted.com.au \
 *     MARKET_DATA_API_URL=https://api.shorted.com.au npm run dev          # :3020
 *   npx playwright test e2e/chart-surfaces.spec.ts --project=chromium --workers=1 --reporter=list
 *
 * WebKit (Safari's engine) runs the same checks through the project the config already has
 * for it. No project is added or changed, and none excludes this file. Once per machine:
 *   npx playwright install webkit
 *   npx playwright test e2e/chart-surfaces.spec.ts --project=webkit --workers=1 --reporter=list
 * The phone checks can also run as an iPhone 12 (WebKit, touch, mobile user agent) under the
 * "Mobile Safari" project. The names with "phone" pick out the phone checks:
 *   npx playwright test e2e/chart-surfaces.spec.ts --project="Mobile Safari" -g phone --workers=1 --reporter=list
 *
 * TF_VAR_rate_limit_testing_bypass_secret, that one variable from the repo-root .env, clears
 * the edge for localhost (helpers/test.ts). The API still caps an anonymous address at 30
 * calls a minute, so a refused call is waited out (waitOutRateLimit, as in stock-tabs).
 * Screenshots go to test-results/chart-surfaces/. Never point BASE_URL at production.
 */

// The windows the surfaces are checked at: a phone held upright (where the Activity and the
// share page turn their charts sideways), and a desktop.
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const CHART = "[data-chart-container] svg";
const INDICATORS = /^Indicators/;
// A cold dev server compiles the route on the first request, so the first chart is slow.
const LOADED = { timeout: 60_000 };
// A warm-up is one more price request behind the first chart, and it draws only when it lands.
const LANDED = { timeout: 30_000 };
const SHOTS = path.resolve("test-results", "chart-surfaces");

// The price history a chart asks for: one POST per period, its JSON body naming the period
// (getHistoricalData in src/@/lib/stock-data-service.ts).
const PRICE_PATH = "/api/market-data/historical";

function periodOf(request: { postData(): string | null }): string | undefined {
  try {
    return (
      JSON.parse(request.postData() ?? "null") as { period?: string } | null
    )?.period;
  } catch {
    return undefined;
  }
}

/** The period of every price history request the page makes, in order. Listen before the first load. */
function recordPriceRequests(page: Page): string[] {
  const periods: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === PRICE_PATH
    ) {
      periods.push(periodOf(request) ?? "");
    }
  });
  return periods;
}

/**
 * The API lets an anonymous address make 30 calls a minute. A call it refuses is waited out
 * and asked again, as stock-tabs.spec.ts does (its waitOutRateLimit, copied here so this
 * spec does not import another spec).
 */
async function waitOutRateLimit(page: Page): Promise<void> {
  await page.route(
    (url) =>
      url.pathname.startsWith("/shorts.v1alpha1.") ||
      url.pathname === PRICE_PATH,
    async (route) => {
      try {
        // This route runs before the fixture's, so it sends the trusted-test header itself.
        const request = route.request();
        const headers = {
          ...request.headers(),
          ...cloudflareTestingBypassHeadersFor(request.url()),
        };
        let response = await route.fetch({ headers });
        for (let retry = 0; response.status() === 429 && retry < 3; retry++) {
          const seconds = Number(response.headers()["retry-after"]);
          await new Promise((resolve) =>
            setTimeout(resolve, (seconds > 0 ? seconds : 20) * 1000 + 250),
          );
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

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// A chart keeps asking for history after its last assertion (a warm-up, a refetch). Drop the
// rate-limit route first, so a request still in flight when the page closes is not reported
// as this test's failure.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.describe("the Discord Activity on a desktop", () => {
  test.use({ viewport: DESKTOP });

  test("is the chart: no links, no site chrome, and its controls in the header row", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitOutRateLimit(page);
    await page.goto("/embed/discord?code=CBA&view=combined&period=max");
    await expect(page.locator(CHART).first()).toBeVisible(LOADED);

    await expect(page.locator("a")).toHaveCount(0);
    await expect(page.locator("header, footer")).toHaveCount(0);
    // The dev and preview banners read the same chromeless list as the header.
    await expect(
      page.getByText("Development Mode", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Preview Environment", { exact: true }),
    ).toHaveCount(0);

    const header = await page
      .locator("[data-embed-header]")
      .first()
      .boundingBox();
    expect(header?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(16);
    await expect(
      page.getByRole("button", { name: "Search stocks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open CBA on Shorted", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: INDICATORS })).toBeVisible();
    await shot(page, "activity-desktop");
  });
});

test.describe("the Discord Activity launched on a phone", () => {
  test.use({ viewport: PHONE });

  test("starts turned sideways, and sends its links out through Discord, never the frame", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Records every window.open: a link that leaves in a plain tab shows up here.
    await page.addInitScript(() => {
      const opened: unknown[][] = [];
      Object.defineProperty(window, "__opened", { value: opened });
      window.open = ((...args: unknown[]) => {
        opened.push(args);
        return null;
      }) as typeof window.open;
    });
    const openedCount = () =>
      page.evaluate(
        () => (window as unknown as { __opened: unknown[] }).__opened.length,
      );

    await waitOutRateLimit(page);
    await page.goto(
      "/embed/discord?code=CBA&view=combined&period=max&frame_id=live&instance_id=live&platform=mobile",
    );
    await expect(page.locator('[data-landscape="true"]')).toBeVisible(LOADED);
    await expect(page.locator(CHART).first()).toBeVisible(LOADED);
    await shot(page, "activity-phone-landscape");

    // No SDK here, so the link is shown to copy, in the chart's box: text, not a navigation.
    // The status region is sr-only, so the visible box is what is checked.
    await page
      .getByRole("button", { name: "Open CBA on Shorted", exact: true })
      .click();
    await expect(page.locator("[data-link-fallback]")).toContainText(
      "shorted.com.au/shorts/CBA",
      { timeout: 10_000 },
    );
    await expect(page.locator("[data-link-fallback]")).toBeVisible();
    expect(await openedCount()).toBe(0);
    await expect(page).toHaveURL(/\/embed\/discord\?/);

    // Search is an upright dialog outside the turned chart; Escape closes it and keeps the turn.
    await page
      .getByRole("button", { name: "Search stocks", exact: true })
      .click();
    const search = page.getByRole("dialog", {
      name: "Search ASX stocks",
      exact: true,
    });
    await expect(search).toBeVisible();
    await expect(
      page.locator('[data-landscape="true"] [role="dialog"]'),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();
    await expect(page.locator('[data-landscape="true"]')).toBeVisible();
    await shot(page, "activity-phone-after-escape");
  });
});

// Discord's proxy loads the site root with the launch parameters and follows the server
// redirect itself, so the browser's address stays `/` while the Activity page's HTML
// arrives. route.fetch() follows that redirect the way the proxy does, and fulfilling it
// keeps the address the page asked for. Without the script that moves the address, in the
// root layout's <head> (src/config/discord-activity.mjs), the site chrome renders and
// hydration fails, so this check fails without it.
//
// The proxy also puts its own inline script in <head>, after the first preload. This is the
// one it adds (it does nothing unless the page is framed). React must hydrate a document with
// that extra element and report no error, so withProxyHeadScript inserts it into the HTML.
const DISCORD_PROXY_HEAD_SCRIPT =
  '<script type="text/javascript">(function(){ if (window.parent === window) return; })();</script>';

/** The HTML with DISCORD_PROXY_HEAD_SCRIPT right after the first <link rel="preload" as="script"> in <head>. */
function withProxyHeadScript(html: string): string {
  const preload = /<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="script")[^>]*>/.exec(html);
  if (!preload || html.indexOf("</head>") < preload.index) {
    throw new Error('the Activity HTML has no <link rel="preload" as="script"> in its <head>');
  }
  const at = preload.index + preload[0].length;
  return html.slice(0, at) + DISCORD_PROXY_HEAD_SCRIPT + html.slice(at);
}

async function behindDiscordProxy(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/" && url.searchParams.has("frame_id"),
    async (route) => {
      try {
        // This route runs before the fixture's, so it sends the trusted-test header itself.
        const request = route.request();
        const response = await route.fetch({
          headers: {
            ...request.headers(),
            ...cloudflareTestingBypassHeadersFor(request.url()),
          },
        });
        // The body is replaced, so the headers that described the original go: its length, and
        // its encoding (response.text() is already decoded). The length is set for the new body.
        const headers = response.headers();
        delete headers["content-length"];
        delete headers["content-encoding"];
        delete headers["transfer-encoding"];
        const body = withProxyHeadScript(await response.text());
        await route.fulfill({
          status: response.status(),
          headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
          body,
        });
      } catch (error) {
        // The test is over and the page with it.
        if (!page.isClosed()) throw error;
      }
    },
  );
}

/**
 * Records every uncaught page error, and every console error that React reports for a
 * hydration mismatch (#418 and #423 in production; the words in development, where React
 * prints them in full). Listen before the first load.
 */
function recordHydrationProblems(page: Page): { pageErrors: string[]; hydration: string[] } {
  const problems = { pageErrors: [] as string[], hydration: [] as string[] };
  page.on("pageerror", (error) => problems.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /#418|#423|hydrat/i.test(message.text())) {
      problems.hydration.push(message.text());
    }
  });
  return problems;
}

// The root with the launch parameters Discord sends, and the custom_id a button launches with.
const launchPath = (platform: "mobile" | "desktop") =>
  `/?frame_id=f&instance_id=i&platform=${platform}&custom_id=activity%3ACBA%3Acombined%3A6m`;

for (const [device, viewport, platform] of [
  ["phone", PHONE, "mobile"],
  ["desktop", DESKTOP, "desktop"],
] as const) {
  test.describe(`the Discord Activity behind Discord's proxy on a ${device}`, () => {
    test.use({ viewport });

    test("keeps the Activity's address, renders no site chrome, opens the chart it was launched on, and hydrates past Discord's head script", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await waitOutRateLimit(page);
      await behindDiscordProxy(page);
      const problems = recordHydrationProblems(page);
      // The proxy's route holds the navigation while a cold dev server compiles the Activity.
      await page.goto(launchPath(platform), LOADED);

      // The router reads the Activity's address, not the homepage's.
      await expect(page).toHaveURL(
        /\/embed\/discord\?frame_id=f&instance_id=i/,
        LOADED,
      );
      await expect(page.locator("header, footer")).toHaveCount(0);
      await expect(page.locator("a")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Open CBA on Shorted", exact: true }),
      ).toBeVisible(LOADED);
      // The chart is drawn by client code, so it is drawn after hydration.
      await expect(page.locator(CHART).first()).toBeVisible(LOADED);
      // The script the proxy adds is in the document the page hydrated, so the case ran.
      expect(await page.evaluate(() => document.head.innerHTML)).toContain(
        "window.parent === window",
      );
      expect(problems.pageErrors).toEqual([]);
      expect(problems.hydration).toEqual([]);
      await shot(page, `activity-proxy-${device}`);
    });
  });
}

test.describe("the Discord Activity's indicators", () => {
  test.use({ viewport: DESKTOP });

  test("asks for the history an indicator needs, and offers sign-in with no anchor in the frame", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitOutRateLimit(page);
    const periods = recordPriceRequests(page);
    await page.goto("/embed/discord?code=CBA&view=price&period=1m");
    await expect(page.locator(CHART).first()).toBeVisible(LOADED);
    expect(periods).toEqual(["1m"]);

    // SMA 20 needs 19 sessions before its first value; a one-month view has 21, so the
    // first longer period that covers it (3m) is fetched once, before the line is drawn.
    const warmup = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === PRICE_PATH &&
        periodOf(request) === "3m",
    );
    await page.getByRole("button", { name: INDICATORS }).click();
    await page.getByRole("button", { name: "SMA 20", exact: true }).click();
    await warmup;

    // The line is drawn, and named in the legend, once the 3m history has landed.
    // A lookahead, so the legend's "SMA 200" (signed in, advanced) would not count as "SMA 20".
    await expect(page.locator('[data-chart="indicator-legend"]')).toContainText(
      /SMA 20(?!\d)/,
      LANDED,
    );
    await expect(
      page.getByRole("button", { name: "Sign in on Shorted", exact: true }),
    ).toBeVisible();
    await expect(page.locator("a")).toHaveCount(0);
    await shot(page, "activity-indicators");
  });
});

test.describe("the share page on a phone", () => {
  test.use({ viewport: PHONE });

  test("opens turned sideways, asks for one price history, and returns a sign-in to this chart", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitOutRateLimit(page);
    const periods = recordPriceRequests(page);
    await page.goto("/chart/CBA?view=combined&period=max&landscape=1");
    await expect(page.locator('[data-landscape="true"]')).toBeVisible(LOADED);
    await expect(page.locator(CHART).first()).toBeVisible(LOADED);
    // No indicator is chosen, so nothing is warmed up: the one request is the chart's own.
    expect(periods).toEqual(["max"]);

    await page.getByRole("button", { name: INDICATORS }).click();
    // The session check decides between "checking" and the link, so allow for it.
    await expect(
      page.getByRole("link", { name: "Sign in to unlock", exact: true }),
    ).toHaveAttribute(
      "href",
      /^\/signin\?callbackUrl=%2Fchart%2FCBA%3Fview%3Dcombined%26period%3Dmax%26landscape%3D1/,
      { timeout: 15_000 },
    );
    await shot(page, "share-phone");
  });
});

test.describe("the stock page's chart", () => {
  for (const [label, viewport, boxHeight] of [
    ["desktop", DESKTOP, 420],
    ["phone", PHONE, 360],
  ] as const) {
    test.describe(label, () => {
      test.use({ viewport });

      test(`keeps its indicators in one menu, and draws the one picked in a ${boxHeight}px box`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await waitOutRateLimit(page);
        await page.goto("/shorts/CBA");
        await expect(page.locator(CHART).first()).toBeVisible(LOADED);
        // The indicators live in the menu: with it closed, no moving average is a button.
        await expect(
          page.getByRole("button", { name: "SMA 20", exact: true }),
        ).toHaveCount(0);

        await page.getByRole("button", { name: INDICATORS }).click();
        await page.getByRole("button", { name: "SMA 50", exact: true }).click();
        // A one-year view needs two years of prices for a 50-day average, so the legend
        // waits on that warm-up.
        await expect(
          page.locator('[data-chart="indicator-legend"]'),
        ).toContainText("SMA 50", LANDED);
        const box = await page
          .locator('[class*="[grid-area:chart]"]')
          .first()
          .boundingBox();
        expect(box?.height).toBe(boxHeight);
        await shot(page, `stock-${label}`);
      });
    });
  }
});

test.describe("the public embed", () => {
  test("offers no indicators, and asks for one price history", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitOutRateLimit(page);
    const periods = recordPriceRequests(page);
    await page.goto("/embed/chart?code=CBA&view=combined");
    await expect(page.locator(CHART).first()).toBeVisible(LOADED);
    await expect(page.getByRole("button", { name: INDICATORS })).toHaveCount(0);
    await expect(page.locator('[data-chart="indicator-legend"]')).toHaveCount(
      0,
    );
    expect(periods).toEqual(["1y"]);
  });
});
