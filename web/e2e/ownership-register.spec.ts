import { test, expect, type Page } from "./helpers/test";

/**
 * The ownership register and the workspace (spec 14.6, and section 10's stage 3 sentence): the
 * register page's cache, its holder lanes at a phone width, the page's horizontal fit, the
 * `#ownership` anchor under the stock page's docked bar, the workspace nav reaching every page,
 * and a map cell's selection filling the inspector.
 *
 * No workflow runs this spec. It is written to run against a PRODUCTION build served by
 * `next start`, never `next dev`: the cache assertion reads `x-nextjs-cache`, which only
 * `next start` sets (Vercel reports the same fact as `x-vercel-cache`).
 *
 * The suite reads LIVE public data: the server fetches the register, the workspace and the stock
 * page from the public API, so it needs network access and a stock the API knows (BHP).
 * There is no webServer block in the Playwright config; the server must already be running.
 *
 *   cd web
 *   SKIP_ENV_VALIDATION=1 NEXT_PUBLIC_API_URL=https://api.shorted.com.au \
 *     npx next build
 *   SKIP_ENV_VALIDATION=1 SHORTS_SERVICE_ENDPOINT=https://api.shorted.com.au \
 *     NEXT_PUBLIC_API_URL=https://api.shorted.com.au \
 *     MARKET_DATA_API_URL=https://api.shorted.com.au npm run start   # :3020, the config's baseURL
 *   # In another shell, on Node 22 (see stock-tabs.spec.ts):
 *   npx playwright test e2e/ownership-register.spec.ts --project=chromium --workers=1 --reporter=list
 *
 * - Leave BASE_URL unset, or the suite is aimed somewhere other than localhost:3020. Never point it
 *   at production.
 * - Export TF_VAR_rate_limit_testing_bypass_secret, that one variable from the repo-root .env, before
 *   the run. helpers/test.ts sends it to localhost and our own origins only. Without it the API's
 *   edge can answer 429 and the cache and lane assertions fail for that reason.
 * - The register's cache assertion (a second request answers HIT) passes only once the first request
 *   has rendered the page into the cache, so it is the first thing a fresh server answers.
 */

const CODE = "BHP";
const REGISTER = `/ownership/stocks/${CODE}`;

// A first visit to a page is an on-demand ISR render (several API reads), so the first assertion on
// each of those waits longer than the 5 s default.
const COLD = { timeout: 30_000 };

const PHONE_NARROW = { width: 360, height: 780 };
const DESKTOP = { width: 1280, height: 900 };

// The workspace's pages in the order the nav gives them (spec 14.1), each with the label the nav prints.
const WORKSPACE = [
  { label: "Overview", path: "/ownership" },
  { label: "Market map", path: "/ownership/map" },
  { label: "Connections", path: "/ownership/connections" },
  { label: "Activity", path: "/ownership/activity" },
  { label: "Funds", path: "/ownership/funds" },
  { label: "Holders", path: "/ownership/holders" },
  { label: "Changes", path: "/ownership/changes" },
] as const;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const workspaceNav = (page: Page) => page.getByRole("navigation", { name: "Ownership" });

