import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { retryWithBackoff } from "@/lib/retry";
import {
  getEconomicSeriesClient,
  listSeriesCorrelationsClient,
} from "../getEconomyClient";
import { NATIONAL_ECONOMY_OVERLAYS } from "@/lib/economy/map-metrics";

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@/lib/retry", () => ({
  retryWithBackoff: jest.fn((operation: () => unknown) => operation()),
}));

const mockCreateClient = createClient as jest.Mock;
const mockCreateConnectTransport = createConnectTransport as jest.Mock;
const mockRetryWithBackoff = retryWithBackoff as jest.Mock;

describe("listSeriesCorrelationsClient", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
  });

  it("requests ranked correlations and reuses the session-cached response", async () => {
    const response = {
      correlations: [
        {
          overlaySeriesKey: "commodities.price_index.bulk.aus",
          r: 0.81,
          n: 24,
        },
      ],
    };
    const listSeriesCorrelations = jest.fn().mockResolvedValue(response);
    mockCreateClient.mockReturnValue({ listSeriesCorrelations });

    await expect(
      listSeriesCorrelationsClient("markets.short_interest_wavg.nsw"),
    ).resolves.toBe(response);
    await expect(
      listSeriesCorrelationsClient("markets.short_interest_wavg.nsw"),
    ).resolves.toEqual(response);

    expect(mockCreateConnectTransport).toHaveBeenCalledTimes(1);
    expect(mockRetryWithBackoff).toHaveBeenCalledTimes(1);
    expect(listSeriesCorrelations).toHaveBeenCalledWith({
      baseSeriesKey: "markets.short_interest_wavg.nsw",
      windowMonths: 24,
      minAbsR: 0,
      limit: 250,
    });
  });
});

describe("getEconomicSeriesClient", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
  });

  it("sends one request when the list fits", async () => {
    const getEconomicSeries = jest.fn().mockResolvedValue({ series: [{ a: 1 }] });
    mockCreateClient.mockReturnValue({ getEconomicSeries });

    await getEconomicSeriesClient(["a", "b"]);

    expect(getEconomicSeries).toHaveBeenCalledTimes(1);
    expect(getEconomicSeries).toHaveBeenCalledWith({ seriesKeys: ["a", "b"] });
  });

  // The server REJECTS more than 50 keys — it does not truncate — and this
  // wrapper swallows errors into undefined. Unchunked, an over-long list
  // rendered as "not enough overlapping data" with nothing saying why.
  it("splits an over-long list at the server's 50-key limit and merges the results", async () => {
    const getEconomicSeries = jest
      .fn()
      .mockResolvedValueOnce({ series: [{ k: "first" }] })
      .mockResolvedValueOnce({ series: [{ k: "second" }] });
    mockCreateClient.mockReturnValue({ getEconomicSeries });

    const keys = Array.from({ length: 54 }, (_, i) => `key-${i}`);
    const result = await getEconomicSeriesClient(keys);

    expect(getEconomicSeries).toHaveBeenCalledTimes(2);
    expect(getEconomicSeries.mock.calls[0]![0].seriesKeys).toHaveLength(50);
    expect(getEconomicSeries.mock.calls[1]![0].seriesKeys).toHaveLength(4);
    expect(result?.series).toEqual([{ k: "first" }, { k: "second" }]);
  });

  // The reason the chunking above is not hypothetical: the correlation surface
  // fetches every overlay in one call on its fallback path, and the overlay
  // list crossed 50 the day the global catalog landed.
  it("is load-bearing — the national overlay list exceeds one request", () => {
    expect(NATIONAL_ECONOMY_OVERLAYS.length).toBeGreaterThan(50);
  });
});
