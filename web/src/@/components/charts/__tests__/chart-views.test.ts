import {
  CHART_PERIODS,
  CHART_VIEWS,
  buildChartView,
  isChartPeriod,
  isChartViewId,
} from "../chart-views";
import type { ChartPoint } from "../types";

const series = (n: number, base = 10): ChartPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2026, 0, 1 + i), v: base + i }));

const input = (n = 30, opts: { showMA?: boolean } = {}) => ({
  stockCode: "BHP",
  short: series(n, 2),
  price: series(n, 40),
  volume: series(n, 1000),
  ...opts,
});

describe("chart view registry", () => {
  it("lists the three views and six periods", () => {
    expect(CHART_VIEWS.map((v) => v.id)).toEqual(["combined", "short", "price"]);
    expect(CHART_PERIODS).toEqual(["1m", "3m", "6m", "1y", "2y", "max"]);
  });

  it("guards view ids and periods", () => {
    expect(isChartViewId("combined")).toBe(true);
    expect(isChartViewId("candles")).toBe(false);
    expect(isChartViewId(undefined)).toBe(false);
    expect(isChartPeriod("2y")).toBe(true);
    expect(isChartPeriod("5y")).toBe(false);
    expect(isChartPeriod(null)).toBe(false);
  });
});

describe("buildChartView", () => {
  it("short: one short-% area on the LEFT axis, no volume, no right axis", () => {
    const c = buildChartView("short", input(30, { showMA: true }));
    expect(c.series).toHaveLength(1);
    expect(c.series[0]).toMatchObject({ id: "BHP:short", axis: "left", kind: "area" });
    expect(c.volume).toBeUndefined();
    expect(c.indicators).toEqual([]); // MA never applies to short
    expect(c.leftAxis.side).toBe("left");
    expect(c.leftAxis.format?.(12.345)).toBe("12.3%");
    expect(c.rightAxis).toBeUndefined();
  });

  it("price: price area on the left axis with volume", () => {
    const c = buildChartView("price", input());
    expect(c.series).toHaveLength(1);
    expect(c.series[0]).toMatchObject({ id: "BHP:price", axis: "left", kind: "area" });
    expect(c.volume).toHaveLength(30);
    expect(c.leftAxis.format?.(45.5)).toBe("$45.50");
    expect(c.rightAxis).toBeUndefined();
  });

  it("combined: price area (left, $) + short line (right, %) + volume", () => {
    const c = buildChartView("combined", input());
    expect(c.series.map((s) => [s.id, s.axis, s.kind])).toEqual([
      ["BHP:price", "left", "area"],
      ["BHP:short", "right", "line"],
    ]);
    expect(c.volume).toHaveLength(30);
    expect(c.leftAxis.format?.(1)).toBe("$1.00");
    expect(c.rightAxis).toMatchObject({ side: "right" });
    expect(c.rightAxis?.format?.(1)).toBe("1.0%");
  });

  it("adds SMA 20 only when enabled AND there are at least 20 price points", () => {
    expect(buildChartView("price", input(30)).indicators).toEqual([]);
    expect(buildChartView("combined", input(19, { showMA: true })).indicators).toEqual([]);
    for (const view of ["price", "combined"] as const) {
      const [ma, ...rest] = buildChartView(view, input(20, { showMA: true })).indicators;
      expect(rest).toEqual([]);
      expect(ma).toMatchObject({ id: "sma20", seriesId: "BHP:price" });
      expect(ma!.values).toHaveLength(20);
    }
  });

  it("drops an empty series rather than drawing nothing (partial loads)", () => {
    const noPrice = { ...input(), price: [] };
    expect(buildChartView("combined", noPrice).series.map((s) => s.id)).toEqual([
      "BHP:short",
    ]);
    expect(buildChartView("price", noPrice).series).toEqual([]);
    const noShort = { ...input(), short: [] };
    expect(buildChartView("combined", noShort).series.map((s) => s.id)).toEqual([
      "BHP:price",
    ]);
    expect(buildChartView("short", noShort).series).toEqual([]);
  });
});
