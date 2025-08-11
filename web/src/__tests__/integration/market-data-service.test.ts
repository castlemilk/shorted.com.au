/**
 * Integration tests for market data service
 * Tests the connection and functionality of the market data API
 */

import { 
  getMultipleStockQuotes, 
  getHistoricalData, 
  getStockPrice, 
  getServiceStatus 
} from '@/lib/stock-data-service';

describe('Market Data Service Integration', () => {
  beforeAll(async () => {
    // Ensure the mock market data service is available
    const status = await getServiceStatus();
    if (!status.marketDataAPI) {
      console.warn('Market data API is not available. Make sure mock-market-data.js is running on port 8090');
    }
  });

  describe('Service Health Check', () => {
    it('should have market data API available', async () => {
      const status = await getServiceStatus();
      expect(status.marketDataAPI).toBe(true);
    });
  });

  describe('Stock Quotes', () => {
    it('should fetch multiple stock quotes', async () => {
      const stockCodes = ['CBA', 'BHP', 'CSL'];
      const quotes = await getMultipleStockQuotes(stockCodes);
      
      expect(quotes).toBeInstanceOf(Map);
      expect(quotes.size).toBeGreaterThan(0);
      
      // Check if we get data for at least one stock
      const firstQuote = quotes.values().next().value;
      expect(firstQuote).toHaveProperty('symbol');
      expect(firstQuote).toHaveProperty('price');
      expect(firstQuote).toHaveProperty('change');
      expect(firstQuote).toHaveProperty('changePercent');
    });

    it('should fetch single stock quote', async () => {
      const quote = await getStockPrice('CBA');
      
      expect(quote).not.toBeNull();
      if (quote) {
        expect(quote.symbol).toBe('CBA');
        expect(typeof quote.price).toBe('number');
        expect(typeof quote.change).toBe('number');
        expect(typeof quote.changePercent).toBe('number');
      }
    });

    it('should handle invalid stock codes gracefully', async () => {
      const quotes = await getMultipleStockQuotes(['INVALID_CODE']);
      expect(quotes.size).toBe(0);
    });
  });

  describe('Historical Data', () => {
    it('should fetch historical data for valid stock', async () => {
      const data = await getHistoricalData('CBA', '1m');
      
      expect(Array.isArray(data)).toBe(true);
      if (data.length > 0) {
        const firstDataPoint = data[0];
        expect(firstDataPoint).toHaveProperty('date');
        expect(firstDataPoint).toHaveProperty('open');
        expect(firstDataPoint).toHaveProperty('high');
        expect(firstDataPoint).toHaveProperty('low');
        expect(firstDataPoint).toHaveProperty('close');
        expect(firstDataPoint).toHaveProperty('volume');
      }
    });

    it('should handle different time periods', async () => {
      const periods = ['1d', '1w', '1m', '3m'];
      
      for (const period of periods) {
        const data = await getHistoricalData('CBA', period);
        expect(Array.isArray(data)).toBe(true);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // This test assumes the service might not be available
      try {
        const quotes = await getMultipleStockQuotes(['CBA']);
        // If successful, ensure we get valid data
        expect(quotes).toBeInstanceOf(Map);
      } catch (error) {
        // If error, ensure it's handled properly
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Unable to fetch');
      }
    });
  });
});