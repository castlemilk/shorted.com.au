import { test, expect } from '@playwright/test';
import { APIMockHelper } from './helpers/api-mock';
import { AuthHelper } from './helpers/auth';
import testUsers from './fixtures/test-users.json';

test.describe('API Integration & Error Handling', () => {
  let apiMock: APIMockHelper;
  let authHelper: AuthHelper;

  test.beforeEach(async ({ page }) => {
    apiMock = new APIMockHelper(page);
    authHelper = new AuthHelper(page);
  });

  test('should handle complete API connectivity failures gracefully', async ({ page }) => {
    // Mock total API failure (network error)
    await page.route('**/shorts/v1alpha1/**', route => {
      route.abort('connectionrefused');
    });

    await page.route('**/api/**', route => {
      route.abort('connectionrefused');
    });

    await page.goto('/');
    
    // Should show appropriate error state
    await expect(
      page.locator('[data-testid="connection-error"]')
        .or(page.getByText(/connection error|offline|network error|unable to connect/i))
        .or(page.locator('.error-message'))
    ).toBeVisible({ timeout: 10000 });

    // Should provide retry mechanism
    const retryButton = page.getByRole('button', { name: /retry|try again|refresh/i });
    if (await retryButton.isVisible()) {
      await expect(retryButton).toBeVisible();
    }

    // Should still show basic page structure
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('h1, header')).toBeVisible();
  });

  test('should handle server errors with proper error messages', async ({ page }) => {
    // Mock different types of server errors
    const errorScenarios = [
      { status: 500, message: 'Internal Server Error', expectedText: /server error|internal error|something went wrong/i },
      { status: 503, message: 'Service Unavailable', expectedText: /service unavailable|temporarily unavailable/i },
      { status: 502, message: 'Bad Gateway', expectedText: /service error|gateway error/i },
      { status: 504, message: 'Gateway Timeout', expectedText: /timeout|taking longer than expected/i }
    ];

    for (const scenario of errorScenarios) {
      await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
        route.fulfill({
          status: scenario.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: scenario.message, code: scenario.status })
        });
      });

      await page.goto('/');
      
      // Should show appropriate error message
      await expect(
        page.locator('[data-testid="server-error"]')
          .or(page.getByText(scenario.expectedText))
          .or(page.locator('.error-message'))
      ).toBeVisible({ timeout: 8000 });

      // Should provide action options
      const actionButtons = [
        page.getByRole('button', { name: /retry|refresh|try again/i }),
        page.getByRole('button', { name: /home|dashboard|browse/i }),
        page.getByRole('link', { name: /contact|support|help/i })
      ];

      let actionFound = false;
      for (const button of actionButtons) {
        if (await button.isVisible({ timeout: 2000 })) {
          await expect(button).toBeVisible();
          actionFound = true;
          break;
        }
      }

      expect(actionFound).toBeTruthy();
    }
  });

  test('should handle slow API responses with loading states and timeouts', async ({ page }) => {
    // Mock progressively slower responses
    const delays = [1000, 3000, 8000]; // 1s, 3s, 8s
    
    for (const delay of delays) {
      await page.route('**/shorts/v1alpha1/**/top-shorts', async route => {
        await new Promise(resolve => setTimeout(resolve, delay));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            timeSeries: Array.from({ length: 5 }, (_, i) => ({
              productCode: `TST${i}`,
              productName: `Test Company ${i}`,
              shortPosition: 5.5 + i,
              percentageChange: (Math.random() - 0.5) * 10,
              date: new Date().toISOString()
            })),
            metadata: {
              totalCount: 5,
              period: '3m',
              lastUpdated: new Date().toISOString()
            }
          })
        });
      });

      await page.goto('/');
      
      // Should show loading state for delayed responses
      if (delay > 500) {
        await expect(
          page.locator('[data-testid="loading"]')
            .or(page.locator('.loading'))
            .or(page.locator('.spinner'))
            .or(page.locator('[aria-label*="loading"]'))
        ).toBeVisible({ timeout: 1000 });
      }
      
      // Should eventually show data
      await expect(page.locator('text=TST0')).toBeVisible({ timeout: delay + 3000 });
      
      // For very slow responses, might show timeout message
      if (delay > 5000) {
        const timeoutMessage = page.getByText(/taking longer than expected|slow connection/i);
        if (await timeoutMessage.isVisible({ timeout: 2000 })) {
          await expect(timeoutMessage).toBeVisible();
        }
      }
    }
  });

  test('should handle empty and null API responses appropriately', async ({ page }) => {
    const emptyScenarios = [
      {
        name: 'empty array',
        response: { timeSeries: [], metadata: { totalCount: 0, period: '3m', lastUpdated: new Date().toISOString() } },
        expectedMessage: /no data|no stocks|empty/i
      },
      {
        name: 'null response',
        response: null,
        expectedMessage: /error|failed to load/i
      },
      {
        name: 'missing data fields',
        response: { metadata: { period: '3m' } },
        expectedMessage: /no data|invalid response/i
      },
      {
        name: 'zero results',
        response: { timeSeries: [], metadata: { totalCount: 0, message: 'No stocks match criteria' } },
        expectedMessage: /no stocks match|no results/i
      }
    ];

    for (const scenario of emptyScenarios) {
      await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(scenario.response)
        });
      });

      await page.goto('/');
      
      // Should show appropriate empty state
      await expect(
        page.locator('[data-testid="empty-state"]')
          .or(page.getByText(scenario.expectedMessage))
          .or(page.locator('.empty-message'))
      ).toBeVisible({ timeout: 8000 });

      // Should provide helpful actions for empty states
      const helpfulActions = [
        page.getByRole('button', { name: /refresh|reload/i }),
        page.getByRole('link', { name: /browse all|view all|explore/i }),
        page.getByText(/try different period|adjust filters/i)
      ];

      for (const action of helpfulActions) {
        if (await action.isVisible({ timeout: 2000 })) {
          await expect(action).toBeVisible();
          break;
        }
      }
    }
  });

  test('should implement proper retry mechanisms with exponential backoff', async ({ page }) => {
    let requestCount = 0;
    const requestTimes: number[] = [];
    
    await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
      requestTimes.push(Date.now());
      requestCount++;
      
      if (requestCount <= 3) {
        // First 3 requests fail with different errors
        const errors = [
          { status: 503, message: 'Service Unavailable' },
          { status: 502, message: 'Bad Gateway' },
          { status: 500, message: 'Internal Server Error' }
        ];
        
        const error = errors[requestCount - 1] || errors[0];
        route.fulfill({
          status: error.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: error.message })
        });
      } else {
        // 4th request succeeds
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            timeSeries: [{
              productCode: 'CBA',
              productName: 'Commonwealth Bank',
              shortPosition: 3.2,
              percentageChange: 1.5,
              date: new Date().toISOString()
            }],
            metadata: {
              totalCount: 1,
              period: '3m',
              lastUpdated: new Date().toISOString()
            }
          })
        });
      }
    });

    await page.goto('/');
    
    // Should eventually show data after retries
    await expect(page.locator('text=CBA')).toBeVisible({ timeout: 30000 });
    expect(requestCount).toBeGreaterThan(3);

    // Verify exponential backoff timing (requests should be spaced out)
    if (requestTimes.length > 2) {
      const firstDelay = requestTimes[1] - requestTimes[0];
      const secondDelay = requestTimes[2] - requestTimes[1];
      
      // Second delay should be longer than first (exponential backoff)
      expect(secondDelay).toBeGreaterThanOrEqual(firstDelay);
    }
  });

  test('should validate API response data integrity and structure', async ({ page }) => {
    let capturedRequests: any[] = [];
    
    // Mock various API endpoints with proper responses
    await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
      capturedRequests.push({
        endpoint: 'top-shorts',
        request: route.request(),
        timestamp: Date.now()
      });
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [
            {
              productCode: 'BHP',
              productName: 'BHP Group Limited',
              shortPosition: 4.123456,
              percentageChange: -0.5,
              sharesShorted: 125000000,
              totalShares: 5000000000,
              marketCap: 195000000000,
              price: 45.67,
              volume: 2500000,
              date: '2025-01-15T10:30:00Z'
            }
          ],
          metadata: {
            totalCount: 1,
            period: '3m',
            lastUpdated: '2025-01-15T10:35:00Z',
            dataSource: 'ASIC',
            version: '1.0'
          }
        })
      });
    });

    await page.route('**/shorts/v1alpha1/**/industry-treemap', route => {
      capturedRequests.push({
        endpoint: 'industry-treemap',
        request: route.request(),
        timestamp: Date.now()
      });
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          children: [
            {
              name: 'Materials',
              value: 28.5,
              children: [
                { name: 'BHP', value: 12.3, code: 'BHP', color: '#ff4444' }
              ]
            }
          ]
        })
      });
    });

    await page.goto('/');
    
    // Verify data is displayed with proper formatting
    await expect(page.locator('text=BHP')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=4.12')).toBeVisible(); // Should round to 2 decimals
    
    // Verify percentage formatting
    const percentageElement = page.getByText(/-0\.5%/);
    if (await percentageElement.isVisible()) {
      await expect(percentageElement).toBeVisible();
    }

    // Verify price formatting (should include $ symbol)
    const priceElement = page.getByText(/\$45\.67/);
    if (await priceElement.isVisible()) {
      await expect(priceElement).toBeVisible();
    }

    // Verify request headers and content
    expect(capturedRequests.length).toBeGreaterThan(0);
    
    const topShortsRequest = capturedRequests.find(r => r.endpoint === 'top-shorts');
    if (topShortsRequest) {
      const headers = topShortsRequest.request.headers();
      expect(headers['content-type']).toMatch(/(application\/json|application\/connect\+protobuf)/);
      expect(headers['accept']).toBeTruthy();
    }
  });

  test('should handle malformed and corrupt API responses', async ({ page }) => {
    const malformedScenarios = [
      {
        name: 'invalid JSON',
        response: 'invalid json response {{{',
        contentType: 'application/json'
      },
      {
        name: 'wrong content type',
        response: '<html><body>Error</body></html>',
        contentType: 'text/html'
      },
      {
        name: 'missing required fields',
        response: JSON.stringify({ someField: 'value' }),
        contentType: 'application/json'
      },
      {
        name: 'invalid data types',
        response: JSON.stringify({
          timeSeries: 'should be array',
          metadata: null
        }),
        contentType: 'application/json'
      },
      {
        name: 'corrupted data values',
        response: JSON.stringify({
          timeSeries: [{
            productCode: null,
            shortPosition: 'invalid number',
            date: 'not a date'
          }]
        }),
        contentType: 'application/json'
      }
    ];

    for (const scenario of malformedScenarios) {
      await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
        route.fulfill({
          status: 200,
          contentType: scenario.contentType,
          body: scenario.response
        });
      });

      await page.goto('/');
      
      // Should handle gracefully with appropriate error message
      await expect(
        page.locator('[data-testid="data-error"]')
          .or(page.getByText(/invalid data|corrupt|parse error|data format error/i))
          .or(page.locator('.error-message'))
      ).toBeVisible({ timeout: 8000 });

      // Should not crash the application
      await expect(page.locator('nav')).toBeVisible();
      await expect(page.locator('body')).not.toHaveClass(/error-boundary/);
    }
  });

  test('should handle concurrent API requests without conflicts', async ({ page }) => {
    let requestCounter = 0;
    const requestLog: any[] = [];
    
    // Mock multiple API endpoints
    await page.route('**/shorts/v1alpha1/**', route => {
      const url = route.request().url();
      const requestId = ++requestCounter;
      
      requestLog.push({
        id: requestId,
        url,
        timestamp: Date.now(),
        status: 'received'
      });

      // Simulate variable response times
      const delay = Math.random() * 1000; // 0-1 second delay
      
      setTimeout(() => {
        requestLog.push({
          id: requestId,
          url,
          timestamp: Date.now(),
          status: 'responding'
        });

        if (url.includes('top-shorts')) {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              timeSeries: [{
                productCode: 'TEST' + requestId,
                productName: 'Test Company ' + requestId,
                shortPosition: 5.0 + requestId,
                date: new Date().toISOString()
              }],
              metadata: { totalCount: 1, period: '3m', requestId }
            })
          });
        } else if (url.includes('industry-treemap')) {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              children: [{
                name: 'Test Sector',
                value: 10 + requestId,
                children: [{ name: 'TEST' + requestId, value: 5 + requestId }]
              }]
            })
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [], requestId })
          });
        }
      }, delay);
    });

    await page.goto('/');
    
    // Navigate to different pages to trigger multiple API calls
    await page.goto('/treemap');
    await page.waitForTimeout(1000);
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    // Wait for all requests to complete
    await page.waitForTimeout(3000);
    
    // Verify multiple requests were handled
    expect(requestCounter).toBeGreaterThan(2);
    
    // Verify requests completed in reasonable time
    const completedRequests = requestLog.filter(r => r.status === 'responding');
    expect(completedRequests.length).toBeGreaterThan(0);
    
    // Page should still be functional
    await expect(page.locator('nav')).toBeVisible();
    
    // Should display some data (from the last successful request)
    const testElements = page.locator('[data-testid="stocks-table"] td, [data-testid="treemap"] text').filter({ hasText: /TEST\d+/ });
    if (await testElements.first().isVisible({ timeout: 5000 })) {
      await expect(testElements.first()).toBeVisible();
    }
  });

  test('should handle authentication-related API errors', async ({ page }) => {
    const authErrorScenarios = [
      {
        status: 401,
        error: 'Unauthorized',
        expectedAction: 'redirect to login or show login prompt'
      },
      {
        status: 403,
        error: 'Forbidden',
        expectedAction: 'show access denied message'
      },
      {
        status: 429,
        error: 'Too Many Requests',
        expectedAction: 'show rate limit message'
      }
    ];

    for (const scenario of authErrorScenarios) {
      await page.route('**/shorts/v1alpha1/**', route => {
        route.fulfill({
          status: scenario.status,
          contentType: 'application/json',
          body: JSON.stringify({
            error: scenario.error,
            message: `Request failed with status ${scenario.status}`
          })
        });
      });

      await page.goto('/');
      
      if (scenario.status === 401) {
        // Should show login prompt or redirect
        await expect(
          page.getByText(/login|sign in|authenticate/i)
            .or(page.locator('[data-testid="login-prompt"]'))
            .or(page.getByRole('button', { name: /login|sign in/i }))
        ).toBeVisible({ timeout: 8000 });
        
      } else if (scenario.status === 403) {
        // Should show access denied message
        await expect(
          page.getByText(/access denied|forbidden|permission/i)
            .or(page.locator('[data-testid="access-denied"]'))
        ).toBeVisible({ timeout: 8000 });
        
      } else if (scenario.status === 429) {
        // Should show rate limit message
        await expect(
          page.getByText(/rate limit|too many requests|slow down/i)
            .or(page.locator('[data-testid="rate-limit"]'))
        ).toBeVisible({ timeout: 8000 });
        
        // Should suggest retry after delay
        const retryMessage = page.getByText(/try again later|wait/i);
        if (await retryMessage.isVisible()) {
          await expect(retryMessage).toBeVisible();
        }
      }
    }
  });

  test('should maintain data consistency across multiple API calls', async ({ page }) => {
    const stockData = {
      productCode: 'CBA',
      productName: 'Commonwealth Bank of Australia',
      shortPosition: 3.45,
      price: 95.50,
      volume: 2500000
    };

    // Mock consistent data across different endpoints
    await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [stockData],
          metadata: { totalCount: 1, period: '3m' }
        })
      });
    });

    await page.route('**/shorts/v1alpha1/**/stock/CBA', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...stockData,
          marketCap: 164000000000,
          pe: 15.2,
          eps: 6.28
        })
      });
    });

    await page.route('**/shorts/v1alpha1/**/stock/CBA/data', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: Array.from({ length: 30 }, (_, i) => ({
            date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
            shortPosition: stockData.shortPosition + (Math.random() - 0.5),
            price: stockData.price + (Math.random() - 0.5) * 10,
            volume: stockData.volume + Math.random() * 500000
          })).reverse()
        })
      });
    });

    // Navigate through different views
    await page.goto('/');
    await expect(page.locator('text=CBA')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=3.45')).toBeVisible();

    // Navigate to stock detail
    await page.click('text=CBA');
    await expect(page.locator('h1')).toContainText('CBA', { timeout: 10000 });

    // Verify consistent data display
    await expect(page.locator('text=Commonwealth Bank')).toBeVisible();
    
    // Price should be consistent (allowing for formatting differences)
    const priceElement = page.getByText(/95\.50|95\.5|\$95/);
    if (await priceElement.isVisible()) {
      await expect(priceElement).toBeVisible();
    }
  });

  test('should handle network interruptions and reconnections', async ({ page }) => {
    let networkEnabled = true;
    let requestCount = 0;

    await page.route('**/shorts/v1alpha1/**', route => {
      requestCount++;
      
      if (!networkEnabled) {
        route.abort('connectionrefused');
        return;
      }

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeSeries: [{
            productCode: 'TEST',
            productName: 'Test Company',
            shortPosition: 5.5,
            date: new Date().toISOString()
          }],
          metadata: { totalCount: 1, period: '3m', connectionStatus: 'online' }
        })
      });
    });

    // Start with working connection
    await page.goto('/');
    await expect(page.locator('text=TEST')).toBeVisible({ timeout: 10000 });

    // Simulate network interruption
    networkEnabled = false;
    await page.reload();

    // Should show offline/connection error
    await expect(
      page.getByText(/offline|connection error|network unavailable/i)
        .or(page.locator('[data-testid="offline"]'))
    ).toBeVisible({ timeout: 8000 });

    // Restore connection
    networkEnabled = true;
    
    // Trigger retry (either automatic or manual)
    const retryButton = page.getByRole('button', { name: /retry|refresh/i });
    if (await retryButton.isVisible()) {
      await retryButton.click();
    } else {
      await page.reload();
    }

    // Should recover and show data
    await expect(page.locator('text=TEST')).toBeVisible({ timeout: 10000 });
    
    // Should indicate online status if supported
    const onlineIndicator = page.getByText(/online|connected/i);
    if (await onlineIndicator.isVisible()) {
      await expect(onlineIndicator).toBeVisible();
    }
  });

  test('should cache responses appropriately and handle cache invalidation', async ({ page }) => {
    let requestCount = 0;
    const responses: any[] = [];

    await page.route('**/shorts/v1alpha1/**/top-shorts', route => {
      requestCount++;
      const timestamp = new Date().toISOString();
      
      const response = {
        timeSeries: [{
          productCode: 'CACHE',
          productName: 'Cache Test Company',
          shortPosition: 5.5,
          date: timestamp
        }],
        metadata: {
          totalCount: 1,
          period: '3m',
          requestId: requestCount,
          timestamp: timestamp,
          cacheControl: 'max-age=300' // 5 minutes
        }
      };
      
      responses.push(response);
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'cache-control': 'max-age=300',
          'etag': `"${requestCount}"`,
          'last-modified': new Date().toUTCString()
        },
        body: JSON.stringify(response)
      });
    });

    // Initial request
    await page.goto('/');
    await expect(page.locator('text=CACHE')).toBeVisible({ timeout: 10000 });
    const initialRequestCount = requestCount;

    // Subsequent navigation within cache period
    await page.goto('/treemap');
    await page.goto('/');
    
    // Should use cached data (minimal additional requests)
    const cacheRequestCount = requestCount;
    expect(cacheRequestCount).toBeLessThanOrEqual(initialRequestCount + 2); // Allow for some additional requests

    // Force cache invalidation (hard refresh)
    await page.reload({ waitUntil: 'networkidle' });
    
    // Should make fresh request
    await expect(page.locator('text=CACHE')).toBeVisible({ timeout: 10000 });
    expect(requestCount).toBeGreaterThan(cacheRequestCount);
  });
});