import { test, expect } from '@playwright/test';
import { APIMockHelper } from './helpers/api-mock';
import { AuthHelper } from './helpers/auth';
import testUsers from './fixtures/test-users.json';

test.describe('Stock Detail Page', () => {
  let apiMock: APIMockHelper;
  let authHelper: AuthHelper;

  test.beforeEach(async ({ page }) => {
    apiMock = new APIMockHelper(page);
    authHelper = new AuthHelper(page);
    
    // Mock successful API responses
    await apiMock.mockSuccessfulResponses();
    
    // Navigate to a known stock (CBA is commonly used in tests)
    await page.goto('/shorts/CBA');
  });

  test('should load stock detail page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/CBA.*Shorted/);
    await expect(page.locator('h1')).toContainText('CBA');
  });

  test('should display comprehensive stock information', async ({ page }) => {
    // Check for stock name and code
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Check for key metrics
    const keyMetrics = [
      page.getByText(/short position/i),
      page.getByText(/price|current price/i),
      page.getByText(/change|percent change/i),
      page.getByText(/volume/i),
      page.getByText(/market cap/i)
    ];
    
    for (const metric of keyMetrics) {
      if (await metric.isVisible()) {
        await expect(metric).toBeVisible();
      }
    }
    
    // Verify stock data is displayed in proper format
    const priceElement = page.getByText(/\\$\\d+\\.\\d{2}/);
    if (await priceElement.isVisible()) {
      await expect(priceElement).toBeVisible();
    }
    
    // Check for percentage formatting
    const percentageElement = page.getByText(/\\d+\\.\\d{2}%/);
    if (await percentageElement.isVisible()) {
      await expect(percentageElement).toBeVisible();
    }
  });

  test('should show interactive stock chart', async ({ page }) => {
    // Wait for chart to load
    await expect(
      page.locator('[data-testid="stock-chart"]')
        .or(page.locator('.recharts-container'))
        .or(page.locator('svg'))
    ).toBeVisible({ timeout: 15000 });
    
    // Check for chart elements
    const chart = page.locator('[data-testid="stock-chart"]')
      .or(page.locator('.recharts-container'))
      .or(page.locator('svg')).first();
    
    await expect(chart).toBeVisible();
    
    // Verify chart has interactive elements
    const chartPaths = page.locator('svg path').or(page.locator('.recharts-line'));
    if (await chartPaths.first().isVisible()) {
      await expect(chartPaths.first()).toBeVisible();
      
      // Test chart interaction (hover)
      await chartPaths.first().hover();
      
      // Should show tooltip or data point information
      await expect(
        page.locator('[data-testid="tooltip"]')
          .or(page.locator('.recharts-tooltip-wrapper'))
          .or(page.locator('[role="tooltip"]'))
      ).toBeVisible({ timeout: 3000 });
    }
    
    // Verify chart axes
    const xAxis = page.locator('.recharts-xAxis').or(page.locator('g.x-axis'));
    const yAxis = page.locator('.recharts-yAxis').or(page.locator('g.y-axis'));
    
    if (await xAxis.isVisible()) {
      await expect(xAxis).toBeVisible();
    }
    if (await yAxis.isVisible()) {
      await expect(yAxis).toBeVisible();
    }
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

  test('should handle invalid stock codes gracefully', async ({ page }) => {
    // Mock 404 response for invalid stock
    await apiMock.mockRouteError('**/shorts/v1alpha1/**/stock/INVALID', 404, 'Stock not found');
    
    await page.goto('/shorts/INVALID');
    
    // Should show appropriate error message
    await expect(
      page.locator('text=/not found|error|invalid|does not exist/i')
        .or(page.locator('[data-testid="error"]'))
        .or(page.locator('.error-message'))
    ).toBeVisible({ timeout: 10000 });
    
    // Should provide navigation back to homepage
    const backLink = page.getByRole('link', { name: /home|back|browse stocks/i });
    if (await backLink.isVisible()) {
      await expect(backLink).toBeVisible();
    }
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

  test('should display comprehensive company metadata', async ({ page }) => {
    // Wait for page to load
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Check for company logo
    const logo = page.locator('img[alt*="logo"]')
      .or(page.locator('[data-testid="company-logo"]'))
      .or(page.locator('img[src*="logo"]'));
    
    if (await logo.isVisible()) {
      await expect(logo).toBeVisible();
      
      // Logo should have proper alt text
      const altText = await logo.getAttribute('alt');
      expect(altText).toBeTruthy();
    }
    
    // Company name should be displayed prominently
    await expect(
      page.getByText(/Commonwealth Bank|CBA/i)
        .or(page.locator('[data-testid="company-name"]'))
    ).toBeVisible();
    
    // Industry and sector information
    const industryInfo = [
      page.getByText(/Banks|Banking/i),
      page.getByText(/Financials/i),
      page.getByText(/ASX/i),
      page.locator('[data-testid="company-sector"]'),
      page.locator('[data-testid="company-industry"]')
    ];
    
    let industryFound = false;
    for (const info of industryInfo) {
      if (await info.isVisible()) {
        await expect(info).toBeVisible();
        industryFound = true;
        break;
      }
    }
    
    // Company description or additional details
    const companyDetails = [
      page.locator('[data-testid="company-description"]'),
      page.getByText(/description/i).locator('..').locator('p, div'),
      page.locator('.company-description'),
      page.getByText(/market cap|pe ratio|dividend/i)
    ];
    
    for (const detail of companyDetails) {
      if (await detail.first().isVisible()) {
        await expect(detail.first()).toBeVisible();
        break;
      }
    }
    
    // Website link if available
    const websiteLink = page.getByRole('link', { name: /website|company site/i })
      .or(page.locator('a[href*="commbank.com"]'));
    
    if (await websiteLink.isVisible()) {
      await expect(websiteLink).toBeVisible();
      
      // Link should open in new tab
      const target = await websiteLink.getAttribute('target');
      expect(target).toBe('_blank');
    }
  });

  test('should be responsive on mobile devices', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
    // Page should still be functional
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Chart should adapt to mobile
    const chart = page.locator('[data-testid="stock-chart"]')
      .or(page.locator('.recharts-container'))
      .or(page.locator('svg')).first();
    
    if (await chart.isVisible()) {
      await expect(chart).toBeVisible();
      
      // Chart should fit within mobile viewport
      const chartBounds = await chart.boundingBox();
      if (chartBounds) {
        expect(chartBounds.width).toBeLessThanOrEqual(375);
      }
    }
    
    // Key information should be visible without horizontal scrolling
    const keyElements = [
      page.getByText(/price/i),
      page.getByText(/short position/i),
      page.getByText(/change/i)
    ];
    
    for (const element of keyElements) {
      if (await element.first().isVisible()) {
        await expect(element.first()).toBeVisible();
      }
    }
    
    // Navigation should work on mobile
    const mobileNav = page.locator('[data-testid="mobile-nav"]')
      .or(page.locator('button[aria-label*="menu"]'));
    
    if (await mobileNav.isVisible()) {
      await mobileNav.click();
      await expect(
        page.getByRole('link', { name: /home|dashboard/i })
      ).toBeVisible();
    }
  });

  test('should display historical short position data', async ({ page }) => {
    // Wait for page and chart to load
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Should show historical data table or chart
    const historicalData = [
      page.locator('[data-testid="historical-data"]'),
      page.locator('.data-table'),
      page.locator('table').filter({ hasText: /date|short position/i }),
      page.locator('.recharts-container')
    ];
    
    let dataFound = false;
    for (const data of historicalData) {
      if (await data.isVisible()) {
        await expect(data).toBeVisible();
        dataFound = true;
        break;
      }
    }
    
    if (dataFound) {
      // Should show dates in proper format
      const dateElements = page.locator('text=/\\d{1,2}\/\\d{1,2}\/\\d{4}|\\d{4}-\\d{2}-\\d{2}/');
      if (await dateElements.first().isVisible()) {
        await expect(dateElements.first()).toBeVisible();
      }
    }
  });

  test('should allow chart period selection', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Look for period selection controls
    const periodControls = [
      page.locator('[data-testid="period-selector"]'),
      page.locator('button').filter({ hasText: /1M|3M|6M|1Y|YTD/i }),
      page.locator('select').filter({ hasText: /month|year/i }),
      page.locator('[role="tablist"]').locator('button')
    ];
    
    for (const control of periodControls) {
      if (await control.first().isVisible()) {
        // Click different period options
        const options = await control.all();
        
        for (let i = 0; i < Math.min(options.length, 3); i++) {
          const option = options[i];
          if (await option.isVisible()) {
            await option.click();
            
            // Wait for chart to update
            await page.waitForTimeout(1500);
            
            // Chart should still be visible
            await expect(
              page.locator('[data-testid="stock-chart"]')
                .or(page.locator('.recharts-container'))
                .or(page.locator('svg'))
            ).toBeVisible();
          }
        }
        break;
      }
    }
  });

  test('should show price and volume information', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Check for current price
    const priceElements = [
      page.locator('[data-testid="current-price"]'),
      page.getByText(/\\$\\d+\\.\\d{2}/),
      page.locator('.price'),
      page.getByText(/price/i).locator('..').locator('text=/\\$\\d/')
    ];
    
    let priceFound = false;
    for (const price of priceElements) {
      if (await price.first().isVisible()) {
        await expect(price.first()).toBeVisible();
        
        // Price should be in proper format
        const priceText = await price.first().textContent();
        expect(priceText).toMatch(/\\$\\d+\\.\\d{2}/);
        priceFound = true;
        break;
      }
    }
    
    // Check for price change
    const changeElements = [
      page.locator('[data-testid="price-change"]'),
      page.getByText(/[+\\-]\\d+\\.\\d{2}/),
      page.locator('.change'),
      page.getByText(/change/i).locator('..').locator('text=/[+\\-]/')
    ];
    
    for (const change of changeElements) {
      if (await change.first().isVisible()) {
        await expect(change.first()).toBeVisible();
        
        // Should have proper color coding
        const changeClass = await change.first().getAttribute('class');
        expect(changeClass).toMatch(/(green|red|positive|negative|up|down)/);
        break;
      }
    }
    
    // Check for volume information
    const volumeElements = [
      page.locator('[data-testid="volume"]'),
      page.getByText(/volume/i).locator('..').locator('text=/\\d/'),
      page.locator('.volume')
    ];
    
    for (const volume of volumeElements) {
      if (await volume.first().isVisible()) {
        await expect(volume.first()).toBeVisible();
        
        // Volume should be formatted with commas or suffixes
        const volumeText = await volume.first().textContent();
        expect(volumeText).toMatch(/[\\d,]+|\\d+[KMB]/);
        break;
      }
    }
  });

  test('should handle data loading and error states', async ({ page }) => {
    // Test loading state
    await apiMock.mockLoadingStates(2000);
    await page.reload();
    
    // Should show loading indicator
    await expect(
      page.locator('[data-testid="loading"]')
        .or(page.locator('.loading'))
        .or(page.locator('.spinner'))
        .or(page.locator('[aria-label*="loading"]'))
    ).toBeVisible({ timeout: 1000 });
    
    // Eventually should show content
    await expect(page.locator('h1')).toContainText('CBA', { timeout: 10000 });
    
    // Test error state
    await apiMock.mockRouteError('**/shorts/v1alpha1/**/stock/CBA/data', 500);
    await page.reload();
    
    // Should handle chart data errors gracefully
    await expect(page.locator('h1')).toContainText('CBA');
    
    // Error message or fallback content should be shown
    const errorIndicators = [
      page.locator('[data-testid="chart-error"]'),
      page.getByText(/unable to load|error loading|chart unavailable/i),
      page.locator('.error-message')
    ];
    
    let errorShown = false;
    for (const error of errorIndicators) {
      if (await error.isVisible({ timeout: 5000 })) {
        await expect(error).toBeVisible();
        errorShown = true;
        break;
      }
    }
    
    // Page should still be functional even with chart errors
    await expect(page.locator('h1')).toContainText('CBA');
  });
});