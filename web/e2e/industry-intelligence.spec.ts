import { expect, test } from "@playwright/test";

test.describe("Industry Intelligence", () => {
  test("renders the story route and validates the linked panel when data is available", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    const response = await page.goto("/industry-intelligence", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { name: "Industry Intelligence" }),
    ).toBeVisible();

    const body = await page.locator("body").innerText({ timeout: 15_000 });
    expect(body).not.toMatch(/Application error|Element type is invalid|Page Not Found|\b500\b/i);

    const panel = page.getByRole("heading", {
      name: "Top Stocks In This Industry",
    });
    const hasLivePanel = (await panel.count()) > 0;

    if (!hasLivePanel) {
      await expect(
        page.getByText(/The next ASIC-backed industry sync will populate this page/i),
      ).toBeVisible();
      return;
    }

    await expect(panel).toBeVisible();
    await expect(page.getByRole("link", { name: "View all top shorts" })).toHaveAttribute(
      "href",
      "/top",
    );
    await expect(page.getByRole("link", { name: "Find a stock" })).toHaveAttribute(
      "href",
      "/stocks",
    );
    await expect(page.getByRole("link", { name: "Open industry view" })).toHaveAttribute(
      "href",
      /\/industry\/[a-z0-9-]+/,
    );

    const stockLink = page.locator('a[href^="/shorts/"]').first();
    await expect(stockLink).toBeVisible();

    const selectorButtons = page.locator('button[aria-pressed]');
    if ((await selectorButtons.count()) > 1) {
      await selectorButtons.nth(1).click();
      await expect(selectorButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
    }

    expect(consoleErrors).toEqual([]);
  });

  test("keeps the mobile story layout usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/industry-intelligence", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await expect(
      page.getByRole("heading", { name: "Industry Intelligence" }),
    ).toBeVisible();

    const body = await page.locator("body").innerText({ timeout: 15_000 });
    expect(body).not.toMatch(/Application error|Element type is invalid|Page Not Found|\b500\b/i);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  });

  test("is promoted from the about landing page", async ({ page }) => {
    const response = await page.goto("/about", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", {
        name: "Industry Intelligence turns sectors into evidence stories",
      }),
    ).toBeVisible();
    await expect(page.getByText("Policy Footprint")).toBeVisible();
    await expect(page.getByText("Public Money")).toBeVisible();
    await expect(page.getByText("Trade Exposure")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Industry Intelligence" })).toHaveAttribute(
      "href",
      "/industry-intelligence",
    );
    await expect(page.getByRole("link", { name: "Compare top shorts" })).toHaveAttribute(
      "href",
      "/top",
    );
    await expect(page.getByRole("link", { name: "View Top Shorts" })).toHaveAttribute(
      "href",
      "/top",
    );
  });
});
