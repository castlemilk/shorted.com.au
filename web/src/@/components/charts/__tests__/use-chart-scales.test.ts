import { renderHook } from "@testing-library/react";
import { useChartScales } from "../use-chart-scales";
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
