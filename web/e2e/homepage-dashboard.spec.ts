import { test, expect } from "@playwright/test";

test.describe("Homepage Dashboard View", () => {
  test("should show dashboard view without login", async ({ page }) => {
    await page.goto("/");
    
    // Check that the main dashboard components are visible
    await expect(page.locator('text="Top Shorts"')).toBeVisible();
    await expect(page.locator('text="BOE"').or(page.locator('text="Loading top shorts"'))).toBeVisible();
    
    // Check that there's no blocking overlay
    const overlay = page.locator('.absolute.inset-0.bg-white\\/80');
    await expect(overlay).not.toBeVisible();
    
    // Check for subtle login prompt banner
    const loginBanner = page.locator('text="Unlock advanced features"');
    await expect(loginBanner).toBeVisible();
    
    // Check that Sign in button is in the header
    const headerSignIn = page.locator('header').locator('button:has-text("Sign in")');
    await expect(headerSignIn).toBeVisible();
  });

  test("should allow closing the login prompt banner", async ({ page }) => {
    await page.goto("/");
    
    // Find and click the close button on the banner
    const closeButton = page.locator('button:has(svg.lucide-x)').first();
    await closeButton.click();
    
    // Banner should disappear
    const loginBanner = page.locator('text="Unlock advanced features"');
    await expect(loginBanner).not.toBeVisible();
  });

  test("should not show dashboard link for non-authenticated users", async ({ page }) => {
    await page.goto("/");
    
    // Check that dashboard link is not in navigation
    const dashboardLink = page.locator('nav a[href="/dashboards"]');
    await expect(dashboardLink).not.toBeVisible();
    
    // But about and blog links should be visible
    await expect(page.locator('nav a[href="/about"]')).toBeVisible();
    await expect(page.locator('nav a[href="/blog"]')).toBeVisible();
  });
});