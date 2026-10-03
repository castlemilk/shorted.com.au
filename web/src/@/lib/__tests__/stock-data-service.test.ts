/// <reference types="jest" />
import {
  getCorrelationMatrix,
  getMultipleStockQuotes,
  getSectorPerformance,
} from "../stock-data-service";

describe("stock-data-service client routing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches batched quotes through the app API proxy", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        prices: {
          CBA: {
            stockCode: "CBA",
            close: 101,
            change: 1,
            changePercent: 1,
            volume: "1000",
            high: 102,
            low: 99,
            open: 100,
          },
        },
      }),
    });

    const quotes = await getMultipleStockQuotes(["cba"]);

    expect(quotes.get("CBA")?.price).toBe(101);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/market-data/multiple-quotes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ stockCodes: ["CBA"] }),
      }),
    );
  });

  it("fetches correlations through the app API proxy", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        correlations: {
          CBA: { correlations: { BHP: 0.42 } },
        },
      }),
    });

    const matrix = await getCorrelationMatrix(["cba", "bhp"], "1y");

    expect(matrix.CBA?.BHP).toBe(0.42);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/market-data/correlations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ stockCodes: ["CBA", "BHP"], period: "1y" }),
      }),
    );
  });

  it("fetches all 24 sector symbols in one batch and keeps quotes in their sectors", async () => {
    const prices = Object.fromEntries(
      [
        ["CBA", 4, 100],
        ["WBC", -2, 200],
        ["ANZ", 1, 300],
        ["NAB", -3, 400],
        ["BHP", 8, 500],
        // The proxy may return extra symbols: they must not affect any sector.
        ["EXTRA", 100, 10000],
      ].map(([symbol, changePercent, volume]) => [symbol, {
        stockCode: symbol,
        close: 100,
        change: 1,
        changePercent,
        volume: String(volume),
      }]),
    );
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices }),
    });

    const result = await getSectorPerformance("1w");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/market-data/multiple-quotes",
      expect.objectContaining({
        body: JSON.stringify({ stockCodes: [
          "CBA", "WBC", "ANZ", "NAB", "BHP", "RIO", "FMG", "NCM",
          "CSL", "COH", "SHL", "RMD", "WOW", "COL", "WES", "TWE",
          "WDS", "STO", "ORG", "OSH", "XRO", "WTC", "CPU", "APT",
        ] }),
      }),
    );
    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({
      sector: "Financials", performance: 0, volume: 1000,
      topGainers: ["CBA", "ANZ"], topLosers: ["WBC", "NAB"],
    });
    // Keep the existing four-stock denominator when quotes are missing.
    expect(result[1]).toEqual({
      sector: "Materials", performance: 2, volume: 500,
      topGainers: ["BHP"], topLosers: ["BHP"],
    });
    expect(result[2]).toEqual({
      sector: "Healthcare", performance: 0, volume: 0,
      topGainers: [], topLosers: [],
    });
  });

  it("retains all six zero-valued sectors when the batch has no quotes", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: {} }),
    });

    const result = await getSectorPerformance();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(6);
    for (const sector of result) {
      expect(sector).toMatchObject({
        performance: 0, volume: 0, topGainers: [], topLosers: [],
      });
    }
  });
});
