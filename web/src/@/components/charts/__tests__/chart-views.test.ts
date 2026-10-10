import {
  CHART_PERIODS,
  CHART_VIEWS,
  buildChartView,
  isChartPeriod,
  isChartViewId,
  priceFmt,
  shortFmt,
} from "../chart-views";
import { seriesDelta } from "../chart-readout";
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

describe("shortFmt", () => {
  // ASIC publishes short interest to two decimals and the stock header prints
  // it to two, so the chart's readout, axes and hover card do too: a stock under
  // 1% short would otherwise read "0.1%" under a header saying "0.08%", and its
  // axis would repeat the same label at every tick.
  it("prints short interest to two decimals", () => {
    expect(shortFmt(1.57)).toBe("1.57%");
    expect(shortFmt(0.08)).toBe("0.08%");
    expect(shortFmt(0)).toBe("0.00%");
    expect(shortFmt(12.3)).toBe("12.30%");
  });

  it("keeps ticks 0.05 apart distinct, where one decimal repeated them", () => {
    const ticks = [0.05, 0.1, 0.15, 0.2].map(shortFmt);
    expect(new Set(ticks).size).toBe(4);
  });

  it("is the format of the short axis in every view that has one", () => {
    expect(buildChartView("short", input()).leftAxis.format).toBe(shortFmt);
    expect(buildChartView("combined", input()).rightAxis?.format).toBe(shortFmt);
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
    expect(c.leftAxis.format?.(12.345)).toBe("12.35%");
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
    expect(c.rightAxis?.format?.(1)).toBe("1.00%");
  });

  it("measures the short series in percentage points and leaves price relative", () => {
    for (const view of ["short", "combined"] as const) {
      const c = buildChartView(view, input());
      expect(c.series.find((s) => s.id === "BHP:short")).toMatchObject({
        measureMode: "absolute",
        measureUnit: "pp",
      });
    }
    const priceSeries = buildChartView("price", input()).series[0]!;
    expect(priceSeries.measureMode).toBeUndefined();
    expect(priceSeries.measureUnit).toBeUndefined();
  });

  it("reads a change in the built series as points for short and percent for price", () => {
    const { series: built } = buildChartView("combined", input());
    const [price, short] = built;
    // short runs 2 -> 3, price 40 -> 41.
    expect(seriesDelta(short!, short!.points[0]!, short!.points[1]!).text).toBe(
      "+1.00 pp",
    );
    expect(seriesDelta(price!, price!.points[0]!, price!.points[1]!).text).toBe(
      "+2.5%",
    );
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

  describe("combined, with one of its two series missing", () => {
    // The Combined view of a stock with no price history, or no short history,
    // drew the series it had on axes built for both: a short line on the right
    // under a dollar axis on the left with nothing on it ($0.00 to $1.00), or a
    // price beside a percentage axis on the right with nothing on it. The axes
    // follow the data; the view the caller asked for is still Combined.
    const noPrice = { ...input(30, { showMA: true }), price: [] };
    const noShort = { ...input(30, { showMA: true }), short: [] };

    it("with no price, is the short view: the series on the left axis, in percent, and no dollar axis", () => {
      const c = buildChartView("combined", noPrice);
      expect(c).toEqual(buildChartView("short", noPrice));
      expect(c.series).toHaveLength(1);
      expect(c.series[0]).toMatchObject({ id: "BHP:short", axis: "left", kind: "area" });
      expect(c.leftAxis.format).toBe(shortFmt);
      expect(c.rightAxis).toBeUndefined();
      // Volume and an average are of a price that is not there.
      expect(c.volume).toBeUndefined();
      expect(c.indicators).toEqual([]);
    });

    it("with no short interest, is the price view: the series on the left axis in dollars, with its volume and average", () => {
      const c = buildChartView("combined", noShort);
      expect(c).toEqual(buildChartView("price", noShort));
      expect(c.series).toHaveLength(1);
      expect(c.series[0]).toMatchObject({ id: "BHP:price", axis: "left", kind: "area" });
      expect(c.leftAxis.format?.(45.5)).toBe("$45.50");
      expect(c.rightAxis).toBeUndefined();
      expect(c.volume).toHaveLength(30);
      expect(c.indicators.map((i) => i.id)).toEqual(["sma20"]);
    });

    it("with neither, draws nothing and keeps the axes the Combined view has", () => {
      const c = buildChartView("combined", { ...input(), price: [], short: [] });
      expect(c.series).toEqual([]);
      expect(c.leftAxis.format).toBe(priceFmt);
      expect(c.rightAxis?.format).toBe(shortFmt);
    });

    it("leaves the Combined view of both series as it was: price left, short right", () => {
      const c = buildChartView("combined", input());
      expect(c.series.map((s) => [s.id, s.axis, s.kind])).toEqual([
        ["BHP:price", "left", "area"],
        ["BHP:short", "right", "line"],
      ]);
      expect(c.leftAxis.format).toBe(priceFmt);
      expect(c.rightAxis?.format).toBe(shortFmt);
    });

    it("changes nothing for the views that name one series", () => {
      expect(buildChartView("short", noPrice).series.map((s) => s.id)).toEqual(["BHP:short"]);
      expect(buildChartView("price", noShort).series.map((s) => s.id)).toEqual(["BHP:price"]);
      expect(buildChartView("price", noPrice).series).toEqual([]);
      expect(buildChartView("short", noShort).series).toEqual([]);
    });
  });
});
