import { test, expect } from "@playwright/test";

test.describe("Sidebar Authentication Behavior", () => {
  test("should NOT show sidebar on public stock page when not logged in", async ({
    page,
  }) => {
    // Visit a public stock detail page without authentication
    await page.goto("/shorts/BHP");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Sidebar should NOT be visible for unauthenticated users
    const desktopSidebar = page.locator("aside");
    await expect(desktopSidebar).toHaveCount(0);

    // Mobile menu button should also NOT be visible
    const mobileMenuButton = page.locator(
      'button:has-text("Menu"), button:has(svg.lucide-menu)',
    );
    await expect(mobileMenuButton).toHaveCount(0);
  });

  test("should NOT show sidebar on home page when not logged in", async ({
    page,
  }) => {
    // Visit home page without authentication
    await page.goto("/");

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Sidebar should NOT be visible
    const desktopSidebar = page.locator("aside");
    await expect(desktopSidebar).toHaveCount(0);

    // Mobile menu button should also NOT be visible
    const mobileMenuButton = page.locator(
      'button:has-text("Menu"), button:has(svg.lucide-menu)',
    );
    await expect(mobileMenuButton).toHaveCount(0);
  });

  test("should redirect to signin when accessing protected routes", async ({
    page,
  }) => {
    // Try to access protected dashboard route
    await page.goto("/dashboards");

    // Should be redirected to signin page
    await expect(page).toHaveURL(/\/signin/);
  });

  test("should redirect to signin when accessing protected shorts list", async ({
    page,
  }) => {
    // Try to access protected shorts list route
    await page.goto("/shorts");

    // Should be redirected to signin page
    await expect(page).toHaveURL(/\/signin/);
  });

  // Note: To test authenticated sidebar visibility, we'd need to set up authentication
  // in the test, which requires the auth helper from e2e/helpers/auth.ts
  // and proper test user credentials
});
