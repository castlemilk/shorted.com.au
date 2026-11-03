/**
 * The browser's stock calls. The transport is stood in for: these are about the
 * requests a window produces, and how the answers map to the chart's shapes.
 */
const mockGetStockData = jest.fn();
const mockGetStockPrices = jest.fn();
// Plain functions, not jest.fn: the config resets mocks between tests.
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getStockData: (req: unknown) => mockGetStockData(req),
    getStockPrices: (req: unknown) => mockGetStockPrices(req),
  }),
}));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));

import { fetchStockDataClient, fetchStockPricesClient } from "../client-api";

// The transport takes `fetch` at call time; jsdom has none, and no request is made.
global.fetch = jest.fn() as unknown as typeof fetch;

beforeEach(() => {
  mockGetStockData.mockReset().mockResolvedValue({ points: [] });
  mockGetStockPrices.mockReset().mockResolvedValue({ points: [] });
});

describe("fetchStockDataClient", () => {
  it("makes the live request, unchanged, with no window", async () => {
    await fetchStockDataClient("BHP", "1y");
    expect(mockGetStockData).toHaveBeenCalledWith({ productCode: "BHP", period: "1y" });
  });

  it("names the window's dates, and keeps the period for the bucketing", async () => {
    await fetchStockDataClient("BHP", "max", { to: "2026-10-29" });
    expect(mockGetStockData).toHaveBeenCalledWith({
      productCode: "BHP",
      period: "max",
      from: "",
      to: "2026-10-29",
    });
  });
});

describe("fetchStockPricesClient", () => {
  it("asks for the window's dates and maps each session to the historical shape", async () => {
    mockGetStockPrices.mockResolvedValue({
      points: [
        {
          date: "2026-11-03",
          open: 10,
          high: 11,
          low: 9.5,
          close: 10.5,
          adjustedClose: 10.4,
          volume: BigInt(1234567),
        },
      ],
    });
    const rows = await fetchStockPricesClient("BHP", { from: "2026-08-04", to: "2026-11-03" });
    expect(mockGetStockPrices).toHaveBeenCalledWith({
      productCode: "BHP",
      from: "2026-08-04",
      to: "2026-11-03",
    });
    expect(rows).toEqual([
      {
        date: "2026-11-03",
        open: 10,
        high: 11,
        low: 9.5,
        close: 10.5,
        volume: 1234567,
        adjustedClose: 10.4,
      },
    ]);
  });

  it("leaves an open end open: a max window has no start", async () => {
    await fetchStockPricesClient("BHP", { to: "2026-11-03" });
    expect(mockGetStockPrices).toHaveBeenCalledWith({
      productCode: "BHP",
      from: "",
      to: "2026-11-03",
    });
  });

  it("answers nothing for an invalid code, without a request", async () => {
    expect(await fetchStockPricesClient("no-code!", { to: "2026-11-03" })).toBeUndefined();
    expect(mockGetStockPrices).not.toHaveBeenCalled();
  });
});
