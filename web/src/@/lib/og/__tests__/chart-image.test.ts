import {
  MAX_IMAGE_POINTS,
  buildChartGeometry,
  decimalsFor,
  downsample,
  formatAxisValue,
  formatPrice,
  formatPriceChange,
  formatShortChange,
  niceTicks,
  pricePointsFromResponse,
  seriesChange,
  shortPointsFromSeries,
  timestampMs,
  valueDomain,
  type SeriesPoint,
} from "../chart-image";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-15T00:00:00Z");

function series(
  n: number,
  f: (i: number) => number,
  start = T0,
): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: start + i * DAY, v: f(i) }));
}

describe("downsample", () => {
  it("returns short series untouched", () => {
    const s = series(10, (i) => i);
    expect(downsample(s)).toBe(s);
  });

  it("caps the point count and keeps the first and last points", () => {
    const s = series(5000, (i) => i);
    const out = downsample(s);
    expect(out).toHaveLength(MAX_IMAGE_POINTS);
    expect(out[0]).toBe(s[0]);
    expect(out[out.length - 1]).toBe(s[s.length - 1]);
    // ascending, no duplicates
    for (let i = 1; i < out.length; i++)
      expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t);
  });
});

describe("timestampMs", () => {
  it("reads every wire shape a timestamp arrives in", () => {
    const ms = Date.parse("2026-10-13T00:00:00Z");
    expect(timestampMs({ seconds: BigInt(ms / 1000), nanos: 0 })).toBe(ms);
    // unstable_cache serialises the bigint to a number
    expect(timestampMs({ seconds: ms / 1000 })).toBe(ms);
    // the edge read returns JSON
    expect(timestampMs("2026-10-13T00:00:00Z")).toBe(ms);
    expect(timestampMs(ms)).toBe(ms);
  });

  it("rejects missing and invalid values", () => {
    expect(timestampMs(undefined)).toBeNull();
    expect(timestampMs({ seconds: 0 })).toBeNull();
    expect(timestampMs("not a date")).toBeNull();
  });
});

describe("shortPointsFromSeries", () => {
  it("sorts, dedupes by instant and drops unreadable points", () => {
    const pts = shortPointsFromSeries({
      points: [
        { timestamp: "2026-10-14T00:00:00Z", shortPosition: 3.1 },
        { timestamp: { seconds: BigInt(T0 / 1000) }, shortPosition: 2.5 },
        { timestamp: "2026-10-14T00:00:00Z", shortPosition: 3.2 },
        { timestamp: undefined, shortPosition: 9 },
        { timestamp: "2026-10-15T00:00:00Z", shortPosition: Number.NaN },
      ],
    });
    expect(pts).toEqual([
      { t: T0, v: 2.5 },
      { t: Date.parse("2026-10-14T00:00:00Z"), v: 3.2 },
    ]);
  });

  it("is empty for a missing series", () => {
    expect(shortPointsFromSeries(undefined)).toEqual([]);
    expect(shortPointsFromSeries({})).toEqual([]);
  });
});

describe("pricePointsFromResponse", () => {
  it("reads the close at midnight UTC of the bar's day, oldest first", () => {
    expect(
      pricePointsFromResponse({
        prices: [
          { date: "2026-10-14T00:00:00Z", close: 2.88 },
          { date: "2026-10-13", close: "2.62" },
          { date: "2026-10-12", close: 0 },
          { date: undefined, close: 1 },
        ],
      }),
    ).toEqual([
      { t: Date.parse("2026-10-13T00:00:00Z"), v: 2.62 },
      { t: Date.parse("2026-10-14T00:00:00Z"), v: 2.88 },
    ]);
  });

  it("is empty for anything that is not a prices response", () => {
    expect(pricePointsFromResponse(null)).toEqual([]);
    expect(pricePointsFromResponse({})).toEqual([]);
    expect(pricePointsFromResponse({ prices: "nope" })).toEqual([]);
  });
});

