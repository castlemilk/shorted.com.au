/// <reference types="jest" />

import {
  DENSITY_W,
  densityCurve,
  deriveSuburbContext,
  MIN_PRICE_COVERAGE,
  ordinal,
  percentileRank,
  type SuburbLike,
} from "./suburb-stats";

const suburb = (over: Partial<SuburbLike> & { salCode: string }): SuburbLike => ({
  salName: `SUBURB ${over.salCode}`,
  stateCode: "NSW",
  postcode: "2000",
  latestMedianPrice: 0,
  yoyPct: 0,
  medianWeeklyHhdIncome: 0,
  amenityScore: 0,
  ...over,
});

describe("percentileRank", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("midranks a member of its own population", () => {
    // 4 strictly below 5, one equal to it: (4 + 0.5) / 10.
    expect(percentileRank(sorted, 5)).toEqual({ pct: 45, strictPct: 40, n: 10 });
  });

  it("never puts a unique maximum at the 100th percentile", () => {
    // A suburb cannot be dearer than itself.
    // Midrank 95 for the label, strictly-above-90% for the prose.
    expect(percentileRank(sorted, 10)).toEqual({ pct: 95, strictPct: 90, n: 10 });
  });

  it("puts a value below the whole population at zero", () => {
    expect(percentileRank(sorted, 0)?.pct).toBe(0);
  });

  it("splits a tied block rather than handing every member its top", () => {
    // The old at-or-below rule read "dearer than 100% of suburbs" for all four.
    expect(percentileRank([5, 5, 5, 5], 5)?.pct).toBe(50);
    expect(percentileRank([5, 5, 5, 5], 5)?.strictPct).toBe(0);
    expect(percentileRank([1, 5, 5, 9], 5)?.pct).toBe(50);
  });

  it("returns null for an empty population or a non-finite value", () => {
    expect(percentileRank([], 5)).toBeNull();
    expect(percentileRank(sorted, Number.NaN)).toBeNull();
  });
});

describe("ordinal", () => {
  it("clamps ordinals away from 0th and 100th", () => {
    expect(ordinal(0)).toBe("1st");
    expect(ordinal(100)).toBe("99th");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(93.6)).toBe("94th");
  });
});

describe("densityCurve", () => {
  const values = Array.from({ length: 200 }, (_, i) => 100_000 + i * 10_000);

  it("refuses to draw a distribution from too few observations", () => {
    expect(densityCurve([1, 2, 3], 2)).toBeNull();
  });

  it("refuses degenerate inputs rather than emitting NaN coordinates", () => {
    expect(densityCurve(values, Number.NaN)).toBeNull();
    expect(densityCurve(values, 0)).toBeNull();
    // bins = 1 divides by zero when spacing the points.
    expect(densityCurve(values, 1_000_000, { bins: 1 })).toBeNull();
    expect(densityCurve(values, 1_000_000, { bins: 2.5 })).toBeNull();
    expect(densityCurve(values, 1_000_000)!.path).not.toContain("NaN");
  });

  it("produces a closed path and places the marker inside the box", () => {
    const dist = densityCurve(values, 1_000_000, { log: true });
    expect(dist).not.toBeNull();
    expect(dist!.path.startsWith("M")).toBe(true);
    expect(dist!.path.endsWith("Z")).toBe(true);
    expect(dist!.markerX).toBeGreaterThanOrEqual(0);
    expect(dist!.markerX).toBeLessThanOrEqual(DENSITY_W);
    expect(dist!.n).toBe(200);
  });

  it("clamps a marker beyond the observed range to the edge", () => {
    const dist = densityCurve(values, 50_000_000, { log: true })!;
    expect(dist.markerX).toBe(DENSITY_W);
  });

  it("reports the domain in original units even when log-scaled", () => {
    const dist = densityCurve(values, 1_000_000, { log: true })!;
    // Trimmed to the 1st..99th percentile, so the domain sits inside the raw
    // extremes (100k..2.09M) and both ends report as clipped.
    expect(dist.min).toBe(120_000);
    expect(dist.max).toBe(2_070_000);
    expect(dist.clippedLow).toBe(true);
    expect(dist.clippedHigh).toBe(true);
  });

  it("does not claim clipping when nothing falls outside the domain", () => {
    const flatish = Array.from({ length: 100 }, () => 500_000);
    // A degenerate population has no spread to draw at all.
    expect(densityCurve(flatish, 500_000)).toBeNull();

    const tight = Array.from({ length: 300 }, (_, i) => 500_000 + i);
    const dist = densityCurve(tight, 500_100, { trim: 0 })!;
    expect(dist.clippedLow).toBe(false);
    expect(dist.clippedHigh).toBe(false);
  });

  it("keeps a single extreme outlier from flattening the whole curve", () => {
    // One $111M sale used to stretch the axis so far that a 98th-percentile
    // suburb drew near the middle of the chart — the opposite of its true rank.
    const withOutlier = [...values, 111_000_000];
    const dist = densityCurve(withOutlier, 2_000_000, { log: true })!;
    expect(dist.max).toBeLessThan(3_000_000);
    expect(dist.clippedHigh).toBe(true);
    expect(dist.markerX).toBeGreaterThan(DENSITY_W * 0.8);
  });
});

