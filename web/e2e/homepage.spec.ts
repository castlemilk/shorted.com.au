import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load homepage successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/Shorted/);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('should display navigation menu', async ({ page }) => {
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByRole('link', { name: /home/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /treemap/i })).toBeVisible();
  });

  test('should show top shorted stocks table', async ({ page }) => {
    await expect(page.locator('[data-testid="stocks-table"]')).toBeVisible();
    
    // Wait for data to load
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });
    
    // Check table headers
    await expect(page.getByRole('columnheader', { name: /product code/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /name/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /short position/i })).toBeVisible();
  });

  test('should allow filtering stocks by period', async ({ page }) => {
    // Wait for page to load
    await expect(page.locator('[data-testid="stocks-table"]')).toBeVisible();
    
    // Find and click period selector
    const periodSelector = page.locator('select').or(page.locator('[role="combobox"]')).first();
    if (await periodSelector.isVisible()) {
      await periodSelector.click();
      
      // Select different period
      const oneWeekOption = page.getByRole('option', { name: /1 week/i }).or(page.getByText('1W'));
      if (await oneWeekOption.isVisible()) {
        await oneWeekOption.click();
        
        // Verify table updates
        await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });
      }
    }
  });

  test('should navigate to stock detail page when clicking stock row', async ({ page }) => {
    // Wait for table to load
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });
    
    // Click first stock row
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();
    
    // Should navigate to stock detail page
    await expect(page).toHaveURL(/\/stock\/[A-Z]+/);
    await expect(page.locator('h1')).toContainText(/stock/i);
  });

  test('should handle loading states', async ({ page }) => {
    // Check for loading indicators
    const loadingIndicator = page.locator('[data-testid="loading"]').or(page.locator('.loading'));
    
    // Loading should either be present initially or table should be visible
    await Promise.race([
      expect(loadingIndicator).toBeVisible(),
      expect(page.locator('table tbody tr').first()).toBeVisible()
    ]);
  });

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('[data-testid="stocks-table"]')).toBeVisible();
    
    // Mobile navigation might be different
    const mobileMenu = page.locator('[data-testid="mobile-menu"]').or(page.locator('button[aria-label*="menu"]'));
    if (await mobileMenu.isVisible()) {
      await mobileMenu.click();
      await expect(page.getByRole('link', { name: /treemap/i })).toBeVisible();
    }
  });
});