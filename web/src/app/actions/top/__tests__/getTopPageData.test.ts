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
import { calculateMovers } from "~/@/lib/shorts-calculations";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

function populatedSeries() {
  const today = Math.floor(Date.now() / 1000);
  return Array.from({ length: 100 }, (_, index) => ({
    productCode: `T${String(index).padStart(2, "0")}`,
    name: `Company ${index}`,
    latestShortPosition: 5 + index / 10,
    points: Array.from({ length: 90 }, (_, point) => ({
      timestamp: { seconds: BigInt(today - (89 - point) * 86400), nanos: 0 },
      shortPosition: 5 + index / 10 + Math.sin(point / 5) * (index + 1) / 100,
    })),
  }));
}

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

  it("refreshes cached top-page data containing invalid instruments", async () => {
    mockGetCached.mockResolvedValueOnce({
      timeSeries: [
        {
          productCode: "ATBHQ",
          name: "ASIAN DEVELOPMENT 4.35% 17-JAN-29",
          latestShortPosition: 100,
          points: [{ shortPosition: 100 }],
        },
      ],
      movers: {
        biggestGainers: [],
        biggestLosers: [
          {
            productCode: "ATBHQ",
            name: "ASIAN DEVELOPMENT 4.35% 17-JAN-29",
            latestShortPosition: 100,
            points: [{ shortPosition: 100 }],
            change: -60,
          },
        ],
        mostVolatile: [],
      },
      stockListItems: [],
      lastUpdated: "2026-07-01T00:00:00.000Z",
      period: "3m",
    });

    const result = await getTopPageData("3m", 100);

    expect(result.timeSeries.map((stock) => stock.productCode)).toEqual(["LOT"]);
    expect(result.movers.biggestLosers.map((stock) => stock.productCode)).toEqual(["LOT"]);
    expect(mockDeleteCached).toHaveBeenCalledWith("cache:top:3m:100");
    expect(mockGetTopShortsData).toHaveBeenCalledWith("3m", 100, 0);
  });

  it("filters invalid instruments before deriving top-page stats and movers", async () => {
    mockGetTopShortsData.mockResolvedValueOnce({
      timeSeries: [
        {
          productCode: "ATBHQ",
          name: "ASIAN DEVELOPMENT 4.35% 17-JAN-29",
          latestShortPosition: 100,
          points: [
            { timestamp: "2026-04-01T00:00:00Z", shortPosition: 160 },
            { timestamp: "2026-07-01T00:00:00Z", shortPosition: 100 },
          ],
        },
        {
          productCode: "OOO",
          name: "BETASHARESCRUDEOIL ETF UNITS",
          latestShortPosition: 20,
          points: [
            { timestamp: "2026-04-01T00:00:00Z", shortPosition: 10 },
            { timestamp: "2026-07-01T00:00:00Z", shortPosition: 20 },
          ],
        },
        {
          productCode: "LOT",
          name: "LOTUS RESOURCES LTD ORDINARY",
          latestShortPosition: 22.82,
          points: [
            { timestamp: "2026-04-01T00:00:00Z", shortPosition: 10 },
            { timestamp: "2026-07-01T00:00:00Z", shortPosition: 22.82 },
          ],
        },
      ],
      offset: 0,
    });

    const result = await getTopPageData("3m", 100);

    expect(result.timeSeries.map((stock) => stock.productCode)).toEqual(["LOT"]);
    expect(result.stockListItems.map((stock) => stock.productCode)).toEqual(["LOT"]);
    expect(result.movers.biggestGainers.map((stock) => stock.productCode)).toEqual(["LOT"]);
    expect(result.movers.biggestLosers.map((stock) => stock.productCode)).toEqual(["LOT"]);
    expect(result.movers.mostVolatile.map((stock) => stock.productCode)).toEqual(["LOT"]);
  });

  it("sends the five visible mover summaries per card while retaining table sparkline histories", async () => {
    const raw = populatedSeries();
    mockGetTopShortsData.mockResolvedValueOnce({ timeSeries: raw, offset: 0 });

    const result = await getTopPageData("3m", 100);
    const fullMovers = calculateMovers(raw as unknown as TimeSeriesData[], "3m");
    for (const key of ["biggestGainers", "biggestLosers", "mostVolatile"] as const) {
      expect(result.movers[key]).toEqual(fullMovers[key].slice(0, 5).map(({ points: _points, ...summary }) => summary));
      for (const summary of result.movers[key]) {
        expect(summary).not.toHaveProperty("points");
        expect(summary).not.toHaveProperty("max");
        expect(summary).not.toHaveProperty("min");
      }
    }
    expect(result.timeSeries).toHaveLength(100);
    expect(result.timeSeries[0]?.points).toHaveLength(90);
    expect(result.timeSeries[0]?.points[89]).toMatchObject({
      timestamp: new Date(Number(raw[0]!.points[89]!.timestamp.seconds) * 1000).toISOString(),
      shortPosition: raw[0]!.points[89]!.shortPosition,
    });
    expect(result.stockListItems).toHaveLength(20);
    expect(result.period).toBe("3m");
    expect(result.lastUpdated).toBe(result.timeSeries[0]?.points[89]?.timestamp);

    const legacyBytes = Buffer.byteLength(JSON.stringify({ ...result, movers: fullMovers }));
    const summaryBytes = Buffer.byteLength(JSON.stringify(result));
    // Meaningful payload budget for 100 table rows / 90 points each. Histories
    // used by the table stay intact; only unused mover copies are removed.
    expect(summaryBytes).toBeLessThan(legacyBytes * 0.9);
  });

  it("normalizes existing cached mover histories without fetching or changing freshness", async () => {
    const raw = populatedSeries();
    mockGetTopShortsData.mockResolvedValueOnce({ timeSeries: raw, offset: 0 });
    const built = await getTopPageData("3m", 100);
    const legacy = {
      ...built,
      movers: calculateMovers(raw as unknown as TimeSeriesData[], "3m"),
    };
    mockGetCached.mockResolvedValueOnce(legacy);
    mockGetTopShortsData.mockClear();
    mockSetCached.mockClear();

    const result = await getTopPageData("3m", 100);

    expect(result.movers).toEqual(built.movers);
    expect(result.timeSeries).toBe(legacy.timeSeries);
    expect(result.lastUpdated).toBe(legacy.lastUpdated);
    expect(result.stockListItems).toBe(legacy.stockListItems);
    expect(mockGetTopShortsData).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(mockDeleteCached).not.toHaveBeenCalled();
    // Normalization must not mutate the shared cached object.
    expect(legacy.movers.biggestGainers).toHaveLength(10);
    expect(legacy.movers.biggestGainers[0]?.points).toHaveLength(90);
  });
});
