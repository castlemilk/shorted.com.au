import { fireEvent, render, screen } from "@testing-library/react";

const DAY = 86_400_000;
const points = Array.from({ length: 260 }, (_, i) => ({
  t: Date.UTC(2025, 9, 1) + i * DAY,
  v: 40 + (i % 7),
}));
const shortPoints = points.map((p) => ({ t: p.t, v: 5 }));

// What the chart-data hook answers. A test may change it; beforeEach puts it
// back. The arrays keep their identity between renders, as the real hook's do.
const mockChartData = {
  price: points,
  short: shortPoints,
  anyLoading: false,
  isError: false,
};

const mockUseStockChartData = jest.fn((code: string, period: string) => ({
  volume: [],
  correlation: null,
  ...mockChartData,
}));
jest.mock("~/@/components/charts/use-stock-chart-data", () => ({
  useStockChartData: (code: string, period: string) =>
    mockUseStockChartData(code, period),
}));

type ChartStandInProps = {
  series: Array<{ id: string }>;
  levels?: Array<{ axis: string }>;
  bands?: unknown[];
  markers?: unknown[];
  indicators?: Array<{ seriesId: string; color: string; values: unknown[] }>;
  leftAxis?: { format?: (v: number) => string };
  rightAxis?: { format?: (v: number) => string };
  viewMode?: string;
  height?: number;
  showBrush?: boolean;
};
jest.mock("~/@/components/charts/StockChart", () => ({
  StockChart: (p: ChartStandInProps) => (
    <div
      data-testid="chart"
      data-series={p.series.length}
      data-series-ids={p.series.map((s) => s.id).join(",")}
      data-levels={p.levels?.length ?? 0}
      data-level-axes={(p.levels ?? []).map((l) => l.axis).join(",")}
      data-bands={p.bands?.length ?? 0}
      data-markers={p.markers?.length ?? 0}
      data-indicators={p.indicators?.length ?? 0}
      data-indicator-targets={(p.indicators ?? [])
        .map((i) => i.seriesId)
        .join(",")}
      data-indicator-lengths={(p.indicators ?? [])
        .map((i) => i.values.length)
        .join(",")}
      data-indicator-colors={(p.indicators ?? []).map((i) => i.color).join(",")}
      data-right-axis={p.rightAxis ? "on" : "off"}
      data-view-mode={p.viewMode ?? "absolute"}
      data-left-sample={p.leftAxis?.format?.(12.5)}
      data-right-sample={p.rightAxis?.format?.(12.5)}
      data-height={p.height}
      data-show-brush={String(p.showBrush)}
    />
  ),
}));

