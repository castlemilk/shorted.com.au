import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { retryWithBackoff } from "@/lib/retry";
import { listSeriesCorrelationsClient } from "../getEconomyClient";

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
