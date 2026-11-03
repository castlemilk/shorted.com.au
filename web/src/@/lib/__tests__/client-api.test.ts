/**
 * The browser's stock calls. The transport is stood in for: these are about the
 * requests a window produces, and how a failure reads. A transient failure
 * must reject, so TanStack retries it instead of caching an empty answer.
 */
const mockGetStockData = jest.fn();
const mockGetStockPrices = jest.fn();
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));
// Plain functions, not jest.fn: the config resets mocks between tests.
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getStockData: (req: unknown) => mockGetStockData(req),
    getStockPrices: (req: unknown) => mockGetStockPrices(req),
  }),
}));
jest.mock("~/gen/shorts/v1alpha1/stock_pb", () => ({ StockService: {} }));

// The transport takes `fetch` at call time; jsdom has none, and no request is made.
global.fetch = jest.fn() as unknown as typeof fetch;

import {
  fetchStockDataClient,
  fetchStockDataWindowClient,
  fetchStockPricesClient,
} from "../client-api";

/** A Connect error as the transport raises it: a numeric code. */
const connectError = (code: number, message = "boom") =>
  Object.assign(new Error(message), { code });
const NOT_FOUND = 5;
const INVALID_ARGUMENT = 3;
const UNAVAILABLE = 14;
const RATE_LIMITED = 8;

beforeEach(() => {
  mockGetStockData.mockReset().mockResolvedValue({ points: [] });
  mockGetStockPrices.mockReset().mockResolvedValue({ points: [] });
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("fetchStockDataClient (live)", () => {
  it("makes the live request, unchanged", async () => {
    await fetchStockDataClient("BHP", "1y");
    expect(mockGetStockData).toHaveBeenCalledWith({ productCode: "BHP", period: "1y" });
  });
});

describe("fetchStockDataWindowClient", () => {
  it("names the window's dates, and keeps the period for the bucketing", async () => {
    await fetchStockDataWindowClient("BHP", "MAX", { to: "2026-10-28" });
    expect(mockGetStockData).toHaveBeenCalledWith({
      productCode: "BHP",
      period: "MAX",
      from: "",
      to: "2026-10-28",
    });
  });

  it("answers an empty series, with no request, for a window that cannot hold a session", async () => {
    const result = await fetchStockDataWindowClient("WBT", "1M", {
      from: "2026-10-04",
      to: "2026-01-05",
    });
    expect(result.points).toEqual([]);
    expect(mockGetStockData).not.toHaveBeenCalled();
  });

  it("accepts a two-character code, the share page's and the bot's rule", async () => {
    await fetchStockDataWindowClient("XY", "1M", { to: "2026-10-28" });
    expect(mockGetStockData).toHaveBeenCalledTimes(1);
  });

  it("refuses a one-character code without a request", async () => {
    const result = await fetchStockDataWindowClient("X", "1M", { to: "2026-10-28" });
    expect(result.points).toEqual([]);
    expect(mockGetStockData).not.toHaveBeenCalled();
  });

  it("answers empty for a stock the API does not know", async () => {
    mockGetStockData.mockRejectedValue(connectError(NOT_FOUND, "not_found"));
    const result = await fetchStockDataWindowClient("BHP", "1M", { to: "2026-10-28" });
    expect(result.points).toEqual([]);
  });

  it.each([
    ["an unavailable upstream", connectError(UNAVAILABLE, "unavailable")],
    ["a rate limit", connectError(RATE_LIMITED, "resource_exhausted")],
    ["a dropped connection", new TypeError("Failed to fetch")],
  ])("rejects on %s, so the query retries", async (_label, error) => {
    mockGetStockData.mockRejectedValue(error);
    await expect(
      fetchStockDataWindowClient("BHP", "1M", { to: "2026-10-28" }),
    ).rejects.toBe(error);
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

  it("leaves an open start open: a max window has no start", async () => {
    await fetchStockPricesClient("BHP", { to: "2026-11-03" });
    expect(mockGetStockPrices).toHaveBeenCalledWith({
      productCode: "BHP",
      from: "",
      to: "2026-11-03",
    });
  });

  it("answers [] for a window that cannot hold a session, with no request", async () => {
    expect(
      await fetchStockPricesClient("BHP", { from: "2026-11-05", to: "2026-11-03" }),
    ).toEqual([]);
    expect(mockGetStockPrices).not.toHaveBeenCalled();
  });

  it("answers [] for a code the API does not know, and for an invalid argument", async () => {
    mockGetStockPrices.mockRejectedValueOnce(connectError(NOT_FOUND, "not_found"));
    expect(await fetchStockPricesClient("BHP", { to: "2026-11-03" })).toEqual([]);
    mockGetStockPrices.mockRejectedValueOnce(connectError(INVALID_ARGUMENT, "invalid_argument"));
    expect(await fetchStockPricesClient("BHP", { to: "2026-11-03" })).toEqual([]);
  });

  it("rejects on a transient failure: an empty answer is never returned for it", async () => {
    const error = connectError(UNAVAILABLE, "unavailable");
    mockGetStockPrices.mockRejectedValue(error);
    await expect(fetchStockPricesClient("BHP", { to: "2026-11-03" })).rejects.toBe(error);
  });

  it("accepts a two-character code, and refuses a seven-character one without a request", async () => {
    await fetchStockPricesClient("XY", { to: "2026-11-03" });
    expect(mockGetStockPrices).toHaveBeenCalledTimes(1);
    expect(await fetchStockPricesClient("ABCDEFG", { to: "2026-11-03" })).toEqual([]);
    expect(mockGetStockPrices).toHaveBeenCalledTimes(1);
  });
});
