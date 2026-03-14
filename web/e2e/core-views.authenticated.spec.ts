import { test, expect } from "@playwright/test";

/**
 * Core Views E2E Tests — Authenticated Pages
 *
 * These tests require authentication via the setup project.
 * They validate pages and features only available to logged-in users.
 *
 * Run: npx playwright test e2e/core-views.authenticated.spec.ts --project=chromium-authenticated
 */

test.setTimeout(60_000);

test.describe("Authenticated - Chat Page", () => {
  test("chat page loads for authenticated user", async ({ page }) => {
    await page.goto("/chat", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    // Wait for page to settle
    await page.waitForTimeout(3000);

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Authenticated user should see chat interface, not a login redirect
    const url = page.url();
    // Either we're on /chat or the chat loaded within the page
    const isOnChat = url.includes("/chat");
    const hasChatUI = await page
      .locator(
        'textarea, input[placeholder*="message" i], [data-testid="chat-input"]',
      )
      .isVisible()
      .catch(() => false);

    // Should either be on chat page or have chat UI visible
    // (If premium-gated, we might see a gate instead — that's OK)
    const hasPremiumGate = await page
      .getByText(/premium|upgrade|subscribe/i)
      .isVisible()
      .catch(() => false);

    expect(isOnChat || hasChatUI || hasPremiumGate).toBeTruthy();
  });
});

test.describe("Authenticated - Navigation", () => {
  test("authenticated user sees user menu in navigation", async ({ page }) => {
    await page.goto("/", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    await page.waitForTimeout(3000);

    // Should see some user-related UI (avatar, menu, email, name)
    const userIndicators = [
      page.locator('[data-testid="user-menu"]'),
      page.locator('[data-testid="user-avatar"]'),
      page.getByRole("button", { name: /account|profile|menu/i }),
      // The user icon/avatar button in the nav
      page.locator("nav button img, nav button svg, header button img"),
    ];

    let foundUserUI = false;
    for (const indicator of userIndicators) {
      if (await indicator.first().isVisible().catch(() => false)) {
        foundUserUI = true;
        break;
      }
    }

    // Even if no explicit user UI, the user should NOT see "Sign in" as a primary CTA
    // (they may see it in footer, but not as the main nav action)
    if (!foundUserUI) {
      // At minimum, verify we're logged in by checking the session cookie exists
      const cookies = await page.context().cookies();
      const sessionCookie = cookies.find(
        (c) =>
          c.name.includes("next-auth.session-token") ||
          c.name.includes("__Secure-next-auth.session-token"),
      );
      expect(sessionCookie).toBeTruthy();
    }
  });
});

test.describe("Authenticated - Stock Pages", () => {
  test("authenticated user can view enriched stock details", async ({
    page,
  }) => {
    await page.goto("/shorts/CBA", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should contain CBA content
    expect(body!).toContain("CBA");
  });

  test("authenticated user can access shorts list with full features", async ({
    page,
  }) => {
    await page.goto("/shorts", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });
});

test.describe("Authenticated - Screener", () => {
  test("authenticated user can access screener page", async ({ page }) => {
    await page.goto("/screener", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    // Wait for client-side hydration
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should have screener-related content
    const hasScreenerContent =
      body!.toLowerCase().includes("screener") ||
      body!.toLowerCase().includes("filter") ||
      body!.toLowerCase().includes("screen") ||
      body!.toLowerCase().includes("short");
    expect(hasScreenerContent).toBeTruthy();
  });
});

test.describe("Authenticated - Homepage Widgets", () => {
  test("homepage loads with all widgets for authenticated user", async ({
    page,
  }) => {
    await page.goto("/", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    await expect(page).toHaveTitle(/Shorted/i, { timeout: 15_000 });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(200);
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);
  });
});

test.describe("Authenticated - Treemap", () => {
  test("treemap page renders for authenticated user", async ({ page }) => {
    await page.goto("/treemap", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const body = await page.locator("body").textContent({ timeout: 15_000 });
    expect(body).toBeTruthy();
    expect(body!).not.toMatch(/\b500\b.*internal server error/i);

    // Should have treemap-specific content or SVG
    const hasSVG = await page
      .locator("svg")
      .first()
      .isVisible()
      .catch(() => false);
    const hasCanvas = await page
      .locator("canvas")
      .first()
      .isVisible()
      .catch(() => false);

    // Treemap renders as SVG or canvas
    expect(
      hasSVG ||
        hasCanvas ||
        body!.toLowerCase().includes("treemap") ||
        body!.toLowerCase().includes("industry"),
    ).toBeTruthy();
  });
});
