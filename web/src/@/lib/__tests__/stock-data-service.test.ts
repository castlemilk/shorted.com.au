/// <reference types="jest" />
import {
  getCorrelationMatrix,
  getMultipleStockQuotes,
  getSectorPerformance,
  searchStocksEnriched,
} from "../stock-data-service";

jest.mock("~/app/actions/searchStocks", () => ({
  searchStocks: jest.fn().mockResolvedValue({ stocks: [{
    productCode: "CBA", name: "Commonwealth Bank", percentageShorted: 1,
    totalProductInIssue: 1, reportedShortPositions: 1, industry: "Financials", tags: [], logoUrl: "",
  }] }),
}));
jest.mock("@/lib/client-api", () => ({ fetchStockDetailsClient: jest.fn().mockResolvedValue({}) }));

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

  it("decodes protobuf omitted zero scalars without producing NaN portfolio or sector values", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ prices: {
        CBA: { stockCode: "CBA", date: "2026-10-02T00:00:00Z", close: 101 },
      } }),
    });

    const quotes = await getMultipleStockQuotes(["CBA"]);
    expect(quotes.get("CBA")).toEqual({
      symbol: "CBA", price: 101, previousClose: 101, change: 0,
      changePercent: 0, volume: 0, high: 0, low: 0, open: 0,
    });

    const sectors = await getSectorPerformance();
    expect(sectors[0]).toEqual({
      sector: "Financials", performance: 0, volume: 0,
      topGainers: ["CBA"], topLosers: ["CBA"],
    });
    expect(sectors.every(sector => Number.isFinite(sector.performance) && Number.isFinite(sector.volume))).toBe(true);
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

describe("quote cancellation and retry policy", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("avoids fetching an empty symbol set", async () => {
    expect(await getMultipleStockQuotes([])).toEqual(new Map());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])("does not retry permanent HTTP %s", async (status) => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status, headers: new Headers() });
    expect(await getMultipleStockQuotes(["CBA"])).toEqual(new Map());
    await jest.advanceTimersByTimeAsync(10_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("honors the transient rate-limit delay before retrying", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({
        "Retry-After": "2", "X-RateLimit-Scope": "edge-minute",
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ prices: {} }) });
    const pending = getMultipleStockQuotes(["CBA"]);
    await jest.advanceTimersByTimeAsync(1999);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(new Map());
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a monthly exhausted quota", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429, headers: new Headers({
      "Retry-After": "3600", "X-RateLimit-Monthly-Limit": "100", "X-RateLimit-Monthly-Used": "100",
    }) });
    expect(await getMultipleStockQuotes(["CBA"])).toEqual(new Map());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes abort to fetch and never retries the canceled request", async () => {
    const controller = new AbortController();
    (global.fetch as jest.Mock).mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })),
    );
    const pending = getMultipleStockQuotes(["CBA"], controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(global.fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: controller.signal }));
    controller.abort();
    await rejected;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels search price enrichment at 1.5 seconds without losing search results", async () => {
    let signal: AbortSignal | undefined;
    (global.fetch as jest.Mock).mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
    });
    const pending = searchStocksEnriched("CBA");
    await jest.advanceTimersByTimeAsync(1499);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const results = await pending;
    expect(signal?.aborted).toBe(true);
    expect(results).toEqual([expect.objectContaining({ product_code: "CBA", name: "Commonwealth Bank", currentPrice: undefined })]);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("stops search quote backoff at its deadline rather than continuing four attempts", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
    const pending = searchStocksEnriched("CBA");
    await jest.advanceTimersByTimeAsync(1500);
    expect((await pending)[0]?.product_code).toBe("CBA");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
