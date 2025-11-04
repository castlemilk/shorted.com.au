/**
 * Integration tests for /api/market-data/historical route
 * Tests the market data historical prices proxy endpoint
 */

import { POST } from "../route";
import { NextRequest } from "next/server";
import {
  mockHistoricalPrices,
  mockEmptyResponse,
} from "@/__tests__/fixtures/market-data";

// Mock the market data service
global.fetch = jest.fn();

describe("/api/market-data/historical", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset fetch mock
    (global.fetch as jest.Mock).mockReset();
  });

  describe("Success Cases", () => {
    it("should return historical prices for valid stock code with 6m period", async () => {
      // Mock successful backend response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockHistoricalPrices.CBA.sixMonths,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveProperty("prices");
      expect(Array.isArray(data.prices)).toBe(true);
      expect(data.prices.length).toBeGreaterThan(0);
      expect(data.prices[0]).toHaveProperty("stockCode", "CBA");
    });

    it("should return historical prices for different periods", async () => {
      const periods = ["1m", "3m", "1y"];

      for (const period of periods) {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockHistoricalPrices.CBA.oneMonth,
        });

        const request = new NextRequest(
          "http://localhost:3020/api/market-data/historical",
          {
            method: "POST",
            body: JSON.stringify({ stockCode: "CBA", period }),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data).toHaveProperty("prices");
      }
    });

    it("should return prices with correct structure", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockHistoricalPrices.CBA.sixMonths,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      const price = data.prices[0];
      expect(price).toHaveProperty("stockCode");
      expect(price).toHaveProperty("date");
      expect(price).toHaveProperty("open");
      expect(price).toHaveProperty("high");
      expect(price).toHaveProperty("low");
      expect(price).toHaveProperty("close");
      expect(price).toHaveProperty("volume");
      expect(typeof price.open).toBe("number");
      expect(typeof price.close).toBe("number");
    });

    it("should default to 3m period when period not specified", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockHistoricalPrices.CBA.sixMonths,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA" }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      // Verify the fetch was called with default period
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          "/marketdata.v1.MarketDataService/GetHistoricalPrices",
        ),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"period":"3m"'),
        }),
      );
    });
  });

  describe("Error Handling", () => {
    it("should return empty prices array for invalid stock code", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "INVALID", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ prices: [] });
    });

    it("should return empty prices array for 404 response", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "NOTFOUND", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ prices: [] });
    });

    it("should return 500 error when market data service is unavailable", async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error("Network error"),
      );

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toHaveProperty("error");
    });

    it("should handle malformed request body gracefully", async () => {
      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: "invalid json",
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it("should return empty array when backend returns empty data", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockEmptyResponse,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "NODATA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ prices: [] });
    });
  });

  describe("Data Validation", () => {
    it("should ensure prices are sorted by date", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockHistoricalPrices.CBA.sixMonths,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Check if dates are in ascending order
      for (let i = 1; i < data.prices.length; i++) {
        const prevDate = new Date(data.prices[i - 1].date);
        const currDate = new Date(data.prices[i].date);
        expect(currDate.getTime()).toBeGreaterThanOrEqual(prevDate.getTime());
      }
    });

    it("should validate all price values are numbers", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockHistoricalPrices.CBA.sixMonths,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      data.prices.forEach((price: Record<string, unknown>) => {
        expect(typeof price.open).toBe("number");
        expect(typeof price.high).toBe("number");
        expect(typeof price.low).toBe("number");
        expect(typeof price.close).toBe("number");
      });
    });

    it("should validate dates are valid ISO strings", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockHistoricalPrices.CBA.sixMonths,
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      data.prices.forEach((price: Record<string, unknown>) => {
        const date = new Date(price.date as string);
        expect(date.toString()).not.toBe("Invalid Date");
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle stock with no historical data", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ prices: [] }),
      });

      const request = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "NEWSTOCK", period: "6m" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.prices).toEqual([]);
    });

    it("should handle concurrent requests independently", async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockHistoricalPrices.CBA.sixMonths,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockHistoricalPrices.BHP.sixMonths,
        });

      const request1 = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "CBA", period: "6m" }),
        },
      );

      const request2 = new NextRequest(
        "http://localhost:3020/api/market-data/historical",
        {
          method: "POST",
          body: JSON.stringify({ stockCode: "BHP", period: "6m" }),
        },
      );

      const [response1, response2] = await Promise.all([
        POST(request1),
        POST(request2),
      ]);

      const [data1, data2] = await Promise.all([
        response1.json(),
        response2.json(),
      ]);

      expect(data1.prices[0].stockCode).toBe("CBA");
      expect(data2.prices[0].stockCode).toBe("BHP");
    });
  });
});
