/**
 * The card's readers for a chart kept as posted. Each series asks the stock
 * service for its anchored window through the first-party transport, and maps
 * the answer as the live readers do.
 *
 * The data cache is a fake that stores a value only when the loader resolves,
 * as Next's does. So the failure tests can tell that a failed or empty read is
 * asked again next time, rather than the mock passing every call through.
 */
const mockStore = new Map<string, unknown>();
const mockCacheOptions: Array<{ keys: unknown[]; opts: { revalidate: number } }> = [];
const mockGetStockData = jest.fn();
const mockGetStockPrices = jest.fn();
const mockGetStockDataLive = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (
    fn: () => Promise<unknown>,
    keys: unknown[],
    opts: { revalidate: number },
  ) => {
    mockCacheOptions.push({ keys, opts });
    const key = JSON.stringify(keys);
    return async () => {
      if (mockStore.has(key)) return mockStore.get(key);
      // A rejection is not stored: the next call runs the loader again.
      const value = await fn();
      mockStore.set(key, value);
      return value;
    };
  },
}));
const mockTransport = jest.fn();
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (opts: unknown) => {
    mockTransport(opts);
    return {};
  },
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getStockData: (req: unknown) => mockGetStockData(req),
    getStockPrices: (req: unknown) => mockGetStockPrices(req),
  }),
}));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));
jest.mock("~/app/actions/getStockData", () => ({
  getStockData: (code: string, period: string) => mockGetStockDataLive(code, period),
}));
jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "https://shorts.test",
  serverFetchOutsideNextCache: jest.fn(),
  serverFetchWithUserAgent: jest.fn(),
  getServerMarketDataApiUrl: () => "https://market.test",
  buildApiUrl: (base: string, path: string) => `${base}${path}`,
}));

import { getChartPrices, getChartShorts } from "../chart-data";
import {
  anchoredWindows,
  type ChartAnchor,
} from "~/@/components/charts/chart-anchor";

const anchor: ChartAnchor = {
  day: "2026-11-04",
  prices: "2026-11-03",
  shorts: "2026-10-28",
};
const DAY = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

beforeEach(() => {
  mockStore.clear();
  mockCacheOptions.length = 0;
  mockTransport.mockReset();
  mockGetStockData.mockReset();
  mockGetStockPrices.mockReset();
  mockGetStockDataLive.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("anchored chart readers: windows", () => {
  it("asks the short series for the shorts window of the anchor", async () => {
    mockGetStockData.mockResolvedValue({ points: [] });
    await getChartShorts("BHP", "3m", anchor);
    const w = anchoredWindows("3m", anchor).shorts;
    expect(mockGetStockData).toHaveBeenCalledWith({
      productCode: "BHP",
      period: "3M",
      from: w.from,
      to: w.to,
    });
  });

  it("asks the prices for the prices window, which ends on the newest close", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [] });
    await getChartPrices("BHP", "3m", anchor);
    const w = anchoredWindows("3m", anchor).prices;
    expect(mockGetStockPrices).toHaveBeenCalledWith({
      productCode: "BHP",
      from: w.from,
      to: w.to,
    });
    expect(w.to).toBe("2026-11-03");
  });

  it("asks ten years back for MAX prices, as the live chart does", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [] });
    await getChartPrices("BHP", "max", anchor);
    const w = anchoredWindows("max", anchor).prices;
    expect(mockGetStockPrices).toHaveBeenCalledWith({
      productCode: "BHP",
      from: w.from,
      to: "2026-11-03",
    });
    // Ten years back from the newest close, the first day after that date.
    expect(w.from).toBe("2016-11-04");
  });

  it("goes through the first-party fetcher on the shorts API origin", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-11-03", close: 1 }] });
    await getChartPrices("BHP", "1m", anchor);
    expect(mockTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function),
        baseUrl: "https://shorts.test",
      }),
    );
  });

  it("does not ask the API for a window that cannot hold a session", async () => {
    // The shorts window reaches back from the anchor's shorts day ("2026-01-05")
    // to a later start: from is after to.
    const stale: ChartAnchor = {
      day: "2026-11-04",
      prices: "2026-11-03",
      shorts: "2026-01-05",
    };
    expect(anchoredWindows("1m", stale).shorts.from! > stale.shorts).toBe(true);
    expect(await getChartShorts("WBT", "1m", stale)).toEqual([]);
    expect(mockGetStockData).not.toHaveBeenCalled();
  });

});

