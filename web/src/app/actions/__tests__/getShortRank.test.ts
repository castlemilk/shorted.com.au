/**
 * @jest-environment node
 */
/**
 * getShortRank ranks a stock against one top-shorts list that every stock's
 * short-interest page shares. The list is held for a day in one unstable_cache
 * entry, so one fetch serves them all. An empty or failed answer throws inside
 * that cache, which stores nothing, so the next page asks again.
 *
 * The request used to carry a `next` option, which stored each answer in Next's
 * data cache for the day: an empty answer reached every stock's page for that
 * day. Without the option the list would be fetched on every stock-page render
 * (about 100 KB each time), so the shared entry is what keeps it at one call a
 * day.
 */
const mockCacheStore = new Map<string, unknown>();
const mockUnstableCache = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (cb: () => Promise<unknown>, keys: string[], opts: unknown) => {
    mockUnstableCache(keys, opts);
    return async () => {
      const key = JSON.stringify(keys);
      if (mockCacheStore.has(key)) return mockCacheStore.get(key);
      // A throw from the callback propagates and is not stored, as in Next.
      const value = await cb();
      mockCacheStore.set(key, value);
      return value;
    };
  },
}));

import { getShortRank } from "../getShortRank";
import { STOCK_PAGE_CACHE_SECONDS } from "../stockPageCache";

const ORIGINAL_FETCH = globalThis.fetch;
const LIST = {
  timeSeries: [{ productCode: "BHP" }, { productCode: "CBA" }, { productCode: "WBC" }],
};

describe("getShortRank", () => {
  let fetchMock: jest.Mock;

  const respond = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );

  beforeEach(() => {
    mockCacheStore.clear();
    mockUnstableCache.mockClear();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("ranks a listed code and reads the shared list once for every code", async () => {
    respond(LIST);

    expect(await getShortRank("CBA")).toEqual({ rank: 2, total: 3 });
    expect(await getShortRank("WBC")).toEqual({ rank: 3, total: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/shorts\.v1alpha1\.ShortedStocksService\/GetTopShorts$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      period: "max",
      limit: 1000,
      offset: 0,
      summaryOnly: true,
    });
    // The day is the route's policy, held in unstable_cache, not a fetch option.
    expect(init).not.toHaveProperty("next");
    expect(mockUnstableCache).toHaveBeenCalledWith(
      ["short-interest-rank-universe"],
      { revalidate: STOCK_PAGE_CACHE_SECONDS },
    );
  });

  it("answers null for a code that is not on the list", async () => {
    respond(LIST);
    expect(await getShortRank("ZZZ")).toBeNull();
  });

  it("does not hold an empty answer: the next page asks again", async () => {
    // The kill switch answers an empty object, not an error.
    respond({});
    expect(await getShortRank("CBA")).toBeNull();

    respond(LIST);
    expect(await getShortRank("CBA")).toEqual({ rank: 2, total: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hold a failed answer either", async () => {
    respond({ code: "unavailable" }, 503);
    expect(await getShortRank("CBA")).toBeNull();

    respond(LIST);
    expect(await getShortRank("CBA")).toEqual({ rank: 2, total: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
