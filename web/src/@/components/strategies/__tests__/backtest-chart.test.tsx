import { renderToStaticMarkup } from "react-dom/server";

import { BacktestChart, PHONE_WIDTH } from "../backtest-chart";
import { mapSeriesPoint } from "~/@/lib/strategies/map-backtest";
import {
  FIXTURE_ENGINE_SEGMENTS,
  FIXTURE_LIVE_FROM,
  FIXTURE_RECORDED_FROM,
  fixtureSeries,
} from "~/@/lib/strategies/__tests__/backtest-fixtures";

// The chart measures its own width. Under test the measured width is fixed, so the SVG is drawn.
let mockWidth = 720;
jest.mock("@/components/charts/parent-size", () => ({
  ParentSize: ({ children }: { children: (s: { width: number; height: number }) => React.ReactNode }) =>
    children({ width: mockWidth, height: 0 }),
}));

const series = fixtureSeries().map((p) => mapSeriesPoint(p));
const coverageMonthly = [
  { month: "2025-11", coveragePct: 97, measurable: true },
  { month: "2025-12", coveragePct: 62, measurable: true },
];
const props = {
  windowLabel: "Since May 2019",
  windowFrom: "2019-05-01",
  windowTo: "2026-11-05",
  maxDrawdownPct: -3.64,
  troughDate: "2020-01-06",
  liveFrom: FIXTURE_LIVE_FROM,
  recordedFrom: FIXTURE_RECORDED_FROM,
  engineSegments: FIXTURE_ENGINE_SEGMENTS,
  coverageMonthly,
  coverageLabel: "Qualifying ≥ 5% short",
  benchmarkName: "S&P/ASX 200 Gross Total Return (XJT)",
  referenceName: "same-data reference",
  referenceTo: "2026-10-30",
  label: "Growth of A$100,000",
};

describe("the growth, drawdown and coverage chart", () => {
  beforeEach(() => {
    mockWidth = 720;
  });

  it("draws the strategy, XJT (full name in the legend) and the reference, and the drawdown panel", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain('data-series="strategy"');
    expect(html).toContain('data-series="benchmark"');
    expect(html).toContain('data-series="reference"');
    expect(html).toContain('data-series="drawdown"');
    expect(html).toContain("S&amp;P/ASX 200 Gross Total Return (XJT)");
    expect(html).toContain("Drawdown (strategy)");
  });

  it("draws the drawdown callout at its trough with the summary's maximum drawdown", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain('data-callout-pct="-3.64"');
    expect(html).toContain("−3.6%");
  });

  it("starts the recorded band at the track's own first session, and marks the engine change", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain("data-recorded-band");
    expect(html).toContain("Recorded since 2 Oct 2026");
    expect(html).toContain('data-engine-mark="1.1.1"');
    expect(html).toContain("engine 1.1.1 from 20 Oct");
    expect(html).toContain("Rules frozen 1 Oct 2026");
  });

  it("names the reference by its last measured session, and hides the date when it runs to the end", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain("to 30 Oct 2026");
    const toEnd = renderToStaticMarkup(<BacktestChart {...props} referenceTo="" series={series.map((p) => ({ ...p, reference: p.reference }))} />);
    expect(toEnd).toContain('data-legend="reference"');
  });

  it("draws the monthly coverage inside the chart, hatched under 80%", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain('data-coverage-month="2025-12"');
    expect(html).toMatch(/data-coverage-month="2025-12" data-hatched/);
    expect(html).not.toMatch(/data-coverage-month="2025-11" data-hatched/);
  });

  it("keeps the end labels on a wide chart and takes them off a phone (the legend carries the values)", () => {
    expect(PHONE_WIDTH).toBe(640);
    const wide = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(wide).toContain('data-end-label="strategy"');
    mockWidth = 390;
    const phone = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(phone).not.toContain('data-end-label="strategy"');
    expect(phone).toContain('data-legend="benchmark"');
  });

  it("draws in CSS pixels at its measured width, never a scaled viewBox", () => {
    mockWidth = 390;
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toMatch(/<svg[^>]*width="390"/);
    expect(html).not.toContain("viewBox");
  });

  it("says in words when there is no series for the window", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={[]} />);
    expect(html).toContain("No series for this window");
  });
});
