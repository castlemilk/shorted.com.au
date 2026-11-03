/**
 * The card's readers for a chart kept as posted: each series asks the stock
 * service for its anchored window, through the first-party transport, and maps
 * the answer as the live readers do. A failed or empty read is [] and is never
 * cached.
 */
const mockGetStockData = jest.fn();
const mockGetStockPrices = jest.fn();
const mockGetStockDataLive = jest.fn();
const mockCache = jest.fn();
const mockTransport = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown, keys: unknown[], opts: unknown) => {
    mockCache(keys, opts);
    return fn;
  },
}));
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

import {
  getChartPrices,
  getChartShorts,
  isSettledAnchor,
} from "../chart-data";
import type { ChartAnchor } from "~/@/components/charts/chart-anchor";

const anchor: ChartAnchor = { day: "2026-11-04", shorts: "2026-10-29" };
const DAY = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

beforeEach(() => {
  mockGetStockData.mockReset();
  mockGetStockPrices.mockReset();
  mockGetStockDataLive.mockReset();
  mockCache.mockReset();
  mockTransport.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("anchored chart readers", () => {
  it("requests the short series for the window ending on the newest report", async () => {
    mockGetStockData.mockResolvedValue({ points: [] });
    await getChartShorts("BHP", "3m", anchor).catch(() => undefined);
    expect(mockGetStockData).toHaveBeenCalledWith({
      productCode: "BHP",
      period: "3M",
      from: "2026-07-30",
      to: "2026-10-29",
    });
  });

  it("requests the prices for the window ending the day before posting", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [] });
    await getChartPrices("BHP", "3m", anchor);
    expect(mockGetStockPrices).toHaveBeenCalledWith({
      productCode: "BHP",
      from: "2026-08-04",
      to: "2026-11-03",
    });
  });

  it("goes through the first-party fetcher on the shorts API origin", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-11-03", close: 1 }] });
    await getChartPrices("BHP", "1m", anchor);
    // The config's first-party fetcher (a wrapper here, since the mock is hoisted).
    expect(mockTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function),
        baseUrl: "https://shorts.test",
      }),
    );
  });

  it("maps the short points as the live reader does", async () => {
    mockGetStockData.mockResolvedValue({
      points: [
        { timestamp: "2026-10-28T00:00:00Z", shortPosition: 3.5 },
        { timestamp: "2026-10-29T00:00:00Z", shortPosition: 3.6 },
      ],
    });
    expect(await getChartShorts("BHP", "1m", anchor)).toEqual([
      { t: DAY("2026-10-28"), v: 3.5 },
      { t: DAY("2026-10-29"), v: 3.6 },
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

  it("answers [] when the read fails, and never caches the failure", async () => {
    mockGetStockPrices.mockRejectedValue(new Error("upstream"));
    expect(await getChartPrices("BHP", "1m", anchor)).toEqual([]);
    expect(mockCache).toHaveBeenCalled();
  });

  it("answers [] for an empty window, which is not cached either", async () => {
    mockGetStockData.mockResolvedValue({ points: [] });
    expect(await getChartShorts("BHP", "1m", anchor)).toEqual([]);
  });

  it("keys its cache on every parameter of the window", async () => {
    mockGetStockPrices.mockResolvedValue({ points: [{ date: "2026-11-03", close: 1 }] });
    await getChartPrices("BHP", "3m", anchor);
    const [keys] = mockCache.mock.calls[0]!;
    expect(keys).toEqual(expect.arrayContaining(["BHP", "2026-08-04", "2026-11-03"]));
  });

  it("keeps the live reader for a chart with no anchor", async () => {
    mockGetStockDataLive.mockResolvedValue({ points: [] });
    await getChartShorts("BHP", "1m");
    expect(mockGetStockDataLive).toHaveBeenCalledWith("BHP", "1m");
    expect(mockGetStockData).not.toHaveBeenCalled();
  });
});

describe("isSettledAnchor", () => {
  // 10:00 on 4 Nov 2026 in Sydney (AEDT, UTC+11).
  const now = new Date("2026-11-03T23:00:00Z");

  it("is settled from two days before today in Sydney", () => {
    expect(isSettledAnchor({ day: "2026-11-02", shorts: "2026-10-29" }, now)).toBe(true);
  });

  it("is not settled for yesterday or today", () => {
    expect(isSettledAnchor({ day: "2026-11-03", shorts: "2026-10-29" }, now)).toBe(false);
    expect(isSettledAnchor({ day: "2026-11-04", shorts: "2026-11-04" }, now)).toBe(false);
  });

  it("is not settled without an anchor", () => {
    expect(isSettledAnchor(undefined, now)).toBe(false);
    expect(isSettledAnchor(null, now)).toBe(false);
  });
});
