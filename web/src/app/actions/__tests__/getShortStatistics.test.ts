const unstableCache = jest.fn((callback: () => Promise<unknown>) => callback);
const screenStocks = jest.fn();
const getMarketByDate = jest.fn();
const getAvailableDates = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (...args: unknown[]) => unstableCache(...(args as [() => Promise<unknown>])),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({ transport: true })),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    screenStocks: (...args: unknown[]) => screenStocks(...args),
    getMarketByDate: (...args: unknown[]) => getMarketByDate(...args),
  })),
}));
jest.mock("../config", () => ({
  SHORTS_API_URL: "https://shorts.test",
  bailOnEmptyRender: (...args: unknown[]) => bailOnEmptyRender(...args),
  serverFetchOutsideNextCache: jest.fn(),
  skipForBuild: () => false,
}));
jest.mock("../market/getMarketByDate", () => ({
  getAvailableDates: (...args: unknown[]) => getAvailableDates(...args),
}));

import { ScreenerSortField, SortDirection } from "~/gen/shorts/v1alpha1/screener_pb";
import { getShortStatistics } from "../getShortStatistics";

const REPORT_DATE = "2026-10-15";

const stock = (
  stockCode: string,
  industry: string,
  marketCap: number,
  shortPct = 2,
  shortPctChange4w = 0,
) => ({
  stockCode,
  companyName: `${stockCode} Ltd`,
  industry,
  shortPct,
  shortPctChange4w,
  marketCap,
});

/** The latest ASIC report: the codes with a reported short position. */
const report = (codes: string[]) => ({
  date: REPORT_DATE,
  stocks: codes.map((productCode) => ({ productCode, percentageShorted: 1.5 })),
  totalCount: codes.length,
});

