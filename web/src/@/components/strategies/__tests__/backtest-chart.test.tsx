import { renderToStaticMarkup } from "react-dom/server";

import { BacktestChart } from "../backtest-chart";
import { mapSeriesPoint } from "~/@/lib/strategies/map-backtest";
import {
  FIXTURE_ENGINE_SEGMENTS,
  FIXTURE_LIVE_FROM,
  FIXTURE_RECORDED_FROM,
  fixtureSeries,
} from "~/@/lib/strategies/__tests__/backtest-fixtures";

const props = {
  windowLabel: "Since May 2019",
  liveFrom: FIXTURE_LIVE_FROM,
  recordedFrom: FIXTURE_RECORDED_FROM,
  engineSegments: FIXTURE_ENGINE_SEGMENTS,
  benchmarkName: "S&P/ASX 200 Gross Total Return (XJT)",
  referenceName: "same-data reference",
  label: "Growth of A$100,000",
};

const series = fixtureSeries().map((p) => mapSeriesPoint(p));

describe("the growth and drawdown chart", () => {
  it("draws the strategy, the benchmark and the reference, and the drawdown on its own panel", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain('data-series="strategy"');
    expect(html).toContain('data-series="benchmark"');
    expect(html).toContain('data-series="reference"');
    expect(html).toContain('data-series="drawdown"');
    expect(html).toContain("data-trough");
  });

  it("marks the freeze with a dashed line and shades the recorded span after it", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain("data-frozen-marker");
    expect(html).toContain("data-recorded-band");
    expect(html).toContain("Rules frozen 2 Oct 2026");
    // The band names the track's own first session, a few days after the freeze.
    expect(html).toContain("Recorded since 5 Oct 2026");
  });

  it("marks an engine change inside the recorded span, with a label", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain('data-engine-mark="1.0.1"');
    expect(html).toContain("engine 1.0.1 from 19 Oct");
  });

  it("names the reference by its last measured session, in the legend and at the end", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain('data-legend="reference"');
    // The last measured session is the Friday before the freeze, named in the legend.
    expect(html).toMatch(/to \d{1,2} Sep 2026/);
    expect(html).toContain('data-end-label="reference"');
  });

  it("draws no recorded band when the window ends before the track starts", () => {
    const before = series.filter((p) => p.date < FIXTURE_RECORDED_FROM);
    const html = renderToStaticMarkup(<BacktestChart {...props} series={before} />);
    expect(html).not.toContain("data-recorded-band");
  });

  it("draws no frozen marker when the rules are not frozen yet", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} liveFrom="" series={series} />);
    expect(html).not.toContain("data-frozen-marker");
  });

  it("draws the drawdown in the semantic red's fill, and never a market colour as a line", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain("color-mix(in srgb, var(--semantic-red) 18%, transparent)");
    expect(html).not.toMatch(/#22c55e|#ef4444|#16a34a|#dc2626/i);
  });

  it("says in words when there is no series for the window", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={[]} />);
    expect(html).toContain("No series for this window");
  });

  it("carries a text summary for a screen reader", () => {
    const html = renderToStaticMarkup(<BacktestChart {...props} series={series} />);
    expect(html).toContain("The strategy ends at A$");
  });
});
