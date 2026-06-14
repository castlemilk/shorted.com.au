import {
  fromMultiSeries,
  type MultiSeriesInput,
} from "../from-multi-series";
import type { IndicatorConfig } from "@/lib/technical-indicators";

const T0 = new Date("2024-01-01T00:00:00Z").getTime();
const DAY = 86_400_000;

/** Build N ascending {timestamp,value} points starting at T0. */
function points(n: number, base = 1): { timestamp: Date; value: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(T0 + i * DAY),
    value: base + i,
  }));
}

function config(over: Partial<IndicatorConfig> = {}): IndicatorConfig {
  return {
    type: "SMA",
    period: 5,
    stockCode: "CBA",
    color: "#abc",
    enabled: true,
    ...over,
  };
}

describe("fromMultiSeries", () => {
  it("maps STOCH %D into oscillator extraLines (parity with legacy)", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      showOscillatorPanel: true,
      series: [{ stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" }],
      indicators: [
        {
          config: config({ type: "STOCH", period: 14 }),
          values: Array(10).fill(50),
          multiOutput: {
            primary: Array(10).fill(50),
            percentK: Array(10).fill(50),
            percentD: Array(10).fill(55),
          },
        },
      ],
    };
    const { oscillators } = fromMultiSeries(input);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0]!.values).toEqual(Array(10).fill(50)); // %K primary
    expect(oscillators[0]!.extraLines?.[0]?.values).toEqual(Array(10).fill(55)); // %D
  });

  it("maps legacy points (Date) to {t,v} epoch-ms points", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [{ stockCode: "CBA", color: "#f00", points: points(3) }],
    };
    const { series } = fromMultiSeries(input);
    expect(series).toHaveLength(1);
    expect(series[0]!.points).toEqual([
      { t: T0, v: 1 },
      { t: T0 + DAY, v: 2 },
      { t: T0 + 2 * DAY, v: 3 },
    ]);
    expect(series[0]!.kind).toBe("line");
    expect(series[0]!.label).toBe("CBA");
    expect(series[0]!.color).toBe("#f00");
    // No seriesType → "v" suffix in the id.
    expect(series[0]!.id).toBe("CBA:v");
  });

  it("assigns single-axis (left) when not dual-axis", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      hasDualAxis: false,
      series: [
        { stockCode: "CBA", color: "#f00", points: points(2), seriesType: "shorts" },
        { stockCode: "PRICE:CBA", color: "#00f", points: points(2), seriesType: "market" },
      ],
    };
    const { series } = fromMultiSeries(input);
    expect(series.map((s) => s.axis)).toEqual(["left", "left"]);
  });

  it("assigns dual axis: shorts → left, market → right", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      hasDualAxis: true,
      series: [
        { stockCode: "CBA", color: "#f00", points: points(2), seriesType: "shorts" },
        { stockCode: "PRICE:CBA", color: "#00f", points: points(2), seriesType: "market" },
      ],
    };
    const { series } = fromMultiSeries(input);
    const byId = new Map(series.map((s) => [s.id, s]));
    expect(byId.get("CBA:shorts")!.axis).toBe("left");
    expect(byId.get("PRICE:CBA:market")!.axis).toBe("right");
  });

  it("splits indicators into overlays vs oscillators", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
      ],
      indicators: [
        { config: config({ type: "SMA", period: 5 }), values: Array(10).fill(1) },
        { config: config({ type: "RSI", period: 14 }), values: Array(10).fill(50) },
      ],
    };
    const { indicators, oscillators } = fromMultiSeries(input);
    expect(indicators).toHaveLength(1);
    expect(indicators[0]!.label).toBe("SMA(5)");
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0]!.label).toBe("RSI(14)");
  });

  it("matches overlay seriesId to a built series id (shorts dataSource)", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
      ],
      indicators: [
        {
          config: config({ type: "EMA", period: 5, dataSource: "shorts" }),
          values: Array(10).fill(2),
        },
      ],
    };
    const { series, indicators } = fromMultiSeries(input);
    expect(indicators[0]!.seriesId).toBe(series[0]!.id);
    expect(series.some((s) => s.id === indicators[0]!.seriesId)).toBe(true);
  });

  it("matches a market-dataSource overlay to the PRICE: series id", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      hasDualAxis: true,
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
        { stockCode: "PRICE:CBA", color: "#00f", points: points(10), seriesType: "market" },
      ],
      indicators: [
        {
          config: config({ type: "EMA", period: 5, dataSource: "market", stockCode: "CBA" }),
          values: Array(10).fill(3),
        },
      ],
    };
    const { indicators } = fromMultiSeries(input);
    expect(indicators[0]!.seriesId).toBe("PRICE:CBA:market");
  });

  it("falls back to first same-code series for dataSource-less overlay", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
      ],
      indicators: [
        // no dataSource on config
        { config: config({ type: "SMA", period: 5 }), values: Array(10).fill(1) },
      ],
    };
    const { indicators } = fromMultiSeries(input);
    expect(indicators[0]!.seriesId).toBe("CBA:shorts");
  });

  it("carries Bollinger upper/middle/lower bands through", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
      ],
      indicators: [
        {
          config: config({ type: "BBANDS", period: 20 }),
          values: Array(10).fill(5),
          multiOutput: {
            primary: Array(10).fill(5),
            upper: Array(10).fill(7),
            middle: Array(10).fill(5),
            lower: Array(10).fill(3),
          },
        },
      ],
    };
    const { indicators } = fromMultiSeries(input);
    expect(indicators[0]!.upper).toEqual(Array(10).fill(7));
    expect(indicators[0]!.middle).toEqual(Array(10).fill(5));
    expect(indicators[0]!.lower).toEqual(Array(10).fill(3));
  });

  it("aligns indicator values 1:1 to the target series raw points", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(7), seriesType: "shorts" },
      ],
      indicators: [
        { config: config({ type: "SMA", period: 3 }), values: Array(7).fill(1) },
      ],
    };
    const { series, indicators } = fromMultiSeries(input);
    expect(indicators[0]!.values.length).toBe(series[0]!.points.length);
  });

  it("Williams %R gets the inverted -100..0 domain; RSI gets 0..100", () => {
    const input: MultiSeriesInput = {
      viewMode: "absolute",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
      ],
      indicators: [
        { config: config({ type: "WILLR", period: 14 }), values: Array(10).fill(-50) },
        { config: config({ type: "RSI", period: 14 }), values: Array(10).fill(50) },
      ],
    };
    const { oscillators } = fromMultiSeries(input);
    const willr = oscillators.find((o) => o.label === "%R(14)")!;
    const rsi = oscillators.find((o) => o.label === "RSI(14)")!;
    expect(willr.domain).toEqual([-100, 0]);
    expect(rsi.domain).toEqual([0, 100]);
    expect(rsi.reference).toEqual([30, 50, 70]);
  });

  it("drops disabled indicators", () => {
    const input: MultiSeriesInput = {
      viewMode: "normalized",
      series: [
        { stockCode: "CBA", color: "#f00", points: points(10), seriesType: "shorts" },
      ],
      indicators: [
        { config: config({ type: "SMA", period: 5, enabled: false }), values: Array(10).fill(1) },
        { config: config({ type: "RSI", period: 14, enabled: false }), values: Array(10).fill(50) },
      ],
    };
    const { indicators, oscillators, viewMode } = fromMultiSeries(input);
    expect(indicators).toHaveLength(0);
    expect(oscillators).toHaveLength(0);
    expect(viewMode).toBe("normalized");
  });
});
