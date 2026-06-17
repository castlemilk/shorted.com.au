import { computeDivergenceRegions } from "../divergence";

const DAY = 86_400_000;
const ramp = (n: number, step: number) =>
  Array.from({ length: n }, (_, i) => ({ t: i * DAY, v: 10 + i * step }));

describe("computeDivergenceRegions", () => {
  it("flags a bearish span when short and price both rise", () => {
    const regions = computeDivergenceRegions(ramp(40, 1), ramp(40, 0.1));
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((r) => r.tone === "bearish")).toBe(true);
  });

  it("flags a bullish span when short and price both fall", () => {
    const regions = computeDivergenceRegions(ramp(40, -1), ramp(40, -0.1));
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((r) => r.tone === "bullish")).toBe(true);
  });

  it("flags nothing for the normal inverse relationship (short up, price down)", () => {
    // price falling, short rising — the expected anti-correlation, not divergence
    expect(computeDivergenceRegions(ramp(40, -1), ramp(40, 0.1))).toEqual([]);
  });

  it("returns [] for too-few points", () => {
    expect(computeDivergenceRegions([], [])).toEqual([]);
    expect(computeDivergenceRegions(ramp(2, 1), ramp(2, 0.1))).toEqual([]);
  });

  it("keeps region times within the short-series range", () => {
    const short = ramp(40, 0.1);
    const [r] = computeDivergenceRegions(ramp(40, 1), short);
    expect(r!.start).toBeGreaterThanOrEqual(short[0]!.t);
    expect(r!.end).toBeLessThanOrEqual(short[short.length - 1]!.t);
  });

  it("drops runs shorter than minRun", () => {
    // 40 points, but force a tiny window + large minRun so no run qualifies
    const regions = computeDivergenceRegions(ramp(40, 1), ramp(40, 0.1), {
      window: 3,
      minRun: 1000,
    });
    expect(regions).toEqual([]);
  });
});
