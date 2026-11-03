import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockChartPanel } from "../StockChartPanel";
import { resetChartPrefsForTests } from "../chart-prefs";
import type { ChartPeriod } from "../chart-views";

// The panel with its real data hooks and history. The data services are the only
// stand-ins, and the chart is a probe of what it was given.
const DAY = 86_400_000;
const LAST_SESSION = Date.UTC(2026, 9, 30);

function rows(n: number) {
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

const SESSIONS: Record<string, number> = { "1m": 21, "3m": 63, "6m": 126, "1y": 252, "2y": 504, max: 2520 };

const defaultHistory = (_code: string, period: string) =>
  Promise.resolve(rows(SESSIONS[period] ?? 21));

// The 2y history hangs until the test releases it, as a warm-up in flight does.
let release2y: (() => void) | null = null;
const mockGetHistorical = jest.fn((code: string, period: string) => {
  if (period === "2y") {
    return new Promise((resolve) => {
      release2y = () => resolve(rows(SESSIONS["2y"]));
    });
  }
  return defaultHistory(code, period);
});

jest.mock("@/lib/stock-data-service", () => ({
  getHistoricalData: (code: string, period: string) => mockGetHistorical(code, period),
  getMultipleStockQuotes: jest.fn(),
  getStockPrice: jest.fn(),
  QUOTE_REFRESH_INTERVAL_MS: 60_000,
}));

jest.mock("@/lib/client-api", () => ({
  fetchStockClient: jest.fn(),
  fetchStockDetailsClient: jest.fn(),
  fetchTopShortsClient: jest.fn(),
  // No short interest: a Combined chart falls back to its price.
  fetchStockDataClient: jest.fn(() => Promise.resolve({ points: [] })),
}));

jest.mock("next/navigation", () => ({ usePathname: () => "/shorts/BHP" }));

jest.mock("~/@/components/ui/embed-dialog", () => ({
  EmbedDialog: () => <button type="button">Embed</button>,
}));

// The chart reports what it was given: the indicator and panel ids, and how many
// values the panel has (a panel waiting for its history is drawn empty).
jest.mock("../StockChart", () => ({
  StockChart: (props: {
    indicators?: { id: string }[];
    oscillators?: { id: string; values: (number | null)[] }[];
  }) => (
    <div
      data-testid="stock-chart"
      data-indicators={(props.indicators ?? []).map((i) => i.id).join(",")}
      data-oscillators={(props.oscillators ?? []).map((o) => o.id).join(",")}
      data-osc-values={(props.oscillators ?? [])
        .map((o) => o.values.filter((v) => v !== null).length)
        .join(",")}
    />
  ),
}));

function renderPanel(period: ChartPeriod, view: "combined" | "price") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StockChartPanel stockCode="BHP" defaultView={view} defaultPeriod={period} />
    </QueryClientProvider>,
  );
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const chart = () => screen.getByTestId("stock-chart");

function openIndicators() {
  const trigger = screen.getByRole("button", { name: /^Indicators/ });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

beforeEach(() => {
  resetChartPrefsForTests();
  release2y = null;
  mockGetHistorical.mockClear();
  mockGetHistorical.mockImplementation((code: string, period: string) => {
    if (period === "2y") {
      return new Promise((resolve) => {
        release2y = () => resolve(rows(SESSIONS["2y"]));
      });
    }
    return defaultHistory(code, period);
  });
});

describe("StockChartPanel: while a warm-up loads", () => {
  it("keeps SMA 20 drawn while SMA 50's history loads, and adds SMA 50 when it lands", async () => {
    renderPanel("1y", "price");
    await flush();
    await flush();
    openIndicators();
    fireEvent.click(screen.getByRole("button", { name: "SMA 20" }));
    await flush();
    expect(chart()).toHaveAttribute("data-indicators", "sma20");

    // SMA 50 needs 2y on a 1y chart. Until that lands it waits; SMA 20 does not.
    fireEvent.click(screen.getByRole("button", { name: "SMA 50" }));
    await flush();
    expect(chart()).toHaveAttribute("data-indicators", "sma20");

    await act(async () => {
      release2y?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();
    expect(chart()).toHaveAttribute("data-indicators", "sma20,sma50");
  });

  it("keeps an RSI panel in place while SMA 200's history loads, when the history RSI uses is kept", async () => {
    renderPanel("6m", "price");
    await flush();
    await flush();
    openIndicators();
    fireEvent.click(screen.getByRole("button", { name: "RSI 14" }));
    await flush();
    await flush();
    expect(chart()).toHaveAttribute("data-oscillators", "rsi14");

    // SMA 200 needs 2y. The 1y history RSI uses is kept, so the panel stays drawn.
    fireEvent.click(screen.getByRole("button", { name: "SMA 200" }));
    await flush();
    expect(chart()).toHaveAttribute("data-oscillators", "rsi14");
    expect(chart()).not.toHaveAttribute("data-osc-values", "0");
  });

  it("draws an RSI panel empty, in its place, while the history it and SMA 200 need loads together", async () => {
    renderPanel("6m", "price");
    await flush();
    await flush();
    openIndicators();
    fireEvent.click(screen.getByRole("button", { name: "RSI 14" }));
    fireEvent.click(screen.getByRole("button", { name: "SMA 200" }));
    await flush();
    // The panel keeps its place (its caption and axis), with no values yet.
    expect(chart()).toHaveAttribute("data-oscillators", "rsi14");
    expect(chart()).toHaveAttribute("data-osc-values", "0");

    await act(async () => {
      release2y?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();
    expect(chart()).toHaveAttribute("data-oscillators", "rsi14");
    expect(chart()).not.toHaveAttribute("data-osc-values", "0");
  });
});

describe("StockChartPanel: what it draws and counts", () => {
  it("says an indicator a young listing has no history for, and does not count it", async () => {
    // A listing of 100 sessions: no period has the 200 SMA 200 needs.
    mockGetHistorical.mockImplementation(async () => rows(100));
    renderPanel("1y", "price");
    await flush();
    await flush();
    openIndicators();
    fireEvent.click(screen.getByRole("button", { name: /^SMA 200/ }));
    // The item's name carries its hint once the history is known to be short.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^SMA 200/ })).toHaveTextContent(
        "Not enough history",
      ),
    );
    expect(chart()).toHaveAttribute("data-indicators", "");
    // Nothing on the chart, so nothing counted on the trigger.
    expect(screen.getByRole("button", { name: /^Indicators/ })).toHaveAccessibleName("Indicators");
  });

  it("offers and counts only what a Combined chart with one series draws", async () => {
    renderPanel("1y", "combined");
    await flush();
    await flush();
    openIndicators();
    expect(screen.getByRole("button", { name: "SMA 20" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Short 30-day avg/ })).toBeNull();
  });
});