describe("anchored chart readers: mapping", () => {
  it("maps the short points as the live reader does", async () => {
    mockGetStockData.mockResolvedValue({
      points: [
        { timestamp: "2026-10-27T00:00:00Z", shortPosition: 3.5 },
        { timestamp: "2026-10-28T00:00:00Z", shortPosition: 3.6 },
      ],
    });
    expect(await getChartShorts("BHP", "1m", anchor)).toEqual([
      { t: DAY("2026-10-27"), v: 3.5 },
      { t: DAY("2026-10-28"), v: 3.6 },
    ]);
  });

  it("maps the close of each session to midnight UTC, dropping a zero close", async () => {
    mockGetStockPrices.mockResolvedValue({
      points: [
        { date: "2026-11-02", close: 10 },
        { date: "2026-11-03", close: 10.5 },
        { date: "2026-11-02", close: 0 },
      ],
    });
    expect(await getChartPrices("BHP", "1m", anchor)).toEqual([
      { t: DAY("2026-11-02"), v: 10 },
      { t: DAY("2026-11-03"), v: 10.5 },
    ]);
  });
});

describe("anchored chart readers: failures are never cached", () => {
  it("answers [] on a failed read, and asks the API again on the next call", async () => {
    mockGetStockPrices
      .mockRejectedValueOnce(new Error("upstream"))
      .mockResolvedValueOnce({ points: [{ date: "2026-11-03", close: 9 }] });

    expect(await getChartPrices("BHP", "1m", anchor)).toEqual([]);
    expect(mockStore.size).toBe(0);

    expect(await getChartPrices("BHP", "1m", anchor)).toEqual([
      { t: DAY("2026-11-03"), v: 9 },
    ]);
    expect(mockGetStockPrices).toHaveBeenCalledTimes(2);
  });

  it("answers [] on an empty window, and asks again rather than store it", async () => {
    mockGetStockData
      .mockResolvedValueOnce({ points: [] })
      .mockResolvedValueOnce({ points: [{ timestamp: "2026-10-28T00:00:00Z", shortPosition: 2 }] });

    expect(await getChartShorts("BHP", "1m", anchor)).toEqual([]);
    expect(await getChartShorts("BHP", "1m", anchor)).toEqual([
      { t: DAY("2026-10-28"), v: 2 },
    ]);
    expect(mockGetStockData).toHaveBeenCalledTimes(2);
  });

  it("serves a read that answered points from the cache, without the API", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-11-03", close: 9 }] });
    await getChartPrices("BHP", "1m", anchor);
    await getChartPrices("BHP", "1m", anchor);
    expect(mockGetStockPrices).toHaveBeenCalledTimes(1);
  });

  it("keys the cache on every parameter of the window", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-11-03", close: 1 }] });
    await getChartPrices("BHP", "3m", anchor);
    const w = anchoredWindows("3m", anchor).prices;
    const keys = mockCacheOptions[0]!.keys;
    expect(keys).toEqual(expect.arrayContaining(["BHP", w.from, w.to]));
  });
});

describe("anchored chart readers: cache lifetime", () => {
  // 10:00 on 4 Nov 2026 in Sydney.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-11-03T23:00:00Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds a settled anchor's data for seven days", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-09-01", close: 1 }] });
    const settled: ChartAnchor = {
      day: "2026-09-01",
      prices: "2026-09-01",
      shorts: "2026-08-20",
    };
    await getChartPrices("BHP", "1m", settled);
    expect(mockCacheOptions[0]!.opts.revalidate).toBe(7 * 86400);
  });

  it("re-reads a chart still gaining figures hourly", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-11-03", close: 1 }] });
    await getChartPrices("BHP", "1m", anchor);
    expect(mockCacheOptions[0]!.opts.revalidate).toBe(3600);
  });
});
