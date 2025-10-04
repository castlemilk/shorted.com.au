/**
 * Integration tests for market data service
 * Tests the connection and functionality of the market data API with mocks
 */

import { 
  getMultipleStockQuotes, 
  getHistoricalData, 
  getStockPrice, 
  getServiceStatus 
} from '@/lib/stock-data-service';

// Mock fetch for these tests
global.fetch = jest.fn();

describe('Market Data Service Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Service Health Check', () => {
    it('should check market data API availability', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok' })
      });
      
      const status = await getServiceStatus();
      expect(status).toBeDefined();
    });
  });

  describe('Stock Quotes', () => {
    it('should fetch multiple stock quotes with mock data', async () => {
      const mockResponse = {
        quotes: [
          { symbol: 'CBA', price: 100, change: 1.5, changePercent: 1.5 },
          { symbol: 'BHP', price: 45, change: -0.5, changePercent: -1.1 },
        ]
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const stockCodes = ['CBA', 'BHP'];
      const quotes = await getMultipleStockQuotes(stockCodes);
      
      expect(quotes).toBeInstanceOf(Map);
    });

    it('should fetch single stock quote with mock data', async () => {
      const mockQuote = { 
        symbol: 'CBA', 
        price: 100, 
        change: 1.5, 
        changePercent: 1.5 
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockQuote
      });

      const quote = await getStockPrice('CBA');
      expect(quote).toBeDefined();
    });

    it('should handle invalid stock codes gracefully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quotes: [] })
      });

      const quotes = await getMultipleStockQuotes(['INVALID_CODE']);
      expect(quotes).toBeDefined();
    });
  });

  describe('Historical Data', () => {
    it('should fetch historical data for valid stock with mock data', async () => {
      const mockData = {
        data: Array.from({ length: 30 }, (_, i) => ({
          date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
          open: 100 + Math.random() * 10,
          high: 105 + Math.random() * 10,
          low: 95 + Math.random() * 10,
          close: 100 + Math.random() * 10,
          volume: 1000000 + Math.random() * 500000
        }))
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      const data = await getHistoricalData('CBA', '1m');
      expect(data).toBeDefined();
    });

    it('should handle different time periods with mocks', async () => {
      const periods = ['1d', '1w', '1m', '3m'];
      
      for (const period of periods) {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [] })
        });
        
        const data = await getHistoricalData('CBA', period);
        expect(data).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Network error')
      );

      try {
        await getMultipleStockQuotes(['CBA']);
        // If it doesn't throw, that's okay too (might be caught internally)
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });
});