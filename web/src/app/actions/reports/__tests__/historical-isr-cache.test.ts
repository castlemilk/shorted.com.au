type CachedEntry = { value: unknown; tags: string[] };
const mockEntries = new Map<string, CachedEntry>();
const mockCacheOptions: Array<{ key: string[]; tags: string[]; revalidate: number }> = [];

jest.mock("next/cache", () => ({
  unstable_cache: (
    loader: () => Promise<unknown>,
    key: string[],
    options: { tags: string[]; revalidate: number },
  ) => async () => {
    const cacheKey = JSON.stringify(key);
    mockCacheOptions.push({ key, ...options });
    if (mockEntries.has(cacheKey)) return mockEntries.get(cacheKey)!.value;
    // Match Next's JSON storage boundary: only successful serializable values
    // can be cached, never rejected requests.
    const value: unknown = JSON.parse(JSON.stringify(await loader()));
    mockEntries.set(cacheKey, { value, tags: options.tags });
    return value;
  },
  revalidateTag: (tag: string) => {
    for (const [key, entry] of mockEntries) {
      if (entry.tags.includes(tag)) mockEntries.delete(key);
    }
  },
}));
jest.mock("react", () => ({ ...jest.requireActual("react"), cache: (fn: unknown) => fn }));
jest.mock("../../withRetry", () => ({
  withRetry: (fn: unknown) => fn,
  withRetryAndNotFound: (fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      try { return await fn(...args); } catch { return undefined; }
    },
}));
jest.mock("../../config", () => ({ SHORTS_API_URL: "http://api.test", serverFetchOutsideNextCache: jest.fn() }));
jest.mock("~/@/lib/tracing", () => ({
  withSpan: (_name: string, _attributes: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn() }));
const mockAvailableDates = jest.fn();
const mockMarket = jest.fn();
const mockNarrative = jest.fn();
const mockHighlights = jest.fn();
const mockList = jest.fn();
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getAvailableDates: (...args: unknown[]) => mockAvailableDates(...args),
    getMarketByDate: (...args: unknown[]) => mockMarket(...args),
    getWeeklyReport: (...args: unknown[]) => mockNarrative(...args),
    getStockFinancialHighlights: (...args: unknown[]) => mockHighlights(...args),
    listReports: (...args: unknown[]) => mockList(...args),
  }),
}));
jest.mock("~/gen/shorts/v1alpha1/market_pb", () => ({ MarketService: {} }));
jest.mock("~/gen/shorts/v1alpha1/reports_pb", () => ({ ReportsService: {} }));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));

import { revalidateTag } from "next/cache";
import {
  getWeeklyReportDataStrict,
  getMonthlyReportDataStrict,
  getEnhancedWeeklyReportDataStrict,
  getStockFinancialHighlightsStrict,
  getReportsListStrict,
} from "../getReportData";

const stock = (percentageShorted: number) => ({
  productCode: "BHP", name: "BHP", percentageShorted, industry: "Materials",
});
const narrative = (headline: string) => ({
  headline, summary: "Summary", narrative: { openingHook: "Hook" },
  topShorted: [], risers: [], fallers: [], faqs: [], qualityScore: 1,
});

describe("strict historical report caching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntries.clear();
    mockCacheOptions.length = 0;
    mockAvailableDates.mockResolvedValue({ dates: ["2026-05-15", "2026-05-14"] });
    mockMarket.mockResolvedValue({ stocks: [stock(2)], totalCount: 1 });
  });

  it("queries dates within the requested historical week and shares a tagged cache", async () => {
    await expect(getWeeklyReportDataStrict("2026-W20")).resolves.toHaveProperty("topStocks.0.shortPercent", 2);
    await getWeeklyReportDataStrict("2026-W20");
    expect(mockAvailableDates).toHaveBeenCalledWith({ limit: 5, before: "2026-05-18" });
    expect(mockMarket).toHaveBeenCalledTimes(1);
    expect(mockCacheOptions[0]).toMatchObject({
      revalidate: 86400, tags: ["report-2026-W20", "shorts-data"],
    });
  });

  it("selects the last actual trading date when a month ends on a weekend", async () => {
    mockAvailableDates.mockResolvedValue({ dates: ["2026-05-29", "2026-05-28", "2026-04-30"] });
    const result = await getMonthlyReportDataStrict("2026-05");
    expect(mockAvailableDates).toHaveBeenCalledWith({ limit: 31, before: "2026-06-01" });
    expect(mockMarket).toHaveBeenCalledWith({ date: "2026-05-29", limit: 50, offset: 0 });
    expect(result.dates).toEqual(["2026-05-29", "2026-05-28"]);
  });

  it.each([
    ["weekly", "2026-W20", getWeeklyReportDataStrict],
    ["monthly", "2026-05", getMonthlyReportDataStrict],
  ] as const)("never caches a failed %s snapshot and retries successfully later", async (_name, slug, accessor) => {
    mockMarket.mockRejectedValue(new Error("backend unavailable"));
    await expect(accessor(slug)).rejects.toThrow("backend unavailable");
    expect(mockEntries.size).toBe(0);
    mockMarket.mockResolvedValue({ stocks: [stock(3)], totalCount: 1 });
    await expect(accessor(slug)).resolves.toHaveProperty("topStocks.0.shortPercent", 3);
  });

  it("refreshes corrected historical ASIC data after its ingest tag is invalidated", async () => {
    await getWeeklyReportDataStrict("2026-W20");
    mockMarket.mockResolvedValue({ stocks: [stock(4)], totalCount: 1 });
    await expect(getWeeklyReportDataStrict("2026-W20")).resolves.toHaveProperty("topStocks.0.shortPercent", 2);
    revalidateTag("shorts-data");
    await expect(getWeeklyReportDataStrict("2026-W20")).resolves.toHaveProperty("topStocks.0.shortPercent", 4);
  });

  it("a publication event replaces a cached missing narrative and a corrected headline", async () => {
    mockNarrative.mockRejectedValue({ code: 5, message: "not published" });
    await expect(getEnhancedWeeklyReportDataStrict("2026-W20")).resolves.toBeNull();
    mockNarrative.mockResolvedValue(narrative("First publication"));
    revalidateTag("report-2026-W20");
    await expect(getEnhancedWeeklyReportDataStrict("2026-W20")).resolves.toHaveProperty("headline", "First publication");
    mockNarrative.mockResolvedValue(narrative("Corrected publication"));
    revalidateTag("report-2026-W20");
    await expect(getEnhancedWeeklyReportDataStrict("2026-W20")).resolves.toHaveProperty("headline", "Corrected publication");
  });

  it("propagates narrative outages and does not store missing publication on failure", async () => {
    mockNarrative.mockRejectedValue(new Error("narrative unavailable"));
    await expect(getEnhancedWeeklyReportDataStrict("2026-W20")).rejects.toThrow("narrative unavailable");
    expect(mockEntries.size).toBe(0);
  });

  it("propagates ancillary archive and financial failures to the ISR caller", async () => {
    mockList.mockRejectedValue(new Error("archive unavailable"));
    mockHighlights.mockRejectedValue(new Error("financials unavailable"));
    await expect(getReportsListStrict("weekly", 60)).rejects.toThrow("archive unavailable");
    await expect(getStockFinancialHighlightsStrict(["BHP"])).rejects.toThrow("financials unavailable");
    expect(mockEntries.size).toBe(0);
  });
});