describe("getShortStatistics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    getAvailableDates.mockResolvedValue({ dates: [REPORT_DATE] });
  });
  afterEach(() => jest.restoreAllMocks());

  it("counts a stock the ASX has not classified under Other, never as an industry", async () => {
    screenStocks.mockResolvedValue({
      totalCount: 4,
      stocks: [
        stock("CBA", "Banks", 4e9),
        stock("AFI", "Not Applic", 3e9),
        stock("XYZ", "Class Pend", 2e9),
        stock("NEW", "", 1e9),
      ],
    });
    getMarketByDate.mockResolvedValue(report(["CBA", "AFI", "XYZ", "NEW"]));

    const stats = await getShortStatistics();

    expect(stats?.industries.map((i) => [i.industry, i.stockCount])).toEqual([
      ["Other", 3],
      ["Banks", 1],
    ]);
  });

  // mv_screener_data keeps a code's newest row however old it is. On
  // 2026-10-21 /statistics led "Shorts building" with CSJ (last reported
  // 2012-08-01, +8.49 pp) and "Shorts covering" with REY (2011-12-29).
  it("leaves codes missing from the latest ASIC report out of movers and every count", async () => {
    screenStocks.mockResolvedValue({
      totalCount: 5,
      stocks: [
        stock("CSJ", "Materials", 4e8, 13.15, 8.49), // stale: the largest rise
        stock("REY", "Energy", 0, 0.01, -17.96), // stale: the largest fall
        stock("DRO", "Capital Goods", 3e9, 9.4, 2.1),
        stock("LTR", "Materials", 1e9, 6, -1.5),
        stock("BHP", "Materials", 2e11, 1.2, 0.4),
      ],
    });
    getMarketByDate.mockResolvedValue(report(["DRO", "LTR", "BHP", "CBA"]));

    const stats = await getShortStatistics();

    const movers = [...(stats?.risers ?? []), ...(stats?.fallers ?? [])].map((m) => m.code);
    expect(movers).not.toContain("CSJ");
    expect(movers).not.toContain("REY");
    expect(stats?.risers[0]?.code).toBe("DRO");
    expect(stats?.fallers[0]?.code).toBe("LTR");
    expect(stats?.stockCount).toBe(3);
    expect(stats?.avgShortPct).toBeCloseTo((9.4 + 6 + 1.2) / 3);
    expect(stats?.stocksAbove10Pct).toBe(0);
    expect(stats?.stocksAbove5Pct).toBe(2);
    expect(stats?.excludedCount).toBe(0);
    expect(stats?.topByDollars.map((s) => s.code)).toEqual(["BHP", "DRO", "LTR"]);
    expect(stats?.asOfDate).toBe(REPORT_DATE);
    expect(getMarketByDate).toHaveBeenCalledWith({ date: REPORT_DATE, limit: 1000, offset: 0 });
  });

  it("withholds the figures, rather than counting every screener row, when the report holds nothing", async () => {
    screenStocks.mockResolvedValue({ totalCount: 1, stocks: [stock("CSJ", "Materials", 4e8, 13.15, 8.49)] });
    getMarketByDate.mockResolvedValue(report([]));

    await expect(getShortStatistics()).resolves.toBeNull();
  });

  // /press and the share card render from this null too, and neither caps its
  // own fallback: without the cap here, a failed read dropped the /press
  // citation for an hour and the card's figures for a day.
  it.each([
    ["the report holds nothing", () => getMarketByDate.mockResolvedValue(report([]))],
    ["the report cannot be read", () => getMarketByDate.mockRejectedValue(new Error("unavailable"))],
    ["there is no report date", () => getAvailableDates.mockResolvedValue({ dates: [] })],
    ["the screener comes back empty", () => screenStocks.mockResolvedValue({ totalCount: 0, stocks: [] })],
  ])("caps the reading render at a minute when %s", async (_, arrange) => {
    screenStocks.mockResolvedValue({ totalCount: 1, stocks: [stock("BHP", "Materials", 2e11)] });
    getMarketByDate.mockResolvedValue(report(["BHP"]));
    arrange();

    await expect(getShortStatistics()).resolves.toBeNull();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("leaves the render's lifetime alone when it has the figures", async () => {
    screenStocks.mockResolvedValue({ totalCount: 1, stocks: [stock("BHP", "Materials", 2e11)] });
    getMarketByDate.mockResolvedValue(report(["BHP"]));

    await expect(getShortStatistics()).resolves.not.toBeNull();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("caches the report's codes and the figures per report date", async () => {
    screenStocks.mockResolvedValue({ totalCount: 1, stocks: [stock("BHP", "Materials", 2e11)] });
    getMarketByDate.mockResolvedValue(report(["BHP"]));

    await getShortStatistics();

    const keys = unstableCache.mock.calls.map((call) => (call as unknown[])[1]);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["asic-report-codes-v1", REPORT_DATE],
        ["short-statistics-v2", REPORT_DATE],
      ]),
    );
  });

  // The pages after the first used to be awaited one at a time: 17 calls in
  // series were the 1.7 s cold render (2026-10-21).
  it("asks for the first page, then the same pages as before four at a time", async () => {
    const TOTAL = 1800; // the first page and 8 more
    let inFlight = 0;
    let mostInFlight = 0;
    screenStocks.mockImplementation(async ({ offset }: { offset: number }) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { totalCount: TOTAL, stocks: [stock(`S${offset}`, "Banks", 1e9)] };
    });
    const codes = Array.from({ length: TOTAL / 200 }, (_, i) => `S${i * 200}`);
    getMarketByDate.mockResolvedValue(report(codes));

    const stats = await getShortStatistics();

    expect(mostInFlight).toBe(4);
    const requests = screenStocks.mock.calls.map((call) => (call as [Record<string, unknown>])[0]);
    expect(requests.map((r) => r.offset)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600]);
    for (const r of requests) {
      expect(r).toEqual({
        sortField: ScreenerSortField.SHORT_PCT,
        sortDirection: SortDirection.DESC,
        limit: 200,
        offset: r.offset,
      });
    }
    expect(stats?.stockCount).toBe(9);
  });

  it("stops asking once a page comes back empty", async () => {
    screenStocks.mockImplementation(async ({ offset }: { offset: number }) => ({
      totalCount: 2000,
      stocks: offset < 600 ? [stock(`S${offset}`, "Banks", 1e9)] : [],
    }));
    getMarketByDate.mockResolvedValue(report(["S0", "S200", "S400"]));

    const stats = await getShortStatistics();

    // The first page, then one batch of four (200-800) holding the empty page.
    expect(screenStocks).toHaveBeenCalledTimes(5);
    expect(stats?.stockCount).toBe(3);
  });
});
