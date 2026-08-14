import { expect, test } from "@playwright/test";

test.describe("heatmap hover interactions", () => {
  test("uses edge cached data and keeps the tooltip tracking the cursor", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const pagePosts: string[] = [];
    const edgeRequests: string[] = [];
    const directConnectPosts: string[] = [];

    await page.route("**/edge/v1/industry-treemap**", async (route) => {
      edgeRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "x-shorted-cache": "HIT",
          "x-shorted-edge": "cloudflare",
        },
        body: JSON.stringify({
          industries: ["Energy", "Materials"],
          stocks: [
            {
              industry: "Energy",
              productCode: "LOT",
              shortPosition: 19.4,
            },
            {
              industry: "Energy",
              productCode: "GMD",
              shortPosition: 14.2,
            },
            {
              industry: "Materials",
              productCode: "LYS",
              shortPosition: 9.8,
            },
          ],
        }),
      });
    });

    await page.route("**/edge/v1/stock/LOT/details", async (route) => {
      edgeRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "x-shorted-cache": "HIT",
          "x-shorted-edge": "cloudflare",
        },
        body: JSON.stringify({
          productCode: "LOT",
          companyName: "Lotus Resources",
          industry: "Energy",
          summary: "Uranium developer profile served from the edge cache.",
          website: "https://lotusresources.com.au",
        }),
      });
    });

    await page.route("**/edge/v1/stock/LOT/data**", async (route) => {
      edgeRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "x-shorted-cache": "HIT",
          "x-shorted-edge": "cloudflare",
        },
        body: JSON.stringify({
          productCode: "LOT",
          latestShortPosition: 19.4,
          points: [
            {
              timestamp: "2026-07-01T00:00:00Z",
              shortPosition: 18.9,
            },
            {
              timestamp: "2026-07-02T00:00:00Z",
              shortPosition: 19.4,
            },
          ],
        }),
      });
    });

    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        // Any shorts.v1alpha1 service — legacy ShortedStocksService AND the
        // per-domain services (MarketService etc.) the web migrated to.
        request.url().includes("/shorts.v1alpha1.")
      ) {
        directConnectPosts.push(request.url());
      }
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/embed/treemap"
      ) {
        pagePosts.push(request.url());
      }
    });

    await page.goto("/embed/treemap?period=3m");

    const treemap = page.getByTestId("treemap");
    await expect(treemap).toBeVisible({ timeout: 30_000 });
    expect(edgeRequests.some((url) => url.includes("/edge/v1/industry-treemap")))
      .toBe(true);

    const lotTile = page
      .locator('[role="link"][aria-label^="LOT "]')
      .first();
    await expect(lotTile).toBeVisible();

    await lotTile.hover({ position: { x: 20, y: 20 } });

    const tooltip = page.getByTestId("treemap-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Lotus Resources");

    const firstBox = await tooltip.boundingBox();
    const tileBox = await lotTile.boundingBox();
    expect(firstBox).not.toBeNull();
    expect(tileBox).not.toBeNull();

    await page.mouse.move(tileBox!.x + 60, tileBox!.y + 50, { steps: 4 });
    await expect
      .poll(async () => {
        const movedBox = await tooltip.boundingBox();
        if (!movedBox || !firstBox) return 0;
        return (
          Math.abs(movedBox.x - firstBox.x) +
          Math.abs(movedBox.y - firstBox.y)
        );
      })
      .toBeGreaterThan(10);

    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    await page.mouse.move(
      tooltipBox!.x + tooltipBox!.width / 2,
      tooltipBox!.y + tooltipBox!.height / 2,
      { steps: 5 },
    );
    await page.waitForTimeout(300);
    await expect(tooltip).toBeVisible();

    const sparkline = page.getByTestId("treemap-tooltip-sparkline");
    await expect(sparkline).toBeVisible();
    const sparklineBox = await sparkline.boundingBox();
    expect(sparklineBox).not.toBeNull();
    await page.mouse.move(
      sparklineBox!.x + sparklineBox!.width / 2,
      sparklineBox!.y + sparklineBox!.height / 2,
      { steps: 4 },
    );
    await expect(tooltip).toContainText(/\$1(?:8\.90|9\.40)/);

    expect(edgeRequests.some((url) => url.includes("/edge/v1/stock/LOT/details")))
      .toBe(true);
    expect(edgeRequests.some((url) => url.includes("/edge/v1/stock/LOT/data")))
      .toBe(true);
    expect(directConnectPosts).toEqual([]);
    expect(pagePosts).toEqual([]);
  });
});
