import { test, expect } from "@playwright/test";

/**
 * Core Views E2E Tests — Public Pages
 *
 * Validates that all major public pages load correctly, render key content,
 * and don't return 500 errors. These run without authentication.
 *
 * Run: npx playwright test e2e/core-views.spec.ts --project=chromium
 */

test.setTimeout(60_000);

test.describe("Homepage", () => {
  test("renders with title and top shorts content", async ({ page }) => {
    await page.goto("/", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    await expect(page).toHaveTitle(/Shorted/i, { timeout: 15_000 });

    // Should have content (not a blank page)
    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(200);

    // Should not be a 500 error page
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });

  test("shows navigation elements", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");

    // Nav should have key links
    const nav = page.locator("nav, header");
    await expect(nav.first()).toBeVisible({ timeout: 15_000 });

    // Should have links to major sections
    const hasTopShorted = await page
      .getByRole("link", { name: /top shorted|shorts/i })
      .first()
      .isVisible()
      .catch(() => false);
    const hasScreener = await page
      .getByRole("link", { name: /screener/i })
      .first()
      .isVisible()
      .catch(() => false);

    expect(hasTopShorted || hasScreener).toBeTruthy();
  });

  test("has proper meta tags for SEO", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Check meta description
    const metaDesc = page.locator('meta[name="description"]');
    await expect(metaDesc).toHaveAttribute("content", /.+/);

    // Check OG tags
    const ogTitle = page.locator('meta[property="og:title"]');
    await expect(ogTitle).toHaveAttribute("content", /Shorted/i);

    // Check canonical
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", /.+/);
  });
});

test.describe("Shorts List Page", () => {
  test("loads without 500 error and shows short position content", async ({
    page,
  }) => {
    await page.goto("/shorts", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();

    // Must not be a 500 error page
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should contain short-position related content
    const hasRelevantContent =
      body!.toLowerCase().includes("short") ||
      body!.toLowerCase().includes("position") ||
      body!.toLowerCase().includes("stock");
    expect(hasRelevantContent).toBeTruthy();
  });
});

test.describe("Stock Detail Page", () => {
  test("loads BHP stock page with company info", async ({ page }) => {
    await page.goto("/shorts/BHP", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should contain BHP or related content
    expect(body!).toContain("BHP");
  });

  test("loads CBA stock page", async ({ page }) => {
    await page.goto("/shorts/CBA", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });

  test("financial report links open in new tab with valid href", async ({
    page,
  }) => {
    // GOR has financial reports in the local DB
    await page.goto("/shorts/GOR", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    // Wait for enriched content to load
    await page.waitForTimeout(3000);

    // Find financial report links (the ExternalLink icons or title links)
    const reportLinks = page.locator(
      'a[target="_blank"][rel="noopener noreferrer"]',
    );

    const count = await reportLinks.count();
    if (count > 0) {
      // Every external link must have a non-empty, valid href — no "" or "javascript:" allowed
      for (let i = 0; i < Math.min(count, 10); i++) {
        const href = await reportLinks.nth(i).getAttribute("href");
        expect(href, `Link ${i} has empty or missing href`).toBeTruthy();
        expect(href, `Link ${i} href "${href}" is not a valid URL`).toMatch(
          /^https?:\/\//,
        );
      }

      // Verify link elements are actual <a> tags (not Button wrappers)
      const tagName = await reportLinks.first().evaluate((el) => el.tagName);
      expect(tagName).toBe("A");
    }
  });

  test("handles non-existent stock code gracefully", async ({ page }) => {
    await page.goto("/shorts/ZZZXXX", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    // Should show 404 or "not found" - NOT a 500 crash
    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/500.*internal server/i);
  });
});

test.describe("Treemap Page", () => {
  test("loads treemap visualization", async ({ page }) => {
    await page.goto("/treemap", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    expect(page.url()).toContain("treemap");

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });
});

test.describe("Screener Page", () => {
  test("loads screener with filter controls", async ({ page }) => {
    await page.goto("/screener", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should have screener-related content
    const hasScreenerContent =
      body!.toLowerCase().includes("screener") ||
      body!.toLowerCase().includes("filter") ||
      body!.toLowerCase().includes("screen");
    expect(hasScreenerContent).toBeTruthy();
  });
});

test.describe("Blog", () => {
  test("blog index page loads", async ({ page }) => {
    await page.goto("/blog", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });

  test("blog post page loads (hello-world)", async ({ page }) => {
    await page.goto("/blog/hello-world", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });
});

test.describe("FAQ Page", () => {
  test("FAQ page loads with questions", async ({ page }) => {
    await page.goto("/faq", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should have FAQ content
    const hasFAQContent =
      body!.toLowerCase().includes("faq") ||
      body!.toLowerCase().includes("frequently") ||
      body!.toLowerCase().includes("question");
    expect(hasFAQContent).toBeTruthy();
  });
});

test.describe("Pricing Page", () => {
  test("pricing page loads with plan information", async ({ page }) => {
    await page.goto("/pricing", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should have pricing-related content
    const hasPricingContent =
      body!.toLowerCase().includes("pricing") ||
      body!.toLowerCase().includes("plan") ||
      body!.toLowerCase().includes("free") ||
      body!.toLowerCase().includes("pro") ||
      body!.toLowerCase().includes("premium");
    expect(hasPricingContent).toBeTruthy();
  });
});

test.describe("Static Pages", () => {
  test("terms page loads", async ({ page }) => {
    await page.goto("/terms", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });

  test("roadmap page loads", async ({ page }) => {
    await page.goto("/roadmap", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });

  test("learn page loads", async ({ page }) => {
    await page.goto("/learn", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });
});

test.describe("API Endpoints", () => {
  test("health endpoint responds", async ({ page }) => {
    const response = await page.request.get("/api/health", {
      timeout: 10_000,
    });
    expect(response.status()).toBeLessThan(500);
  });

  test("search API returns valid response", async ({ page }) => {
    const response = await page.request.get(
      "/api/stocks/search?q=BHP&limit=3",
      { timeout: 15_000 },
    );

    expect(response.status()).toBeLessThan(500);

    if (response.ok()) {
      const data = await response.json();
      expect(data).toHaveProperty("stocks");
    }
  });
});

test.describe("SEO & Accessibility", () => {
  test("robots.txt is accessible", async ({ page }) => {
    const response = await page.request.get("/robots.txt", {
      timeout: 10_000,
    });
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("User-agent");
  });

  test("sitemap.xml is accessible", async ({ page }) => {
    const response = await page.request.get("/sitemap.xml", {
      timeout: 15_000,
    });
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("<urlset");
  });

  test("llms.txt is accessible", async ({ page }) => {
    const response = await page.request.get("/llms.txt", {
      timeout: 10_000,
    });
    // Should exist (200) or gracefully not found (404), not crash (500)
    expect(response.status()).toBeLessThan(500);
  });
});
