const unstableCache = jest.fn((callback: () => Promise<unknown>) => callback);
const screenStocks = jest.fn();
const getAvailableDates = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (...args: unknown[]) => unstableCache(...(args as [() => Promise<unknown>])),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({ transport: true })),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    screenStocks: (...args: unknown[]) => screenStocks(...args),
    getAvailableDates: (...args: unknown[]) => getAvailableDates(...args),
  })),
}));
jest.mock("../config", () => ({
  SHORTS_API_URL: "https://shorts.test",
  serverFetchOutsideNextCache: jest.fn(),
  skipForBuild: () => false,
}));

import { getShortStatistics } from "../getShortStatistics";

const stock = (stockCode: string, industry: string, marketCap: number) => ({
  stockCode,
  companyName: `${stockCode} Ltd`,
  industry,
  shortPct: 2,
  shortPctChange4w: 0,
  marketCap,
});

describe("getShortStatistics", () => {
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
    getAvailableDates.mockResolvedValue({ dates: ["2026-10-13"] });

    const stats = await getShortStatistics();

    expect(stats?.industries.map((i) => [i.industry, i.stockCount])).toEqual([
      ["Other", 3],
      ["Banks", 1],
    ]);
  });
});
