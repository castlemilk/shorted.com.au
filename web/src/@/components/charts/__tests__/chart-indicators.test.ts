import { CHART_PERIODS, type ChartPeriod } from "../chart-views";
import { DAY_MS } from "../chart-indicator-math";
import {
  CHART_INDICATORS,
  PERIOD_ORDER,
  buildIndicatorLayers,
  chartSeriesId,
  menuIndicators,
  planWarmup,
  readyIndicators,
  toggleIndicator,
  visibleIndicators,
  withHistory,
  coversLookback,
  drawnIndicatorIds,
  indicatorDef,
  heldCovers,
  indicatorsWithoutValues,
  type ChartIndicatorId,
} from "../chart-indicators";
import type { ChartPoint } from "../types";

const BASE = Date.UTC(2026, 0, 1);
/** A point on day `n` (counting from the base) with value `v`. */
const point = (n: number, v: number): ChartPoint => ({ t: BASE + n * DAY_MS, v });
/** Daily points for days `from` through `to`, valued at their own day number. */
const days = (from: number, to: number): ChartPoint[] =>
  Array.from({ length: to - from + 1 }, (_, i) => point(from + i, from + i));

describe("registry", () => {
  it("has PERIOD_ORDER equal to the chart's periods", () => {
    expect([...PERIOD_ORDER]).toEqual([...CHART_PERIODS]);
  });

  it("names series by stock and target, the id the chart series carry", () => {
    expect(chartSeriesId("BHP", "price")).toBe("BHP:price");
    expect(chartSeriesId("BHP", "short")).toBe("BHP:short");
  });

  it("offers price items on the price and combined views, short items on the short and combined", () => {
    const ids = (view: "combined" | "short" | "price") =>
      menuIndicators(view).map((def) => def.id);
    expect(ids("price")).not.toContain("short-avg-30d");
    expect(ids("short")).toEqual(["short-avg-30d", "short-avg-90d"]);
    expect(ids("combined")).toHaveLength(CHART_INDICATORS.length);
  });
});

describe("visibleIndicators", () => {
  // In registry order, which is the order the function returns.
  const all: ChartIndicatorId[] = ["sma20", "short-avg-30d", "sma200", "rsi14"];

  it("shows the advanced indicators only to a signed-in visitor", () => {
    expect(visibleIndicators(all, { view: "combined", access: "signed-in" })).toEqual(all);
    expect(visibleIndicators(all, { view: "combined", access: "signed-out" })).toEqual([
      "sma20",
      "short-avg-30d",
    ]);
    expect(visibleIndicators(all, { view: "combined", access: "checking" })).toEqual([
      "sma20",
      "short-avg-30d",
    ]);
  });

  it("drops the indicators a view does not offer", () => {
    expect(visibleIndicators(all, { view: "short", access: "signed-in" })).toEqual([
      "short-avg-30d",
    ]);
  });
});

describe("toggleIndicator", () => {
  it("adds an indicator, and removes it on the next toggle", () => {
    expect(toggleIndicator([], "sma20")).toEqual(["sma20"]);
    expect(toggleIndicator(["sma20"], "sma20")).toEqual([]);
  });

  it("keeps one panel: RSI then MACD leaves MACD", () => {
    expect(toggleIndicator(["rsi14"], "macd")).toEqual(["macd"]);
  });

  it("returns the selection in registry order", () => {
    expect(toggleIndicator(["macd"], "sma20")).toEqual(["sma20", "macd"]);
  });
});

describe("readyIndicators", () => {
  it("holds back the indicators whose warm-up is still loading, and only those", () => {
    const ids: ChartIndicatorId[] = ["sma20", "short-avg-30d"];
    expect(readyIndicators(ids, { price: true, short: false })).toEqual(["short-avg-30d"]);
    expect(readyIndicators(ids, { price: false, short: false })).toEqual(ids);
  });
});

