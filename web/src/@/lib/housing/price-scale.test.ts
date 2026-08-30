import { makePriceScale, robustDomainTop } from "./price-scale";

/**
 * These pin the reason the clamp exists, not just its arithmetic.
 *
 * Measured on prod NSW (2,433 priced suburbs, 2026-08-28): min $60k, median
 * $1.0M, p98 $4.5M, p99 $5.5M, max $110.5M. Anchored on the raw maximum, the
 * MEDIAN suburb sat at 9.5% of the sqrt ramp and the state rendered as one
 * colour. Dropping the single implausible row ($110.5M in St Leonards, a
 * commercial sale in a suburb with few house sales) only moved it to 12.9% —
 * the fragility is in the scale, not the data.
 */
describe("robustDomainTop", () => {
  const nswLike = () => {
    // 2,000 suburbs clustered near $1M, then a real long tail. The tail is not
    // corrupt — Point Piper genuinely transacts in the tens of millions.
    const body = Array.from({ length: 2000 }, (_, i) => 400_000 + i * 800);
    return [...body, 17_000_000, 23_000_000, 30_000_000, 60_500_000, 110_500_000];
  };

  it("keeps the median well inside the ramp, where the raw max does not", () => {
    const vals = nswLike();
    const median = vals[Math.floor(vals.length / 2)]!;
    const rawMax = Math.max(...vals);

    const atRawMax = Math.sqrt(median) / Math.sqrt(rawMax);
    const atClamped = Math.sqrt(median) / Math.sqrt(robustDomainTop(vals));

    expect(atRawMax).toBeLessThan(0.25); // the bug: median crushed into the floor
    expect(atClamped).toBeGreaterThan(0.6); // the fix: median in the usable band
  });

  it("does not discard the tail — values above the top still paint", () => {
    const vals = nswLike();
    const top = robustDomainTop(vals);
    const scale = makePriceScale(top);
    // d3 sequential scales clamp the output range, so an above-top value is the
    // top colour rather than undefined or a wrapped hue.
    expect(scale(110_500_000)).toBe(scale(top));
    expect(scale(110_500_000)).toBeTruthy();
  });

  it("falls back to the maximum when there are too few points to rank", () => {
    const few = [500_000, 900_000, 4_000_000];
    expect(robustDomainTop(few)).toBe(4_000_000);
  });

  it("never returns below the median, however degenerate the input", () => {
    const spiky = [...Array.from({ length: 40 }, () => 1_000_000), 90_000_000];
    expect(robustDomainTop(spiky)).toBeGreaterThanOrEqual(1_000_000);
  });

  it("ignores non-finite and non-positive values rather than propagating NaN", () => {
    const dirty = [...Array.from({ length: 30 }, (_, i) => 100_000 + i * 1000), NaN, 0, -5];
    const top = robustDomainTop(dirty as number[]);
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBeGreaterThan(0);
  });

  it("returns a usable domain for an empty population", () => {
    expect(robustDomainTop([])).toBe(1);
  });

  /**
   * The implementation sorts in a Float64Array to avoid a comparator callback
   * per comparison (4.1x faster, measured 2.4k-50k values). That is only a safe
   * trade if it is bit-identical to the obvious version, so this re-derives the
   * answer the slow, plainly-correct way over randomised inputs including the
   * shapes that break naive percentile code: NaN, zero, negatives, ties,
   * single-element and empty populations.
   */
  it("is identical to a plain sorted-array implementation", () => {
    const reference = (values: number[], percentile = 0.98): number => {
      const finite = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
      if (finite.length === 0) return 1;
      if (finite.length < 20) return finite[finite.length - 1]!;
      const idx = Math.min(finite.length - 1, Math.floor((finite.length - 1) * percentile));
      return Math.max(finite[idx]!, finite[Math.floor((finite.length - 1) / 2)]!, 1);
    };

    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 20260828;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(rand() * 120);
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = rand();
        if (r < 0.05) vals.push(NaN);
        else if (r < 0.1) vals.push(0);
        else if (r < 0.15) vals.push(-rand() * 1000);
        else if (r < 0.25) vals.push(1_000_000); // ties
        else vals.push(rand() * 9_000_000);
      }
      expect(robustDomainTop(vals)).toBe(reference(vals));
    }
  });
});
