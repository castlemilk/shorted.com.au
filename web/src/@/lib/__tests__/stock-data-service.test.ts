/// <reference types="jest" />
import {
  getCorrelationMatrix,
  getMultipleStockQuotes,
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
});