describe("withHistory", () => {
  it("puts the earlier history in front, and the visible points from their start", () => {
    const visible = days(5, 6);
    const history = days(3, 6);
    const { points, offset } = withHistory(visible, history);
    expect(offset).toBe(2);
    expect(points.map((p) => p.v)).toEqual([3, 4, 5, 6]);
    expect(points.slice(offset)).toEqual(visible);
  });

  it("is the visible points alone with no history", () => {
    const visible = days(5, 6);
    expect(withHistory(visible, undefined)).toEqual({ points: visible, offset: 0 });
  });

  it("adds nothing when the history is all after the visible points", () => {
    const visible = days(5, 6);
    expect(withHistory(visible, days(7, 9))).toEqual({ points: visible, offset: 0 });
  });

  it("is empty for no visible points", () => {
    expect(withHistory([], days(1, 3))).toEqual({ points: [], offset: 0 });
  });
});

describe("planWarmup", () => {
  it.each<[ChartPeriod, ChartIndicatorId[], ChartPeriod | null, ChartPeriod | null]>([
    ["1m", ["sma20"], "3m", null],
    ["1m", ["sma50"], "6m", null],
    ["1m", ["sma200"], "1y", null],
    ["3m", ["sma200"], "2y", null],
    ["6m", ["sma20"], "1y", null],
    ["1y", ["sma20"], null, null],
    ["1y", ["sma50"], "2y", null],
    ["2y", ["sma50"], null, null],
    ["2y", ["sma200"], "max", null],
    ["max", ["sma200"], null, null],
    ["max", ["short-avg-90d"], null, null],
    ["1m", ["rsi14"], "3m", null],
    ["1y", ["macd"], "2y", null],
    ["1m", ["short-avg-30d"], null, "3m"],
    ["3m", ["short-avg-30d"], null, "6m"],
    ["6m", ["short-avg-30d"], null, "1y"],
    ["1y", ["short-avg-30d"], null, null],
    ["1m", ["short-avg-90d"], null, "6m"],
    ["3m", ["short-avg-90d"], null, "1y"],
    ["1y", ["short-avg-90d"], null, "2y"],
    ["2y", ["short-avg-90d"], null, null],
    ["1m", ["sma20", "short-avg-30d"], "3m", "3m"],
  ])("%s with %j fetches price from %s and short interest from %s", (period, ids, price, short) => {
    expect(planWarmup(period, ids)).toEqual({ price, short });
  });
});

