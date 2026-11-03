/**
 * An empty industry answer is never held, on either path, and a good one is
 * shared for its window while KV is down. getIndustryData.test.ts passes a
 * pass-through unstable_cache, so it cannot see the shared entry's guard. This
 * file gives the entry a store, as Next's unstable_cache does: a read that
 * throws is not held.
 */
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T extends (...args: any[]) => unknown>(fn: T): T => fn,
}));

const mockCacheStore = new Map<string, unknown>();
jest.mock("next/cache", () => ({
  unstable_cache:
    (read: () => Promise<unknown>, keyParts: string[]) => async () => {
      const key = JSON.stringify(keyParts);
      if (mockCacheStore.has(key)) return mockCacheStore.get(key);
      const value = await read();
      mockCacheStore.set(key, value);
      return value;
    },
}));

// getOrSetCached writes the loader's value only when the loader resolves, as
// the KV layer does. A throwing loader writes nothing.
const mockKvStore = new Map<string, unknown>();
const storeWhenLoaded = async (key: string, loader: () => Promise<unknown>) => {
  const value = await loader();
  mockKvStore.set(key, value);
  return value;
};
const mockGetOrSetCached = jest.fn(storeWhenLoaded);

jest.mock("~/@/lib/kv-cache", () => ({
  getOrSetCached: (...args: unknown[]) => mockGetOrSetCached(...args),
  CACHE_KEYS: {
    industryTreeMap: (period: string, limit: number, viewMode: string) =>
      `cache:homepage:treemap:${period}:${limit}:${viewMode}`,
  },
}));

const mockServerFetch = jest.fn();
jest.mock("../../config", () => ({
  SHORTS_API_URL: "https://api.shorted.com.au",
  serverFetchWithUserAgent: (...args: unknown[]) => mockServerFetch(...args),
  serverFetchOutsideNextCache: (...args: unknown[]) => mockServerFetch(...args),
  skipForBuild: () => false,
}));

import { getIndustryData, getIndustryStocks } from "../getIndustryData";

const TREEMAP_3M_KEY = "cache:homepage:treemap:3m:50:current:raw:v1";
const MATERIALS = [
  { productCode: "MIN", industry: "Materials", shortPosition: 12.4 },
  { productCode: "LTR", industry: "Materials", shortPosition: 7.8 },
];

function treemap(stocks: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ stocks }) };
}

describe("an empty industry treemap is never held", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockCacheStore.clear();
    mockKvStore.clear();
    mockGetOrSetCached.mockReset();
    mockGetOrSetCached.mockImplementation(storeWhenLoaded);
    mockServerFetch.mockReset();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("asks the API again after an empty max answer, and returns the rows", async () => {
    mockServerFetch
      .mockResolvedValueOnce(treemap([]))
      .mockResolvedValueOnce(treemap(MATERIALS));

    await expect(getIndustryData()).resolves.toEqual([]);
    expect(mockKvStore.size).toBe(0);

    const industries = await getIndustryData();
    expect(industries.map((industry) => industry.name)).toEqual(["Materials"]);
    expect(mockServerFetch).toHaveBeenCalledTimes(2);
  });

  it("writes no empty 3m panel answer to KV, and the next panel read asks again", async () => {
    mockServerFetch
      .mockResolvedValueOnce(treemap([]))
      .mockResolvedValueOnce(treemap(MATERIALS));

    await expect(getIndustryStocks("materials")).resolves.toEqual({
      industry: null,
      stocks: [],
      reason: "unavailable",
    });
    expect(mockKvStore.has(TREEMAP_3M_KEY)).toBe(false);

    const result = await getIndustryStocks("materials");
    expect(result.stocks.map((stock) => stock.code)).toEqual(["MIN", "LTR"]);
    expect(mockKvStore.has(TREEMAP_3M_KEY)).toBe(true);
    expect(mockServerFetch).toHaveBeenCalledTimes(2);
  });

  it("shares a good answer for its window while KV is down: a second page view does not call the API", async () => {
    // KV down: the loader runs on every call and nothing is stored there.
    mockGetOrSetCached.mockImplementation(
      (_key: string, loader: () => Promise<unknown>) => loader(),
    );
    mockServerFetch.mockResolvedValue(treemap(MATERIALS));

    await expect(getIndustryData()).resolves.toHaveLength(1);
    await expect(getIndustryData()).resolves.toHaveLength(1);

    expect(mockServerFetch).toHaveBeenCalledTimes(1);
  });
});
