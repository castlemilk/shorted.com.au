/**
 * The financial-highlights cache (docs/plans/fundamentals-coverage.md §7.1,
 * "highlights cache fixed"): a failure must never be cached (it used to be
 * swallowed INSIDE unstable_cache, pinning an empty map for 24h), and the
 * entry is tagged so the picks job's `fundamentals` ping refreshes it.
 */

type CacheCall = [() => Promise<unknown>, string[], { revalidate: number; tags?: string[] }];
const cacheCalls: CacheCall[] = [];
jest.mock("next/cache", () => ({
  unstable_cache: (
    loader: () => Promise<unknown>,
    key: string[],
    opts: { revalidate: number; tags?: string[] },
  ) => {
    cacheCalls.push([loader, key, opts]);
    return loader;
  },
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(),
}));

const mockHighlights = jest.fn();
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockFinancialHighlights: (...args: unknown[]) => mockHighlights(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));
jest.mock("~/gen/shorts/v1alpha1/reports_pb", () => ({ ReportsService: {} }));
jest.mock("~/gen/shorts/v1alpha1/market_pb", () => ({ MarketService: {} }));

import {
  financialHighlightsCacheTags,
  getStockFinancialHighlights,
} from "../getReportData";

describe("getStockFinancialHighlights", () => {
  beforeEach(() => {
    cacheCalls.length = 0;
    mockHighlights.mockReset();
  });

  it("maps the highlights under a tagged, versioned key", async () => {
    mockHighlights.mockResolvedValue({
      highlights: {
        BHP: {
          reports: [
            {
              reportTitle: "Appendix 4E",
              reportType: "annual_report",
              reportDate: "2026-08-19",
              metrics: [
                { metricType: "revenue", sourceText: "Revenue US$55.7b", attributes: { value_millions: "55657" } },
              ],
              digest: "Summary",
              confidence: 0.9,
            },
          ],
        },
      },
    });
    const result = await getStockFinancialHighlights(["BHP", "CBA"]);
    expect(result.BHP?.[0]?.metrics[0]?.attributes).toEqual({ value_millions: "55657" });

    const [, key, opts] = cacheCalls[0]!;
    expect(key).toEqual(["financial-highlights-BHP,CBA", "v2"]);
    expect(opts.revalidate).toBe(86400);
    expect(opts.tags).toEqual([
      "financial-highlights",
      "fundamentals",
      "financial-highlights:bhp",
      "financial-highlights:cba",
    ]);
  });

  it("throws inside the cache on failure (never cached) and returns {} to the caller", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockHighlights.mockRejectedValue(new Error("unavailable"));

    await expect(getStockFinancialHighlights(["ZZZ"])).resolves.toEqual({});
    const [loader] = cacheCalls[0]!;
    await expect(loader()).rejects.toThrow("unavailable");
    consoleSpy.mockRestore();
  });

  it("tags each code once, upper-cased and sorted in the key's order", () => {
    expect(financialHighlightsCacheTags(["cba", "BHP", "bhp", ""])).toEqual([
      "financial-highlights",
      "fundamentals",
      "financial-highlights:bhp",
      "financial-highlights:cba",
    ]);
  });
});
