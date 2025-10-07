import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    // Support testing against:
    // 1. Vercel preview deployments (BASE_URL=https://pr-123.vercel.app)
    // 2. Local development server (default)
    baseURL: process.env.BASE_URL || 
             (process.env.E2E_TEST ? 'http://localhost:3001' : 'http://localhost:3020'),
    trace: 'on-first-retry',
    
    // Add backend URLs as extra context for tests
    extraHTTPHeaders: process.env.SHORTS_URL ? {
      'X-Test-Shorts-URL': process.env.SHORTS_URL,
      'X-Test-Market-Data-URL': process.env.MARKET_DATA_URL || '',
    } : {},
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },

    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});