describe("deriveSuburbContext", () => {
  const subject = suburb({
    salCode: "S1",
    postcode: "2026",
    latestMedianPrice: 3_000_000,
    medianWeeklyHhdIncome: 2_800,
    amenityScore: 87,
  });

  const state: SuburbLike[] = [
    subject,
    ...Array.from({ length: 99 }, (_, i) =>
      suburb({
        salCode: `X${i}`,
        postcode: i < 3 ? "2026" : "3000",
        latestMedianPrice: 500_000 + i * 10_000,
        yoyPct: 1,
        medianWeeklyHhdIncome: 1_000 + i * 10,
        amenityScore: 10 + i * 0.5,
      }),
    ),
  ];

  it("ranks the subject against its own state, including itself", () => {
    const ctx = deriveSuburbContext(state, subject);
    expect(ctx.price?.n).toBe(100);
    // Dearest of 100, midranked: 99 below + half of the one tie with itself.
    expect(ctx.price?.pct).toBe(99.5);
    expect(ctx.income?.pct).toBe(99.5);
    expect(ctx.amenity?.pct).toBe(99.5);
  });

  it("prefers same-postcode neighbours and excludes the subject", () => {
    const ctx = deriveSuburbContext(state, subject);
    expect(ctx.nearbyBasis).toBe("postcode");
    expect(ctx.nearby).toHaveLength(3);
    expect(ctx.nearby.map((n) => n.salCode)).not.toContain("S1");
  });

  it("falls back to closest-by-price when the postcode is alone", () => {
    const lone = { ...subject, postcode: "9999" };
    const ctx = deriveSuburbContext([lone, ...state.slice(1)], lone);
    expect(ctx.nearbyBasis).toBe("price");
    expect(ctx.nearby).toHaveLength(6);
    // The dearest suburbs are the closest to a $3M subject.
    expect(ctx.nearby[0]!.latestMedianPrice).toBe(1_480_000);
  });

  // 39 income-only suburbs + the subject: income clears MIN_RANK_POPULATION,
  // price sits at 1-in-40 coverage.
  const incomeOnlyState: SuburbLike[] = [
    subject,
    ...Array.from({ length: 39 }, (_, i) =>
      suburb({ salCode: `Z${i}`, latestMedianPrice: 0, medianWeeklyHhdIncome: 900 + i }),
    ),
  ];

  it("excludes suburbs missing a metric from that metric's population", () => {
    const ctx = deriveSuburbContext(incomeOnlyState, subject);
    expect(ctx.income?.n).toBe(40);
    expect(ctx.pricedCount).toBe(1);
  });

  it("publishes no price rank when too few of the state carry a price", () => {
    // 1 priced suburb in 40 is 2.5% coverage — a "percentile in NSW" drawn from
    // that would be a percentile among a biased fortieth of the state.
    const ctx = deriveSuburbContext(incomeOnlyState, subject);
    expect(ctx.priceCoverage).toBeLessThan(MIN_PRICE_COVERAGE);
    expect(ctx.price).toBeNull();
    expect(ctx.priceDist).toBeNull();
    // The metrics that ARE well covered still rank.
    expect(ctx.income).not.toBeNull();
  });

  it("publishes no rank at all against a population too small to mean anything", () => {
    const tiny: SuburbLike[] = [
      subject,
      ...Array.from({ length: 4 }, (_, i) =>
        suburb({ salCode: `T${i}`, latestMedianPrice: 900_000 + i, medianWeeklyHhdIncome: 900 + i }),
      ),
    ];
    const ctx = deriveSuburbContext(tiny, subject);
    // Price coverage is 100% here, so only the absolute-population gate applies.
    expect(ctx.priceCoverage).toBe(1);
    expect(ctx.price).toBeNull();
    expect(ctx.income).toBeNull();
  });

  it("returns nulls rather than zeros for an unpriced subject", () => {
    const unpriced = { ...subject, latestMedianPrice: 0, amenityScore: 0 };
    const ctx = deriveSuburbContext([unpriced, ...state.slice(1)], unpriced);
    expect(ctx.price).toBeNull();
    expect(ctx.priceDist).toBeNull();
    expect(ctx.amenity).toBeNull();
  });

  it("degrades to an empty context when the state list is empty", () => {
    const ctx = deriveSuburbContext([], subject);
    expect(ctx.nearby).toEqual([]);
    expect(ctx.nearbyBasis).toBe("none");
    expect(ctx.price).toBeNull();
  });
});
