import { test, expect } from '@playwright/test';

// Test configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3020';
const API_URL = process.env.API_URL || 'http://localhost:9091';
const MARKET_DATA_URL = process.env.MARKET_DATA_URL || 'http://localhost:8090';

// Test stocks from seed data
const TEST_STOCKS = ['CBA', 'BHP', 'CSL', 'WOW', 'RIO'];

test.describe('Full Stack E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Set up any required auth or initial state
    await page.goto(BASE_URL);
  });

  test.describe('Homepage', () => {
    test('should load homepage with top shorts', async ({ page }) => {
      await page.goto(BASE_URL);
      
      // Check main elements are present
      await expect(page.locator('h1')).toContainText(/Short Positions/i);
      
      // Check that data table loads
      await expect(page.locator('table')).toBeVisible({ timeout: 10000 });
      
      // Verify at least one stock is displayed
      const stockRows = page.locator('table tbody tr');
      await expect(stockRows).toHaveCount(await stockRows.count());
      expect(await stockRows.count()).toBeGreaterThan(0);
    });

    test('should search for stocks', async ({ page }) => {
      await page.goto(BASE_URL);
      
      // Search for a test stock
      const searchInput = page.locator('input[placeholder*="Search"]');
      await searchInput.fill('CBA');
      await searchInput.press('Enter');
      
      // Verify search results
      await expect(page.locator('text=Commonwealth Bank')).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Stock Analysis Page', () => {
    test('should display stock price chart with multiple timeframes', async ({ page }) => {
      await page.goto(`${BASE_URL}/stocks`);
      
      // Search for a stock
      await page.fill('input[placeholder*="stock code"]', 'WOW');
      await page.click('button:has-text("Search")');
      
      // Wait for stock data to load
      await expect(page.locator('text=/\\$[0-9]+\\.[0-9]+/')).toBeVisible({ timeout: 10000 });
      
      // Check all timeframe buttons are present
      const timeframes = ['1W', '1M', '3M', '6M', '1Y', '5Y', '10Y'];
      for (const tf of timeframes) {
        await expect(page.locator(`button:has-text("${tf}")`)).toBeVisible();
      }
      
      // Test switching timeframes
      await page.click('button:has-text("5Y")');
      await page.waitForTimeout(1000); // Wait for chart to update
      
      // Verify chart is displayed
      await expect(page.locator('canvas, svg').first()).toBeVisible();
    });

    test('should display stock details and statistics', async ({ page }) => {
      await page.goto(`${BASE_URL}/stocks`);
      
      // Load a stock
      await page.fill('input[placeholder*="stock code"]', 'BHP');
      await page.click('button:has-text("Search")');
      
      // Check stock info is displayed
      await expect(page.locator('h2:has-text("BHP")')).toBeVisible({ timeout: 10000 });
      
      // Check key metrics are displayed
      await expect(page.locator('text=Open')).toBeVisible();
      await expect(page.locator('text=High')).toBeVisible();
      await expect(page.locator('text=Low')).toBeVisible();
      await expect(page.locator('text=Volume')).toBeVisible();
      await expect(page.locator('text=Previous Close')).toBeVisible();
    });

    test('should handle popular stock shortcuts', async ({ page }) => {
      await page.goto(`${BASE_URL}/stocks`);
      
      // Click on a popular stock button
      const popularStock = page.locator('button:has-text("CBA")').first();
      await expect(popularStock).toBeVisible();
      await popularStock.click();
      
      // Verify stock loads
      await expect(page.locator('h2:has-text("CBA")')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=/\\$[0-9]+\\.[0-9]+/')).toBeVisible();
    });
  });

  test.describe('Short Position Details Page', () => {
    test('should display short position trends', async ({ page }) => {
      await page.goto(`${BASE_URL}/shorts/WOW`);
      
      // Wait for page to load
      await expect(page.locator('h2')).toContainText(/Short Position Trends/i, { timeout: 10000 });
      
      // Check chart is displayed
      await expect(page.locator('text=Clear')).toBeVisible();
      await expect(page.locator('text=Reset')).toBeVisible();
      
      // Check timeframe toggles
      const timeframes = ['1M', '3M', '6M', '1Y'];
      for (const tf of timeframes) {
        const button = page.locator(`button:has-text("${tf}")`).first();
        await expect(button).toBeVisible();
      }
    });

    test('should display historical price data', async ({ page }) => {
      await page.goto(`${BASE_URL}/shorts/BHP`);
      
      // Check for historical price section
      await expect(page.locator('h2:has-text("Historical Price Data")')).toBeVisible({ timeout: 10000 });
      
      // Verify 5Y and 10Y options are available
      await expect(page.locator('button:has-text("5Y")')).toBeVisible();
      await expect(page.locator('button:has-text("10Y")')).toBeVisible();
      
      // Test switching to 10Y view
      await page.click('button:has-text("10Y")');
      await page.waitForTimeout(1000); // Wait for chart update
    });

    test('should display company information', async ({ page }) => {
      await page.goto(`${BASE_URL}/shorts/CSL`);
      
      // Wait for company info to load
      await expect(page.locator('text=CSL')).toBeVisible({ timeout: 10000 });
      
      // Check for key sections (these would be populated from company-metadata)
      const sections = page.locator('.card, [class*="card"]');
      await expect(sections).toHaveCount(await sections.count());
      expect(await sections.count()).toBeGreaterThan(0);
    });
  });

  test.describe('API Integration Tests', () => {
    test('should fetch market data through API proxy', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/market-data/historical`, {
        data: {
          stockCode: 'CBA',
          period: '1m'
        },
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.prices).toBeDefined();
      expect(Array.isArray(data.prices)).toBeTruthy();
      expect(data.prices.length).toBeGreaterThan(0);
    });

    test('should fetch 5Y and 10Y historical data', async ({ request }) => {
      // Test 5Y data
      const response5y = await request.post(`${BASE_URL}/api/market-data/historical`, {
        data: {
          stockCode: 'BHP',
          period: '5y'
        },
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      expect(response5y.ok()).toBeTruthy();
      const data5y = await response5y.json();
      expect(data5y.prices.length).toBeGreaterThan(1000); // ~250 trading days per year
      
      // Test 10Y data
      const response10y = await request.post(`${BASE_URL}/api/market-data/historical`, {
        data: {
          stockCode: 'BHP',
          period: '10y'
        },
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      expect(response10y.ok()).toBeTruthy();
      const data10y = await response10y.json();
      expect(data10y.prices.length).toBeGreaterThan(2000); // ~250 trading days per year
    });

    test('should handle multiple stock quotes', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/market-data/multiple-quotes`, {
        data: {
          stockCodes: ['CBA', 'BHP', 'WOW']
        },
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.quotes).toBeDefined();
      expect(Object.keys(data.quotes).length).toBe(3);
    });
  });

  test.describe('Performance Tests', () => {
    test('should load homepage within 3 seconds', async ({ page }) => {
      const startTime = Date.now();
      await page.goto(BASE_URL);
      await page.waitForLoadState('networkidle');
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(3000);
    });

    test('should load stock analysis page within 3 seconds', async ({ page }) => {
      const startTime = Date.now();
      await page.goto(`${BASE_URL}/stocks`);
      await page.waitForLoadState('networkidle');
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(3000);
    });

    test('should fetch API data within 1 second', async ({ request }) => {
      const startTime = Date.now();
      const response = await request.post(`${BASE_URL}/api/market-data/historical`, {
        data: {
          stockCode: 'CBA',
          period: '1m'
        },
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const responseTime = Date.now() - startTime;
      
      expect(response.ok()).toBeTruthy();
      expect(responseTime).toBeLessThan(1000);
    });
  });

  test.describe('Error Handling', () => {
    test('should handle invalid stock codes gracefully', async ({ page }) => {
      await page.goto(`${BASE_URL}/stocks`);
      
      // Search for invalid stock
      await page.fill('input[placeholder*="stock code"]', 'INVALID');
      await page.click('button:has-text("Search")');
      
      // Should show no data or error message
      await expect(page.locator('text=/No data|not found/i')).toBeVisible({ timeout: 10000 });
    });

    test('should handle network errors gracefully', async ({ page, context }) => {
      // Block API calls
      await context.route('**/api/**', route => route.abort());
      
      await page.goto(`${BASE_URL}/stocks`);
      
      // Try to search
      await page.fill('input[placeholder*="stock code"]', 'CBA');
      await page.click('button:has-text("Search")');
      
      // Should not crash, may show loading or error state
      await page.waitForTimeout(2000);
      // Page should still be responsive
      await expect(page.locator('input[placeholder*="stock code"]')).toBeVisible();
    });
  });

  test.describe('Mobile Responsiveness', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('should be usable on mobile devices', async ({ page }) => {
      await page.goto(BASE_URL);
      
      // Check navigation is accessible
      const menuButton = page.locator('button[aria-label*="menu"], button:has-text("☰")');
      if (await menuButton.isVisible()) {
        await menuButton.click();
      }
      
      // Check main content is visible
      await expect(page.locator('h1')).toBeVisible();
      
      // Navigate to stocks page
      await page.goto(`${BASE_URL}/stocks`);
      await expect(page.locator('input[placeholder*="stock code"]')).toBeVisible();
      
      // Search should work on mobile
      await page.fill('input[placeholder*="stock code"]', 'CBA');
      await page.click('button:has-text("Search")');
      
      // Data should be displayed
      await expect(page.locator('text=/\\$[0-9]+\\.[0-9]+/')).toBeVisible({ timeout: 10000 });
    });
  });
});