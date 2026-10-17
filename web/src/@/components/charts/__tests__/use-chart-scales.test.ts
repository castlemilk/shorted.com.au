import { renderHook } from "@testing-library/react";
import { getTicks } from "@visx/scale";
import { useChartScales, valueAxisLabels } from "../use-chart-scales";
import type { ChartSeriesSpec } from "../types";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const MARGIN = { top: 8, right: 48, bottom: 24, left: 48 };

const line = (
  values: number[],
  axis: "left" | "right" = "left",
): ChartSeriesSpec => ({
  id: `s-${axis}`,
  label: "S",
  color: "#000",
  axis,
  kind: "line",
  points: values.map((v, i) => ({ t: T0 + i * DAY, v })),
});

const scalesOf = (series: ChartSeriesSpec[]) =>
  renderHook(() =>
    useChartScales({ series, width: 400, height: 300, margin: MARGIN }),
  ).result.current;

describe("useChartScales: the value axes", () => {
  it("pads the data by 8% of its range", () => {
    // 10 to 20: 0.8 either side, then niced out to whole numbers.
    expect(scalesOf([line([10, 15, 20])]).leftScale.domain()).toEqual([9, 21]);
  });

  describe("a series with no spread: one point, or a flat line", () => {
    // 8% of no range is no padding, and a scale with nothing between its ends
    // draws the series on its midpoint. It used to be padded by a flat 1, which
    // is a ±2.5% window on a $40 price, an axis from -$0.95 to $1.05 on a 5c
    // one, and $-1.00 to $1.00 on a price of nothing.
    it("is padded by 5% of its value either side", () => {
      expect(scalesOf([line([40])]).leftScale.domain()).toEqual([38, 42]);
      expect(scalesOf([line([40, 40, 40])]).leftScale.domain()).toEqual([38, 42]);
    });

    it("scales with the value: a 20c price gets a 20c axis, a $400 one a $400 axis", () => {
      // d3 rounds the ends out to whole ticks, so "5% either side" is a window
      // just over it: nothing like the old -0.80 to 1.20.
      const [lo, hi] = scalesOf([line([0.2])]).leftScale.domain() as [number, number];
      expect(lo).toBeLessThanOrEqual(0.19 + 1e-9);
      expect(lo).toBeGreaterThan(0.18);
      expect(hi).toBeGreaterThanOrEqual(0.21 - 1e-9);
      expect(hi).toBeLessThan(0.22);
      expect(scalesOf([line([400])]).leftScale.domain()).toEqual([380, 420]);
    });

    it("pads a negative value by 5% of its size, on the right side of it", () => {
      expect(scalesOf([line([-40])]).leftScale.domain()).toEqual([-42, -38]);
    });

    it("falls back to 1 either side of zero, where 5% of nothing is nothing", () => {
      expect(scalesOf([line([0])]).leftScale.domain()).toEqual([-1, 1]);
    });

    it("pads the right axis the same way", () => {
      expect(scalesOf([line([20], "right")]).rightScale.domain()).toEqual([19, 21]);
    });
  });

  it("gives a side with no series the unit domain", () => {
    expect(scalesOf([line([40])]).rightScale.domain()).toEqual([0, 1]);
  });

  it("takes a hard domain as given", () => {
    const { leftScale } = renderHook(() =>
      useChartScales({
        series: [line([40])],
        width: 400,
        height: 300,
        margin: MARGIN,
        leftDomain: [0, 100],
      }),
    ).result.current;
    expect(leftScale.domain()).toEqual([0, 100]);
  });
});

// The margin beside the plot has to be known before there is a plot, so what an
// axis will print is worked out from the data alone. It has to be the labels the
// axis then prints: the same domain, niced the same way, ticked the same way.
describe("valueAxisLabels: what a value axis will print", () => {
  const price = (lo: number, hi: number, axis: "left" | "right" = "left") =>
    line(Array.from({ length: 20 }, (_, i) => lo + ((hi - lo) * i) / 19), axis);
  const dollars = (v: number) => `$${v.toFixed(2)}`;
  const labels = (
    series: ChartSeriesSpec[],
    over: Partial<Parameters<typeof valueAxisLabels>[0]> = {},
  ) => valueAxisLabels({ series, side: "left", numTicks: 4, ...over });

  it("formats the ticks of the padded, niced domain with the axis' own format", () => {
    // $150.25 to $184.45, 8% padded and niced out to 145-190, in steps of 10.
    expect(labels([price(150.25, 184.45)], { format: dollars })).toEqual([
      "$150.00",
      "$160.00",
      "$170.00",
      "$180.00",
      "$190.00",
    ]);
  });

  it("prints what the scale the chart draws prints, tick for tick", () => {
    for (const [lo, hi] of [
      [150.25, 184.45],
      [39.4, 48.6],
      [0.4, 1.8],
      [-12, 240],
      [95, 105],
    ] as const) {
      const series = [price(lo, hi)];
      const { leftScale } = scalesOf(series);
      expect(labels(series, { format: dollars })).toEqual(
        getTicks(leftScale, 4).map((t) => dollars(Number(t))),
      );
    }
  });

  it("does the same on the right, from the series on the right and nothing else", () => {
    const series = [price(150.25, 184.45, "left"), price(10.5, 12.25, "right")];
    expect(labels(series, { side: "right", format: (v) => `${v.toFixed(2)}%` })).toEqual(
      getTicks(scalesOf(series).rightScale, 4).map((t) => `${Number(t).toFixed(2)}%`),
    );
  });

  it("takes a hard domain as given, as the scale does", () => {
    const series = [price(150, 160)];
    const { leftScale } = renderHook(() =>
      useChartScales({ series, width: 400, height: 300, margin: MARGIN, leftDomain: [0, 1000] }),
    ).result.current;
    const printed = labels(series, { hard: [0, 1000], format: dollars });
    expect(printed).toEqual(getTicks(leftScale, 4).map((t) => dollars(Number(t))));
    expect(printed).not.toEqual(labels(series, { format: dollars }));
  });

  it("falls back to the scale's own format where the axis gives none, as the axis does", () => {
    // visx formats an axis with no formatter by scale.tickFormat(): whole numbers
    // here, with no unit.
    expect(labels([price(150.25, 184.45)])).toEqual(["150", "160", "170", "180", "190"]);
    // And a thousands separator where the numbers are that big.
    expect(labels([price(12_000, 34_000)]).every((l) => /^\d{2},000$/.test(l))).toBe(true);
  });

  it("gives a side with no series the unit domain's labels", () => {
    const unit = labels([price(150, 160)], { side: "right", format: (v) => v.toFixed(1) });
    expect(unit[0]).toBe("0.0");
    expect(unit[unit.length - 1]).toBe("1.0");
  });

  it("prints no labels when asked for no ticks", () => {
    expect(labels([price(150, 160)], { format: dollars, numTicks: 0 })).toEqual([]);
  });
});
