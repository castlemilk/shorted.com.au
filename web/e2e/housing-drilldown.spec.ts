import { test, expect } from "@playwright/test";

// Housing national → state → suburb drilldown.
// NOTE: the state/suburb assertions need the shorts backend serving
// ListStateSuburbs/GetSuburbProfile against a DB with suburb_demographics +
// SA price data (Census DataPack + Valuer-General). The national-map + zoom
// checks only need states.topojson + GetHousingOverview.

// dynamic(ssr:false) maps + client TopoJSON fetch are slow on the first
// dev-mode compile; allow generous timeouts (a production build is fast).
const MAP_TIMEOUT = 30_000;

test("national map renders real states coloured by price", async ({ page }) => {
  await page.goto("/housing");
  const svg = page.locator('svg[aria-label*="Australian states"]');
  await expect(svg).toBeVisible({ timeout: MAP_TIMEOUT });
  // 8 state polygons, all painted (not the no-data hatch) given price data.
  await expect(svg.locator("path")).toHaveCount(8, { timeout: MAP_TIMEOUT });
  const colored = await svg.locator('path[fill^="rgb"]').count();
  expect(colored).toBeGreaterThanOrEqual(1);
});

test("national map supports wheel zoom", async ({ page }) => {
  await page.goto("/housing");
  const svg = page.locator('svg[aria-label*="Australian states"]');
  await svg.waitFor({ timeout: MAP_TIMEOUT });
  // d3-zoom listens for a real wheel event on the svg; Playwright's synthetic
  // mouse.wheel doesn't reach it, so dispatch one directly.
  await svg.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -300,
    }));
  });
  await page.waitForTimeout(400);
  const transform = await svg.locator("g").first().getAttribute("transform");
  expect(transform ?? "").toMatch(/scale\(/);
});

test("state page drills into a suburb profile with breadcrumb", async ({ page }) => {
  await page.goto("/housing/sa");
  await expect(page.getByRole("heading", { name: /South Australia suburbs/i })).toBeVisible();
  // breadcrumb present (Australia › State switcher)
  await expect(page.locator('nav[aria-label="Breadcrumb"]')).toContainText("Australia");

  // suburb choropleth renders real polygons
  const map = page.locator('svg[aria-label*="suburbs"]');
  await expect(map).toBeVisible({ timeout: MAP_TIMEOUT });
  expect(await map.locator("path").count()).toBeGreaterThan(100);

  // drill into the first priced suburb in the list (shows a "$" value)
  const pricedItem = page.locator("button", { hasText: "$" }).first();
  await pricedItem.click();
  await expect(page).toHaveURL(/\/housing\/sa\/.+[?&]sal=/);
  await expect(page.getByText(/Population/i)).toBeVisible({ timeout: MAP_TIMEOUT });
  await expect(page.locator('nav[aria-label="Breadcrumb"]')).toContainText("South Australia");
});