describe("valueDomain", () => {
  it("is null for an empty series", () => {
    expect(valueDomain([])).toBeNull();
  });

  it("pads a varying series on both sides", () => {
    const d = valueDomain([2, 4])!;
    expect(d.min).toBeLessThan(2);
    expect(d.max).toBeGreaterThan(4);
  });

  it("gives a flat series a band around its value", () => {
    const d = valueDomain([3, 3, 3])!;
    expect(d.min).toBeLessThan(3);
    expect(d.max).toBeGreaterThan(3);
  });

  it("never pads a non-negative series below zero when asked", () => {
    expect(valueDomain([0, 0.1], { floorAtZero: true })!.min).toBe(0);
    expect(valueDomain([0], { floorAtZero: true })).toEqual({ min: 0, max: 1 });
  });
});

describe("ticks and labels", () => {
  it("lands ticks on round numbers inside the domain", () => {
    const { values, step } = niceTicks({ min: 2.515, max: 4.07 });
    expect(step).toBe(0.5);
    expect(values).toEqual([3, 3.5, 4]);
  });

  it("prints at least two decimals, more when the step needs them", () => {
    expect(decimalsFor(0.25)).toBe(2);
    expect(decimalsFor(0.005)).toBe(3);
    expect(formatAxisValue(3.5, "price", 0.5)).toBe("$3.50");
    expect(formatAxisValue(0.045, "price", 0.005)).toBe("$0.045");
    expect(formatAxisValue(2, "short", 0.5)).toBe("2.00%");
  });

  it("prints a sub-ten-cent price to a tenth of a cent", () => {
    expect(formatPrice(2.881)).toBe("$2.88");
    expect(formatPrice(0.061)).toBe("$0.061");
  });

  it("prints changes with a true minus sign and no sign for zero", () => {
    expect(formatShortChange(0.623)).toBe("+0.62 pp");
    expect(formatShortChange(-0.31)).toBe("−0.31 pp");
    expect(formatShortChange(0.001)).toBe("0.00 pp");
    expect(formatPriceChange(-16.48)).toBe("−16.5%");
    expect(formatPriceChange(4.2)).toBe("+4.2%");
    expect(formatPriceChange(0.01)).toBe("0.0%");
  });
});

describe("seriesChange", () => {
  it("is null for an empty series", () => {
    expect(seriesChange([])).toBeNull();
  });

  it("measures first to last, with no percent from a zero start", () => {
    expect(seriesChange(series(3, (i) => [2, 5, 3][i]!))).toEqual({
      first: 2,
      last: 3,
      delta: 1,
      pct: 50,
    });
    expect(seriesChange(series(2, (i) => i))!.pct).toBeNull();
  });
});

