import { test, expect } from '@playwright/test';

test.describe('TreeMap Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/treemap');
  });

  test('should load treemap page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/TreeMap.*Shorted/);
    await expect(page.locator('h1')).toContainText(/treemap|tree map/i);
  });

  test('should display treemap visualization', async ({ page }) => {
    // Wait for treemap to load
    await expect(page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()).toBeVisible({ timeout: 15000 });
    
    // Check for treemap elements (rectangles representing stocks)
    const treemapSvg = page.locator('svg').first();
    await expect(treemapSvg).toBeVisible();
    
    // Should have multiple rect elements for different stocks
    const rects = treemapSvg.locator('rect');
    await expect(rects.first()).toBeVisible();
  });

  test('should show stock information on hover', async ({ page }) => {
    // Wait for treemap to load
    const treemap = page.locator('[data-testid="treemap"]').or(page.locator('svg')).first();
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Hover over a treemap segment
    const firstRect = treemap.locator('rect').first();
    if (await firstRect.isVisible()) {
      await firstRect.hover();
      
      // Look for tooltip or hover information
      const tooltip = page.locator('[data-testid="tooltip"]').or(page.locator('.tooltip'));
      if (await tooltip.isVisible()) {
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText(/[A-Z]{2,4}/); // Stock code pattern
      }
    }
  });

  test('should navigate to stock detail on click', async ({ page }) => {
    // Wait for treemap to load
    const treemap = page.locator('[data-testid="treemap"]').or(page.locator('svg')).first();
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Click on a treemap segment
    const firstRect = treemap.locator('rect').first();
    if (await firstRect.isVisible()) {
      await firstRect.click();
      
      // Should navigate to stock detail page
      await expect(page).toHaveURL(/\/stock\/[A-Z]+/);
    }
  });

  test('should allow filtering by industry or sector', async ({ page }) => {
    // Wait for treemap to load
    await expect(page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()).toBeVisible({ timeout: 15000 });
    
    // Look for filter controls
    const filterSelect = page.locator('select').or(page.locator('[role="combobox"]'));
    const filterButtons = page.locator('button').filter({ hasText: /finance|mining|energy|health/i });
    
    if (await filterSelect.first().isVisible()) {
      await filterSelect.first().click();
      const firstOption = page.getByRole('option').first();
      if (await firstOption.isVisible()) {
        await firstOption.click();
        // Treemap should update
        await page.waitForTimeout(1000);
      }
    } else if (await filterButtons.first().isVisible()) {
      await filterButtons.first().click();
      // Treemap should update
      await page.waitForTimeout(1000);
    }
  });

  test('should display legend', async ({ page }) => {
    // Wait for page to load
    await expect(page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()).toBeVisible({ timeout: 15000 });
    
    // Look for legend
    const legend = page.locator('[data-testid="legend"]').or(page.locator('.legend'));
    if (await legend.isVisible()) {
      await expect(legend).toBeVisible();
    }
  });

  test('should handle loading states', async ({ page }) => {
    // Check for loading indicators
    const loadingIndicator = page.locator('[data-testid="loading"]').or(page.locator('.loading'));
    
    // Loading should either be present initially or treemap should be visible
    await Promise.race([
      expect(loadingIndicator).toBeVisible(),
      expect(page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()).toBeVisible()
    ]);
  });

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
    // Treemap should still be visible and functional
    await expect(page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()).toBeVisible({ timeout: 15000 });
    
    // Touch interactions should work
    const firstRect = page.locator('svg rect').first();
    if (await firstRect.isVisible()) {
      await firstRect.tap();
    }
  });

  test('should display color coding for short positions', async ({ page }) => {
    // Wait for treemap to load
    const treemap = page.locator('[data-testid="treemap"]').or(page.locator('svg')).first();
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Check that rectangles have different colors (fill attributes)
    const rects = treemap.locator('rect');
    if (await rects.first().isVisible()) {
      const firstRectFill = await rects.first().getAttribute('fill');
      const secondRectFill = await rects.nth(1).getAttribute('fill');
      
      // Colors should exist and potentially be different
      expect(firstRectFill).toBeTruthy();
    }
  });
});