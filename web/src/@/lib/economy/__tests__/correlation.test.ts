import {
  pearson,
  alignMonthly,
  rollingPearson,
  topCorrelations,
} from "../correlation";
import type { Obs } from "../map-metrics";

/** Build a monthly series starting at startYear-01, one obs per month. */
const monthly = (values: number[], startYear = 2023): Obs[] =>
  values.map((v, i) => ({
    date: new Date(Date.UTC(startYear, i, 1)),
    value: v,
  }));

/** Build a quarterly series — obs on the first month of each calendar quarter. */
const quarterly = (values: number[], startYear = 2023): Obs[] =>
  values.map((v, i) => ({
    date: new Date(Date.UTC(startYear, i * 3, 1)),
    value: v,
  }));

describe("pearson", () => {
  it("returns +1 for a perfectly positive linear relationship", () => {
    const r = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(1, 10);
  });

  it("returns -1 for a perfectly negative linear relationship", () => {
    const r = pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(-1, 10);
  });

  it("returns ~0 for uncorrelated symmetric data", () => {
    // xs symmetric about its mean paired with a symmetric quadratic → r = 0.
    const xs = [-2, -1, 0, 1, 2];
    const ys = [4, 1, 0, 1, 4];
    const r = pearson(xs, ys);
    expect(r).not.toBeNull();
    expect(Math.abs(r!)).toBeLessThan(1e-10);
  });

  it("computes a known intermediate coefficient", () => {
    // r for these two vectors is exactly 0.8 (worked by hand: cov=8, both σ² sums=10).
    const r = pearson([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.8, 10);
  });

  it("guards n < 3 → null", () => {
    expect(pearson([1, 2], [3, 4])).toBeNull();
    expect(pearson([1], [3])).toBeNull();
    expect(pearson([], [])).toBeNull();
  });

  it("guards zero variance in either vector → null", () => {
    expect(pearson([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3, 4], [7, 7, 7, 7])).toBeNull();
  });

  it("truncates to the shorter vector length", () => {
    const r = pearson([1, 2, 3, 4, 5, 99], [2, 4, 6, 8, 10]);
    expect(r!).toBeCloseTo(1, 10);
  });
});

describe("alignMonthly", () => {
  it("aligns two monthly series on shared month keys only", () => {
    const a = monthly([1, 2, 3, 4], 2023); // Jan..Apr
    const b = monthly([10, 20, 30], 2023).map((o, i) => ({
      ...o,
      date: new Date(Date.UTC(2023, i + 1, 1)), // Feb..Apr
    }));
    const pairs = alignMonthly(a, b);
    expect(pairs.map((p) => p.key)).toEqual(["2023-02", "2023-03", "2023-04"]);
    expect(pairs.map((p) => p.x)).toEqual([2, 3, 4]);
    expect(pairs.map((p) => p.y)).toEqual([10, 20, 30]);
  });

  it("forward-fills a quarterly series within its quarter only", () => {
    // Quarterly b: Q1=100 (Jan), Q2=200 (Apr). Monthly a: Jan..Jun = 1..6.
    const a = monthly([1, 2, 3, 4, 5, 6], 2023);
    const b = quarterly([100, 200], 2023);
    const pairs = alignMonthly(a, b);
    // Jan/Feb/Mar carry 100; Apr/May/Jun carry 200. No bleed across the boundary.
    expect(pairs.map((p) => p.key)).toEqual([
      "2023-01",
      "2023-02",
      "2023-03",
      "2023-04",
      "2023-05",
      "2023-06",
    ]);
    expect(pairs.map((p) => p.y)).toEqual([100, 100, 100, 200, 200, 200]);
  });

  it("does NOT bleed a quarterly value across a gapped quarter (Q1 + Q3, Q2 absent)", () => {
    // Quarterly b with a hole: Q1=100 (Jan), Q3=300 (Jul). Q2 has no obs.
    const a = monthly(Array.from({ length: 9 }, (_, i) => i + 1), 2023); // Jan..Sep
    const b: Obs[] = [
      { date: new Date(Date.UTC(2023, 0, 1)), value: 100 },
      { date: new Date(Date.UTC(2023, 6, 1)), value: 300 },
    ];
    const pairs = alignMonthly(a, b);
    // Q1 fills Jan/Feb/Mar; Apr/May/Jun absent; Q3 fills Jul/Aug/Sep.
    expect(pairs.map((p) => p.key)).toEqual([
      "2023-01",
      "2023-02",
      "2023-03",
      "2023-07",
      "2023-08",
      "2023-09",
    ]);
    expect(pairs.map((p) => p.y)).toEqual([100, 100, 100, 300, 300, 300]);
  });

  it("returns empty when there is no month overlap", () => {
    const a = monthly([1, 2, 3], 2020);
    const b = monthly([4, 5, 6], 2025);
    expect(alignMonthly(a, b)).toEqual([]);
  });
});

describe("rollingPearson", () => {
  it("computes r over the latest window and reports n", () => {
    // Perfectly correlated 30 months; window 24 → r=1, n=24.
    const xs = Array.from({ length: 30 }, (_, i) => i);
    const a = xs.map((v, i) => ({ date: new Date(Date.UTC(2020, i, 1)), value: v }));
    const b = xs.map((v, i) => ({ date: new Date(Date.UTC(2020, i, 1)), value: v * 3 + 1 }));
    const { r, n } = rollingPearson(a, b, 24);
    expect(n).toBe(24);
    expect(r!).toBeCloseTo(1, 10);
  });

  it("uses all overlap when shorter than the window", () => {
    const a = monthly([1, 2, 3, 4, 5], 2023);
    const b = monthly([2, 4, 6, 8, 10], 2023);
    const { r, n } = rollingPearson(a, b, 24);
    expect(n).toBe(5);
    expect(r!).toBeCloseTo(1, 10);
  });

  it("returns null r when overlap < 3", () => {
    const a = monthly([1, 2], 2023);
    const b = monthly([2, 4], 2023);
    const { r, n } = rollingPearson(a, b, 24);
    expect(r).toBeNull();
    expect(n).toBe(2);
  });
});

describe("topCorrelations", () => {
  const short = Array.from({ length: 24 }, (_, i) => ({
    date: new Date(Date.UTC(2022, i, 1)),
    value: Math.sin(i / 2),
  }));

  it("gates on minN and minAbsR, sorted by |r| descending", () => {
    const strongNeg = short.map((o) => ({ ...o, value: -o.value * 5 + 2 })); // r ≈ -1
    const weak = short.map((o, i) => ({ ...o, value: (i % 2) * 0.001 })); // ~0
    const shortWindow = short.slice(0, 6); // only 6 months overlap → below minN
    const results = topCorrelations(
      short,
      [
        { key: "strong", label: "Strong", series: strongNeg },
        { key: "weak", label: "Weak", series: weak },
        { key: "tooShort", label: "Too short", series: shortWindow },
      ],
      { minAbsR: 0.4, minN: 12 },
    );
    expect(results.map((r) => r.key)).toEqual(["strong"]);
    expect(results[0]!.r).toBeCloseTo(-1, 6);
    expect(results[0]!.n).toBe(24);
  });

  it("returns [] when the short series is too sparse for any candidate (minN not met)", () => {
    const sparse = monthly([1, 2, 3], 2023); // 3 obs
    const cand = monthly([2, 4, 6], 2023);
    const results = topCorrelations(sparse, [{ key: "c", label: "C", series: cand }], {
      minAbsR: 0.4,
      minN: 12,
    });
    expect(results).toEqual([]);
  });

  it("orders multiple qualifiers by absolute r", () => {
    const strong = short.map((o) => ({ ...o, value: o.value * 10 })); // r ≈ +1
    const mid = short.map((o, i) => ({
      ...o,
      value: o.value * 3 + (i % 3), // weaker positive
    }));
    const results = topCorrelations(
      short,
      [
        { key: "mid", label: "Mid", series: mid },
        { key: "strong", label: "Strong", series: strong },
      ],
      { minAbsR: 0.3, minN: 12 },
    );
    expect(results[0]!.key).toBe("strong");
    expect(Math.abs(results[0]!.r)).toBeGreaterThanOrEqual(Math.abs(results[1]!.r));
  });
});
