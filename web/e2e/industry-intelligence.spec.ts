import { expect, type Page, test } from "@playwright/test";

async function expectNoVisibleTextOverflow(page: Page) {
  const overflowIssues = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        [
          'nav[aria-label="Industry intelligence story sections"] a',
          "#industry-explorer button",
          '[data-testid="industry-top-stocks-panel"] a',
          '[data-testid="industry-crowding-chart"] a',
          "#industry-explorer h2",
          "#industry-explorer p",
          "#industry-explorer span",
        ].join(","),
      ),
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();

        return {
          tag: element.tagName.toLowerCase(),
          text: text.slice(0, 80),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: style.overflowX,
          right: Math.round(rect.right),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            text.length > 0,
        };
      })
      .filter((issue) => {
        if (!issue.visible) return false;

        const outsideViewport =
          issue.left < -1 || issue.right > window.innerWidth + 1;
        const visibleScrollOverflow =
          issue.scrollWidth > issue.clientWidth + 1 &&
          issue.overflowX === "visible";

        return outsideViewport || visibleScrollOverflow;
      }),
  );

  expect(overflowIssues).toEqual([]);
}

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
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);

    const body = await page.locator("body").innerText({ timeout: 15_000 });
    expect(body).not.toMatch(/Application error|Element type is invalid|Page Not Found|\b500\b/i);

    const panel = page.getByRole("heading", {
      name: "Top Stocks In This Industry",
    });
    await expect(panel).toBeVisible();
    await expect(
      page.getByText(/The next ASIC-backed industry sync will populate this page/i),
    ).toHaveCount(0);
    await expect(page.getByText(/source-ready/i)).toHaveCount(0);
    await expect(page.getByText("Policy Footprint")).toHaveCount(0);
    await expect(page.getByText("Premium evidence pack")).toHaveCount(0);
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

  test("keeps story rail and explorer text contained at compressed desktop widths", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 720 });

    const response = await page.goto("/industry-intelligence", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { name: "Industry Intelligence" }),
    ).toBeVisible();
    await expect(
      page.locator('nav[aria-label="Industry intelligence story sections"] li'),
    ).toHaveCount(4);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await expectNoVisibleTextOverflow(page);
  });

  test("is promoted from the about landing page", async ({ page }) => {
    const response = await page.goto("/about", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", {
        name: "Industry Intelligence connects sectors to stocks",
      }),
    ).toBeVisible();
    await expect(page.getByText("Industry crowding")).toBeVisible();
    await expect(page.getByText("Ranked companies")).toBeVisible();
    await expect(page.getByText("Alert monitors")).toBeVisible();
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