import { StrategyLevelsChart } from "../strategy-levels-chart";
import { LEVEL_COLORS } from "../strategy-levels";
import type {
  StockPriceFeatures,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

const fits: StockStrategyFitRow[] = [
  {
    strategyId: "zanger-breakout",
    strategyName: "Zanger Breakout",
    status: "watch",
    score: 30,
    rank: 9,
    totalCount: 40,
    rules: [],
    ruleColumns: [],
  },
  {
    strategyId: "minervini-trend-template",
    strategyName: "Minervini Trend Template",
    status: "triggered",
    score: 68,
    rank: 2,
    totalCount: 90,
    rules: [],
    ruleColumns: [],
  },
  {
    strategyId: "crowded-short-breakout",
    strategyName: "Crowded-Short Breakout",
    status: "none",
    score: null,
    rank: null,
    totalCount: 12,
    rules: [
      {
        ruleId: "short_interest",
        status: "pass",
        detail: "Short interest 6.5% ≥ 5%",
      },
    ],
    ruleColumns: [{ id: "short_interest", title: "Short interest" }],
  },
];
// A strategy whose level set has no caption lines of its own: it draws the
// 200-day average and says nothing under the chart.
const qualityCompounders: StockStrategyFitRow = {
  strategyId: "quality-compounders",
  strategyName: "Quality Compounders",
  status: "setup",
  score: 55,
  rank: 4,
  totalCount: 60,
  rules: [],
  ruleColumns: [],
};
const pf: StockPriceFeatures = {
  asOf: "2026-10-07",
  close: 42.1,
  sma50: 40,
  sma150: 39,
  sma200: 38.5,
  sma200PriorMonth: 38.1,
  high52w: 45,
  low52w: 30,
  baseHigh: 43,
  baseLow: 39,
  baseDepthPct: 9.3,
  baseLengthDays: 22,
  breakoutRecent: true,
  breakoutDate: "2026-09-19",
  rs3mPct: 4.2,
  rs6mPct: null,
  volumeRatio50d: 1.8,
  sessionsAvailable: 260,
};

const renderChart = (
  props: Partial<React.ComponentProps<typeof StrategyLevelsChart>> = {},
) =>
  render(
    <StrategyLevelsChart
      stockCode="BHP"
      fits={fits}
      priceFeatures={pf}
      {...props}
    />,
  );

describe("StrategyLevelsChart", () => {
  beforeEach(() => {
    mockUseStockChartData.mockClear();
    Object.assign(mockChartData, {
      price: points,
      short: shortPoints,
      anyLoading: false,
      isError: false,
    });
  });

  it("defaults to the strongest strategy and draws its full-lookback averages", () => {
    render(
      <StrategyLevelsChart stockCode="BHP" fits={fits} priceFeatures={pf} />,
    );
    expect(
      screen.getByRole("button", { name: "Minervini Trend Template" }),
    ).toHaveAttribute("aria-pressed", "true");
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-levels", "5");
    expect(chart).toHaveAttribute("data-indicators", "3"); // 260 points ≥ 200: every window is full
    expect(chart).toHaveAttribute("data-series", "1");
  });

  it("switches level sets, adds the short series for the crowded-short strategy, and quotes the rule", () => {
    render(
      <StrategyLevelsChart stockCode="BHP" fits={fits} priceFeatures={pf} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Crowded-Short Breakout" }),
    );
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-series", "2");
    expect(chart).toHaveAttribute("data-bands", "1");
    expect(screen.getByText("Short interest 6.5% ≥ 5%")).toBeInTheDocument();
  });

  it("is price-only with a note when features are null", () => {
    render(
      <StrategyLevelsChart stockCode="BHP" fits={fits} priceFeatures={null} />,
    );
    expect(screen.getByTestId("chart")).toHaveAttribute("data-levels", "0");
    expect(screen.getByText(/showing price only/)).toBeInTheDocument();
  });

  it("draws no moving-average line when there are no features to attempt one for", () => {
    renderChart({ priceFeatures: null });
    expect(screen.getByTestId("chart")).toHaveAttribute("data-indicators", "0");
  });

  describe("moving-average lines need a full lookback", () => {
    it.each<[number, number]>([
      [260, 3],
      [200, 3],
      [199, 2],
      [150, 2],
      [149, 1],
      [50, 1],
      [49, 0],
    ])("%i loaded prices draw %i of the 3 average lines", (loaded, lines) => {
      mockChartData.price = points.slice(0, loaded);
      renderChart();
      const chart = screen.getByTestId("chart");
      expect(chart).toHaveAttribute("data-indicators", String(lines));
      // The levels are the current values, which the window does not change.
      expect(chart).toHaveAttribute("data-levels", "5");
    });
  });

  describe("what reaches the chart", () => {
    it("keeps every level on the price axis and the chart in absolute prices, whichever strategy is shown", () => {
      renderChart();
      for (const name of [
        "Zanger Breakout",
        "Minervini Trend Template",
        "Crowded-Short Breakout",
      ]) {
        fireEvent.click(screen.getByRole("button", { name }));
        const chart = screen.getByTestId("chart");
        const axes = (chart.getAttribute("data-level-axes") ?? "")
          .split(",")
          .filter(Boolean);
        expect(axes.length).toBeGreaterThan(0);
        expect(new Set(axes)).toEqual(new Set(["left"]));
        expect(chart).toHaveAttribute("data-view-mode", "absolute");
      }
    });

    it("opens the right axis for the short series of the crowded-short strategy only", () => {
      renderChart();
      const chart = screen.getByTestId("chart");
      expect(chart).toHaveAttribute("data-right-axis", "off");
      expect(chart).toHaveAttribute("data-series-ids", "BHP:price");
      fireEvent.click(
        screen.getByRole("button", { name: "Crowded-Short Breakout" }),
      );
      expect(chart).toHaveAttribute("data-right-axis", "on");
      expect(chart).toHaveAttribute("data-series-ids", "BHP:price,BHP:short");
      fireEvent.click(screen.getByRole("button", { name: "Zanger Breakout" }));
      expect(chart).toHaveAttribute("data-right-axis", "off");
    });

    it("draws the short series only beside the prices its levels are placed against", () => {
      mockChartData.price = [];
      renderChart({ initialStrategyId: "crowded-short-breakout" });
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
      expect(screen.getByText("No price data for BHP.")).toBeInTheDocument();
    });
  });

  describe("the chart's wiring", () => {
    it("reads the prices for the stock over the layout chart's period, so the query is shared", () => {
      renderChart({ stockCode: "CBA" });
      expect(mockUseStockChartData).toHaveBeenCalledWith("CBA", "1y");
    });

    it("lays each average over the price series, one value per price, in the colour of its level", () => {
      renderChart();
      const chart = screen.getByTestId("chart");
      expect(chart).toHaveAttribute(
        "data-indicator-targets",
        "BHP:price,BHP:price,BHP:price",
      );
      expect(chart).toHaveAttribute(
        "data-indicator-lengths",
        `${points.length},${points.length},${points.length}`,
      );
      expect(chart).toHaveAttribute(
        "data-indicator-colors",
        [LEVEL_COLORS.sma50, LEVEL_COLORS.sma150, LEVEL_COLORS.sma200].join(
          ",",
        ),
      );
    });

    it("draws the price alone when the short interest has not loaded", () => {
      mockChartData.short = [];
      renderChart({ initialStrategyId: "crowded-short-breakout" });
      expect(screen.getByTestId("chart")).toHaveAttribute(
        "data-series-ids",
        "BHP:price",
      );
    });

    it("formats the price axis in dollars and the short axis in percent", () => {
      renderChart();
      const chart = screen.getByTestId("chart");
      expect(chart).toHaveAttribute("data-left-sample", "$12.50");
      expect(chart).not.toHaveAttribute("data-right-sample");
      fireEvent.click(
        screen.getByRole("button", { name: "Crowded-Short Breakout" }),
      );
      expect(chart).toHaveAttribute("data-left-sample", "$12.50");
      expect(chart).toHaveAttribute("data-right-sample", "12.5%");
    });

    it("gives the chart the height of its placeholders, and no brush", () => {
      renderChart();
      const chart = screen.getByTestId("chart");
      expect(chart).toHaveAttribute("data-height", "360");
      expect(chart).toHaveAttribute("data-show-brush", "false");
    });
  });

  describe("the strategy control", () => {
    it("marks the strategy shown, moves the mark and the caption with a choice", () => {
      const { container } = renderChart();
      const root = container.querySelector("[data-strategy-chart]");
      expect(root).toHaveAttribute(
        "data-strategy-chart",
        "minervini-trend-template",
      );
      expect(
        screen.getByText("Close $42.10 vs 52-week high $45.00"),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Zanger Breakout" }));
      expect(root).toHaveAttribute("data-strategy-chart", "zanger-breakout");
      expect(
        screen.getByRole("button", { name: "Zanger Breakout" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("button", { name: "Minervini Trend Template" }),
      ).toHaveAttribute("aria-pressed", "false");
      expect(
        screen.getByText("Base 9.3% deep over 22 sessions"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Close $42.10 vs 52-week high $45.00"),
      ).not.toBeInTheDocument();
    });

    it("starts on the strategy it is told to", () => {
      renderChart({ initialStrategyId: "zanger-breakout" });
      expect(
        screen.getByRole("button", { name: "Zanger Breakout" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("chart")).toHaveAttribute("data-bands", "1");
    });

    it("quotes the short-interest evidence of the crowded-short strategy only", () => {
      renderChart();
      expect(
        screen.queryByText("Short interest 6.5% ≥ 5%"),
      ).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Crowded-Short Breakout" }),
      );
      expect(screen.getByText("Short interest 6.5% ≥ 5%")).toBeInTheDocument();
    });
  });

  describe("the date the levels are as at", () => {
    // The levels are as at the picker's last refresh, while the prices are
    // fetched when the page is viewed: the newest bar can post-date a level, and
    // a level it has crossed would read as current without a date.
    it("is stated under the chart, whichever strategy is shown", () => {
      renderChart();
      for (const name of [
        "Zanger Breakout",
        "Minervini Trend Template",
        "Crowded-Short Breakout",
      ]) {
        fireEvent.click(screen.getByRole("button", { name }));
        expect(screen.getByText("Levels as at 7 Oct 2026")).toBeInTheDocument();
      }
    });

    it("follows the strategy's own caption lines, in the same list", () => {
      renderChart({ initialStrategyId: "zanger-breakout" });
      expect(
        screen.getAllByRole("listitem").map((item) => item.textContent),
      ).toEqual([
        "Base 9.3% deep over 22 sessions",
        "Volume 1.8× the 50-day average",
        "Levels as at 7 Oct 2026",
      ]);
    });

    it("dates a strategy that has no caption lines of its own", () => {
      renderChart({ fits: [qualityCompounders] });
      expect(screen.getByTestId("chart")).toHaveAttribute("data-levels", "1");
      expect(
        screen.getAllByRole("listitem").map((item) => item.textContent),
      ).toEqual(["Levels as at 7 Oct 2026"]);
    });

    it.each([
      ["2026-09-30", "30 Sep 2026"], // "Sep", where Node 24's en-AU says "Sept"
      ["2026-01-05", "5 Jan 2026"], // the day is not zero-padded
    ])("writes %s as %s", (asOf, written) => {
      renderChart({ priceFeatures: { ...pf, asOf } });
      expect(screen.getByText(`Levels as at ${written}`)).toBeInTheDocument();
    });

    it("is left out when there are no levels to date", () => {
      renderChart({ priceFeatures: null });
      expect(screen.queryByText(/Levels as at/)).not.toBeInTheDocument();
      expect(screen.getByText(/showing price only/)).toBeInTheDocument();
    });

    it.each(["", "2026-02-31", "yesterday"])(
      "is left out, not guessed, when the as-of date %p is not a real day",
      (asOf) => {
        renderChart({ priceFeatures: { ...pf, asOf } });
        expect(screen.queryByText(/Levels as at/)).not.toBeInTheDocument();
        // The levels themselves are still drawn.
        expect(screen.getByTestId("chart")).toHaveAttribute("data-levels", "5");
      },
    );
  });

  describe("without a chart to draw", () => {
    it("says so when the price data cannot be loaded", () => {
      Object.assign(mockChartData, { price: [], short: [], isError: true });
      renderChart();
      expect(
        screen.getByText("Unable to load price data."),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    });

    it("holds the place of the chart, announced, while the prices load", () => {
      Object.assign(mockChartData, { price: [], short: [], anyLoading: true });
      renderChart();
      expect(
        screen.getByRole("status", { name: "Loading chart" }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    });

    it("says there is no price data when the load finished with none", () => {
      Object.assign(mockChartData, { price: [], short: [] });
      renderChart();
      expect(screen.getByText("No price data for BHP.")).toBeInTheDocument();
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    });
  });
});
