import { Page, Route } from '@playwright/test';
import testUsers from '../fixtures/test-users.json';

export class APIMockHelper {
  constructor(private page: Page) {}

  /**
   * Mock successful API responses
   */
  async mockSuccessfulResponses() {
    await this.mockTopShorts();
    await this.mockStockDetails();
    await this.mockIndustryTreeMap();
    await this.mockStockData();
    await this.mockMarketData();
  }

  /**
   * Mock API error responses
   */
  async mockErrorResponses() {
    // Mock 500 errors
    await this.page.route('**/api/**', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Internal Server Error',
          message: 'Something went wrong'
        })
      });
    });
  }

  /**
   * Mock network timeouts
   */
  async mockNetworkTimeouts() {
    await this.page.route('**/api/**', (route) => {
      // Simulate timeout by never responding
      setTimeout(() => {
        route.abort('timeout');
      }, 30000);
    });
  }

  /**
   * Mock rate limiting
   */
  async mockRateLimitExceeded() {
    await this.page.route('**/api/**', (route) => {
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded'
        })
      });
    });
  }

  /**
   * Mock top shorts API
   */
  async mockTopShorts(period: string = '3m') {
    await this.page.route('**/shorts/v1alpha1/**/top-shorts', (route) => {
      const mockData = {
        timeSeries: Array.from({ length: 10 }, (_, i) => ({
          productCode: testUsers.testStockCodes[i] || `TST${i}`,
          productName: `Test Company ${i + 1}`,
          shortPosition: Math.random() * 20,
          percentageChange: (Math.random() - 0.5) * 10,
          sharesShorted: Math.floor(Math.random() * 1000000),
          totalShares: Math.floor(Math.random() * 10000000),
          marketCap: Math.floor(Math.random() * 10000000000),
          price: 10 + Math.random() * 100,
          change: (Math.random() - 0.5) * 5,
          volume: Math.floor(Math.random() * 1000000),
          date: new Date().toISOString()
        })),
        metadata: {
          totalCount: 10,
          period: period,
          lastUpdated: new Date().toISOString()
        }
      };

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockData)
      });
    });
  }

  /**
   * Mock stock details API
   */
  async mockStockDetails(stockCode: string = 'CBA') {
    await this.page.route(`**/shorts/v1alpha1/**/stock/${stockCode}`, (route) => {
      const mockData = {
        productCode: stockCode,
        productName: 'Commonwealth Bank of Australia',
        currentPrice: 95.50,
        change: 1.25,
        percentChange: 1.33,
        volume: 2500000,
        marketCap: 164000000000,
        pe: 15.2,
        eps: 6.28,
        dividend: 2.10,
        dividendYield: 2.20,
        high52Week: 115.00,
        low52Week: 85.00,
        sharesOutstanding: 1716000000,
        industry: 'Banks',
        sector: 'Financials',
        description: 'Commonwealth Bank of Australia provides integrated financial services.',
        website: 'https://www.commbank.com.au',
        logo: 'https://example.com/cba-logo.png'
      };

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockData)
      });
    });
  }

  /**
   * Mock industry tree map API
   */
  async mockIndustryTreeMap() {
    await this.page.route('**/shorts/v1alpha1/**/industry-treemap', (route) => {
      const mockData = {
        children: [
          {
            name: 'Financials',
            value: 35.5,
            children: [
              { name: 'CBA', value: 8.2, code: 'CBA' },
              { name: 'WBC', value: 7.1, code: 'WBC' },
              { name: 'ANZ', value: 6.8, code: 'ANZ' },
              { name: 'NAB', value: 6.4, code: 'NAB' }
            ]
          },
          {
            name: 'Materials',
            value: 28.3,
            children: [
              { name: 'BHP', value: 12.5, code: 'BHP' },
              { name: 'RIO', value: 8.9, code: 'RIO' },
              { name: 'FMG', value: 4.2, code: 'FMG' }
            ]
          },
          {
            name: 'Healthcare',
            value: 15.8,
            children: [
              { name: 'CSL', value: 9.2, code: 'CSL' },
              { name: 'COH', value: 3.1, code: 'COH' }
            ]
          }
        ]
      };

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockData)
      });
    });
  }

  /**
   * Mock stock historical data
   */
  async mockStockData(stockCode: string = 'CBA') {
    await this.page.route(`**/shorts/v1alpha1/**/stock/${stockCode}/data`, (route) => {
      const mockData = {
        timeSeries: Array.from({ length: 30 }, (_, i) => ({
          date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
          shortPosition: 5 + Math.random() * 10,
          price: 90 + Math.random() * 20,
          volume: Math.floor(1000000 + Math.random() * 2000000),
          change: (Math.random() - 0.5) * 5
        })).reverse()
      };

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockData)
      });
    });
  }

  /**
   * Mock market data APIs
   */
  async mockMarketData() {
    // Mock stock search
    await this.page.route('**/api/search/stocks**', (route) => {
      const url = route.request().url();
      const searchParams = new URL(url).searchParams;
      const query = searchParams.get('q') || '';

      const mockResults = testUsers.testStockCodes
        .filter(code => code.toLowerCase().includes(query.toLowerCase()))
        .map(code => ({
          code: code,
          name: `${code} Company Limited`,
          sector: 'Test Sector',
          price: 10 + Math.random() * 100
        }));

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: mockResults })
      });
    });

    // Mock historical data
    await this.page.route('**/api/market-data/historical**', (route) => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        open: 50 + Math.random() * 50,
        high: 55 + Math.random() * 55,
        low: 45 + Math.random() * 45,
        close: 50 + Math.random() * 50,
        volume: Math.floor(Math.random() * 1000000)
      })).reverse();

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: mockData })
      });
    });

    // Mock correlations
    await this.page.route('**/api/market-data/correlations**', (route) => {
      const mockData = testUsers.testStockCodes.reduce((acc, code1) => {
        acc[code1] = testUsers.testStockCodes.reduce((inner, code2) => {
          inner[code2] = code1 === code2 ? 1 : Math.random() * 2 - 1;
          return inner;
        }, {});
        return acc;
      }, {});

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ correlations: mockData })
      });
    });
  }

  /**
   * Mock authentication APIs
   */
  async mockAuthAPIs() {
    // Mock login
    await this.page.route('**/api/auth/signin', (route) => {
      const request = route.request();
      const postData = request.postDataJSON();

      if (postData.email === testUsers.validUser.email && postData.password === testUsers.validUser.password) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: testUsers.validUser.uid,
              email: testUsers.validUser.email,
              name: testUsers.validUser.name
            },
            token: 'mock-jwt-token'
          })
        });
      } else {
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Invalid credentials'
          })
        });
      }
    });

    // Mock registration
    await this.page.route('**/api/auth/signup', (route) => {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'new-user-id',
            email: testUsers.newUser.email,
            name: testUsers.newUser.name
          },
          message: 'Registration successful'
        })
      });
    });

    // Mock session
    await this.page.route('**/api/auth/session', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: testUsers.validUser.uid,
            email: testUsers.validUser.email,
            name: testUsers.validUser.name
          }
        })
      });
    });
  }

  /**
   * Mock slow responses for performance testing
   */
  async mockSlowResponses(delayMs: number = 3000) {
    await this.page.route('**/api/**', async (route) => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      route.continue();
    });
  }

  /**
   * Clear all mocked routes
   */
  async clearMocks() {
    await this.page.unrouteAll();
  }

  /**
   * Mock specific error for a route
   */
  async mockRouteError(urlPattern: string, statusCode: number = 500, message: string = 'Server Error') {
    await this.page.route(urlPattern, (route) => {
      route.fulfill({
        status: statusCode,
        contentType: 'application/json',
        body: JSON.stringify({
          error: message,
          statusCode: statusCode
        })
      });
    });
  }

  /**
   * Mock loading states
   */
  async mockLoadingStates(delayMs: number = 2000) {
    await this.page.route('**/api/**', async (route) => {
      // Add delay to simulate loading
      await new Promise(resolve => setTimeout(resolve, delayMs));
      route.continue();
    });
  }
}