/**
 * The windowed reads of a chart kept as posted, through TanStack Query. A
 * transient failure must not become a successful empty series: that would be
 * cached for the stale time (30 minutes). The client calls are stood in for;
 * the query's own behaviour is the real one.
 */
const mockPrices = jest.fn();
const mockWindowShorts = jest.fn();
const mockLiveShorts = jest.fn();
jest.mock("@/lib/client-api", () => ({
  fetchStockClient: jest.fn(),
  fetchStockDataClient: (...args: unknown[]) => mockLiveShorts(...args),
  fetchStockDataWindowClient: (...args: unknown[]) => mockWindowShorts(...args),
  fetchStockDetailsClient: jest.fn(),
  fetchStockPricesClient: (...args: unknown[]) => mockPrices(...args),
  fetchTopShortsClient: jest.fn(),
}));
jest.mock("@/lib/stock-data-service", () => ({
  getMultipleStockQuotes: jest.fn(),
  getHistoricalData: jest.fn(async () => []),
  getStockPrice: jest.fn(),
  QUOTE_REFRESH_INTERVAL_MS: 1800000,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useHistoricalData, useShortTimeSeries } from "../use-stock-queries";

const range = { from: "2026-08-04", to: "2026-11-03" };

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  mockPrices.mockReset();
  mockWindowShorts.mockReset();
  mockLiveShorts.mockReset();
});

describe("windowed prices", () => {
  it("is an error, not an empty success, once its retries are spent", async () => {
    // The hook's own retry rule (retryWindowedRead) overrides the client's:
    // three retries, then an error, never an empty success.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    mockPrices.mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() => useHistoricalData("BHP", "3m", { window: range }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockPrices).toHaveBeenCalledTimes(4);
    expect(result.current.data).toBeUndefined();
  });

  it("retries a transient failure and keeps the answer that follows", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    mockPrices
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce([{ date: "2026-11-03", open: 1, high: 1, low: 1, close: 2, volume: 5 }]);
    const { result } = renderHook(() => useHistoricalData("BHP", "3m", { window: range }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPrices).toHaveBeenCalledTimes(2);
    expect(result.current.data?.[0]?.close).toBe(2);
  });

  it("takes an empty answer for a window with no sessions as a success", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockPrices.mockResolvedValue([]);
    const { result } = renderHook(() => useHistoricalData("BHP", "3m", { window: range }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe("windowed shorts", () => {
  it("is an error, not an empty success, once its retries are spent", async () => {
    // The hook's own retry rule (retryWindowedRead) overrides the client's:
    // three retries, then an error, never an empty success.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    mockWindowShorts.mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() => useShortTimeSeries("BHP", "3m", { window: range }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockWindowShorts).toHaveBeenCalledTimes(4);
    expect(result.current.data).toBeUndefined();
  });

  it("asks the windowed client, with the period, and not the live one", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockWindowShorts.mockResolvedValue({ points: [] });
    const { result } = renderHook(() => useShortTimeSeries("BHP", "3m", { window: range }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockWindowShorts).toHaveBeenCalledWith("BHP", "3m", range);
    expect(mockLiveShorts).not.toHaveBeenCalled();
  });
});