describe("buildChartGeometry", () => {
  const W = 880;
  const H = 286;

  it("is null when the view has nothing to draw", () => {
    expect(
      buildChartGeometry({
        view: "combined",
        short: [],
        price: [],
        width: W,
        height: H,
      }),
    ).toBeNull();
    // the short view ignores prices, and the price view ignores shorts
    expect(
      buildChartGeometry({
        view: "short",
        short: [],
        price: series(5, (i) => i + 1),
        width: W,
        height: H,
      }),
    ).toBeNull();
    expect(
      buildChartGeometry({
        view: "price",
        short: series(5, (i) => i + 1),
        price: [],
        width: W,
        height: H,
      }),
    ).toBeNull();
  });

  it("draws the short view as one filled series on the left axis", () => {
    const g = buildChartGeometry({
      view: "short",
      short: series(30, (i) => 3 + i / 10),
      price: [],
      width: W,
      height: H,
    })!;
    expect(g.leftAxis).toBe("short");
    expect(g.rightAxis).toBeNull();
    expect(g.series).toHaveLength(1);
    expect(g.series[0]).toMatchObject({ role: "short", axis: "left" });
    expect(g.series[0]!.area).toMatch(/Z$/);
    expect(g.leftTicks.every((t) => t.label.endsWith("%"))).toBe(true);
  });

  it("puts price on the left ($) and short on the right (%) in the combined view", () => {
    const g = buildChartGeometry({
      view: "combined",
      short: series(28, (i) => 2 + i / 20),
      price: series(21, (i) => 3.5 - i / 30, T0 + 7 * DAY),
      width: W,
      height: H,
    })!;
    expect(g.leftAxis).toBe("price");
    expect(g.rightAxis).toBe("short");
    expect(g.series.map((s) => [s.role, s.axis])).toEqual([
      ["price", "left"],
      ["short", "right"],
    ]);
    // the price is the filled series; the short is a line over it
    expect(g.series[0]!.area).not.toBeNull();
    expect(g.series[1]!.area).toBeNull();
    expect(g.leftTicks.every((t) => t.label.startsWith("$"))).toBe(true);
    expect(g.rightTicks.every((t) => t.label.endsWith("%"))).toBe(true);

    // one shared time axis: the short series starts a week before the price,
    // so the price line starts inside the plot and both end at the right edge
    const priceStartX = Number(/^M([\d.]+),/.exec(g.series[0]!.line)![1]);
    const shortStartX = Number(/^M([\d.]+),/.exec(g.series[1]!.line)![1]);
    expect(shortStartX).toBe(0);
    expect(priceStartX).toBeGreaterThan(0);
    expect(g.series[0]!.last.x).toBe(g.series[1]!.last.x);

    // every tick and point stays inside the plot
    for (const t of [...g.leftTicks, ...g.rightTicks]) {
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThanOrEqual(H);
    }
    for (const s of g.series) {
      expect(s.last.x).toBeLessThanOrEqual(W);
      expect(s.last.y).toBeGreaterThanOrEqual(0);
      expect(s.last.y).toBeLessThanOrEqual(H);
    }
  });

  it("draws the side it has when a combined chart is missing one", () => {
    const g = buildChartGeometry({
      view: "combined",
      short: series(10, (i) => 2 + i / 10),
      price: [],
      width: W,
      height: H,
    })!;
    expect(g.leftAxis).toBe("short");
    expect(g.rightAxis).toBeNull();
    expect(g.series).toHaveLength(1);
  });

  it("draws a single point in the middle with one date label", () => {
    const g = buildChartGeometry({
      view: "short",
      short: [{ t: T0, v: 2.5 }],
      price: [],
      width: W,
      height: H,
    })!;
    expect(g.series[0]!.last.x).toBe(W / 2);
    expect(g.dateLabels).toEqual([
      { x: W / 2, label: "15 Sept 2026", align: "middle" },
    ]);
  });

  it("draws a flat series across the middle of the plot", () => {
    const g = buildChartGeometry({
      view: "short",
      short: series(10, () => 4),
      price: [],
      width: W,
      height: H,
    })!;
    expect(g.series[0]!.last.y).toBeCloseTo(H / 2, 0);
  });

  it("labels the first and last dates, and a real data day in between", () => {
    const g = buildChartGeometry({
      view: "short",
      short: series(29, (i) => i + 1),
      price: [],
      width: W,
      height: H,
    })!;
    expect(g.dateLabels.map((d) => d.align)).toEqual([
      "start",
      "middle",
      "end",
    ]);
    expect(g.dateLabels[0]!.label).toBe("15 Sept 2026");
    expect(g.dateLabels[1]!.label).toBe("29 Sept 2026");
    expect(g.dateLabels[2]!.label).toBe("13 Oct 2026");
  });

  it("caps the drawn points however long the series", () => {
    const g = buildChartGeometry({
      view: "price",
      short: [],
      price: series(5000, (i) => 1 + Math.sin(i / 50)),
      width: W,
      height: H,
    })!;
    expect(g.series[0]!.line.split("L")).toHaveLength(MAX_IMAGE_POINTS);
  });
});
