import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { StockChart } from "../StockChart";
import { LEGEND_HEIGHT_PX } from "../indicator-layout";
import { buildChartView } from "../chart-views";
import type { ChartSeriesSpec, OscillatorSpec, SeriesIndicator } from "../types";

// ParentSize measures the DOM, which jsdom cannot, so it is stood in for, as
// StockChart.height.test.tsx does.
jest.mock("@visx/responsive", () => ({
  ParentSize: ({
    children,
  }: {
    children: (size: { width: number; height: number }) => ReactNode;
  }) => children({ width: 600, height: 360 }),
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const points = (values: number[]) => values.map((v, i) => ({ t: T0 + i * DAY, v }));

const PRICE: ChartSeriesSpec[] = [
  {
    id: "BHP:price",
    label: "Price",
    color: "#123456",
    axis: "left",
    kind: "line",
    points: points([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]),
  },
];

/** A moving average that sits well above every close, so the domain has to reach it. */
const SMA_AT_60: SeriesIndicator = {
  id: "sma20",
  seriesId: "BHP:price",
  label: "SMA 20",
  color: "#f59e0b",
  values: Array.from({ length: 10 }, () => 60),
};

const RSI: OscillatorSpec = {
  id: "rsi14",
  label: "RSI 14",
  caption: "RSI 14",
  color: "#06b6d4",
  values: Array.from({ length: 10 }, (_, i) => 50 + i),
  reference: [30, 70],
  domain: [0, 100],
};

/** The y of every point of an svg path (`M x,y L x,y ...`), as the chart draws it. */
function pathYs(d: string): number[] {
  return Array.from(d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g), (m) => Number(m[2]));
}

/** A moving average sitting just under the highest close, where the legend is. */
const SMA_NEAR_PRICE: SeriesIndicator = {
  id: "sma20",
  seriesId: "BHP:price",
  label: "SMA 20",
  color: "#f59e0b",
  values: [null, ...Array.from({ length: 9 }, () => 47.5)],
};

/** The value axis' tick labels, as numbers. The time axis is not among them. */
function valueTicks(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll(".visx-axis-left text"))
    .map((text) => text.textContent?.trim() ?? "")
    .filter((text) => /^-?\d+(\.\d+)?$/.test(text))
    .map(Number);
}

describe("StockChart indicators", () => {
  it("names the indicators in an in-plot legend, when asked, and not on a compact chart", () => {
    const { container, rerender } = render(
      <StockChart series={PRICE} indicators={[SMA_AT_60]} indicatorLegend />,
    );
    const legend = container.querySelector('[data-chart="indicator-legend"]');
    expect(legend?.textContent).toContain("SMA 20");

    rerender(<StockChart series={PRICE} indicators={[SMA_AT_60]} />);
    expect(container.querySelector('[data-chart="indicator-legend"]')).toBeNull();

    rerender(
      <StockChart
        series={PRICE}
        indicators={[SMA_AT_60]}
        indicatorLegend
        variant="compact"
      />,
    );
    expect(container.querySelector('[data-chart="indicator-legend"]')).toBeNull();
  });

  it("reaches an indicator above the price in the value axis only when asked", () => {
    const { container, rerender } = render(
      <StockChart series={PRICE} indicators={[SMA_AT_60]} />,
    );
    const without = valueTicks(container);
    expect(without.length).toBeGreaterThan(0);
    expect(Math.max(...without)).toBeLessThan(60);

    rerender(<StockChart series={PRICE} indicators={[SMA_AT_60]} indicatorsInDomain />);
    expect(Math.max(...valueTicks(container))).toBeGreaterThanOrEqual(60);
  });

  it("captions an oscillator panel and labels its reference levels", () => {
    const { container } = render(<StockChart series={PRICE} oscillators={[RSI]} />);
    const panel = container.querySelector('[data-chart="oscillator"]');
    expect(panel?.textContent).toContain("RSI 14");
    expect(panel?.textContent).toContain("70");
  });

  it("draws a panel with no caption as before: no caption text", () => {
    const { container } = render(
      <StockChart series={PRICE} oscillators={[{ ...RSI, caption: undefined }]} />,
    );
    const panel = container.querySelector('[data-chart="oscillator"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).not.toContain("RSI 14");
  });

  it("keeps the highest value under the legend: the legend's bottom is above the first value", () => {
    // Falling from $49: the highest close is the first point, the place the legend sits.
    const falling: ChartSeriesSpec[] = [
      {
        id: "BHP:price",
        label: "Price",
        color: "#123456",
        axis: "left",
        kind: "line",
        points: points([49, 48, 47, 46, 45, 44, 43, 42, 41, 40]),
      },
    ];
    const { container } = render(
      <StockChart series={falling} indicators={[SMA_NEAR_PRICE]} indicatorLegend />,
    );
    expect(container.querySelector('[data-chart="indicator-legend"]')).not.toBeNull();
    // The legend is inset 4px and LEGEND_HEIGHT_PX tall; both share the plot's origin.
    const legendBottom = 4 + LEGEND_HEIGHT_PX;
    const line = container.querySelector('[data-series="BHP:price"] path');
    expect(Math.min(...pathYs(line!.getAttribute("d")!))).toBeGreaterThanOrEqual(legendBottom);
  });

  it("keeps an oscillator's values under its caption", () => {
    const high: OscillatorSpec = { ...RSI, values: Array.from({ length: 10 }, () => 100) };
    const { container } = render(<StockChart series={PRICE} oscillators={[high]} />);
    const panel = container.querySelector('[data-chart="oscillator"]');
    const d = panel!.querySelector('path[stroke-width="1.25"]')!.getAttribute("d")!;
    // The caption is 10px tall at y = 10: the value of 100 sits at or below 12.
    expect(Math.min(...pathYs(d))).toBeGreaterThanOrEqual(12);
  });

  it("keeps the price axis above zero when a Bollinger edge would cross it", () => {
    // $1.00 for 100 sessions, then $0.10: the lower edge crosses zero after the fall.
    const crash = Array.from({ length: 252 }, (_, i) => ({
      t: T0 + i * DAY,
      v: i < 100 ? 1 : 0.1,
    }));
    const view = buildChartView("price", {
      stockCode: "XYZ",
      short: [],
      price: crash,
      volume: [],
      indicators: ["bb20"],
    });
    const { container } = render(
      <StockChart
        series={view.series}
        indicators={view.indicators}
        leftAxis={view.leftAxis}
        indicatorsInDomain
        indicatorLegend
      />,
    );
    const labels = Array.from(
      container.querySelectorAll(".visx-axis-left text"),
      (t) => t.textContent ?? "",
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((label) => label.includes("-"))).toEqual([]);
  });
});
