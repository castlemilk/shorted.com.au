import { test, expect } from '@playwright/test';
import { APIMockHelper } from './helpers/api-mock';
import { AuthHelper } from './helpers/auth';
import testUsers from './fixtures/test-users.json';

test.describe('Performance & Load Testing', () => {
  let apiMock: APIMockHelper;
  let authHelper: AuthHelper;

  test.beforeEach(async ({ page }) => {
    apiMock = new APIMockHelper(page);
    authHelper = new AuthHelper(page);
  });

  test('should load homepage within acceptable time limits', async ({ page }) => {
    await apiMock.mockSuccessfulResponses();
    
    const startTime = Date.now();
    await page.goto('/');
    
    // Wait for main content to be visible
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    const loadTime = Date.now() - startTime;
    
    // Homepage should load within 5 seconds
    expect(loadTime).toBeLessThan(5000);
    
    // Should also load treemap visualization
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg'))
    ).toBeVisible({ timeout: 3000 });
    
    const totalLoadTime = Date.now() - startTime;
    
    // Complete page with visualizations should load within 8 seconds
    expect(totalLoadTime).toBeLessThan(8000);
    
    console.log(`Homepage loaded in ${loadTime}ms, complete in ${totalLoadTime}ms`);
  });

  test('should handle large datasets efficiently', async ({ page }) => {
    // Mock large dataset response
    const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
      productCode: `STOCK${String(i).padStart(4, '0')}`,
      productName: `Test Company ${i}`,
      shortPosition: Math.random() * 20,
      percentageChange: (Math.random() - 0.5) * 10,
      sharesShorted: Math.floor(Math.random() * 10000000),
      totalShares: Math.floor(Math.random() * 100000000),
      marketCap: Math.floor(Math.random() * 10000000000),
      price: 10 + Math.random() * 100,
      volume: Math.floor(Math.random() * 1000000),
      date: new Date().toISOString()
    }));

    await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: largeDataset,
          metadata: {
            totalCount: largeDataset.length,
            period: '3m',
            lastUpdated: new Date().toISOString()
          }
        })
      });
    });

    const startTime = Date.now();
    await page.goto('/');
    
    // Should handle large dataset without hanging
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20000 });
    
    const renderTime = Date.now() - startTime;
    
    // Should render large dataset within reasonable time (20 seconds max)
    expect(renderTime).toBeLessThan(20000);
    
    // Check that pagination or virtualization is working
    const visibleRows = await page.locator('table tbody tr').count();
    
    // Should not render all 1000 rows at once (performance optimization)
    expect(visibleRows).toBeLessThan(200);
    
    // Page should remain responsive
    const scrollStart = Date.now();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(100);
    const scrollTime = Date.now() - scrollStart;
    
    // Scrolling should be responsive (< 500ms)
    expect(scrollTime).toBeLessThan(500);
    
    console.log(`Large dataset (${largeDataset.length} items) rendered in ${renderTime}ms`);
  });

  test('should render charts and visualizations efficiently', async ({ page }) => {
    await apiMock.mockSuccessfulResponses();
    
    // Test treemap rendering performance
    const treemapStartTime = Date.now();
    await page.goto('/treemap');
    
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg'))
    ).toBeVisible({ timeout: 15000 });
    
    const treemapRenderTime = Date.now() - treemapStartTime;
    
    // Treemap should render within 10 seconds
    expect(treemapRenderTime).toBeLessThan(10000);
    
    // Test stock chart rendering
    await page.goto('/shorts/CBA');
    
    const chartStartTime = Date.now();
    await expect(
      page.locator('[data-testid="stock-chart"]')
        .or(page.locator('.recharts-container'))
        .or(page.locator('svg'))
    ).toBeVisible({ timeout: 15000 });
    
    const chartRenderTime = Date.now() - chartStartTime;
    
    // Stock chart should render within 8 seconds
    expect(chartRenderTime).toBeLessThan(8000);
    
    // Test chart interactions performance
    const chart = page.locator('svg').first();
    if (await chart.isVisible()) {
      const interactionStart = Date.now();
      await chart.hover();
      
      // Should show tooltip quickly
      const tooltip = page.locator('[data-testid="tooltip"]')
        .or(page.locator('.tooltip'))
        .or(page.locator('[role="tooltip"]'));
      
      if (await tooltip.isVisible({ timeout: 2000 })) {
        const interactionTime = Date.now() - interactionStart;
        
        // Chart interactions should be responsive (< 1 second)
        expect(interactionTime).toBeLessThan(1000);
        
        console.log(`Chart interaction response time: ${interactionTime}ms`);
      }
    }
    
    console.log(`Treemap: ${treemapRenderTime}ms, Stock chart: ${chartRenderTime}ms`);
  });

  test('should handle rapid navigation efficiently', async ({ page }) => {
    await apiMock.mockSuccessfulResponses();
    
    const routes = ['/', '/treemap', '/shorts/CBA', '/shorts/BHP', '/'];
    const navigationTimes: number[] = [];
    
    for (let i = 0; i < routes.length; i++) {
      const startTime = Date.now();
      await page.goto(routes[i]);
      
      // Wait for page to load
      await Promise.race([
        page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 }),
        page.locator('svg').first().waitFor({ state: 'visible', timeout: 10000 }),
        page.locator('h1').waitFor({ state: 'visible', timeout: 5000 })
      ]);
      
      const navigationTime = Date.now() - startTime;
      navigationTimes.push(navigationTime);
      
      // Each navigation should complete within 8 seconds
      expect(navigationTime).toBeLessThan(8000);
      
      // Small delay between navigations
      await page.waitForTimeout(100);
    }
    
    // Average navigation time should be reasonable
    const averageTime = navigationTimes.reduce((a, b) => a + b) / navigationTimes.length;
    expect(averageTime).toBeLessThan(5000);
    
    console.log(`Navigation times: ${navigationTimes.join(', ')}ms, Average: ${averageTime.toFixed(0)}ms`);
  });

  test('should maintain performance under slow network conditions', async ({ page }) => {
    // Simulate slow 3G network
    await page.context().newPage();
    await page.route('**/*', async (route) => {
      // Add random delay to simulate slow network
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
      route.continue();
    });
    
    await apiMock.mockSuccessfulResponses();
    
    const startTime = Date.now();
    await page.goto('/');
    
    // Should show loading states promptly
    const loadingVisible = await page.locator('[data-testid="loading"]')
      .or(page.locator('.loading'))
      .or(page.locator('.spinner'))
      .isVisible({ timeout: 2000 });
    
    if (loadingVisible) {
      // Loading indicator should appear quickly even on slow network
      expect(Date.now() - startTime).toBeLessThan(2000);
    }
    
    // Eventually should load content
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 30000 });
    
    const totalTime = Date.now() - startTime;
    
    // Should complete within 30 seconds even on slow network
    expect(totalTime).toBeLessThan(30000);
    
    // Page should remain interactive
    const interactionStart = Date.now();
    await page.click('nav a').catch(() => {}); // Click navigation if available
    const interactionTime = Date.now() - interactionStart;
    
    // UI interactions should still be responsive
    expect(interactionTime).toBeLessThan(2000);
    
    console.log(`Slow network load time: ${totalTime}ms`);
  });

  test('should handle concurrent users and requests', async ({ context }) => {
    // Create multiple page contexts to simulate concurrent users
    const concurrentUsers = 5;
    const pages = await Promise.all(
      Array(concurrentUsers).fill(null).map(() => context.newPage())
    );
    
    // Set up API mocking for all pages
    for (const page of pages) {
      const mockHelper = new APIMockHelper(page);
      await mockHelper.mockSuccessfulResponses();
    }
    
    // Simulate concurrent access
    const startTime = Date.now();
    const loadPromises = pages.map(async (page, index) => {
      const userStartTime = Date.now();
      await page.goto('/');
      await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 20000 });
      const userLoadTime = Date.now() - userStartTime;
      
      console.log(`User ${index + 1} loaded in ${userLoadTime}ms`);
      return userLoadTime;
    });
    
    const loadTimes = await Promise.all(loadPromises);
    const totalConcurrentTime = Date.now() - startTime;
    
    // All users should load within reasonable time
    for (const loadTime of loadTimes) {
      expect(loadTime).toBeLessThan(15000);
    }
    
    // Concurrent access should not take excessively long
    expect(totalConcurrentTime).toBeLessThan(25000);
    
    const averageConcurrentTime = loadTimes.reduce((a, b) => a + b) / loadTimes.length;
    console.log(`${concurrentUsers} concurrent users, average load time: ${averageConcurrentTime.toFixed(0)}ms`);
    
    // Clean up
    await Promise.all(pages.map(page => page.close()));
  });

  test('should optimize resource loading and caching', async ({ page }) => {
    let requestCount = 0;
    const requestTypes: Record<string, number> = {};
    const resourceSizes: number[] = [];
    
    page.on('request', request => {
      requestCount++;
      const resourceType = request.resourceType();
      requestTypes[resourceType] = (requestTypes[resourceType] || 0) + 1;
    });
    
    page.on('response', response => {
      const contentLength = response.headers()['content-length'];
      if (contentLength) {
        resourceSizes.push(parseInt(contentLength));
      }
    });
    
    await apiMock.mockSuccessfulResponses();
    
    // Initial page load
    await page.goto('/');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    const initialRequestCount = requestCount;
    
    // Navigate to another page
    await page.goto('/treemap');
    await expect(page.locator('svg')).toBeVisible({ timeout: 15000 });
    
    // Navigate back
    await page.goto('/');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10000 });
    
    const finalRequestCount = requestCount;
    
    // Should use caching - subsequent requests should be fewer
    const cachedRequests = finalRequestCount - initialRequestCount;
    expect(cachedRequests).toBeLessThan(initialRequestCount);
    
    // Should not have excessive JavaScript requests
    expect(requestTypes['script'] || 0).toBeLessThan(20);
    
    // Should not have excessive stylesheet requests
    expect(requestTypes['stylesheet'] || 0).toBeLessThan(10);
    
    // Should not load excessively large resources
    const totalSize = resourceSizes.reduce((a, b) => a + b, 0);
    const averageSize = totalSize / resourceSizes.length;
    
    // Average resource size should be reasonable (< 500KB)
    expect(averageSize).toBeLessThan(500000);
    
    console.log(`Total requests: ${finalRequestCount}, Cached navigation requests: ${cachedRequests}`);
    console.log(`Request types:`, requestTypes);
    console.log(`Average resource size: ${(averageSize / 1024).toFixed(0)}KB`);
  });

  test('should maintain good Core Web Vitals metrics', async ({ page }) => {
    await apiMock.mockSuccessfulResponses();
    
    // Navigate to page and collect performance metrics
    await page.goto('/');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    
    // Collect Web Vitals metrics
    const metrics = await page.evaluate(() => {
      return new Promise((resolve) => {
        const vitals: any = {};
        
        // Largest Contentful Paint (LCP)
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastEntry = entries[entries.length - 1];
          vitals.lcp = lastEntry.startTime;
        }).observe({ entryTypes: ['largest-contentful-paint'] });
        
        // First Input Delay (FID) - simulated
        vitals.fid = 0; // Will be 0 in automated tests
        
        // Cumulative Layout Shift (CLS)
        let clsValue = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!(entry as any).hadRecentInput) {
              clsValue += (entry as any).value;
            }
          }
          vitals.cls = clsValue;
        }).observe({ entryTypes: ['layout-shift'] });
        
        // First Contentful Paint (FCP)
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          vitals.fcp = entries[0].startTime;
        }).observe({ entryTypes: ['paint'] });
        
        // Total Blocking Time (TBT) approximation
        const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (navigationEntry) {
          vitals.ttfb = navigationEntry.responseStart - navigationEntry.fetchStart;
          vitals.domContentLoaded = navigationEntry.domContentLoadedEventEnd - navigationEntry.fetchStart;
          vitals.loadComplete = navigationEntry.loadEventEnd - navigationEntry.fetchStart;
        }
        
        setTimeout(() => resolve(vitals), 2000);
      });
    });
    
    console.log('Web Vitals metrics:', metrics);
    
    // Assert Core Web Vitals thresholds
    if ((metrics as any).lcp) {
      // LCP should be under 2.5 seconds (good), under 4 seconds (acceptable)
      expect((metrics as any).lcp).toBeLessThan(4000);
    }
    
    if ((metrics as any).fcp) {
      // FCP should be under 1.8 seconds (good), under 3 seconds (acceptable)
      expect((metrics as any).fcp).toBeLessThan(3000);
    }
    
    if ((metrics as any).cls !== undefined) {
      // CLS should be under 0.1 (good), under 0.25 (acceptable)
      expect((metrics as any).cls).toBeLessThan(0.25);
    }
    
    if ((metrics as any).ttfb) {
      // TTFB should be under 600ms (good), under 1.5s (acceptable)
      expect((metrics as any).ttfb).toBeLessThan(1500);
    }
  });

  test('should handle memory usage efficiently during extended use', async ({ page }) => {
    await apiMock.mockSuccessfulResponses();
    
    // Navigate through multiple pages to test memory usage
    const routes = ['/', '/treemap', '/shorts/CBA', '/shorts/BHP', '/shorts/WBC'];
    
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const route of routes) {
        await page.goto(route);
        
        // Wait for page to load
        await Promise.race([
          page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 }),
          page.locator('svg').first().waitFor({ state: 'visible', timeout: 10000 }),
          page.locator('h1').waitFor({ state: 'visible', timeout: 5000 })
        ]);
        
        // Check memory usage
        const memoryUsage = await page.evaluate(() => {
          if ('memory' in performance) {
            return (performance as any).memory;
          }
          return null;
        });
        
        if (memoryUsage) {
          const memoryMB = memoryUsage.usedJSHeapSize / 1024 / 1024;
          
          // Memory usage should not exceed 100MB for typical usage
          expect(memoryMB).toBeLessThan(100);
          
          console.log(`Memory usage at ${route} (cycle ${cycle + 1}): ${memoryMB.toFixed(1)}MB`);
        }
        
        // Brief pause between navigations
        await page.waitForTimeout(200);
      }
    }
    
    // Force garbage collection if possible
    await page.evaluate(() => {
      if ('gc' in window) {
        (window as any).gc();
      }
    });
  });

  test('should optimize search and filtering performance', async ({ page }) => {
    // Mock large dataset for search testing
    const stockCodes = testUsers.testStockCodes;
    const searchData = stockCodes.map(code => ({
      code: code,
      name: `${code} Company Limited`,
      sector: 'Test Sector',
      price: 10 + Math.random() * 100,
      shortPosition: Math.random() * 20
    }));
    
    await page.route('**/api/search/stocks**', route => {
      const url = route.request().url();
      const searchParams = new URL(url).searchParams;
      const query = searchParams.get('q') || '';
      
      const results = searchData.filter(stock => 
        stock.code.toLowerCase().includes(query.toLowerCase()) ||
        stock.name.toLowerCase().includes(query.toLowerCase())
      );
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results })
      });
    });
    
    await page.goto('/');
    
    // Find search input
    const searchInput = page.locator('input[placeholder*="search"]')
      .or(page.locator('[data-testid="search-input"]'))
      .or(page.locator('input[type="search"]'));
    
    if (await searchInput.isVisible()) {
      // Test search performance
      const searchTerms = ['CBA', 'BHP', 'WBC', 'ANZ'];
      
      for (const term of searchTerms) {
        const searchStart = Date.now();
        await searchInput.fill(term);
        
        // Wait for search results
        await expect(
          page.locator('[data-testid="search-results"]')
            .or(page.locator('.search-dropdown'))
            .or(page.locator('[role="listbox"]'))
        ).toBeVisible({ timeout: 3000 });
        
        const searchTime = Date.now() - searchStart;
        
        // Search should be responsive (< 1 second)
        expect(searchTime).toBeLessThan(1000);
        
        console.log(`Search for "${term}" took ${searchTime}ms`);
        
        // Clear search for next iteration
        await searchInput.clear();
        await page.waitForTimeout(200);
      }
    }
    
    // Test filtering performance if available
    const filterControls = page.locator('select, [role="combobox"]').first();
    if (await filterControls.isVisible()) {
      const filterStart = Date.now();
      await filterControls.click();
      
      const options = page.getByRole('option');
      if (await options.first().isVisible({ timeout: 2000 })) {
        await options.first().click();
        
        // Wait for filtered results
        await page.waitForTimeout(1000);
        
        const filterTime = Date.now() - filterStart;
        
        // Filtering should be responsive (< 2 seconds)
        expect(filterTime).toBeLessThan(2000);
        
        console.log(`Filtering took ${filterTime}ms`);
      }
    }
  });

  test('should maintain performance across different device types', async ({ page, browserName }) => {
    await apiMock.mockSuccessfulResponses();
    
    // Test different viewport sizes representing different devices
    const deviceConfigs = [
      { name: 'Mobile', width: 375, height: 667, expectedLoadTime: 10000 },
      { name: 'Tablet', width: 768, height: 1024, expectedLoadTime: 8000 },
      { name: 'Desktop', width: 1920, height: 1080, expectedLoadTime: 6000 }
    ];
    
    for (const device of deviceConfigs) {
      await page.setViewportSize({ width: device.width, height: device.height });
      
      const startTime = Date.now();
      await page.goto('/');
      
      // Wait for main content
      await expect(
        page.locator('table tbody tr').first()
          .or(page.locator('h1'))
      ).toBeVisible({ timeout: device.expectedLoadTime });
      
      const loadTime = Date.now() - startTime;
      
      // Should load within device-specific expectations
      expect(loadTime).toBeLessThan(device.expectedLoadTime);
      
      // Test scroll performance on device
      const scrollStart = Date.now();
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(100);
      const scrollTime = Date.now() - scrollStart;
      
      // Scrolling should be smooth on all devices
      expect(scrollTime).toBeLessThan(500);
      
      console.log(`${device.name} (${device.width}x${device.height}): Load ${loadTime}ms, Scroll ${scrollTime}ms`);
    }
  });
});