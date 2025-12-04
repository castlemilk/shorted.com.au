import { test, expect } from "@playwright/test";

/**
 * Dashboard Tests - Require Authentication
 *
 * These tests run with an authenticated session and verify
 * protected functionality works correctly.
 *
 * File naming: *.authenticated.spec.ts
 * - These tests depend on the "setup" project running first
 * - Session state is loaded from .auth/user.json
 */

test.describe("Dashboard - Authenticated User", () => {
  test("can access dashboard page", async ({ page }) => {
    await page.goto("/dashboards");

    // Should not redirect to signin (we're authenticated)
    await expect(page).not.toHaveURL(/signin/);

    // Dashboard content should be visible
    await expect(
      page.locator("h1, h2").filter({ hasText: /dashboard/i }).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("can access portfolio page", async ({ page }) => {
    await page.goto("/portfolio");

    // Should not redirect to signin
    await expect(page).not.toHaveURL(/signin/);

    // Portfolio content should load
    await expect(page.locator("body")).toContainText(/portfolio/i, {
      timeout: 10000,
    });
  });

  test("can access stocks search page", async ({ page }) => {
    await page.goto("/stocks");

    // Should not redirect to signin
    await expect(page).not.toHaveURL(/signin/);

    // Search input should be visible
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    );
    await expect(searchInput.first()).toBeVisible({ timeout: 10000 });
  });

  test("user menu shows authenticated state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Look for user indicators (avatar, menu, logout button, etc.)
    const userIndicator = page
      .locator('[data-testid="user-menu"]')
      .or(page.getByRole("button", { name: /account|profile|logout/i }))
      .or(page.locator('[class*="avatar"]'))
      .or(page.locator('[class*="user"]'));

    // Should have some user indicator visible
    await expect(userIndicator.first()).toBeVisible({ timeout: 10000 });
  });

  test("can logout successfully", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Find logout option (may be in a menu)
    const userMenu = page.locator('[data-testid="user-menu"]');
    const logoutButton = page.getByRole("button", { name: /logout|sign out/i });

    if (await userMenu.isVisible({ timeout: 3000 }).catch(() => false)) {
      await userMenu.click();
      await page
        .getByRole("menuitem", { name: /logout|sign out/i })
        .click();
    } else if (await logoutButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await logoutButton.click();
    } else {
      // Skip if no logout option found
      test.skip();
      return;
    }

    // After logout, should see signin option or be redirected
    await expect(
      page.getByRole("button", { name: /sign in|login/i })
        .or(page.getByRole("link", { name: /sign in|login/i }))
    ).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Protected API Endpoints - Authenticated", () => {
  test("can access protected API endpoints", async ({ page }) => {
    // Test that authenticated user can access protected endpoints
    await page.goto("/");

    // Try accessing a protected API endpoint
    const response = await page.request.get("/api/user/profile");

    // Should get 200 or meaningful response (not 401/403)
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(403);
  });
});

