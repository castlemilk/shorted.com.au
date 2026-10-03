import { act, cleanup, render, screen } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SectorPerformanceWidget } from "../sector-performance-widget";
import { PortfolioSummaryWidget } from "../portfolio-summary-widget";
import { getMultipleStockQuotes, getSectorPerformance } from "@/lib/stock-data-service";
import { WidgetType, type WidgetConfig } from "~/@/types/dashboard";

jest.mock("@/lib/stock-data-service", () => ({
  getSectorPerformance: jest.fn(),
  getMultipleStockQuotes: jest.fn(),
}));
jest.mock("@visx/responsive", () => ({ ParentSize: () => null }));
jest.mock("@visx/shape", () => ({ Pie: () => null }));
jest.mock("@visx/group", () => ({ Group: () => null }));
jest.mock("@visx/scale", () => ({ scaleBand: jest.fn(), scaleLinear: jest.fn() }));
jest.mock("@visx/axis", () => ({ AxisBottom: () => null, AxisLeft: () => null }));
jest.mock("@visx/grid", () => ({ GridRows: () => null }));
jest.mock("~/@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const REFRESH_INTERVAL = 5 * 60 * 1000;
const sectors = [{
  sector: "Financials", performance: 1, volume: 100,
  topGainers: ["CBA"], topLosers: ["WBC"],
}];

function config(type: WidgetType, settings: Record<string, unknown>): WidgetConfig {
  return {
    id: "test", type, title: "Test", settings,
    layout: { x: 0, y: 0, w: 4, h: 4 }, dataSource: { endpoint: "" },
  };
}

describe("quote widget polling", () => {
  let client: QueryClient;
  let visibility: DocumentVisibilityState;
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true, get: () => visibility,
    });
    focusManager.setFocused(undefined);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    (getSectorPerformance as jest.Mock).mockResolvedValue(sectors);
    (getMultipleStockQuotes as jest.Mock).mockResolvedValue(new Map([
      ["CBA", { symbol: "CBA", price: 100, previousClose: 99, change: 1, changePercent: 1 }],
      ["BHP", { symbol: "BHP", price: 50, previousClose: 51, change: -1, changePercent: -2 }],
    ]));
  });

  afterEach(() => {
    cleanup();
    client.clear();
    focusManager.setFocused(undefined);
    if (originalVisibility) {
      Object.defineProperty(document, "visibilityState", originalVisibility);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    jest.useRealTimers();
  });

  async function settle() {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { jest.advanceTimersByTime(0); });
  }

  async function advance(ms: number) {
    await act(async () => { jest.advanceTimersByTime(ms); });
    await settle();
  }

  async function setVisibility(next: DocumentVisibilityState) {
    await act(async () => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    });
    await settle();
  }

  function sector(period = "1w") {
    return <SectorPerformanceWidget config={config(WidgetType.SECTOR_PERFORMANCE, {
      period, displayType: "heatmap",
    })} />;
  }

  it("deduplicates matching sector widgets on mount and each visible five-minute refresh", async () => {
    const widgets = (count: number) => <QueryClientProvider client={client}>
      {Array.from({ length: count }, (_, i) => <div key={i}>{sector()}</div>)}
    </QueryClientProvider>;
    const view = render(widgets(2));
    await settle();
    expect(getSectorPerformance).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Financials")).toHaveLength(2);

    await advance(60_000);
    view.rerender(widgets(3));
    await settle();
    expect(getSectorPerformance).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Financials")).toHaveLength(3);

    await advance(REFRESH_INTERVAL - 60_000);
    expect(getSectorPerformance).toHaveBeenCalledTimes(2);
    await advance(REFRESH_INTERVAL);
    expect(getSectorPerformance).toHaveBeenCalledTimes(3);
  });

  it("pauses sector polling while hidden and shares the stale refresh when visible again", async () => {
    render(<QueryClientProvider client={client}>{sector()}{sector()}</QueryClientProvider>);
    await settle();
    await setVisibility("hidden");
    await advance(3 * REFRESH_INTERVAL);
    expect(getSectorPerformance).toHaveBeenCalledTimes(1);

    await setVisibility("visible");
    expect(getSectorPerformance).toHaveBeenCalledTimes(2);
    await advance(REFRESH_INTERVAL);
    expect(getSectorPerformance).toHaveBeenCalledTimes(3);
  });

  it("does not refetch fresh sector data on a short tab switch, and keeps period keys separate", async () => {
    render(<QueryClientProvider client={client}>{sector("1w")}{sector("1m")}</QueryClientProvider>);
    await settle();
    expect(getSectorPerformance).toHaveBeenCalledTimes(2);
    expect(getSectorPerformance).toHaveBeenCalledWith("1w");
    expect(getSectorPerformance).toHaveBeenCalledWith("1m");
    await setVisibility("hidden");
    await advance(60_000);
    await setVisibility("visible");
    expect(getSectorPerformance).toHaveBeenCalledTimes(2);
  });

  it("keeps successful sector data after a refresh error, and retains the initial empty error state", async () => {
    const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<QueryClientProvider client={client}>{sector()}</QueryClientProvider>);
      await settle();
      (getSectorPerformance as jest.Mock).mockRejectedValue(new Error("Unavailable"));
      await advance(REFRESH_INTERVAL);
      expect(screen.getByText("Financials")).toBeInTheDocument();
      expect(getSectorPerformance).toHaveBeenCalledTimes(2);
      view.rerender(<QueryClientProvider client={client}>{sector("1m")}</QueryClientProvider>);
      await settle();
      expect(screen.getByText("Financials")).toBeInTheDocument();
      cleanup();
      client.clear();
      render(<QueryClientProvider client={client}>{sector()}</QueryClientProvider>);
      await settle();
      expect(screen.getByText("No sector data available")).toBeInTheDocument();
    } finally {
      log.mockRestore();
    }
  });

  it("shares portfolio quotes across reordered holdings and different share counts, then pauses and resumes polling", async () => {
    const first = config(WidgetType.PORTFOLIO_SUMMARY, { portfolio: [
      { symbol: "CBA", shares: 1 }, { symbol: "BHP", shares: 2 },
    ] });
    const second = config(WidgetType.PORTFOLIO_SUMMARY, { portfolio: [
      { symbol: "BHP", shares: 1 }, { symbol: "CBA", shares: 2 },
    ] });
    const widgets = (one: WidgetConfig) => <QueryClientProvider client={client}>
      <PortfolioSummaryWidget config={one} /><PortfolioSummaryWidget config={second} />
    </QueryClientProvider>;
    const view = render(widgets(first));
    await settle();
    expect(getMultipleStockQuotes).toHaveBeenCalledTimes(1);
    expect(getMultipleStockQuotes).toHaveBeenCalledWith(["BHP", "CBA"]);
    expect(screen.getByText("$200")).toBeInTheDocument();
    expect(screen.getByText("$250")).toBeInTheDocument();

    view.rerender(widgets({ ...first, settings: { portfolio: [
      { symbol: "CBA", shares: 3 }, { symbol: "BHP", shares: 2 },
    ] } }));
    await settle();
    expect(getMultipleStockQuotes).toHaveBeenCalledTimes(1);
    expect(screen.getByText("$400")).toBeInTheDocument();

    await advance(REFRESH_INTERVAL);
    expect(getMultipleStockQuotes).toHaveBeenCalledTimes(2);
    await setVisibility("hidden");
    await advance(3 * REFRESH_INTERVAL);
    expect(getMultipleStockQuotes).toHaveBeenCalledTimes(2);
    await setVisibility("visible");
    expect(getMultipleStockQuotes).toHaveBeenCalledTimes(3);
    expect(screen.getByText("$400")).toBeInTheDocument();
    expect(screen.getByText("$250")).toBeInTheDocument();
  });
});
