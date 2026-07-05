jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T extends (...args: any[]) => any>(fn: T): T => fn,
}));

const mockGetCached = jest.fn();
const mockSetCached = jest.fn();
const mockDeleteCached = jest.fn();
const mockGetTopShortsData = jest.fn();

jest.mock("~/@/lib/kv-cache", () => ({
  getCached: (...args: any[]) => mockGetCached(...args),
  setCached: (...args: any[]) => mockSetCached(...args),
  deleteCached: (...args: any[]) => mockDeleteCached(...args),
  CACHE_KEYS: {
    topPageData: (period: string, limit: number) =>
      `cache:top:${period}:${limit}`,
  },
  TOP_PAGE_TTL: 600,
}));

jest.mock("../../getTopShorts", () => ({
  getTopShortsData: (...args: any[]) => mockGetTopShortsData(...args),
}));

import { getTopPageData } from "../getTopPageData";

describe("getTopPageData", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCached.mockResolvedValue(null);
    mockSetCached.mockResolvedValue(true);
    mockDeleteCached.mockResolvedValue(true);
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [
        {
          productCode: "LOT",
          name: "Lotus Resources",
          latestShortPosition: 22.82,
          points: [
            { timestamp: "2026-04-01T00:00:00Z", shortPosition: 10 },
            { timestamp: "2026-07-01T00:00:00Z", shortPosition: 22.82 },
          ],
        },
      ],
      offset: 0,
    });
  });

  it("builds populated top-page data from plain JSON-shaped top-shorts responses", async () => {
    const result = await getTopPageData("3m", 100);

    expect(result.timeSeries).toHaveLength(1);
    expect(result.timeSeries[0]).toMatchObject({
      productCode: "LOT",
      name: "Lotus Resources",
      latestShortPosition: 22.82,
    });
    expect(result.stockListItems[0]).toMatchObject({
      productCode: "LOT",
      shortPercentage: 22.82,
    });
    expect(result.movers.biggestGainers[0]?.productCode).toBe("LOT");
    expect(mockSetCached).toHaveBeenCalledWith(
      "cache:top:3m:100",
      expect.objectContaining({
        timeSeries: expect.arrayContaining([
          expect.objectContaining({ productCode: "LOT" }),
        ]),
      }),
      600,
    );
  });

  it("refreshes stale empty top-page cache entries", async () => {
    mockGetCached.mockResolvedValueOnce({
      timeSeries: [],
      movers: {
        biggestGainers: [],
        biggestLosers: [],
        mostVolatile: [],
      },
      stockListItems: [],
      lastUpdated: "2026-07-01T00:00:00.000Z",
      period: "3m",
    });

    const result = await getTopPageData("3m", 100);

    expect(result.timeSeries[0]?.productCode).toBe("LOT");
    expect(mockDeleteCached).toHaveBeenCalledWith("cache:top:3m:100");
    expect(mockGetTopShortsData).toHaveBeenCalledWith("3m", 100, 0);
  });
});
