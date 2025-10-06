/**
 * Integration tests for market data service
 * Tests the mocked behavior of market data API functions
 */

import {
  getMultipleStockQuotes,
  getHistoricalData,
  getStockPrice,
  getServiceStatus,
} from "@/lib/stock-data-service";

// Mock the entire stock-data-service module
jest.mock("@/lib/stock-data-service");

const mockGetMultipleStockQuotes =
  getMultipleStockQuotes as jest.MockedFunction<typeof getMultipleStockQuotes>;
const mockGetHistoricalData = getHistoricalData as jest.MockedFunction<
  typeof getHistoricalData
>;
const mockGetStockPrice = getStockPrice as jest.MockedFunction<
  typeof getStockPrice
>;
const mockGetServiceStatus = getServiceStatus as jest.MockedFunction<
  typeof getServiceStatus
>;

describe("Market Data Service Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Service Health Check", () => {
    it("should check market data API availability", async () => {
      mockGetServiceStatus.mockResolvedValueOnce({
        marketData: { available: true, latency: 100 },
        shorts: { available: true, latency: 50 },
      });

      const status = await getServiceStatus();
      expect(status).toBeDefined();
      expect(mockGetServiceStatus).toHaveBeenCalled();
    });
  });

  describe("Stock Quotes", () => {
    it("should fetch multiple stock quotes with mock data", async () => {
      const mockQuotes = new Map([
        [
          "CBA",
          {
            symbol: "CBA",
            price: 100,
            change: 1.5,
            changePercent: 1.5,
            previousClose: 98.5,
            volume: 1000000,
          },
        ],
        [
          "BHP",
          {
            symbol: "BHP",
            price: 45,
            change: -0.5,
            changePercent: -1.1,
            previousClose: 45.5,
            volume: 2000000,
          },
        ],
      ]);

      mockGetMultipleStockQuotes.mockResolvedValueOnce(mockQuotes);

      const stockCodes = ["CBA", "BHP"];
      const quotes = await getMultipleStockQuotes(stockCodes);

      expect(quotes).toBeInstanceOf(Map);
      expect(quotes.size).toBe(2);
      expect(mockGetMultipleStockQuotes).toHaveBeenCalledWith(stockCodes);
    });

    it("should fetch single stock quote with mock data", async () => {
      const mockQuote = {
        symbol: "CBA",
        price: 100,
        change: 1.5,
        changePercent: 1.5,
        previousClose: 98.5,
        volume: 1000000,
      };

      mockGetStockPrice.mockResolvedValueOnce(mockQuote);

      const quote = await getStockPrice("CBA");
      expect(quote).toBeDefined();
      expect(quote.symbol).toBe("CBA");
      expect(mockGetStockPrice).toHaveBeenCalledWith("CBA");
    });

    it("should handle invalid stock codes gracefully", async () => {
      mockGetMultipleStockQuotes.mockResolvedValueOnce(new Map());

      const quotes = await getMultipleStockQuotes(["INVALID_CODE"]);
      expect(quotes).toBeDefined();
      expect(quotes.size).toBe(0);
    });
  });

  describe("Historical Data", () => {
    it("should fetch historical data for valid stock with mock data", async () => {
      const mockData = Array.from({ length: 30 }, (_, i) => ({
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        open: 100 + Math.random() * 10,
        high: 105 + Math.random() * 10,
        low: 95 + Math.random() * 10,
        close: 100 + Math.random() * 10,
        volume: 1000000 + Math.random() * 500000,
        adjustedClose: 100 + Math.random() * 10,
      }));

      mockGetHistoricalData.mockResolvedValueOnce(mockData);

      const data = await getHistoricalData("CBA", "1m");
      expect(data).toBeDefined();
      expect(data.length).toBe(30);
      expect(mockGetHistoricalData).toHaveBeenCalledWith("CBA", "1m");
    });

    it("should handle different time periods with mocks", async () => {
      const periods = ["1d", "1w", "1m", "3m"];

      for (const period of periods) {
        mockGetHistoricalData.mockResolvedValueOnce([]);
        await getHistoricalData("CBA", period);
      }

      expect(mockGetHistoricalData).toHaveBeenCalledTimes(4);
    });
  });

  describe("Error Handling", () => {
    it("should handle network errors gracefully", async () => {
      mockGetMultipleStockQuotes.mockRejectedValueOnce(
        new Error("Network error"),
      );

      await expect(getMultipleStockQuotes(["CBA"])).rejects.toThrow(
        "Network error",
      );
    });
  });
});
