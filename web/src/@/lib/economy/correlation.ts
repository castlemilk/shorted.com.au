import type { Obs } from "./map-metrics";

/**
 * Correlation helpers for the state-page "Local short interest vs …" surface.
 *
 * These are DESCRIPTIVE statistics only — a Pearson coefficient over two
 * economic series is never a causal claim (the UI carries a mandatory
 * "correlation ≠ causation" footnote). The functions here are pure and
 * unit-tested; the component layer only wires them to fetched observations.
 */

/**
 * Pearson product-moment correlation coefficient of two equal-length vectors.
 * Truncates to the shorter length. Returns `null` when it can't be defined:
 *   - fewer than 3 paired points (too few to be meaningful), or
 *   - zero variance in either vector (denominator collapses to 0).
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }

  if (vx === 0 || vy === 0) return null;
  const r = cov / Math.sqrt(vx * vy);
  // Clamp tiny floating-point overshoot into [-1, 1].
  return Math.max(-1, Math.min(1, r));
}

/** A month key like `2024-07` (UTC), stable and lexicographically sortable. */
export function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${m < 10 ? "0" : ""}${m}`;
}

/** Months between two dates (b − a), UTC. */
function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * A series is treated as quarterly when its tightest consecutive gap is ≥ 2
 * months (ABS quarterly cadence). Monthly/dense series (min gap 1) map 1:1 —
 * this avoids inventing a phantom trailing month when a monthly series simply
 * ends mid-quarter. A single-observation series is not assumed quarterly.
 */
function isQuarterly(sorted: Obs[]): boolean {
  if (sorted.length < 2) return false;
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    minGap = Math.min(minGap, monthsBetween(sorted[i - 1]!.date, sorted[i]!.date));
  }
  return minGap >= 2;
}

/**
 * Expand a series to a month→value map.
 *
 * Monthly series map 1:1. Quarterly series (detected via cadence) are
 * FORWARD-FILLED **within their own calendar quarter only**: an observation
 * carries into the remaining months of that same calendar quarter that have no
 * observation of their own — it never bleeds across a quarter boundary. This
 * aligns a quarterly series to a monthly partner (a quarter's published value
 * applies to all three of its months) without extrapolating past what the
 * source states.
 */
function expandToMonthly(obs: Obs[]): Map<string, number> {
  const sorted = [...obs].sort((a, b) => a.date.getTime() - b.date.getTime());
  const map = new Map<string, number>();

  // Pass 1: every real observation owns its own month.
  for (const o of sorted) map.set(monthKey(o.date), o.value);

  // Pass 2: only quarterly series forward-fill within their calendar quarter.
  if (!isQuarterly(sorted)) return map;
  for (const o of sorted) {
    const q = Math.floor(o.date.getUTCMonth() / 3);
    const year = o.date.getUTCFullYear();
    let m = o.date.getUTCMonth() + 1;
    while (Math.floor(m / 3) === q && m <= 11) {
      const key = monthKey(new Date(Date.UTC(year, m, 1)));
      if (!map.has(key)) map.set(key, o.value);
      m += 1;
    }
  }

  return map;
}

export interface AlignedPair {
  key: string;
  x: number;
  y: number;
}

/**
 * Align two series to their shared month keys. Mixed frequencies are supported:
 * quarterly series are forward-filled within-quarter (see {@link expandToMonthly}).
 * Result is sorted ascending by month key; only months present in BOTH series
 * are returned.
 */
export function alignMonthly(a: Obs[], b: Obs[]): AlignedPair[] {
  const ma = expandToMonthly(a);
  const mb = expandToMonthly(b);
  const pairs: AlignedPair[] = [];
  for (const [key, x] of ma) {
    const y = mb.get(key);
    if (y !== undefined) pairs.push({ key, x, y });
  }
  pairs.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  return pairs;
}

export interface RollingResult {
  /** Pearson r over the latest window; null when the window has < 3 points or no variance. */
  r: number | null;
  /** Number of aligned monthly points actually used in the window. */
  n: number;
}

/**
 * Pearson correlation over the LATEST `windowMonths` of aligned monthly overlap
 * between two series. Uses whatever overlap exists when it's shorter than the
 * window. `n` is the count of points actually correlated.
 */
export function rollingPearson(a: Obs[], b: Obs[], windowMonths = 24): RollingResult {
  const aligned = alignMonthly(a, b);
  const window = aligned.slice(-windowMonths);
  const xs = window.map((p) => p.x);
  const ys = window.map((p) => p.y);
  return { r: pearson(xs, ys), n: window.length };
}

export interface CorrelationCandidate {
  /** Stable series key (serializable — safe across the RSC boundary). */
  key: string;
  /** Human-readable label for the chip / switcher. */
  label: string;
  /** The candidate's observations. */
  series: Obs[];
}

export interface CorrelationResult extends CorrelationCandidate {
  r: number;
  n: number;
}

export interface TopCorrelationOptions {
  /** Minimum |r| to surface a candidate as a chip. */
  minAbsR?: number;
  /** Minimum aligned-point count for a coefficient to be trustworthy. */
  minN?: number;
  /** Rolling window length in months. */
  windowMonths?: number;
}

/**
 * Rank candidate series by strength of their rolling correlation with `short`
 * (the state's exposure-weighted short-interest series). Candidates are kept
 * only when the coefficient is defined, |r| ≥ `minAbsR`, and the aligned window
 * has ≥ `minN` points — then sorted by |r| descending. Returns `[]` when the
 * short series is too sparse to clear `minN` against anything (the correct,
 * calm behaviour on a thin local dataset).
 */
export function topCorrelations(
  short: Obs[],
  candidates: CorrelationCandidate[],
  opts: TopCorrelationOptions = {},
): CorrelationResult[] {
  const { minAbsR = 0.4, minN = 12, windowMonths = 24 } = opts;
  const out: CorrelationResult[] = [];
  for (const c of candidates) {
    const { r, n } = rollingPearson(short, c.series, windowMonths);
    if (r === null || n < minN || Math.abs(r) < minAbsR) continue;
    out.push({ ...c, r, n });
  }
  out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  return out;
}