describe("buildIndicatorLayers", () => {
  const stockCode = "BHP";

  it("computes a moving average on the visible points, index for index", () => {
    const price = days(0, 39);
    const { indicators } = buildIndicatorLayers({
      stockCode,
      view: "price",
      price,
      short: [],
      ids: ["sma20"],
    });
    expect(indicators).toHaveLength(1);
    expect(indicators[0]).toMatchObject({ id: "sma20", seriesId: "BHP:price", label: "SMA 20" });
    expect(indicators[0]!.values).toHaveLength(price.length);
    expect(indicators[0]!.values[18]).toBeNull();
    expect(indicators[0]!.values[19]).toBeCloseTo(9.5, 9); // the mean of 0..19
  });

  it("draws nothing when there are fewer points than the window", () => {
    const { indicators } = buildIndicatorLayers({
      stockCode,
      view: "price",
      price: days(0, 18),
      short: [],
      ids: ["sma20"],
    });
    expect(indicators).toEqual([]);
  });

  it("starts the average from the earlier history, so the first visible point has a value", () => {
    // Visible days 40..64 with the history 0..64 in front: the SMA 20 at day 40
    // is the mean of days 21..40.
    const visible = days(40, 64);
    const { indicators } = buildIndicatorLayers({
      stockCode,
      view: "price",
      price: visible,
      short: [],
      ids: ["sma20"],
      history: { price: days(0, 64) },
    });
    expect(indicators[0]!.values).toHaveLength(visible.length);
    expect(indicators[0]!.values[0]).toBeCloseTo(30.5, 9);
  });

  it("skips a price indicator on the short view, and a short one on the price view", () => {
    const layers = (view: "short" | "price", ids: ChartIndicatorId[]) =>
      buildIndicatorLayers({
        stockCode,
        view,
        price: days(0, 39),
        short: days(0, 39),
        ids,
      }).indicators.map((ind) => ind.id);
    expect(layers("short", ["sma20", "short-avg-30d"])).toEqual(["short-avg-30d"]);
    expect(layers("price", ["sma20", "short-avg-30d"])).toEqual(["sma20"]);
  });

  it("gives a band its middle line and both edges, and a panel an oscillator with its references", () => {
    const price = days(0, 79);
    const { indicators, oscillators } = buildIndicatorLayers({
      stockCode,
      view: "price",
      price,
      short: [],
      ids: ["bb20", "rsi14"],
    });
    const band = indicators.find((ind) => ind.id === "bb20");
    expect(band?.upper).toHaveLength(price.length);
    expect(band?.lower).toHaveLength(price.length);
    expect(band?.dash).toBeUndefined();
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0]).toMatchObject({ id: "rsi14", caption: "RSI 14", reference: [30, 70] });
    expect(oscillators[0]!.values).toHaveLength(price.length);
  });

  it("keeps the first panel only, and centres a MACD panel on zero", () => {
    const price = days(0, 79);
    const { oscillators } = buildIndicatorLayers({
      stockCode,
      view: "price",
      price,
      short: [],
      ids: ["macd", "rsi14"],
    });
    expect(oscillators.map((osc) => osc.id)).toEqual(["rsi14"]);

    const macdOnly = buildIndicatorLayers({
      stockCode,
      view: "price",
      price,
      short: [],
      ids: ["macd"],
    }).oscillators[0]!;
    const [low, high] = macdOnly.domain!;
    expect(low).toBeCloseTo(-high!, 9);
    expect(macdOnly.extraLines).toHaveLength(1);
  });
});

describe("heldCovers", () => {
  it("is true when the held period reaches back the lookback before the visible one, for price", () => {
    const sma50 = indicatorDef("sma50"); // lookback 49 sessions
    expect(heldCovers(sma50, "2y", "3m")).toBe(true); // 504 - 63 = 441
    expect(heldCovers(sma50, "6m", "1m")).toBe(true); // 126 - 21 = 105
    expect(heldCovers(sma50, "6m", "3m")).toBe(true); // 126 - 63 = 63
    expect(heldCovers(sma50, "3m", "1m")).toBe(false); // 63 - 21 = 42
    expect(heldCovers(sma50, "2y", "max")).toBe(false); // the held history is the shorter one
  });

  it("needs the lookback in days and the slack, for short interest", () => {
    const short30 = indicatorDef("short-avg-30d"); // 30 days and 7 of slack
    expect(heldCovers(short30, "3m", "1m")).toBe(true); // 91 - 30 = 61 >= 37
    expect(heldCovers(short30, "1m", "1m")).toBe(false);
    expect(heldCovers(short30, "max", "1m")).toBe(false); // weekly buckets: never a source
  });

  it("is false with nothing held", () => {
    expect(heldCovers(indicatorDef("sma20"), undefined, "1m")).toBe(false);
  });
});

describe("readiness", () => {
  it("holds back only the indicators still waiting for history, when told which", () => {
    expect(
      readyIndicators(["sma20", "sma50"], { price: true, short: false }, ["sma50"]),
    ).toEqual(["sma20"]);
  });

  it("holds back every indicator of a pending target without that list, as before", () => {
    expect(
      readyIndicators(["sma20", "short-avg-30d"], { price: true, short: false }),
    ).toEqual(["short-avg-30d"]);
  });
});

