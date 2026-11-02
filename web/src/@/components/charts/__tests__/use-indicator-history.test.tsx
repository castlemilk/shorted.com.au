import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getHistoricalData } from "@/lib/stock-data-service";
import { fetchStockDataClient } from "@/lib/client-api";
import { useIndicatorHistory } from "../use-indicator-history";
import {
  PRICE_SESSIONS,
  SHORT_DAYS,
  readyIndicators,
  type ChartIndicatorId,
} from "../chart-indicators";
import type { ChartPeriod } from "../chart-views";

// The price and short queries are stood in for; the hook itself, its query keys
// and its use of a QueryClient are the real ones.
jest.mock("@/lib/stock-data-service", () => ({
  getHistoricalData: jest.fn(),
  getMultipleStockQuotes: jest.fn(),
  getStockPrice: jest.fn(),
  QUOTE_REFRESH_INTERVAL_MS: 60_000,
}));

jest.mock("@/lib/client-api", () => ({
  fetchStockClient: jest.fn(),
  fetchStockDataClient: jest.fn(),
  fetchStockDetailsClient: jest.fn(),
  fetchTopShortsClient: jest.fn(),
}));

const DAY = 86_400_000;
const LAST_SESSION = Date.UTC(2026, 9, 30);

/** `n` daily closes ending on the last session, in the shape the price query returns. */
function priceRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(LAST_SESSION - (n - 1 - i) * DAY).toISOString().slice(0, 10),
    open: 10,
    high: 10,
    low: 10,
    close: 10 + i * 0.01,
    volume: 1000,
    adjustedClose: 10,
  }));
}

/** `n` daily short-interest points ending on the last session, in the shape the short query returns. */
function shortRows(n: number) {
  return {
    points: Array.from({ length: n }, (_, i) => ({
      timestamp: {
        seconds: BigInt(Math.floor((LAST_SESSION - (n - 1 - i) * DAY) / 1000)),
        nanos: 0,
      },
      shortPosition: 3 + i * 0.001,
    })),
  };
}

