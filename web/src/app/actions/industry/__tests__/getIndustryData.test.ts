jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T extends (...args: any[]) => unknown>(fn: T): T => fn,
}));

const mockGetOrSetCached = jest.fn();
const mockServerFetchWithUserAgent = jest.fn();

jest.mock("~/@/lib/kv-cache", () => ({
  getOrSetCached: (...args: unknown[]) => mockGetOrSetCached(...args),
  CACHE_KEYS: {
    industryTreeMap: (period: string, limit: number, viewMode: string) =>
      `cache:homepage:treemap:${period}:${limit}:${viewMode}`,
  },
}));

jest.mock("../../config", () => ({
  SHORTS_API_URL: "https://api.shorted.com.au",
  serverFetchWithUserAgent: (...args: unknown[]) =>
    mockServerFetchWithUserAgent(...args),
}));

import { getIndustryData, getIndustryStocks } from "../getIndustryData";

function mockTreemapResponse(stocks: unknown[]) {
  mockServerFetchWithUserAgent.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ stocks }),
  });
}

describe("industry data cache loading", () => {
  const originalSkipStaticGeneration = process.env.SKIP_STATIC_GENERATION;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOrSetCached.mockImplementation(
      async (_key: string, loader: () => Promise<unknown>) => loader(),
    );
    delete process.env.SKIP_STATIC_GENERATION;
  });

  afterAll(() => {
    if (originalSkipStaticGeneration === undefined) {
      delete process.env.SKIP_STATIC_GENERATION;
    } else {
      process.env.SKIP_STATIC_GENERATION = originalSkipStaticGeneration;
    }
  });

  it("fetches live industry data at runtime even when static generation is skipped", async () => {
    process.env.SKIP_STATIC_GENERATION = "1";
    mockTreemapResponse([
      { productCode: "MIN", industry: "Materials", shortPosition: 12.4 },
      { productCode: "LTR", industry: "Materials", shortPosition: 7.8 },
    ]);

    const result = await getIndustryData();

    expect(result).toEqual([
      {
        name: "Materials",
        slug: "materials",
        stockCount: 2,
        avgShortPercent: 10.1,
        totalShortPercent: 20.2,
        topStock: { code: "MIN", name: "MIN", shortPercent: 12.4 },
      },
    ]);
    expect(mockGetOrSetCached).toHaveBeenCalledWith(
      "cache:homepage:treemap:max:50:current:industries-index:v2",
      expect.any(Function),
      3600,
    );
    expect(mockServerFetchWithUserAgent).toHaveBeenCalledWith(
      "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not treat empty industry API responses as usable cached data", async () => {
    mockTreemapResponse([]);

    await expect(getIndustryData()).resolves.toEqual([]);

    await expect(mockGetOrSetCached.mock.results[0]?.value).rejects.toThrow(
      "no industry rows",
    );
  });

  it("uses a versioned cache key and live data for industry stock panels", async () => {
    mockTreemapResponse([
      { productCode: "MIN", industry: "Materials", shortPosition: 12.4 },
      { productCode: "LTR", industry: "Materials", shortPosition: 7.8 },
      { productCode: "ZIP", industry: "Financial Services", shortPosition: 6.1 },
    ]);

    const result = await getIndustryStocks("materials");

    expect(result.stocks.map((stock) => stock.code)).toEqual(["MIN", "LTR"]);
    expect(result.industry?.slug).toBe("materials");
    expect(mockGetOrSetCached).toHaveBeenCalledWith(
      "cache:homepage:treemap:3m:50:current:industry:materials:v2",
      expect.any(Function),
      3600,
    );
  });
});