describe("coversLookback", () => {
  const firstVisible = BASE + 100 * DAY_MS;

  it("needs the lookback in sessions before the visible series, for price", () => {
    const sma50 = indicatorDef("sma50"); // lookback 49
    expect(coversLookback(sma50, days(51, 150), firstVisible)).toBe(true); // 49 sessions before day 100
    expect(coversLookback(sma50, days(52, 150), firstVisible)).toBe(false); // 48
    expect(coversLookback(sma50, undefined, firstVisible)).toBe(false);
  });

  it("needs the lookback in days plus the slack, for short interest", () => {
    const short30 = indicatorDef("short-avg-30d"); // 30 days, and 7 of slack
    expect(coversLookback(short30, [point(63, 1)], firstVisible)).toBe(true); // 37 days back
    expect(coversLookback(short30, [point(64, 1)], firstVisible)).toBe(false);
  });
});

describe("waiting panels and lines", () => {
  it("draws a waiting panel empty, at the visible length, with its caption", () => {
    const price = days(0, 39);
    const layers = buildIndicatorLayers({
      stockCode: "BHP",
      view: "price",
      price,
      short: [],
      ids: [],
      pending: ["rsi14"],
    });
    expect(layers.indicators).toEqual([]);
    expect(layers.oscillators).toHaveLength(1);
    expect(layers.oscillators[0]).toMatchObject({ id: "rsi14", caption: "RSI 14", reference: [30, 70] });
    expect(layers.oscillators[0]!.values).toHaveLength(price.length);
    expect(layers.oscillators[0]!.values.every((v) => v === null)).toBe(true);
  });

  it("holds a waiting line back altogether: drawn late, it would jump left when its history lands", () => {
    const layers = buildIndicatorLayers({
      stockCode: "BHP",
      view: "price",
      price: days(0, 39),
      short: [],
      ids: [],
      pending: ["sma50"],
    });
    expect(layers).toEqual({ indicators: [], oscillators: [] });
  });

  it("draws a selected panel from its values, not as a placeholder", () => {
    const layers = buildIndicatorLayers({
      stockCode: "BHP",
      view: "price",
      price: days(0, 79),
      short: [],
      ids: ["rsi14"],
      pending: [],
    });
    expect(layers.oscillators[0]!.values.some((v) => v !== null)).toBe(true);
  });
});

describe("Bollinger bands on price", () => {
  it("never draws an edge below zero, where a crash would take the lower band under it", () => {
    // $1.00 for 100 sessions, then $0.10: the lower edge crosses zero after the fall.
    const price = Array.from({ length: 252 }, (_, i) => ({
      t: BASE + i * DAY_MS,
      v: i < 100 ? 1 : 0.1,
    }));
    const [band] = buildIndicatorLayers({
      stockCode: "XYZ",
      view: "price",
      price,
      short: [],
      ids: ["bb20"],
    }).indicators;
    const lower = band!.lower!.filter((v): v is number => v !== null);
    expect(Math.min(...lower)).toBeGreaterThanOrEqual(0);
    expect(band!.upper!.filter((v) => v !== null)).toHaveLength(lower.length);
  });
});

describe("the drawn set and the count", () => {
  it("names what has something to draw: lines, bands and panels with values, not placeholders", () => {
    const layers = buildIndicatorLayers({
      stockCode: "BHP",
      view: "price",
      price: days(0, 79),
      short: [],
      ids: ["sma20", "sma50"],
      pending: ["rsi14"],
    });
    expect([...drawnIndicatorIds(layers)]).toEqual(["sma20", "sma50"]);
  });

  it("names the selected indicators a series is too short for, not those still waiting", () => {
    const hasData = { price: true, short: false };
    expect(
      indicatorsWithoutValues(["sma20", "sma50"], { drawn: new Set(), waiting: [], hasData }),
    ).toEqual(["sma20", "sma50"]);
    expect(
      indicatorsWithoutValues(["sma20", "sma50"], {
        drawn: new Set(["sma20"]),
        waiting: ["sma50"],
        hasData,
      }),
    ).toEqual([]);
    // No series to be short of: nothing to say.
    expect(
      indicatorsWithoutValues(["short-avg-30d"], { drawn: new Set(), waiting: [], hasData }),
    ).toEqual([]);
  });
});