test.describe("ownership register", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the register page's second request is served from the ISR cache", async ({ request }) => {
    // The first request renders the page on demand (or finds the entry an earlier test left); the second
    // must not render it again. A page that silently renders per request answers 200 every time and never
    // says HIT.
    const first = await request.get(REGISTER, { timeout: 60_000 });
    expect(first.status(), `${REGISTER}: first request`).toBe(200);
    const second = await request.get(REGISTER, { timeout: 60_000 });
    expect(second.status(), `${REGISTER}: second request`).toBe(200);
    expect(second.headers()["x-nextjs-cache"], `${REGISTER}: second request`).toBe("HIT");
  });

  test("360px: each holder lane takes a row of its own under the holder's name", async ({ page }) => {
    await page.setViewportSize(PHONE_NARROW);
    await page.goto(REGISTER);
    const lanes = page.locator('figure[aria-labelledby="holders"] li');
    await expect(lanes.first()).toBeVisible(COLD);
    if ((await lanes.count()) === 0) test.skip(true, "no holder lanes to measure");

    const lane = lanes.first();
    const name = lane.locator("span.block.truncate").first();
    const scale = lane.locator('[title^="Lane scale"] svg').first();
    const nameBox = await name.boundingBox();
    const scaleBox = await scale.boundingBox();
    expect(nameBox, "the holder's name is drawn").not.toBeNull();
    expect(scaleBox, "the lane is drawn").not.toBeNull();
    // Two rows: the lane starts below the name, and it spans most of the phone's width rather than
    // sharing a column with the figures.
    expect(scaleBox!.y, "the lane sits below the name").toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
    expect(scaleBox!.width, "the lane's width at 360px").toBeGreaterThanOrEqual(PHONE_NARROW.width * 0.6);
  });

  test("360px: the register page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize(PHONE_NARROW);
    await page.goto(REGISTER);
    await expect(page.locator('figure[aria-labelledby="holders"]').or(page.getByRole("heading", { level: 1 }))).toBeVisible(
      COLD,
    );
    expect(await horizontalOverflow(page), "the register's overflow at 360px").toBeLessThanOrEqual(0);
  });

  test("the stock page's #ownership anchor lands under the docked tab bar", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`/shorts/${CODE}/company#ownership`);
    const section = page.locator("section#ownership");
    await expect(section).toBeAttached(COLD);
    // Give the browser's hash scroll and the bar's docking a frame to settle.
    await page.waitForTimeout(300);
    const bar = page.getByRole("navigation", { name: "Stock sections" });
    const barBox = await bar.boundingBox();
    const sectionBox = await section.boundingBox();
    expect(barBox, "the stock tab bar is drawn").not.toBeNull();
    expect(sectionBox, "the ownership section is drawn").not.toBeNull();
    // The hash must have moved the page: a page that stayed at the top would pass the next checks
    // without measuring the anchor at all.
    expect(await page.evaluate(() => window.scrollY), "the #ownership hash scrolled the page").toBeGreaterThan(0);
    // Docked, the bar sits under the site header (its h-16 row); the section must start below the bar's
    // bottom edge, not behind it.
    expect(barBox!.y, "the stock tab bar is docked under the site header").toBeLessThanOrEqual(66);
    expect(sectionBox!.y, "#ownership starts under the docked bar").toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  });
});

test.describe("ownership workspace", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the workspace nav reaches every page and marks the page it is on", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/ownership");
    const nav = workspaceNav(page);
    await expect(nav).toBeVisible(COLD);
    for (const { label, path } of WORKSPACE) {
      await nav.getByRole("link", { name: label, exact: true }).click();
      await expect(page, `${label} navigates to ${path}`).toHaveURL(new RegExp(`${path}$`), COLD);
      await expect(
        nav.getByRole("link", { name: label, exact: true }),
        `${label} is the current page`,
      ).toHaveAttribute("aria-current", "page");
    }
  });

  test("360px: no workspace page scrolls sideways", async ({ page }) => {
    await page.setViewportSize(PHONE_NARROW);
    for (const { path } of WORKSPACE) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible(COLD);
      expect(await horizontalOverflow(page), `${path}: overflow at 360px`).toBeLessThanOrEqual(0);
    }
  });

  test("a map cell's selection fills the inspector with that company", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/ownership/map");
    // An interactive cell is role="button"; the server-rendered fallback draws role="img" and takes no
    // clicks, so waiting for the button role waits for the island to hydrate and wire onCellClick.
    const cell = page.locator('g[data-code][role="button"]').first();
    await expect(cell).toBeAttached(COLD);
    const code = await cell.getAttribute("data-code");
    expect(code, "a map cell names its stock").toBeTruthy();

    await cell.click();

    // The selection lives in the URL as ?sel=stock:<code> (spec 14.1).
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sel"), { timeout: 10_000 })
      .toBe(`stock:${code}`);
    // The inspector is the right rail from lg; it names the selected company.
    const inspector = page.locator('aside[aria-label^="Selected"]').first();
    await expect(inspector, "the inspector names the selection").toBeVisible(COLD);
    await expect(inspector).toContainText(code!);
  });
});
