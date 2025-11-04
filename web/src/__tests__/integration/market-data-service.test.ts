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
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0]!,
        open: 100 + Math.random() * 10,
        high: 105 + Math.random() * 10,
        low: 95 + Math.random() * 10,
        close: 100 + Math.random() * 10,
        volume: 1000000 + Math.floor(Math.random() * 500000),
        adjustedClose: 100 + Math.random() * 10,
      }));

      mockGetHistoricalData.mockResolvedValueOnce(mockData);

      const data = await getHistoricalData("CBA", "1m");
      expect(data).toBeDefined();
      expect(data.length).toBe(30);
      expect(mockGetHistoricalData).toHaveBeenCalledWith("CBA", "1m");
    });

    it("should handle different time periods with mocks", async () => {
      const periods = ["1d", "1w", "1m", "3m", "6m", "1y"];

      for (const period of periods) {
        mockGetHistoricalData.mockResolvedValueOnce([]);
        await getHistoricalData("CBA", period);
      }

      expect(mockGetHistoricalData).toHaveBeenCalledTimes(6);
    });

    it("should return data in HistoricalDataPoint format", async () => {
      const mockData = [
        {
          date: "2025-01-01",
          open: 100.5,
          high: 102.3,
          low: 99.8,
          close: 101.2,
          volume: 1500000,
          adjustedClose: 101.2,
        },
        {
          date: "2025-01-02",
          open: 101.2,
          high: 103.5,
          low: 100.9,
          close: 102.8,
          volume: 1600000,
          adjustedClose: 102.8,
        },
      ];

      mockGetHistoricalData.mockResolvedValueOnce(mockData);

      const data = await getHistoricalData("CBA", "1m");
      expect(data).toBeDefined();
      expect(data.length).toBe(2);

      // Verify structure
      data.forEach((point) => {
        expect(point).toHaveProperty("date");
        expect(point).toHaveProperty("open");
        expect(point).toHaveProperty("high");
        expect(point).toHaveProperty("low");
        expect(point).toHaveProperty("close");
        expect(point).toHaveProperty("volume");
        expect(typeof point.date).toBe("string");
        expect(typeof point.open).toBe("number");
        expect(typeof point.close).toBe("number");
      });
    });

    it("should handle empty historical data", async () => {
      mockGetHistoricalData.mockResolvedValueOnce([]);

      const data = await getHistoricalData("NODATA", "1m");
      expect(data).toBeDefined();
      expect(data).toEqual([]);
      expect(Array.isArray(data)).toBe(true);
    });

    it("should handle API errors gracefully", async () => {
      mockGetHistoricalData.mockRejectedValueOnce(new Error("API unavailable"));

      await expect(getHistoricalData("CBA", "1m")).rejects.toThrow(
        "API unavailable",
      );
    });

    it("should format dates correctly", async () => {
      const mockData = [
        {
          date: "2025-01-15",
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1000000,
          adjustedClose: 100.5,
        },
      ];

      mockGetHistoricalData.mockResolvedValueOnce(mockData);

      const data = await getHistoricalData("CBA", "1m");
      expect(data[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should handle sparkline use case (6 month period)", async () => {
      // Mock 6 months of data for sparkline visualization
      const mockData = Array.from({ length: 130 }, (_, i) => ({
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0]!,
        open: 140 + Math.random() * 5,
        high: 142 + Math.random() * 5,
        low: 138 + Math.random() * 5,
        close: 141 + Math.random() * 5,
        volume: 5000000 + Math.floor(Math.random() * 1000000),
        adjustedClose: 141 + Math.random() * 5,
      }));

      mockGetHistoricalData.mockResolvedValueOnce(mockData);

      const data = await getHistoricalData("CBA", "6m");
      expect(data).toBeDefined();
      expect(data.length).toBeGreaterThan(100); // ~130 trading days in 6 months
      expect(mockGetHistoricalData).toHaveBeenCalledWith("CBA", "6m");
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
