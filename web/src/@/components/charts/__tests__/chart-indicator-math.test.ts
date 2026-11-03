import {
  DAY_MS,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  timeWindowMean,
  wma,
  type Series,
} from "../chart-indicator-math";
import type { ChartPoint } from "../types";

const N = null;
const ONE_TO_FIVE = [1, 2, 3, 4, 5];

/** Element by element: a null must be null, a number must match to nine places. */
function expectSeries(actual: Series, expected: Series) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((want, i) => {
    if (want === null) expect(actual[i]).toBeNull();
    else expect(actual[i]).toBeCloseTo(want, 9);
  });
}

describe("sma", () => {
  it("averages each window of n, null until the first full one", () => {
    expectSeries(sma(ONE_TO_FIVE, 3), [N, N, 2, 3, 4]);
  });
});

describe("wma", () => {
  it("weights the newest value by n and the oldest by 1", () => {
    // (3*3 + 2*2 + 1*1) / 6, and so on.
    expectSeries(wma(ONE_TO_FIVE, 3), [N, N, 14 / 6, 20 / 6, 26 / 6]);
  });
});

describe("ema", () => {
  it("seeds with the simple average of the first n values", () => {
    // k = 2 / (3 + 1) = 0.5, and the seed is (1 + 2 + 3) / 3 = 2.
    expectSeries(ema(ONE_TO_FIVE, 3), [N, N, 2, 3, 4]);
  });
});

describe("bollinger", () => {
  it("puts population standard deviations either side of the average", () => {
    const { middle, upper, lower } = bollinger(ONE_TO_FIVE, 3, 2);
    // The window 1, 2, 3 has mean 2 and population deviation sqrt(2 / 3).
    expect(middle[2]).toBeCloseTo(2, 9);
    expect(upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 9); // about 3.633
    expect(lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 9); // about 0.367
    expect(upper[1]).toBeNull();
  });
});

describe("rsi", () => {
  it("is Wilder's index: 100 with no losses, 50 when gains equal losses", () => {
    expectSeries(rsi([1, 2, 3, 2, 3], 2), [N, N, 100, 50, 75]);
  });
});

describe("macd", () => {
  it("is the fast EMA less the slow one, with a signal from the defined run", () => {
    const { macd: line, signal, histogram } = macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
    expectSeries(line, [N, N, 0.5, 0.5, 0.5, 0.5]);
    expectSeries(signal, [N, N, N, 0.5, 0.5, 0.5]);
    expectSeries(histogram, [N, N, N, 0, 0, 0]);
  });

  it("starts the line at the slow EMA's seed and the signal nine points later", () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    const { macd: line, signal } = macd(rising, 12, 26, 9);
    expect(line.findIndex((v) => v !== null)).toBe(25);
    expect(signal.findIndex((v) => v !== null)).toBe(33);
  });
});

describe("timeWindowMean", () => {
  const at = (day: number, v: number): ChartPoint => ({ t: day * DAY_MS, v });

  it("averages the points in the window, null until the input reaches back far enough", () => {
    // At day 40 the window (10, 40] holds only day 40, whose value is 5.
    const points = [at(0, 1), at(1, 2), at(2, 3), at(10, 4), at(40, 5)];
    expectSeries(timeWindowMean(points, 30 * DAY_MS), [N, N, N, N, 5]);
  });

  it("is the trailing 30-day mean once a daily series covers the window", () => {
    const daily = Array.from({ length: 60 }, (_, day) => at(day, day));
    const out = timeWindowMean(daily, 30 * DAY_MS);
    expect(out.slice(0, 23).every((v) => v === null)).toBe(true);
    expect(out[23]).toBeCloseTo(11.5, 9); // the mean of 0..23
    expect(out[59]).toBeCloseTo(44.5, 9); // the mean of 30..59
  });
});

describe("edge cases", () => {
  it("is all nulls for a window under 1 or longer than the input, and empty for no input", () => {
    expect(sma(ONE_TO_FIVE, 0)).toEqual([N, N, N, N, N]);
    expect(wma(ONE_TO_FIVE, 0)).toEqual([N, N, N, N, N]);
    expect(ema(ONE_TO_FIVE, 0)).toEqual([N, N, N, N, N]);
    expect(bollinger(ONE_TO_FIVE, 0, 2).middle).toEqual([N, N, N, N, N]);
    expect(sma([1, 2], 5)).toEqual([N, N]);
    expect(ema([1, 2], 3)).toEqual([N, N]);
    expect(rsi([1, 2], 2)).toEqual([N, N]);
    expect(sma([], 3)).toEqual([]);
    expect(timeWindowMean([], 30 * DAY_MS)).toEqual([]);
    expect(macd([], 12, 26, 9).macd).toEqual([]);
  });
});
