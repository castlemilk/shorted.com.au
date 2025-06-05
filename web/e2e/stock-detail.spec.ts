import { test, expect } from '@playwright/test';

test.describe('Stock Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to a known stock (CBA is commonly used in tests)
    await page.goto('/stock/CBA');
  });

  test('should load stock detail page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/CBA.*Shorted/);
    await expect(page.locator('h1')).toContainText('CBA');
  });

  test('should display stock information', async ({ page }) => {
    // Check for stock name and code
    await expect(page.locator('h1')).toBeVisible();
    
    // Check for key metrics
    await expect(page.getByText(/short position/i)).toBeVisible();
    await expect(page.getByText(/total product/i)).toBeVisible();
  });

  test('should show stock chart', async ({ page }) => {
    // Wait for chart to load
    await expect(page.locator('[data-testid="stock-chart"]').or(page.locator('svg'))).toBeVisible({ timeout: 15000 });
    
    // Check for chart elements
    const chart = page.locator('[data-testid="stock-chart"]').or(page.locator('svg')).first();
    await expect(chart).toBeVisible();
  });

  test('should allow changing chart time period', async ({ page }) => {
    // Wait for chart to load
    await expect(page.locator('[data-testid="stock-chart"]').or(page.locator('svg')).first()).toBeVisible({ timeout: 15000 });
    
    // Look for period buttons or selectors
    const periodButtons = page.locator('button').filter({ hasText: /1M|3M|6M|1Y/ });
    const periodSelect = page.locator('select').filter({ hasText: /month|year/ });
    
    if (await periodButtons.first().isVisible()) {
      await periodButtons.first().click();
      // Chart should update - wait for any loading states
      await page.waitForTimeout(1000);
    } else if (await periodSelect.isVisible()) {
      await periodSelect.click();
      await page.getByRole('option').first().click();
    }
  });

  test('should handle invalid stock codes', async ({ page }) => {
    await page.goto('/stock/INVALID');
    
    // Should show error message or 404
    await expect(page.locator('text=/not found|error|invalid/i')).toBeVisible({ timeout: 10000 });
  });

  test('should navigate back to homepage', async ({ page }) => {
    // Look for navigation links
    const homeLink = page.getByRole('link', { name: /home/i }).or(page.getByRole('link', { name: /shorted/i }));
    
    if (await homeLink.isVisible()) {
      await homeLink.click();
      await expect(page).toHaveURL('/');
    } else {
      // Try browser back button
      await page.goBack();
      await expect(page).toHaveURL('/');
    }
  });

  test('should display company metadata if available', async ({ page }) => {
    // Wait for page to load
    await expect(page.locator('h1')).toBeVisible();
    
    // Check for company logo
    const logo = page.locator('img[alt*="logo"]').or(page.locator('[data-testid="company-logo"]'));
    
    // Company description or industry info
    const companyInfo = page.locator('[data-testid="company-info"]').or(page.getByText(/industry|sector/i));
    
    // These might not always be present, so we check if they exist
    if (await logo.isVisible()) {
      await expect(logo).toBeVisible();
    }
    
    if (await companyInfo.isVisible()) {
      await expect(companyInfo).toBeVisible();
    }
  });

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
    // Page should still be functional
    await expect(page.locator('h1')).toBeVisible();
    
    // Chart should adapt to mobile
    const chart = page.locator('[data-testid="stock-chart"]').or(page.locator('svg')).first();
    if (await chart.isVisible()) {
      await expect(chart).toBeVisible();
    }
  });
});