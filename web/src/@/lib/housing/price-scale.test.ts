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
});
