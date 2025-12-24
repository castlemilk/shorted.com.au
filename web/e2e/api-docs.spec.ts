import { test, expect } from '@playwright/test';

test.describe('API Documentation', () => {
  test('should load the main API docs page', async ({ page }) => {
    await page.goto('/docs/api');
    await expect(page.locator('h1')).toContainText('Shorted API');
    await expect(page.locator('text=Quick Start')).toBeVisible();
    await expect(page.locator('text=Authentication')).toBeVisible();
  });

  test('should navigate to an endpoint page', async ({ page }) => {
    await page.goto('/docs/api');
    
    // Check if we are on mobile (sidebar hidden)
    const sidebar = page.locator('aside').filter({ visible: true });
    if (await sidebar.count() === 0) {
      // Open mobile menu
      const menuTrigger = page.locator('button:has([class*="Menu"]), button:has-text("Menu")').filter({ visible: true }).first();
      if (await menuTrigger.isVisible()) {
        await menuTrigger.click();
      }
    }

    // Using a more robust selector that handles the "POST" prefix and visibility
    const link = page.locator('role=link[name*="RegisterEmail"]').filter({ visible: true }).first();
    await expect(link).toBeVisible();
    await link.click();
    
    await expect(page).toHaveURL(/\/docs\/api\/post--register.v1.registerservice-registeremail/);
    await expect(page.locator('h1')).toContainText('RegisterEmail');
    await expect(page.locator('text=POST').filter({ visible: true }).first()).toBeVisible();
  });

  test('should show code samples', async ({ page }) => {
    await page.goto('/docs/api/post--register.v1.registerservice-registeremail');
    // Expect at least one visible instance of the tabs
    await expect(page.locator('text=cURL').filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator('text=JavaScript').filter({ visible: true }).first()).toBeVisible();
    // Verify syntax highlighting is applied
    await expect(page.locator('pre[class*="language-"]').filter({ visible: true }).first()).toBeVisible();
  });

  test('should show the Try It panel', async ({ page }) => {
    await page.goto('/docs/api/post--register.v1.registerservice-registeremail');
    const tryItTab = page.locator('button:has-text("Try It")').filter({ visible: true }).first();
    await tryItTab.click();
    await expect(page.locator('text=Test Request').filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator('button:has-text("Send")').filter({ visible: true }).first()).toBeVisible();
  });

  test('should search for endpoints via Cmd+K', async ({ page }) => {
    await page.goto('/docs/api');
    
    // Dismiss any potential banners that might block the search button
    const dismissBanner = page.locator('button[name*="Dismiss"]').filter({ visible: true });
    if (await dismissBanner.count() > 0) {
      await dismissBanner.first().click();
    }

    const searchButton = page.locator('button:has-text("Search docs...")').filter({ visible: true }).first();
    await searchButton.click({ force: true });
    
    const searchInput = page.locator('input[placeholder="Search API documentation..."]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Stock');
    
    // Target the result specifically within the dialog to avoid sidebar matches
    const result = page.locator('button:has-text("GetStock")').filter({ visible: true }).first();
    await expect(result).toBeVisible();
    await result.click();
    
    await expect(page).toHaveURL(/\/docs\/api\/post--shorts.v1alpha1.shortedstocksservice-getstock/);
  });
});

