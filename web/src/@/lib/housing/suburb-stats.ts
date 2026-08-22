/**
 * Where one suburb sits inside its own state.
 *
 * Everything here is derived from the state's own suburb list, because none of
 * these numbers exist in the RPC: there is no percentile field on SuburbSummary
 * and no state-wide distribution message. Deriving them here keeps the claim
 * honest — we can say exactly what population each rank is against — without a
 * proto change and a hand-applied prod migration.
 *
 * This module is PURE. The list reaches it via `getStateSuburbIndex`, which owns
 * the caching; see that file for why the raw 3.65 MB response can't be cached and
 * this compact projection can.
 *
 * Every rank is WITHIN THE SUBURB'S OWN STATE and over the suburbs that actually
 * have the metric — never over the full corpus padded with zeros, which would
 * flatter every priced suburb in a mostly-unpriced state.
 */

export type Ranked = {
  /**
   * 0..100 midrank — everything strictly below, plus half of everything equal.
   * This is the PERCENTILE: use it for "94th percentile" labels and for the
   * position of a marker.
   */
  pct: number;
  /**
   * 0..100, the share STRICTLY below. Use this and only this for comparative
   * prose: a unique maximum of 100 midranks to 99.5, which rounds to "dearer
   * than 100% of suburbs" — a claim that is false, because it is not dearer
   * than itself. It is strictly dearer than 99.
   */
  strictPct: number;
  /** Size of the comparison population. */
  n: number;
};

export type Density = {
  /** Closed SVG path (filled area) in the 0..W × 0..H box below. */
  path: string;
  /** x of the suburb's marker, in the same box. */
  markerX: number;
  /** Domain actually drawn — the trimmed range, not the raw extremes. */
  min: number;
  max: number;
  /** True when observations fall below `min` / above `max` and were pooled into
   * the edge bin, so a label can say "$4.2M+" rather than claim a hard limit. */
  clippedLow: boolean;
  clippedHigh: boolean;
  n: number;
};

export const DENSITY_W = 260;
export const DENSITY_H = 48;
const DENSITY_BASE = 44;
const DENSITY_TOP = 4;

/**
 * Percentile of `v` against an ASCENDING-sorted array, as a MIDRANK: everything
 * strictly below it, plus half of everything equal to it.
 *
 * The naive "share at or below" is wrong for a subject that is a member of its
 * own population. A suburb cannot be dearer than itself, so a unique maximum is
 * the 99.5th percentile, not the 100th — and where a value ties (amenity scores
 * are one-decimal, so ties are common) every tied member would otherwise be
 * handed the whole block's rank and read as "dearer than 100%".
 *
 * Returns null for an empty population or a non-finite subject.
 */
