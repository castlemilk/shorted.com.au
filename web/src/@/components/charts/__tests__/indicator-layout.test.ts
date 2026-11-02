import { indicatorDomainSeries, layoutIndicatorLegend } from "../indicator-layout";
import type { ChartSeriesSpec, SeriesIndicator } from "../types";

describe("layoutIndicatorLegend", () => {
  // At AXIS_CHAR_PX = 6.1, "SMA 20" is 37px of text: a 12px swatch, 4px gap, and
  // then 10px between items, 4px of padding either side.
  const items = [
    { label: "SMA 20", color: "#f59e0b" },
    { label: "SMA 50", color: "#87A96B" },
  ];

  it("places the items left to right, and takes the width they need", () => {
    const layout = layoutIndicatorLegend(items, 400);
    expect(layout.items.map((item) => item.x)).toEqual([4, 67]);
    expect(layout.overflow).toBe(0);
    expect(layout.width).toBe(124);
  });

  it("counts what does not fit as +N, placed after the last item that does", () => {
    const layout = layoutIndicatorLegend(items, 100);
    expect(layout.items.map((item) => item.x)).toEqual([4]);
    expect(layout.overflow).toBe(1);
    expect(layout.overflowX).toBe(67);
    expect(layout.width).toBe(84);
  });

  it("shows only the count when no item fits", () => {
    const layout = layoutIndicatorLegend(items, 50);
    expect(layout.items).toEqual([]);
    expect(layout.overflow).toBe(2);
    expect(layout.width).toBe(21);
  });

  it("is nothing at all for no items", () => {
    expect(layoutIndicatorLegend([], 400).width).toBe(0);
  });
});

describe("indicatorDomainSeries", () => {
  const T = (i: number) => Date.UTC(2026, 0, 1 + i);
  const price: ChartSeriesSpec = {
    id: "BHP:price",
    label: "Price",
    color: "#3b82f6",
    axis: "left",
    kind: "area",
    points: [0, 1, 2, 3].map((i) => ({ t: T(i), v: 40 + i })),
  };
  const sma: SeriesIndicator = {
    id: "sma20",
    seriesId: "BHP:price",
    label: "SMA 20",
    color: "#f59e0b",
    values: [null, 41, 60, null],
  };

  it("is one series per value array, on the target's axis, of its finite values", () => {
    const [domain] = indicatorDomainSeries([sma], [price], null);
    expect(domain).toMatchObject({ id: "sma20:domain:values", axis: "left", kind: "line" });
    expect(domain!.points).toEqual([
      { t: T(1), v: 41 },
      { t: T(2), v: 60 },
    ]);
  });

  it("keeps only the values inside the range, at the target's own times", () => {
    const [domain] = indicatorDomainSeries([sma], [price], [T(2), T(3)]);
    expect(domain!.points).toEqual([{ t: T(2), v: 60 }]);
  });

  it("skips an indicator whose values are not as long as its target", () => {
    expect(indicatorDomainSeries([{ ...sma, values: [1, 2] }], [price], null)).toEqual([]);
  });

  it("takes a band's edges as well, and nothing for a target that is not drawn", () => {
    const band: SeriesIndicator = {
      ...sma,
      id: "bb20",
      values: [null, 41, 42, 43],
      upper: [null, 45, 46, 47],
      lower: [null, 37, 38, 39],
    };
    const ids = indicatorDomainSeries([band], [price], null).map((s) => s.id);
    expect(ids).toEqual(["bb20:domain:values", "bb20:domain:upper", "bb20:domain:lower"]);
    expect(indicatorDomainSeries([{ ...band, seriesId: "BHP:short" }], [price], null)).toEqual([]);
  });
});
