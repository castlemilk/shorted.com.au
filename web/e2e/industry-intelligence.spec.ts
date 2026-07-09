import { expect, type Page, test } from "@playwright/test";

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

async function expectNoVisibleTextOverflow(page: Page) {
  const overflowIssues = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        [
          '[data-testid="industry-sidenav"] button',
          '[data-testid="industry-top-stocks-panel"] a',
          '[data-testid="industry-short-status-mix"]',
          '[role="tablist"] [role="tab"]',
          '[data-testid="industry-intelligence-story"] h1',
          '[data-testid="industry-intelligence-story"] h2',
          '[data-testid^="channel-"] h2',
          '[data-testid^="channel-"] p',
          "#methodology dt",
        ].join(","),
      ),
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();

        // Elements inside an intentional horizontal scroll container (e.g. the
        // narrative rail's chip row) legitimately extend past the viewport.
        let scrollAncestor = false;
        for (
          let node = element.parentElement;
          node && node !== document.body;
          node = node.parentElement
        ) {
          const overflowX = window.getComputedStyle(node).overflowX;
          if (overflowX === "auto" || overflowX === "scroll") {
            scrollAncestor = true;
            break;
          }
        }

        return {
          scrollAncestor,
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
        if (!issue.visible || issue.scrollAncestor) return false;

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
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);

    const body = await page.locator("body").innerText({ timeout: 15_000 });
    expect(body).not.toMatch(
      /Application error|Element type is invalid|Page Not Found|\b500\b/i,
    );

    const panel = page.getByRole("heading", {
      name: "Top Shorts In This Industry",
    });
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("industry-top-stocks-panel")).toHaveCount(1);
    await expect(page.getByTestId("industry-short-status-mix")).toBeVisible();
    await expect(page.getByTestId("industry-crowding-summary")).toHaveCount(0);
    await expect(
      page.getByText(
        /The next ASIC-backed industry sync will populate this page/i,
      ),
    ).toHaveCount(0);
    await expect(page.getByText(/source-ready/i)).toHaveCount(0);
    await expect(page.getByText("Premium evidence pack")).toHaveCount(0);

    // Workspace navigation: industry sidenav + section tabs. Both render only
    // what exists — tabs are the source of truth for live evidence channels.
    const sidenav = page.getByTestId("industry-sidenav");
    await expect(sidenav).toBeVisible();
    await expect(
      sidenav.locator('button[aria-pressed="true"]'),
    ).toHaveCount(1);

    const tablist = page.getByRole("tablist");
    await expect(tablist).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Sources" })).toBeVisible();

    // No-fake-data contract: a channel label may only appear when its imported
    // channel exists (e.g. Policy Footprint requires AEC/register data).
    const policyTab = page.getByRole("tab", { name: "Policy Footprint" });
    if ((await policyTab.count()) === 0) {
      await expect(page.getByText("Policy Footprint")).toHaveCount(0);
    }

    // When imported evidence exists the channel tab must open a cited, dated
    // dossier with the report-an-error path; export is premium-gated.
    const channelTabs = page.getByRole("tab", {
      name: /Tax Environment|Public Money|Emissions|Trade Exposure|Policy Footprint/,
    });
    if ((await channelTabs.count()) > 0) {
      await expect(
        page
          .getByTestId("evidence-export-upgrade")
          .or(page.getByTestId("evidence-export-button")),
      ).toBeVisible({ timeout: 15_000 });

      await channelTabs.first().click();
      const channel = page.locator('[data-testid^="channel-"]').first();
      await expect(channel).toBeVisible({ timeout: 15_000 });
      await expect(channel.getByText(/as at \d{4}-\d{2}-\d{2}/)).toBeVisible();
      await expect(
        channel.getByRole("link", { name: /Report an error/i }),
      ).toBeVisible();

      await page.getByRole("tab", { name: "Sources" }).click();
      await expect(
        page.getByRole("heading", { name: "Where these figures come from" }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "Overview" }).click();
    }
    await expect(
      page.getByRole("link", { name: "View all top shorts" }),
    ).toHaveAttribute("href", "/top");
    await expect(
      page.getByRole("link", { name: "Find a stock" }),
    ).toHaveAttribute("href", "/stocks");
    await expect(
      page.getByRole("link", { name: "Open industry view" }),
    ).toHaveAttribute("href", /\/industry\/[a-z0-9-]+/);

    const stockLink = page.locator('a[href^="/shorts/"]').first();
    await expect(stockLink).toBeVisible();

    const selectorButtons = page.locator("button[aria-pressed]");
    if ((await selectorButtons.count()) > 1) {
      await selectorButtons.nth(1).click();
      await expect(selectorButtons.nth(1)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
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
    expect(body).not.toMatch(
      /Application error|Element type is invalid|Page Not Found|\b500\b/i,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  });

  test("stays functional under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    const response = await page.goto("/industry-intelligence", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { name: "Industry Intelligence" }),
    ).toBeVisible();

    // Tab navigation must still work without animation.
    await page.getByRole("tab", { name: "Sources" }).click();
    await expect(
      page.getByRole("heading", { name: "Where these figures come from" }),
    ).toBeVisible();
  });

  test("keeps explorer text contained at compressed desktop widths", async ({
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
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
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
    await expect(
      page.getByText("Industry crowding", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Ranked companies", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Alert monitors", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Industry Intelligence" }),
    ).toHaveAttribute("href", "/industry-intelligence");
    await expect(
      page.getByRole("link", { name: "Compare top shorts" }),
    ).toHaveAttribute("href", "/top");
    await expect(
      page.getByRole("link", { name: "View Top Shorts" }),
    ).toHaveAttribute("href", "/top");
  });

  test("links industry alerts into the monitor builder", async ({ page }) => {
    const response = await page.goto(
      "/industry-intelligence?industry=materials",
      {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      },
    );

    expect(response?.status()).toBeLessThan(400);
    const alertLink = page
      .getByRole("link", { name: "Create daily alert" })
      .first();
    await expect(alertLink).toHaveAttribute(
      "href",
      /\/alerts\?industry=[a-z0-9-]+/,
    );

    const alertHref = await alertLink.getAttribute("href");
    expect(alertHref).toBeTruthy();
    const selectedIndustry = new URL(
      alertHref!,
      "https://shorted.test",
    ).searchParams.get("industry");
    expect(selectedIndustry).toBeTruthy();

    const alertsResponse = await page.goto(alertHref!, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    expect(alertsResponse?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { name: "Short-interest monitors" }),
    ).toBeVisible();
    await expect(
      page.getByText(`${titleFromSlug(selectedIndustry!)} daily movement`),
    ).toBeVisible();
    await expect(page.getByText("Configure a monitor")).toBeVisible();
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  });
});