export function percentileRank(sortedAsc: number[], v: number): Ranked | null {
  const n = sortedAsc.length;
  if (n === 0 || !Number.isFinite(v)) return null;

  const bound = (inclusive: boolean) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = sortedAsc[mid]!;
      if (inclusive ? x <= v : x < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const below = bound(false);
  const atOrBelow = bound(true);
  return {
    pct: ((below + (atOrBelow - below) / 2) / n) * 100,
    strictPct: (below / n) * 100,
    n,
  };
}

const ordinalSuffix = (v: number) => {
  const r = v % 10;
  const t = v % 100;
  return t >= 11 && t <= 13 ? "th" : r === 1 ? "st" : r === 2 ? "nd" : r === 3 ? "rd" : "th";
};

/** 94 → "94th". Clamped to 1..99 so a rank never reads as 0th or 100th. */
export function ordinal(pct: number): string {
  const v = Math.min(99, Math.max(1, Math.round(pct)));
  return `${v}${ordinalSuffix(v)}`;
}

/**
 * A smoothed distribution of `values` with a marker at `v`.
 *
 * `log` compresses the long right tail of house prices so the mass is visible
 * instead of a spike at the left edge; incomes are near-symmetric and stay
 * linear. The curve is a 48-bin histogram put through a 3-tap moving average —
 * enough to read as a distribution, cheap enough to render on the server.
 */
export function densityCurve(
  values: number[],
  v: number,
  { log = false, bins = 48, trim = 0.01 }: { log?: boolean; bins?: number; trim?: number } = {},
): Density | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  if (!Number.isInteger(bins) || bins < 2) return null;
  const clean = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (clean.length < 20) return null;

  // Trim to the 1st..99th percentile before choosing the domain. One $111M
  // outlier in a state of $1M suburbs stretches the axis so far that the whole
  // population piles into two bins and a 98th-percentile suburb draws at the
  // middle of the chart — the curve then says the opposite of the true rank.
  // Values outside the domain are pooled into the edge bins, so nothing is
  // dropped from the shape, only from the scale. One symmetric tail count, so
  // the same number of observations comes off each end — deriving the two ends
  // from independently rounded quantiles trimmed one side and not the other at
  // some population sizes.
  const k = Math.floor(trim * clean.length);
  const lo = clean[k]!;
  const hi = clean[clean.length - 1 - k]!;
  // The marker is clamped to the domain independently, so a subject outside it
  // must set the flag too — otherwise the axis label claims a hard limit while
  // the marker sits pinned to the edge.
  const clippedLow = clean[0]! < lo || v < lo;
  const clippedHigh = clean[clean.length - 1]! > hi || v > hi;

  const tx = (x: number) => (log ? Math.log10(x) : x);
  const min = tx(lo);
  const max = tx(hi);
  if (!(max > min)) return null;

  const counts = new Array<number>(bins).fill(0);
  for (const x of clean) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((tx(x) - min) / (max - min)) * bins)));
    counts[i] += 1;
  }
  // 3-tap smoothing.
  const smooth = counts.map((_, i) => {
    const a = counts[i - 1] ?? counts[i]!;
    const b = counts[i]!;
    const c = counts[i + 1] ?? counts[i]!;
    return (a + 2 * b + c) / 4;
  });
  const peak = Math.max(...smooth, 1);

  const pts = smooth.map((c, i) => {
    const x = (i / (bins - 1)) * DENSITY_W;
    const y = DENSITY_BASE - (c / peak) * (DENSITY_BASE - DENSITY_TOP);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M${pts.join("L")}L${DENSITY_W},${DENSITY_BASE}L0,${DENSITY_BASE}Z`;

  const markerX = Math.min(
    DENSITY_W,
    Math.max(0, ((tx(v) - min) / (max - min)) * DENSITY_W),
  );
  return {
    path,
    markerX,
    min: lo,
    max: hi,
    clippedLow,
    clippedHigh,
    n: clean.length,
  };
}

/**
 * The minimum shape this module needs from a SuburbSummary — deliberately flat
 * and seven fields wide, because a whole state of these has to fit inside Next's
 * 2 MB data-cache entry (see actions/getHousingStateIndex.ts).
 */
export type SuburbLike = {
  salCode: string;
  salName: string;
  stateCode: string;
  postcode: string;
  latestMedianPrice: number;
  yoyPct: number;
  medianWeeklyHhdIncome: number;
  /** SuburbAmenities.amenity_density_score, 0..100; 0 when un-ingested. */
  amenityScore: number;
};

export type SuburbContext = {
  price: Ranked | null;
  income: Ranked | null;
  amenity: Ranked | null;
  priceDist: Density | null;
  incomeDist: Density | null;
  /** Same-postcode suburbs, else the closest by median price. */
  nearby: SuburbLike[];
  /** Whether `nearby` is a postcode neighbourhood or a price-similarity fallback. */
  nearbyBasis: "postcode" | "price" | "none";
  /** Number of suburbs in the state that carry a median price at all. */
  pricedCount: number;
  /** Share of the state's suburbs that carry a median price, 0..1. */
  priceCoverage: number;
};

/**
 * Below this, a "price percentile in NSW" would really be a percentile among a
 * small, systematically biased slice of the state (only suburbs with enough
 * settled transfers to publish a median), and saying "in NSW" would overclaim.
 * Under the floor we publish no price rank at all.
 */
export const MIN_PRICE_COVERAGE = 0.25;

/**
 * No rank is published against fewer than this many observations, for any
 * metric. A "50th percentile" drawn from two suburbs is arithmetic, not a
 * finding, and it renders identically to one drawn from four thousand.
 */
export const MIN_RANK_POPULATION = 30;

const EMPTY: SuburbContext = {
  price: null,
  income: null,
  amenity: null,
  priceDist: null,
  incomeDist: null,
  nearby: [],
  nearbyBasis: "none",
  pricedCount: 0,
  priceCoverage: 0,
};

/**
 * Rank one suburb against its state and pick its neighbours.
 *
 * `suburbs` is the whole state list including the subject; the subject is
 * excluded from `nearby` but INCLUDED in every rank population (a suburb is part
 * of its own state's distribution).
 */
export function deriveSuburbContext(
  suburbs: readonly SuburbLike[],
  subject: SuburbLike,
): SuburbContext {
  if (!suburbs.length) return EMPTY;

  const prices: number[] = [];
  const incomes: number[] = [];
  const amenities: number[] = [];
  for (const s of suburbs) {
    if (s.latestMedianPrice > 0) prices.push(s.latestMedianPrice);
    if (s.medianWeeklyHhdIncome > 0) incomes.push(s.medianWeeklyHhdIncome);
    if (s.amenityScore > 0) amenities.push(s.amenityScore);
  }
  prices.sort((a, b) => a - b);
  incomes.sort((a, b) => a - b);
  amenities.sort((a, b) => a - b);

  const subjectAmenity = subject.amenityScore;

  const others = suburbs.filter((x) => x.salCode !== subject.salCode);
  let nearby: SuburbLike[] = [];
  let nearbyBasis: SuburbContext["nearbyBasis"] = "none";
  if (subject.postcode) {
    const same = others.filter((x) => x.postcode === subject.postcode);
    if (same.length) {
      nearby = same.slice(0, 6);
      nearbyBasis = "postcode";
    }
  }
  if (!nearby.length && subject.latestMedianPrice > 0) {
    nearby = others
      .filter((x) => x.latestMedianPrice > 0)
      .sort(
        (a, b) =>
          Math.abs(a.latestMedianPrice - subject.latestMedianPrice) -
          Math.abs(b.latestMedianPrice - subject.latestMedianPrice),
      )
      .slice(0, 6);
    if (nearby.length) nearbyBasis = "price";
  }

  const priceCoverage = prices.length / suburbs.length;
  const priceRankable = subject.latestMedianPrice > 0 && priceCoverage >= MIN_PRICE_COVERAGE;

  // A rank is only published when the subject has the metric AND the comparison
  // population is big enough to mean anything.
  const rank = (pop: number[], v: number) =>
    v > 0 && pop.length >= MIN_RANK_POPULATION ? percentileRank(pop, v) : null;

  return {
    price: priceRankable ? rank(prices, subject.latestMedianPrice) : null,
    income: rank(incomes, subject.medianWeeklyHhdIncome),
    amenity: rank(amenities, subjectAmenity),
    priceDist: priceRankable
      ? densityCurve(prices, subject.latestMedianPrice, { log: true })
      : null,
    incomeDist:
      subject.medianWeeklyHhdIncome > 0
        ? densityCurve(incomes, subject.medianWeeklyHhdIncome)
        : null,
    nearby,
    nearbyBasis,
    pricedCount: prices.length,
    priceCoverage,
  };
}
