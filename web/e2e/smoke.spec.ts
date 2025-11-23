import { test, expect } from '@playwright/test';

/**
 * Smoke Tests for Preview Deployments
 * 
 * These tests run against Vercel preview deployments to ensure
 * basic functionality works after deployment. They are designed to be:
 * - Fast (< 2 minutes total)
 * - Reliable (no flaky tests)
 * - Critical (catch deployment issues early)
 */

test.describe('Smoke Tests - Preview Deployment', () => {
  test('homepage loads successfully', async ({ page }) => {
    await page.goto('/');
    
    // Check that page loads without errors
    await expect(page).toHaveTitle(/Shorted/i, { timeout: 15000 });
    
    // Verify critical elements are present
    await expect(page.locator('nav')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });
  });

  test('can navigate to shorts page', async ({ page }) => {
    await page.goto('/');
    
    // Wait for navigation to be ready
    await expect(page.locator('nav')).toBeVisible({ timeout: 10000 });
    
    // Find and click shorts/treemap link (multiple possible names)
    const shortsLink = page.getByRole('link', { name: /treemap|shorts|top shorts/i }).first();
    await expect(shortsLink).toBeVisible({ timeout: 5000 });
    await shortsLink.click();
    
    // Verify navigation worked
    await expect(page).toHaveURL(/\/(shorts|treemap)/, { timeout: 10000 });
    
    // Check that content loaded
    await expect(
      page.locator('[data-testid="treemap"]')
        .or(page.locator('svg'))
        .or(page.locator('table'))
    ).toBeVisible({ timeout: 15000 });
  });

  test('top shorts table displays data', async ({ page }) => {
    await page.goto('/');
    
    // Wait for table to load
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15000 });
    
    // Verify table has data rows (at least 5 stocks)
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(10, { timeout: 10000 });
    
    // Verify first row has stock code
    const firstRow = rows.first();
    const firstCell = firstRow.locator('td').first();
    await expect(firstCell).toHaveText(/^[A-Z]{2,5}$/i, { timeout: 5000 });
  });

  test('stock search is functional', async ({ page }) => {
    await page.goto('/');
    
    // Find search input
    const searchInput = page.locator('input[type="search"]')
      .or(page.locator('input[placeholder*="search" i]'))
      .or(page.locator('[data-testid="search-input"]'))
      .first();
    
    if (await searchInput.isVisible({ timeout: 5000 })) {
      // Test search functionality
      await searchInput.fill('CBA');
      await searchInput.press('Enter');
      
      // Either search results appear or navigation occurs
      await Promise.race([
        expect(page.locator('[data-testid="search-results"]')).toBeVisible({ timeout: 10000 }),
        expect(page).toHaveURL(/search|CBA/i, { timeout: 10000 }),
        expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 10000 })
      ]);
    } else {
      test.skip('Search not available on homepage');
    }
  });

  test('navigation menu is accessible', async ({ page }) => {
    await page.goto('/');
    
    // Verify main navigation links exist
    const nav = page.locator('nav');
    await expect(nav).toBeVisible({ timeout: 10000 });
    
    // Check for key navigation items
    const requiredLinks = ['treemap', 'dashboard', 'stocks'];
    let foundCount = 0;
    
    for (const linkName of requiredLinks) {
      const link = page.getByRole('link', { name: new RegExp(linkName, 'i') });
      if (await link.isVisible({ timeout: 2000 })) {
        foundCount++;
      }
    }
    
    // At least 2 of the 3 key links should be present
    expect(foundCount).toBeGreaterThanOrEqual(2);
  });

  test('page responds within acceptable time', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });
    
    const loadTime = Date.now() - startTime;
    
    // Page should load in under 10 seconds on preview
    expect(loadTime).toBeLessThan(10000);
    
    console.log(`Page loaded in ${loadTime}ms`);
  });

  test('no console errors on homepage', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });
    
    // Wait a bit for any delayed errors
    await page.waitForTimeout(2000);
    
    // Filter out known non-critical errors
    const criticalErrors = errors.filter(error => 
      !error.includes('favicon') && 
      !error.includes('404') &&
      !error.includes('ResizeObserver') &&
      !error.toLowerCase().includes('warning')
    );
    
    if (criticalErrors.length > 0) {
      console.log('Console errors found:', criticalErrors);
    }
    
    // Should have no critical errors
    expect(criticalErrors.length).toBe(0);
  });

  test('API endpoints are accessible', async ({ page }) => {
    // Test health endpoint
    const healthResponse = await page.request.get('/api/health');
    expect(healthResponse.ok()).toBeTruthy();
    expect(healthResponse.status()).toBe(200);
    
    // Test version endpoint
    const versionResponse = await page.request.get('/api/version');
    expect(versionResponse.status()).toBeLessThan(500); // 200 or 404 is fine
  });

  test('mobile viewport renders correctly', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
    await page.goto('/');
    
    // Verify page loads on mobile
    await expect(page.locator('h1').or(page.locator('nav'))).toBeVisible({ timeout: 15000 });
    
    // Check for mobile navigation (hamburger menu or mobile nav)
    const mobileNav = page.locator('[data-testid="mobile-menu"]')
      .or(page.locator('button[aria-label*="menu" i]'))
      .or(page.locator('.hamburger'));
    
    // Either mobile menu exists or regular nav is visible
    await expect(
      mobileNav.or(page.locator('nav'))
    ).toBeVisible({ timeout: 5000 });
  });

  test('can access stock detail page directly', async ({ page }) => {
    // Test direct navigation to a stock detail page
    await page.goto('/shorts/CBA');
    
    // Either we get the stock page or a graceful 404
    const isStockPage = await page.locator('h1').filter({ hasText: /CBA/i }).isVisible({ timeout: 10000 });
    const is404 = await page.locator('h1').filter({ hasText: /404|not found/i }).isVisible({ timeout: 5000 });
    
    // Either stock page loads or we get a proper 404 (not a crash)
    expect(isStockPage || is404).toBeTruthy();
    
    // No 500 errors
    expect(page.url()).not.toContain('500');
  });
});

test.describe('Backend API Smoke Tests', () => {
  test('shorts API health check', async ({ page }) => {
    // Get backend URL from env or use default
    const baseURL = process.env.BASE_URL || 'http://localhost:3020';
    
    // Try to get backend URL from page headers or meta tags
    await page.goto('/');
    
    // Test the health endpoint through the Next.js proxy
    const healthResponse = await page.request.get('/api/health');
    
    // Should return 200 or at least not 500
    expect(healthResponse.status()).toBeLessThan(500);
    
    if (healthResponse.ok()) {
      const body = await healthResponse.json();
      console.log('Health check response:', body);
    }
  });
});

/**
 * Test Priorities:
 * 1. Homepage loads
 * 2. Data displays (top shorts table)
 * 3. Navigation works
 * 4. No critical errors
 * 5. API endpoints respond
 * 
 * These tests should complete in < 2 minutes total
 */

