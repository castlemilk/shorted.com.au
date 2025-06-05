import { test, expect } from '@playwright/test';

test.describe('API Integration', () => {
  test('should handle API connectivity issues gracefully', async ({ page }) => {
    // Mock API failure
    await page.route('**/shorts.v1alpha1.ShortedStocksService/GetTopShorts', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal Server Error' })
      });
    });

    await page.goto('/');
    
    // Should show error state or fallback UI
    await expect(page.locator('text=/error|failed|unavailable/i')).toBeVisible({ timeout: 10000 });
  });

  test('should handle slow API responses', async ({ page }) => {
    // Mock slow API response
    await page.route('**/shorts.v1alpha1.ShortedStocksService/GetTopShorts', async route => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [
            {
              productCode: 'TEST',
              name: 'Test Company',
              latestShortPosition: 5.5,
              points: []
            }
          ]
        })
      });
    });

    await page.goto('/');
    
    // Should show loading state
    await expect(page.locator('[data-testid="loading"]').or(page.locator('.loading'))).toBeVisible();
    
    // Then show data
    await expect(page.locator('text=TEST')).toBeVisible({ timeout: 5000 });
  });

  test('should handle empty API responses', async ({ page }) => {
    // Mock empty response
    await page.route('**/shorts.v1alpha1.ShortedStocksService/GetTopShorts', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ timeSeries: [] })
      });
    });

    await page.goto('/');
    
    // Should show empty state
    await expect(page.locator('text=/no data|empty|no stocks/i')).toBeVisible({ timeout: 10000 });
  });

  test('should retry failed requests', async ({ page }) => {
    let requestCount = 0;
    
    await page.route('**/shorts.v1alpha1.ShortedStocksService/GetTopShorts', route => {
      requestCount++;
      
      if (requestCount === 1) {
        // First request fails
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Server Error' })
        });
      } else {
        // Second request succeeds
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            timeSeries: [
              {
                productCode: 'CBA',
                name: 'Commonwealth Bank',
                latestShortPosition: 3.2,
                points: []
              }
            ]
          })
        });
      }
    });

    await page.goto('/');
    
    // Should eventually show data after retry
    await expect(page.locator('text=CBA')).toBeVisible({ timeout: 10000 });
    expect(requestCount).toBeGreaterThan(1);
  });

  test('should handle malformed API responses', async ({ page }) => {
    // Mock malformed response
    await page.route('**/shorts.v1alpha1.ShortedStocksService/GetTopShorts', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: 'invalid json'
      });
    });

    await page.goto('/');
    
    // Should handle gracefully with error state
    await expect(page.locator('text=/error|failed/i')).toBeVisible({ timeout: 10000 });
  });

  test('should validate API response structure', async ({ page }) => {
    let capturedRequest: any = null;
    
    await page.route('**/shorts.v1alpha1.ShortedStocksService/GetTopShorts', route => {
      capturedRequest = route.request();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [
            {
              productCode: 'BHP',
              name: 'BHP Group',
              latestShortPosition: 4.1,
              points: [
                {
                  timestamp: '2024-01-01',
                  shortPosition: 4.1
                }
              ]
            }
          ],
          offset: 0
        })
      });
    });

    await page.goto('/');
    
    // Verify data is displayed correctly
    await expect(page.locator('text=BHP')).toBeVisible();
    await expect(page.locator('text=4.1')).toBeVisible();
    
    // Verify request was made with correct headers
    expect(capturedRequest).toBeTruthy();
    expect(capturedRequest.headers()['content-type']).toContain('application/json');
  });

  test('should handle concurrent API requests', async ({ page }) => {
    let requestCount = 0;
    
    await page.route('**/shorts.v1alpha1.ShortedStocksService/**', route => {
      requestCount++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [],
          offset: 0
        })
      });
    });

    // Navigate to page that might make multiple API calls
    await page.goto('/');
    
    // Navigate to stock detail (which makes additional API calls)
    await page.goto('/stock/CBA');
    
    // Should handle multiple concurrent requests
    expect(requestCount).toBeGreaterThan(0);
  });
});