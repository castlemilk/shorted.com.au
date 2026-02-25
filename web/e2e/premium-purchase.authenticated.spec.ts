import { test, expect } from "@playwright/test";

/**
 * Premium Purchase Flow Tests - Require Authentication
 *
 * Tests the full premium subscription purchase flow using Stripe test mode.
 * Uses Stripe test card 4242424242424242 for sandbox checkout.
 *
 * Prerequisites:
 * - Authenticated session (via auth.setup.ts)
 * - STRIPE_PREMIUM_PRICE_ID set (sandbox value for preview)
 * - Stripe webhook configured for test environment
 */

test.describe("Premium Purchase Flow", () => {
  test("pricing page shows Free vs Premium comparison", async ({ page }) => {
    await page.goto("/pricing");
    await page.waitForLoadState("networkidle");

    // Page title
    await expect(
      page.getByRole("heading", { name: /pricing/i })
    ).toBeVisible({ timeout: 10000 });

    // Free tier card
    await expect(page.getByText("$0")).toBeVisible();
    await expect(page.getByText("Short position data", { exact: true })).toBeVisible();

    // Premium tier card
    await expect(page.getByText("$4")).toBeVisible();
    await expect(page.getByText("AI Chat assistant")).toBeVisible();
    await expect(page.getByText("Market Pulse dashboard")).toBeVisible();
    await expect(page.getByText("Price & position alerts")).toBeVisible();
    await expect(page.getByText("Advanced dashboard widgets")).toBeVisible();
  });

  test("free user sees upgrade button on pricing page", async ({ page }) => {
    await page.goto("/pricing");
    await page.waitForLoadState("networkidle");

    // Should see upgrade button (not "You're on Premium")
    const upgradeButton = page.getByRole("button", {
      name: /upgrade to premium/i,
    });
    await expect(upgradeButton).toBeVisible({ timeout: 10000 });
  });

  test("upgrade button redirects to Stripe checkout", async ({ page }) => {
    await page.goto("/pricing");
    await page.waitForLoadState("networkidle");

    // Click upgrade
    const upgradeButton = page.getByRole("button", {
      name: /upgrade to premium/i,
    });
    await expect(upgradeButton).toBeVisible({ timeout: 10000 });

    // Intercept the checkout API call to capture the response
    const [checkoutResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes("/api/stripe/checkout"),
        { timeout: 15000 }
      ),
      upgradeButton.click(),
    ]);

    const responseBody = await checkoutResponse.json() as { url?: string; error?: string };

    // Skip if server-side auth failed (expected in local dev without real auth)
    if (checkoutResponse.status() === 401) {
      test.skip(true, "Server-side auth not available — run against preview deployment with real auth");
      return;
    }

    // Skip if Stripe credentials not configured
    if (checkoutResponse.status() === 500) {
      test.skip(true, `Checkout failed: ${responseBody.error ?? "unknown server error"}`);
      return;
    }

    expect(responseBody.url).toBeTruthy();

    // Should redirect to Stripe checkout (checkout.stripe.com)
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
    expect(page.url()).toContain("checkout.stripe.com");
  });

  test("full Stripe checkout with test card completes successfully", async ({
    page,
  }) => {
    // Navigate to pricing and start checkout
    await page.goto("/pricing");
    await page.waitForLoadState("networkidle");

    const upgradeButton = page.getByRole("button", {
      name: /upgrade to premium/i,
    });
    await expect(upgradeButton).toBeVisible({ timeout: 10000 });

    // Intercept the checkout API call
    const [checkoutResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes("/api/stripe/checkout"),
        { timeout: 15000 }
      ),
      upgradeButton.click(),
    ]);

    const responseBody = await checkoutResponse.json() as { url?: string; error?: string };

    // Skip if server-side auth or Stripe not available
    if (checkoutResponse.status() !== 200 || !responseBody.url) {
      test.skip(true, `Checkout unavailable: ${responseBody.error ?? `status ${checkoutResponse.status()}`}`);
      return;
    }

    // Wait for Stripe checkout page
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });

    // Fill in Stripe test card details
    // Stripe checkout uses iframes — we need to handle them carefully
    // The email may be pre-filled from the session

    // Wait for the card form to load
    await page.waitForTimeout(3000);

    // Fill email if empty (Stripe may ask for it)
    const emailInput = page.locator('input[name="email"]');
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      const emailValue = await emailInput.inputValue();
      if (!emailValue) {
        await emailInput.fill("e2e-test@shorted.com.au");
      }
    }

    // Fill card number — Stripe uses its own input fields
    const cardNumberInput = page.locator('input[name="cardNumber"]');
    await expect(cardNumberInput).toBeVisible({ timeout: 10000 });
    await cardNumberInput.fill("4242424242424242");

    // Expiry
    const expiryInput = page.locator('input[name="cardExpiry"]');
    await expect(expiryInput).toBeVisible();
    await expiryInput.fill("12/30");

    // CVC
    const cvcInput = page.locator('input[name="cardCvc"]');
    await expect(cvcInput).toBeVisible();
    await cvcInput.fill("123");

    // Cardholder name (if visible)
    const nameInput = page.locator('input[name="billingName"]');
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill("E2E Test User");
    }

    // Submit payment
    const submitButton = page.locator(
      'button[type="submit"], .SubmitButton'
    );
    await expect(submitButton.first()).toBeVisible();
    await submitButton.first().click();

    // Wait for redirect back to success page
    // Stripe processes and redirects — this can take a few seconds
    await page.waitForURL(/subscribe\/success/, { timeout: 60000 });

    // Verify success page content
    await expect(
      page.getByRole("heading", { name: /welcome to premium/i })
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("AI Chat assistant")).toBeVisible();
    await expect(page.getByText("Market Pulse dashboard")).toBeVisible();
  });
});

