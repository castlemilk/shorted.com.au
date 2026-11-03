/**
 * @jest-environment node
 */
/**
 * marketByDateShared holds one GetMarketByDate answer for a day, so the report
 * OG images share one API call per date. An answer with neither stocks nor a
 * previousDate, and a failed request, throw, so neither is held.
 */
const mockCacheStore = new Map<string, unknown>();

jest.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>, keyParts: string[]) => async () => {
    const key = JSON.stringify(keyParts);
    if (mockCacheStore.has(key)) return mockCacheStore.get(key);
    const value = await read();
    mockCacheStore.set(key, value);
    return value;
  },
}));

const mockServerFetchOutsideNextCache = jest.fn();
jest.mock("../config", () => ({
  getServerShortsApiUrl: () => "https://api.example.test",
  serverFetchOutsideNextCache: (...args: unknown[]) =>
    mockServerFetchOutsideNextCache(...args),
}));

import { marketByDateShared } from "../market-by-date";

function answer(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("marketByDateShared", () => {
  beforeEach(() => {
    mockCacheStore.clear();
    mockServerFetchOutsideNextCache.mockReset();
  });

  it("asks the API once for a date and shares the answer", async () => {
    mockServerFetchOutsideNextCache.mockResolvedValue(
      answer({
        stocks: [{ productCode: "MIN", name: "Mineral", percentageShorted: 12.3 }],
      }),
    );

    const first = await marketByDateShared("2026-10-30");
    const second = await marketByDateShared("2026-10-30");

    expect(second).toEqual(first);
    expect(mockServerFetchOutsideNextCache).toHaveBeenCalledTimes(1);
  });

  it("posts GetMarketByDate for one stock on that date, with no fetch-level next option", async () => {
    mockServerFetchOutsideNextCache.mockResolvedValue(
      answer({ stocks: [{ productCode: "MIN" }] }),
    );

    await marketByDateShared("2026-10-30");

    const [url, init] = mockServerFetchOutsideNextCache.mock.calls[0] as [
      string,
      RequestInit & { next?: unknown },
    ];
    expect(url).toBe(
      "https://api.example.test/shorts.v1alpha1.ShortedStocksService/GetMarketByDate",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      date: "2026-10-30",
      limit: 1,
      offset: 0,
    });
    expect(init).not.toHaveProperty("next");
  });

  it("holds an answer that names only the previous date, so that day's hop is shared", async () => {
    mockServerFetchOutsideNextCache.mockResolvedValue(
      answer({ previousDate: "2026-10-29" }),
    );

    await expect(marketByDateShared("2026-10-31")).resolves.toEqual({
      previousDate: "2026-10-29",
    });
    await expect(marketByDateShared("2026-10-31")).resolves.toEqual({
      previousDate: "2026-10-29",
    });
    expect(mockServerFetchOutsideNextCache).toHaveBeenCalledTimes(1);
  });

  it("holds nothing from an empty answer: the next request asks again", async () => {
    mockServerFetchOutsideNextCache
      .mockResolvedValueOnce(answer({}))
      .mockResolvedValueOnce(answer({ stocks: [{ productCode: "MIN" }] }));

    await expect(marketByDateShared("2026-10-30")).rejects.toThrow(
      "returned no stocks",
    );
    await expect(marketByDateShared("2026-10-30")).resolves.toEqual({
      stocks: [{ productCode: "MIN" }],
    });
    expect(mockServerFetchOutsideNextCache).toHaveBeenCalledTimes(2);
  });

  it("holds nothing from a failed request: the next request asks again", async () => {
    mockServerFetchOutsideNextCache
      .mockResolvedValueOnce(answer({}, 503))
      .mockResolvedValueOnce(answer({ stocks: [{ productCode: "MIN" }] }));

    await expect(marketByDateShared("2026-10-30")).rejects.toThrow(
      "API returned 503",
    );
    await expect(marketByDateShared("2026-10-30")).resolves.toEqual({
      stocks: [{ productCode: "MIN" }],
    });
    expect(mockServerFetchOutsideNextCache).toHaveBeenCalledTimes(2);
  });

  it("keeps one answer per date", async () => {
    mockServerFetchOutsideNextCache.mockResolvedValue(
      answer({ stocks: [{ productCode: "MIN" }] }),
    );

    await marketByDateShared("2026-10-30");
    await marketByDateShared("2026-10-23");

    expect(mockServerFetchOutsideNextCache).toHaveBeenCalledTimes(2);
  });
});
