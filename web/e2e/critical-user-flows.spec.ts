import { test, expect } from '@playwright/test';

test.describe('Critical User Flows', () => {
  test.beforeEach(async ({ page }) => {
    // Set viewport and wait for network to be idle
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('Homepage loads with essential elements', async ({ page }) => {
    await page.goto('http://localhost:3020');
    
    // Check main navigation
    await expect(page.getByRole('banner')).toBeVisible();
    
    // Check for main content areas
    await expect(page.getByText(/Most Shorted Stocks/i)).toBeVisible();
    
    // Check footer exists
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
  });

  test('Stock search and navigation', async ({ page }) => {
    await page.goto('http://localhost:3020');
    
    // Find and use the search input
    const searchInput = page.getByPlaceholder(/Search/i);
    await expect(searchInput).toBeVisible();
    
    // Type a stock code
    await searchInput.fill('CBA');
    await searchInput.press('Enter');
    
    // Should navigate to stock details page
    await expect(page).toHaveURL(/\/shorts\/CBA/i);
    
    // Check stock details page loads
    await expect(page.getByText(/Commonwealth Bank/i)).toBeVisible();
  });

  test('Top shorts table interaction', async ({ page }) => {
    await page.goto('http://localhost:3020');
    
    // Wait for table to load
    const table = page.locator('table').first();
    await expect(table).toBeVisible();
    
    // Check table has rows
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(10); // Expecting 10 rows
    
    // Click on first stock row
    await rows.first().click();
    
    // Should navigate to stock details
    await expect(page.url()).toContain('/shorts/');
  });

  test('Dashboard functionality', async ({ page }) => {
    await page.goto('http://localhost:3020/dashboards');
    
    // Check dashboard loads
    await expect(page.getByText(/Dashboard/i)).toBeVisible();
    
    // Check for widget grid
    const widgetGrid = page.locator('[data-testid="widget-grid"]');
    await expect(widgetGrid).toBeVisible();
    
    // Check at least one widget is present
    const widgets = widgetGrid.locator('[data-testid^="widget-"]');
    await expect(widgets.first()).toBeVisible();
  });

  test('Authentication flow - Sign in prompt', async ({ page }) => {
    await page.goto('http://localhost:3020/dashboards');
    
    // Should show sign-in prompt for unauthenticated users
    const signInPrompt = page.getByText(/Sign in to save/i);
    if (await signInPrompt.isVisible()) {
      // Click sign in button if present
      const signInButton = page.getByRole('button', { name: /Sign in/i });
      if (await signInButton.isVisible()) {
        await signInButton.click();
        // Should show auth modal or redirect
        await expect(page.getByText(/Continue with Google/i)).toBeVisible();
      }
    }
  });

  test('Blog navigation', async ({ page }) => {
    await page.goto('http://localhost:3020');
    
    // Navigate to blog
    const blogLink = page.getByRole('link', { name: /Blog/i });
    if (await blogLink.isVisible()) {
      await blogLink.click();
      await expect(page).toHaveURL(/\/blog/);
      
      // Check blog posts are displayed
      const blogPosts = page.locator('article');
      await expect(blogPosts.first()).toBeVisible();
    }
  });

  test('Mobile responsive navigation', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('http://localhost:3020');
    
    // Check mobile menu button
    const menuButton = page.getByRole('button', { name: /menu/i });
    if (await menuButton.isVisible()) {
      await menuButton.click();
      
      // Check mobile menu opens
      const mobileNav = page.locator('[data-testid="mobile-nav"]');
      await expect(mobileNav).toBeVisible();
    }
  });

  test('Chart period selection', async ({ page }) => {
    // Navigate to a stock detail page
    await page.goto('http://localhost:3020/shorts/CBA');
    
    // Wait for chart to load
    const chart = page.locator('[data-testid="stock-chart"]');
    await expect(chart).toBeVisible();
    
    // Find period toggle buttons
    const periodButtons = page.locator('[data-testid^="toggle-"]');
    
    // Test 1M period
    const oneMonthButton = page.locator('[data-testid="toggle-1m"]');
    if (await oneMonthButton.isVisible()) {
      await oneMonthButton.click();
      // Chart should update (check for visual change or API call)
      await page.waitForTimeout(500); // Small delay for chart update
    }
    
    // Test 1Y period
    const oneYearButton = page.locator('[data-testid="toggle-1y"]');
    if (await oneYearButton.isVisible()) {
      await oneYearButton.click();
      await page.waitForTimeout(500);
    }
  });

  test('Error handling - 404 page', async ({ page }) => {
    // Navigate to non-existent page
    await page.goto('http://localhost:3020/non-existent-page');
    
    // Should show 404 error
    await expect(page.getByText(/404/)).toBeVisible();
    
    // Should have link back to home
    const homeLink = page.getByRole('link', { name: /home/i });
    await expect(homeLink).toBeVisible();
  });

  test('Performance - Page load times', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('http://localhost:3020', {
      waitUntil: 'networkidle'
    });
    
    const loadTime = Date.now() - startTime;
    
    // Page should load within 3 seconds
    expect(loadTime).toBeLessThan(3000);
    
    // Check Core Web Vitals (basic check)
    const performanceMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return {
        domContentLoaded: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
        loadComplete: navigation.loadEventEnd - navigation.loadEventStart
      };
    });
    
    // DOM should be ready quickly
    expect(performanceMetrics.domContentLoaded).toBeLessThan(1000);
  });
});

test.describe('Data Integrity', () => {
  test('Stock data displays correctly', async ({ page }) => {
    await page.goto('http://localhost:3020/shorts/CBA');
    
    // Check for essential data points
    await expect(page.getByText(/Short %/i)).toBeVisible();
    await expect(page.getByText(/Total Shorted/i)).toBeVisible();
    
    // Verify data format (percentages should be formatted)
    const percentageRegex = /\d+\.\d{2}%/;
    const percentageElements = page.locator('text=' + percentageRegex);
    await expect(percentageElements.first()).toBeVisible();
  });

  test('API endpoints are responsive', async ({ page }) => {
    // Test health endpoint
    const healthResponse = await page.request.get('http://localhost:9091/health');
    expect(healthResponse.ok()).toBeTruthy();
    
    // Test market data endpoint if available
    const marketDataResponse = await page.request.get('http://localhost:8090/health');
    expect(marketDataResponse.ok()).toBeTruthy();
  });
});

test.describe('Accessibility', () => {
  test('Keyboard navigation works', async ({ page }) => {
    await page.goto('http://localhost:3020');
    
    // Tab through navigation
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // Check focus is visible
    const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedElement).toBeTruthy();
    
    // Enter should activate links
    await page.keyboard.press('Enter');
    // Should navigate somewhere
    await page.waitForTimeout(1000);
  });

  test('ARIA labels are present', async ({ page }) => {
    await page.goto('http://localhost:3020');
    
    // Check for ARIA labels on interactive elements
    const buttons = page.locator('button');
    const buttonsCount = await buttons.count();
    
    for (let i = 0; i < Math.min(buttonsCount, 5); i++) {
      const button = buttons.nth(i);
      const ariaLabel = await button.getAttribute('aria-label');
      const textContent = await button.textContent();
      
      // Button should have either aria-label or text content
      expect(ariaLabel || textContent).toBeTruthy();
    }
  });
});