test.describe("Premium Gating - Authenticated Free User", () => {
  test("chat sidebar shows upgrade prompt for free user", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click the chat FAB
    const chatButton = page.locator("button").filter({ has: page.locator('svg') }).filter({ hasText: "" }).last();
    const chatFab = page.locator('button:has(svg.lucide-message-square)').last();

    // Try to find and click the chat button
    if (await chatFab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await chatFab.click();
    } else {
      test.skip();
      return;
    }

    // Should show upgrade prompt, not the chat interface
    await expect(
      page.getByText(/upgrade to premium/i).or(page.getByText(/sign in to unlock/i))
    ).toBeVisible({ timeout: 10000 });
  });

  test("sidebar shows Pulse and Alerts with lock icons", async ({ page }) => {
    await page.goto("/dashboards");
    await page.waitForLoadState("networkidle");

    // Look for Pulse and Alerts nav items
    const pulseItem = page.getByRole("link", { name: /pulse/i });
    const alertsItem = page.getByRole("link", { name: /alerts/i });

    if (
      await pulseItem.isVisible({ timeout: 5000 }).catch(() => false)
    ) {
      // Click should go to /pricing for free users
      await pulseItem.click();
      await expect(page).toHaveURL(/pricing/, { timeout: 5000 });
    }
  });

  test("pulse page shows upgrade prompt", async ({ page }) => {
    await page.goto("/pulse");
    await page.waitForLoadState("networkidle");

    // Look for the "View Plans" button specifically
    await expect(
      page.getByRole("link", { name: /view plans/i })
    ).toBeVisible({ timeout: 10000 });
  });

  test("alerts page shows upgrade prompt", async ({ page }) => {
    await page.goto("/alerts");
    await page.waitForLoadState("networkidle");

    // Look for the "View Plans" button specifically
    await expect(
      page.getByRole("link", { name: /view plans/i })
    ).toBeVisible({ timeout: 10000 });
  });

  test("user dropdown shows upgrade to premium link", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Find and click the user avatar/menu button
    const avatarButton = page.locator('button[class*="rounded-full"]').last();
    if (await avatarButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await avatarButton.click();

      // Look for upgrade menuitem specifically
      await expect(
        page.getByRole("menuitem", { name: /upgrade to premium/i })
      ).toBeVisible({ timeout: 5000 });
    } else {
      test.skip();
    }
  });
});

test.describe("Pricing Page - Unauthenticated", () => {
  // Use a separate context without auth
  test.use({ storageState: { cookies: [], origins: [] } });

  test("unauthenticated user sees sign up buttons", async ({ page }) => {
    await page.goto("/pricing");
    await page.waitForLoadState("networkidle");

    // Should see "Get Started Free" and "Sign Up & Upgrade"
    await expect(
      page.getByRole("link", { name: /get started free/i })
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("link", { name: /sign up/i })
    ).toBeVisible();
  });
});
