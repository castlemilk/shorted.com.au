import { SPARKLINE_POINTS, toTopRows } from "../top-rows";
import type { SerializedTimeSeriesData } from "../getTopPageData";

const DAY_MS = 86_400_000;

function series(code: string, values: number[]): SerializedTimeSeriesData {
  const start = Date.UTC(2026, 6, 16);
  return {
    productCode: code,
    name: `${code} Limited`,
    latestShortPosition: values[values.length - 1] ?? 0,
    points: values.map((shortPosition, index) => ({
      timestamp: new Date(start + index * DAY_MS).toISOString(),
      shortPosition,
    })),
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

describe("toTopRows", () => {
  it("carries what a row renders and nothing else", () => {
    const [row] = toTopRows([
      series("DRO", [12.87036002, 13.31454852, 16.40083738]),
    ]);
    expect(row).toEqual({
      productCode: "DRO",
      name: "DRO Limited",
      latestShortPosition: 16.40083738,
      change: 16.40083738 - 12.87036002,
      sparkline: [12.87, 13.31, 16.4],
    });
  });

  it("reads no change from a series without two points", () => {
    const [one, none] = toTopRows([
      series("ONE", [7.5]),
      { ...series("NIL", []), latestShortPosition: 4 },
    ]);
    expect(one).toMatchObject({ change: 0, sparkline: [7.5] });
    expect(none).toMatchObject({ change: 0, sparkline: [] });
  });

  it("measures the change from the period's first point, not the sparkline's", () => {
    const values = Array.from({ length: 60 }, (_, i) => 5 + i / 10);
    const [row] = toTopRows([{ ...series("CHG", values), latestShortPosition: 11.5 }]);
    expect(row!.change).toBeCloseTo(11.5 - 5, 10);
  });

  it("orders the sparkline by time, whatever order the points arrive in", () => {
    const sorted = series("ORD", [1, 2, 3]);
    const [p0, p1, p2] = sorted.points;
    const [row] = toTopRows([{ ...sorted, points: [p2!, p0!, p1!] }]);
    expect(row!.sparkline).toEqual([1, 2, 3]);
  });

  it(`keeps a series of ${SPARKLINE_POINTS} points whole`, () => {
    const values = Array.from({ length: SPARKLINE_POINTS }, (_, i) => 3 + i * 0.123456);
    const [row] = toTopRows([series("FIT", values)]);
    expect(row!.sparkline).toEqual(values.map(round2));
  });

  it(`decimates a longer series to at most ${SPARKLINE_POINTS} values, keeping its ends, high and low`, () => {
    const values = Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 4) + i / 30);
    values[17] = 25.123456;
    values[41] = 2.987654;
    const [row] = toTopRows([series("LTB", values)]);
    const line = row!.sparkline;

    expect(line.length).toBeLessThanOrEqual(SPARKLINE_POINTS);
    expect(line.length).toBeGreaterThanOrEqual(SPARKLINE_POINTS - 2);
    expect(line[0]).toBe(round2(values[0]!));
    expect(line[line.length - 1]).toBe(round2(values[59]!));
    expect(Math.max(...line)).toBe(25.12);
    expect(Math.min(...line)).toBe(2.99);
    // Every value is one of the series' own points, at 2 dp.
    const rounded = new Set(values.map(round2));
    for (const value of line) expect(rounded.has(value)).toBe(true);
  });
});