// A load held until the test settles it: a warm-up that is still in flight.
interface Held {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
const held = new Map<string, Held>();

function hold(key: string): void {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  held.set(key, { promise, resolve, reject });
}

function renderHistory(
  initial: { period: ChartPeriod; ids: ChartIndicatorId[] },
  options: { strict?: boolean } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => {
    const inner = <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return options.strict ? <StrictMode>{inner}</StrictMode> : inner;
  };
  return renderHook(
    (props: { code: string; period: ChartPeriod; ids: ChartIndicatorId[] }) =>
      useIndicatorHistory(props.code, props.period, props.ids),
    { wrapper, initialProps: { code: "BHP", ...initial } },
  );
}

/** The periods the price query was asked for, in order. */
const pricePeriods = () =>
  jest.mocked(getHistoricalData).mock.calls.map((call) => call[1] as string);

beforeEach(() => {
  held.clear();
  jest.mocked(getHistoricalData).mockClear();
  jest.mocked(fetchStockDataClient).mockClear();
  jest.mocked(getHistoricalData).mockImplementation(((_code: string, period: string) => {
    const pending = held.get(`price:${period}`);
    if (pending) return pending.promise;
    return Promise.resolve(priceRows(PRICE_SESSIONS[period as ChartPeriod]));
  }) as never);
  jest.mocked(fetchStockDataClient).mockImplementation(((_code: string, period: string) => {
    const pending = held.get(`short:${period}`);
    if (pending) return pending.promise;
    return Promise.resolve(shortRows(SHORT_DAYS[period as Exclude<ChartPeriod, "max">]));
  }) as never);
});

describe("useIndicatorHistory", () => {
  it("holds back only the indicator that needs the longer history, and keeps the rest", async () => {
    hold("price:2y");
    const { result, rerender } = renderHistory({ period: "1y", ids: ["sma20"] });
    await waitFor(() => expect(getHistoricalData).toHaveBeenCalledWith("BHP", "1y"));

    // SMA 50 needs 2y of history for a 1y chart; SMA 20 needs none, so it stays.
    rerender({ code: "BHP", period: "1y", ids: ["sma20", "sma50"] });
    await waitFor(() => expect(result.current.waiting).toEqual(["sma50"]));
    expect(result.current.pricePending).toBe(true);
    const drawn = readyIndicators(
      ["sma20", "sma50"],
      { price: result.current.pricePending, short: result.current.shortPending },
      result.current.waiting,
    );
    expect(drawn).toEqual(["sma20"]);

    // The history lands: nothing waits, and the longer history is kept.
    await act(async () => held.get("price:2y")!.resolve(priceRows(PRICE_SESSIONS["2y"])));
    await waitFor(() => expect(result.current.waiting).toEqual([]));
    expect(result.current.pricePending).toBe(false);
    expect(result.current.price).toHaveLength(PRICE_SESSIONS["2y"]);
  });

  it("keeps the history it has while a longer period loads, and says which indicator waits", async () => {
    // SMA 50 on a 1m chart needs 6m; that history is kept.
    const { result, rerender } = renderHistory({ period: "1m", ids: ["sma50"] });
    await waitFor(() => expect(result.current.price).toHaveLength(PRICE_SESSIONS["6m"]));
    expect(result.current.waiting).toEqual([]);

    // SMA 200 needs 1y. While that loads, SMA 50 is covered by the 6m kept, and
    // SMA 200 is not: only it waits, and the 6m history is still in use.
    hold("price:1y");
    rerender({ code: "BHP", period: "1m", ids: ["sma50", "sma200"] });
    await waitFor(() => expect(result.current.waiting).toEqual(["sma200"]));
    expect(result.current.price).toHaveLength(PRICE_SESSIONS["6m"]);

    await act(async () => held.get("price:1y")!.resolve(priceRows(PRICE_SESSIONS["1y"])));
    await waitFor(() => expect(result.current.waiting).toEqual([]));
    expect(result.current.price).toHaveLength(PRICE_SESSIONS["1y"]);
  });

  it("keeps the longer history when the indicator that needed it is turned off", async () => {
    const { result, rerender } = renderHistory({ period: "1m", ids: ["sma50"] });
    await waitFor(() => expect(result.current.price).toHaveLength(PRICE_SESSIONS["6m"]));

    // Turning SMA 50 off needs no history on a 1m chart, and drops no history either.
    rerender({ code: "BHP", period: "1m", ids: [] });
    expect(result.current.price).toHaveLength(PRICE_SESSIONS["6m"]);
    expect(result.current.waiting).toEqual([]);
  });

  it("does not hold an indicator back once its warm-up has failed: it draws from the visible data", async () => {
    hold("price:6m");
    const { result, rerender } = renderHistory({ period: "1m", ids: [] });
    rerender({ code: "BHP", period: "1m", ids: ["sma50"] });
    await waitFor(() => expect(result.current.waiting).toEqual(["sma50"]));

    await act(async () => held.get("price:6m")!.reject(new Error("offline")));
    await waitFor(() => expect(result.current.waiting).toEqual([]));
    expect(result.current.price).toBeUndefined();
  });

  it("starts a new stock with nothing kept from the last one", async () => {
    const { result, rerender } = renderHistory({ period: "1m", ids: ["sma50"] });
    await waitFor(() => expect(result.current.price).toHaveLength(PRICE_SESSIONS["6m"]));

    rerender({ code: "CBA", period: "1m", ids: [] });
    expect(result.current.price).toBeUndefined();
  });

  // A 1Y chart with SMA 50 loads 2Y. Moving to 3M, the 2Y history already reaches
  // SMA 50's lookback, so the 6M warm-up the plan of 3M would give is not asked for.
  it("does not ask for a warm-up the history already held covers, even under StrictMode", async () => {
    const { result, rerender } = renderHistory(
      { period: "1y", ids: ["sma50"] },
      { strict: true },
    );
    await waitFor(() => expect(result.current.price).toHaveLength(PRICE_SESSIONS["2y"]));
    expect(pricePeriods()).toEqual(expect.arrayContaining(["1y", "2y"]));

    rerender({ code: "BHP", period: "3m", ids: ["sma50"] });
    await waitFor(() => expect(pricePeriods()).toContain("3m"));
    expect(result.current.waiting).toEqual([]);
    expect(result.current.price).toHaveLength(PRICE_SESSIONS["2y"]);
    expect(pricePeriods()).not.toContain("6m");
  });

  it("asks for a warm-up only for the indicator the held history does not cover", async () => {
    const { result, rerender } = renderHistory({ period: "1m", ids: ["sma50"] });
    await waitFor(() => expect(result.current.price).toHaveLength(PRICE_SESSIONS["6m"]));

    // SMA 50 is covered by the 6M held; SMA 200 needs 1Y, so only 1Y is asked for.
    rerender({ code: "BHP", period: "1m", ids: ["sma50", "sma200"] });
    await waitFor(() => expect(pricePeriods()).toContain("1y"));
    expect(pricePeriods().filter((period) => period === "6m")).toHaveLength(1);
    expect(pricePeriods().filter((period) => period === "1y")).toHaveLength(1);
  });

  it("keeps short interest history the same way, and waits for it per indicator", async () => {
    hold("short:3m");
    const { result, rerender } = renderHistory({ period: "1m", ids: [] });
    rerender({ code: "BHP", period: "1m", ids: ["short-avg-30d"] });
    await waitFor(() => expect(result.current.waiting).toEqual(["short-avg-30d"]));
    expect(result.current.shortPending).toBe(true);
    expect(result.current.pricePending).toBe(false);

    await act(async () => held.get("short:3m")!.resolve(shortRows(SHORT_DAYS["3m"])));
    await waitFor(() => expect(result.current.waiting).toEqual([]));
    expect(result.current.short).toHaveLength(SHORT_DAYS["3m"]);
  });
});
