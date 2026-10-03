/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";
import { serverFetchWithUserAgent } from "~/app/actions/config";
import { rateLimit } from "~/@/lib/rate-limit";

jest.mock("~/app/actions/config", () => ({
  buildApiUrl: (origin: string, path: string) => `${origin}${path}`,
  getServerMarketDataApiUrl: () => "https://market-data.example.test",
  serverFetchWithUserAgent: jest.fn(),
}));
jest.mock("~/@/lib/rate-limit", () => ({
  BROWSER_READ_RATE_LIMIT: {},
  rateLimit: jest.fn(),
}));
jest.mock("~/@/lib/product-events", () => ({ recordProductEvent: jest.fn() }));

const symbols = [
  "CBA", "WBC", "ANZ", "NAB", "BHP", "RIO", "FMG", "NCM",
  "CSL", "COH", "SHL", "RMD", "WOW", "COL", "WES", "TWE",
  "WDS", "STO", "ORG", "OSH", "XRO", "WTC", "CPU", "APT",
];
const fetchMock = jest.mocked(serverFetchWithUserAgent);
const rateLimitMock = jest.mocked(rateLimit);

function request() {
  return new NextRequest("http://localhost/api/market-data/multiple-quotes", {
    method: "POST",
    body: JSON.stringify({ stockCodes: symbols }),
  });
}

describe("batch quote proxy deadline", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    fetchMock.mockReset();
    rateLimitMock.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof rateLimit>>);
    // Native AbortSignal.timeout uses internal Node timers. Substitute a
    // timer-backed signal so the deadline can be exercised without real waits.
    jest.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("allows a valid 35-second response and forwards all 24 symbols in one request", async () => {
    const data = { prices: { CBA: { stockCode: "CBA", close: 120 } } };
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(NextResponse.json(data)), 35_000);
    }));
    let completed = false;
    const pending = POST(request()).then((response) => { completed = true; return response; });

    await jest.advanceTimersByTimeAsync(15_000);
    expect(completed).toBe(false);
    await jest.advanceTimersByTimeAsync(20_000);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://market-data.example.test/marketdata.v1.MarketDataService/GetMultipleStockPrices",
      expect.objectContaining({
        method: "POST", body: JSON.stringify({ stockCodes: symbols }), cache: "no-store",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(55_000);
  });

  it("aborts a stalled upstream at 55 seconds and preserves the existing error response", async () => {
    fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    let completed = false;
    const pending = POST(request()).then((response) => { completed = true; return response; });

    await jest.advanceTimersByTimeAsync(54_999);
    expect(completed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch stock quotes" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("returns a rate-limit rejection without starting an upstream request or deadline", async () => {
    const rejected = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    rateLimitMock.mockResolvedValue({ success: false, response: rejected, tier: "free" } as Awaited<ReturnType<typeof rateLimit>>);

    expect(await POST(request())).toBe(rejected);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(AbortSignal.timeout).not.toHaveBeenCalled();
  });

  it("preserves the empty upstream result shape", async () => {
    fetchMock.mockResolvedValue(NextResponse.json({}));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prices: {} });
  });
});
