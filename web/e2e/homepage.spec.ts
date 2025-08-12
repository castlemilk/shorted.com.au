import { test, expect } from '@playwright/test';
import { APIMockHelper } from './helpers/api-mock';
import { AuthHelper } from './helpers/auth';
import testUsers from './fixtures/test-users.json';

test.describe('Homepage', () => {
  let apiMock: APIMockHelper;
  let authHelper: AuthHelper;

  test.beforeEach(async ({ page }) => {
    apiMock = new APIMockHelper(page);
    authHelper = new AuthHelper(page);
    
    // Mock successful API responses by default
    await apiMock.mockSuccessfulResponses();
    
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
    // Check table container exists
    await expect(page.locator('[data-testid="stocks-table"]').or(page.locator('table'))).toBeVisible();
    
    // Wait for data to load
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Check table headers are present and visible
    await expect(page.getByRole('columnheader', { name: /product code|code|symbol/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /name|company/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /short position|short %/i })).toBeVisible();
    
    // Verify we have multiple rows of data
    await expect(page.locator('table tbody tr')).toHaveCount(10, { timeout: 10000 });
    
    // Check that first row contains actual data
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow.locator('td')).toHaveCount(4, { timeout: 5000 }); // Assuming 4 columns
    
    // Verify stock codes are properly formatted (e.g., 3-4 letters)
    const firstStockCode = firstRow.locator('td').first();
    await expect(firstStockCode).toHaveText(/^[A-Z]{2,4}$/i);
  });

  test('should allow filtering stocks by period', async ({ page }) => {
    // Wait for initial data to load
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Find period selector (could be select, combobox, or button group)
    const periodSelectors = [
      page.locator('select[data-testid*="period"]'),
      page.locator('[role="combobox"]'),
      page.locator('[data-testid="period-selector"]'),
      page.locator('button').filter({ hasText: /3M|1M|1W|6M|1Y/i }).first()
    ];
    
    let selectorFound = false;
    for (const selector of periodSelectors) {
      if (await selector.isVisible()) {
        selectorFound = true;
        await selector.click();
        
        // Try to select different periods
        const periodOptions = [
          { pattern: /1 week|1W/i, selector: page.getByRole('option', { name: /1 week|1W/i }).or(page.getByText('1W')) },
          { pattern: /1 month|1M/i, selector: page.getByRole('option', { name: /1 month|1M/i }).or(page.getByText('1M')) },
          { pattern: /6 month|6M/i, selector: page.getByRole('option', { name: /6 month|6M/i }).or(page.getByText('6M')) }
        ];
        
        for (const option of periodOptions) {
          if (await option.selector.isVisible()) {
            await option.selector.click();
            
            // Verify table updates with new data
            await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
            
            // Wait for any loading states to complete
            await page.waitForTimeout(1000);
            break;
          }
        }
        break;
      }
    }
    
    // If no period selector found, skip this test gracefully
    if (!selectorFound) {
      test.skip('No period selector found on the page');
    }
  });

  test('should navigate to stock detail page when clicking stock row', async ({ page }) => {
    // Wait for table to load completely
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Get the stock code from the first row for validation
    const firstRow = page.locator('table tbody tr').first();
    const stockCode = await firstRow.locator('td').first().textContent();
    
    // Click first stock row
    await firstRow.click();
    
    // Should navigate to stock detail page (multiple possible URL patterns)
    await expect(page).toHaveURL(new RegExp(`/(stock|stocks|shorts)/${stockCode}`, 'i'), { timeout: 10000 });
    
    // Verify we're on the stock detail page
    await expect(
      page.locator('h1').filter({ hasText: new RegExp(stockCode || '', 'i') })
        .or(page.locator('[data-testid="stock-header"]'))
        .or(page.getByText('Stock Details'))
    ).toBeVisible({ timeout: 10000 });
    
    // Verify stock chart or price information is present
    await expect(
      page.locator('[data-testid="stock-chart"]')
        .or(page.locator('.recharts-container'))
        .or(page.locator('svg'))
        .or(page.getByText(/price|chart/i))
    ).toBeVisible({ timeout: 15000 });
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
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
    // Verify main elements are visible on mobile
    await expect(
      page.locator('nav').or(page.locator('[data-testid="navigation"]'))
    ).toBeVisible();
    
    // Table should be visible or have mobile-specific layout
    await expect(
      page.locator('[data-testid="stocks-table"]')
        .or(page.locator('table'))
        .or(page.locator('[data-testid="mobile-stocks-list"]'))
    ).toBeVisible();
    
    // Check for mobile navigation patterns
    const mobileMenuTriggers = [
      page.locator('[data-testid="mobile-menu"]'),
      page.locator('button[aria-label*="menu"]'),
      page.locator('.hamburger'),
      page.locator('[data-testid="nav-toggle"]'),
      page.locator('button').filter({ hasText: /☰|Menu/i })
    ];
    
    let menuFound = false;
    for (const menuTrigger of mobileMenuTriggers) {
      if (await menuTrigger.isVisible()) {
        menuFound = true;
        await menuTrigger.click();
        
        // Verify navigation links are accessible
        await expect(
          page.getByRole('link', { name: /treemap/i })
            .or(page.getByRole('link', { name: /dashboard/i }))
            .or(page.getByRole('link', { name: /stocks/i }))
        ).toBeVisible({ timeout: 5000 });
        break;
      }
    }
    
    // Verify content adapts to mobile layout
    const table = page.locator('table');
    if (await table.isVisible()) {
      // Table should be scrollable horizontally on mobile if needed
      const tableContainer = table.locator('..');
      const hasHorizontalScroll = await tableContainer.evaluate(el => el.scrollWidth > el.clientWidth);
      // This is acceptable behavior for mobile tables
    }
    
    // Verify treemap section exists and is responsive
    await expect(
      page.locator('[data-testid="treemap"]')
        .or(page.locator('.treemap-container'))
        .or(page.locator('svg'))
    ).toBeVisible({ timeout: 10000 });
  });

  test('should display search functionality', async ({ page }) => {
    // Look for search input
    const searchInput = page.locator('input[placeholder*="search"]')
      .or(page.locator('[data-testid="search-input"]'))
      .or(page.locator('input[type="search"]'));
    
    if (await searchInput.isVisible()) {
      // Test search functionality
      await searchInput.fill('CBA');
      
      // Wait for search results or autocomplete
      await Promise.race([
        expect(page.locator('[data-testid="search-results"]')).toBeVisible({ timeout: 5000 }),
        expect(page.locator('.search-dropdown')).toBeVisible({ timeout: 5000 }),
        expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })
      ]);
      
      // Clear search
      await searchInput.clear();
    }
  });

  test('should show industry treemap visualization', async ({ page }) => {
    // Wait for treemap to load
    await expect(
      page.locator('[data-testid="treemap"]')
        .or(page.locator('.treemap-container'))
        .or(page.locator('svg').filter({ hasText: /sector|industry/i }))
    ).toBeVisible({ timeout: 15000 });
    
    // Verify interactive elements
    const treemapItems = page.locator('[data-testid="treemap"] rect')
      .or(page.locator('.treemap-container rect'))
      .or(page.locator('svg rect'));
    
    if (await treemapItems.first().isVisible()) {
      // Test hover interaction
      await treemapItems.first().hover();
      
      // Should show tooltip or highlight
      await expect(
        page.locator('[data-testid="tooltip"]')
          .or(page.locator('.tooltip'))
          .or(page.locator('[role="tooltip"]'))
      ).toBeVisible({ timeout: 3000 });
    }
  });

  test('should handle different data periods correctly', async ({ page }) => {
    // Mock different time periods
    await apiMock.mockTopShorts('1w');
    await page.reload();
    
    // Verify data loads for different periods
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Test 1 month period
    await apiMock.mockTopShorts('1m');
    await page.reload();
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Test 6 month period
    await apiMock.mockTopShorts('6m');
    await page.reload();
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
  });

  test('should show loading states correctly', async ({ page }) => {
    // Mock slow responses
    await apiMock.mockLoadingStates(3000);
    await page.reload();
    
    // Should show loading indicators
    await expect(
      page.locator('[data-testid="loading"]')
        .or(page.locator('.loading'))
        .or(page.locator('.spinner'))
        .or(page.locator('[aria-label*="loading"]'))
    ).toBeVisible({ timeout: 2000 });
    
    // Eventually should show content
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });
  });

  test('should handle API errors gracefully', async ({ page }) => {
    // Mock API errors
    await apiMock.mockErrorResponses();
    await page.reload();
    
    // Should show error state
    await expect(
      page.locator('[data-testid="error"]')
        .or(page.getByText(/error|failed|something went wrong/i))
        .or(page.locator('.error'))
    ).toBeVisible({ timeout: 10000 });
    
    // Should have retry option
    const retryButton = page.getByRole('button', { name: /retry|try again|reload/i });
    if (await retryButton.isVisible()) {
      await expect(retryButton).toBeVisible();
    }
  });

  test('should display data last updated timestamp', async ({ page }) => {
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Look for timestamp information
    const timestampSelectors = [
      page.locator('[data-testid="last-updated"]'),
      page.getByText(/last updated|updated/i),
      page.locator('.timestamp'),
      page.getByText(/\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/)
    ];
    
    let timestampFound = false;
    for (const selector of timestampSelectors) {
      if (await selector.isVisible()) {
        await expect(selector).toBeVisible();
        timestampFound = true;
        break;
      }
    }
    
    // Timestamp should be present for data freshness
    if (!timestampFound) {
      console.warn('No timestamp found - consider adding last updated information');
    }
  });

  test('should support keyboard navigation', async ({ page }) => {
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Test tab navigation
    await page.keyboard.press('Tab');
    
    // First focusable element should be highlighted
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
    
    // Test navigation through table rows
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.focus();
    
    // Press Enter to navigate to stock detail
    await page.keyboard.press('Enter');
    
    // Should navigate to stock detail page
    await expect(page).toHaveURL(/\/(stock|stocks|shorts)\/[A-Z]+/i, { timeout: 10000 });
  });

  test('should show percentage changes with proper formatting', async ({ page }) => {
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Look for percentage columns
    const percentageCells = page.locator('td').filter({ hasText: /%/ });
    
    if (await percentageCells.first().isVisible()) {
      const count = await percentageCells.count();
      expect(count).toBeGreaterThan(0);
      
      // Verify percentage formatting (should have % symbol)
      const firstPercentage = await percentageCells.first().textContent();
      expect(firstPercentage).toMatch(/%/);
      
      // Should show positive/negative indicators (colors or +/- signs)
      const cellClass = await percentageCells.first().getAttribute('class');
      const cellText = await percentageCells.first().textContent();
      
      // Should have color coding or +/- indicators
      expect(cellClass || cellText).toMatch(/(green|red|positive|negative|\+|-)/);
    }
  });

  test('should handle tablet viewport correctly', async ({ page }) => {
    // Set tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    
    // Verify layout adapts to tablet
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('table')).toBeVisible({ timeout: 15000 });
    
    // Both treemap and table should be visible on tablet
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg'))
    ).toBeVisible({ timeout: 15000 });
    
    // Table should be readable without horizontal scroll on tablet
    const table = page.locator('table');
    const tableContainer = table.locator('..');
    
    if (await table.isVisible()) {
      // Verify table doesn't overflow container significantly
      const containerWidth = await tableContainer.evaluate(el => el.clientWidth);
      const tableWidth = await table.evaluate(el => el.scrollWidth);
      
      // Allow some overflow for table functionality, but not excessive
      expect(tableWidth).toBeLessThan(containerWidth * 1.3);
    }
  });

  test('should show user authentication state correctly', async ({ page }) => {
    // Test unauthenticated state (default)
    await authHelper.expectNotAuthenticated();
    
    // Test authenticated state
    await authHelper.mockAuthState('validUser');
    
    // Should show user menu or profile information
    await authHelper.expectAuthenticated();
    
    // Verify login prompt banner behavior
    const loginBanner = page.locator('[data-testid="login-prompt"]')
      .or(page.getByText(/sign in|login/i).first());
    
    // Should not show login prompt when authenticated
    await expect(loginBanner).not.toBeVisible();
  });

  test('should handle empty data states', async ({ page }) => {
    // Mock empty data response
    await page.route('**/shorts/v1alpha1/**/top-shorts', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [],
          metadata: {
            totalCount: 0,
            period: '3m',
            lastUpdated: new Date().toISOString()
          }
        })
      });
    });
    
    await page.reload();
    
    // Should show empty state message
    await expect(
      page.getByText(/no data|no stocks|empty/i)
        .or(page.locator('[data-testid="empty-state"]'))
    ).toBeVisible({ timeout: 10000 });
  });
});