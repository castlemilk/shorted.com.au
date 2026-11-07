// The growth chart's geometry: one window of a run's weekly series, rebased to
// A$100,000 at the window's first sampled point, its drawdown from the window's
// own peak, the recorded span, and the paths and ticks a chart draws. Pure: no
// React and no DOM, so every number the chart prints is tested without it.
//
// The series is one point per ISO week plus the first, last and trough sessions
// (GetBacktestRun), so a window starts at its first sampled point, not at its
// first session. The metrics the page prints come from the API and do not use
// this curve; the chart is the picture of them.

import type { SeriesPointView } from "./map-backtest";

/** The growth figure a window starts at. */
export const GROWTH_BASE = 100_000;

export interface GrowthPoint {
  /** Epoch milliseconds at UTC midnight of the session date. */
  t: number;
  date: string;
  /** The strategy, A$, rebased to GROWTH_BASE at the window's first point. */
  strategy: number;
  /** XJT, rebased the same way; null where the benchmark is not measured. */
  benchmark: number | null;
  /** The same-data reference, rebased; null where it is not measured (after the freeze). */
  reference: number | null;
  /** Drawdown from the window's running peak, in percent; zero or negative. */
  drawdownPct: number;
  recorded: boolean;
}

/** The epoch milliseconds of a YYYY-MM-DD date, or NaN. */
export function dateToMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The points whose session falls within [from, to], both inclusive. */
export function seriesInWindow(
  series: readonly SeriesPointView[],
  from: string,
  to: string,
): SeriesPointView[] {
  return series.filter((p) => p.date >= from && (to === "" || p.date <= to));
}

/**
 * The window's curve, rebased to GROWTH_BASE at its first point. The benchmark and
 * the reference are rebased on their own first measured value, so a reference that
 * starts after the window's first point still starts at the base where it begins.
 * An empty input gives no points.
 */
export function growthOf(points: readonly SeriesPointView[]): GrowthPoint[] {
  const first = points[0];
  if (!first || !(first.equity > 0)) return [];
  const benchmarkBase = points.find((p) => p.benchmark !== null)?.benchmark ?? null;
  const referenceBase = points.find((p) => p.reference !== null)?.reference ?? null;

  let peak = Number.NEGATIVE_INFINITY;
  return points.map((p) => {
    const strategy = (GROWTH_BASE * p.equity) / first.equity;
    peak = Math.max(peak, strategy);
    return {
      t: dateToMs(p.date),
      date: p.date,
      strategy,
      benchmark:
        p.benchmark !== null && benchmarkBase !== null
          ? (GROWTH_BASE * p.benchmark) / benchmarkBase
          : null,
      reference:
        p.reference !== null && referenceBase !== null
          ? (GROWTH_BASE * p.reference) / referenceBase
          : null,
      drawdownPct: (strategy / peak - 1) * 100,
      recorded: p.recorded,
    };
  });
}

/** The deepest point of a curve, or null for an empty one. */
export function troughOf(points: readonly GrowthPoint[]): GrowthPoint | null {
  let deepest: GrowthPoint | null = null;
  for (const p of points) {
    if (deepest === null || p.drawdownPct < deepest.drawdownPct) deepest = p;
  }
  return deepest && deepest.drawdownPct < 0 ? deepest : null;
}

/** The first recorded (paper-track) point, or null when the window has none. */
export function firstRecorded(points: readonly GrowthPoint[]): GrowthPoint | null {
  return points.find((p) => p.recorded) ?? null;
}

/**
 * Round a span out to a readable step: 1, 2, 2.5 or 5 times a power of ten, with
 * about `count` steps between the ends. Returns the ticks inside [lo, hi].
 */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const raw = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * power).find((u) => u >= raw) ?? raw;
  const first = Math.ceil(lo / unit) * unit;
  const ticks: number[] = [];
  for (let v = first; v <= hi + unit * 1e-9; v += unit) {
    ticks.push(Number(v.toFixed(12)));
  }
  return ticks;
}

/** A value domain that holds every value, padded to nice ticks. */
export function paddedDomain(values: readonly number[], count = 5): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  if (hi === lo) return [lo - 1, hi + 1];
  const ticks = niceTicks(lo, hi, count);
  const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : (hi - lo) / count;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

export interface PlotBox {
  width: number;
  height: number;
  /** Space for the y-axis labels, on the left. */
  left: number;
  /** Space for the end labels, on the right. */
  right: number;
  top: number;
  bottom: number;
}

export type LinearMap = (value: number) => number;

/** Maps a time domain onto the plot's width. A single-day domain sits at the left. */
export function timeScale(points: readonly GrowthPoint[], box: PlotBox): LinearMap {
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? t0;
  const inner = Math.max(0, box.width - box.left - box.right);
  return (t) => box.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * inner : 0);
}

/** Maps a value domain onto the plot's height, with the larger value at the top. */
export function valueScale(
  domain: readonly [number, number],
  top: number,
  bottom: number,
): LinearMap {
  const [lo, hi] = domain;
  return (v) => (hi > lo ? top + (1 - (v - lo) / (hi - lo)) * (bottom - top) : top);
}

/**
 * An SVG path through the points that have a value, lifting the pen where a value
 * is null, so a line never runs across a gap. Empty when no point has a value.
 */
export function linePath(
  points: readonly GrowthPoint[],
  value: (p: GrowthPoint) => number | null,
  x: LinearMap,
  y: LinearMap,
): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    const v = value(p);
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${round(x(p.t))},${round(y(v))}`;
    pen = true;
  }
  return d;
}

/** A closed area from the zero line down to each point's drawdown, for the drawdown panel. */
export function areaPath(
  points: readonly GrowthPoint[],
  x: LinearMap,
  y: LinearMap,
): string {
  if (points.length === 0) return "";
  const zero = round(y(0));
  const first = points[0]!;
  let d = `M${round(x(first.t))},${zero}`;
  for (const p of points) d += `L${round(x(p.t))},${round(y(p.drawdownPct))}`;
  d += `L${round(x(points[points.length - 1]!.t))},${zero}Z`;
  return d;
}

/** A pixel in the SVG's own units, to two decimals, the way a path writes it. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The band a recorded (paper-track) span covers, from the track's first recorded session
 * to the end of the plot. `recordedFrom` (the API's recorded_from) is the start the design
 * names; without it the first recorded point is used. Null when the span is empty.
 */
export function recordedBand(
  points: readonly GrowthPoint[],
  x: LinearMap,
  box: PlotBox,
  recordedFrom = "",
): { x: number; width: number } | null {
  const first = recordedFrom
    ? points.find((p) => p.date >= recordedFrom) ?? null
    : firstRecorded(points);
  if (!first) return null;
  const start = x(first.t);
  const end = box.width - box.right;
  return end > start ? { x: round(start), width: round(end - start) } : null;
}

/** An engine change inside the track: the x of the session the new engine first wrote, and its label source. */
export interface EngineMark {
  x: number;
  engineVersion: string;
  firstSession: string;
}

/**
 * The engine changes inside a paper track, as marks on the chart: every segment after the
 * first starts at a change, so the first segment is not marked. A segment whose start the
 * window does not show is skipped.
 */
export function engineMarks(
  segments: ReadonlyArray<{ engineVersion: string; firstSession: string }>,
  points: readonly GrowthPoint[],
  x: LinearMap,
): EngineMark[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  return segments.slice(1).flatMap((segment) => {
    const t = dateToMs(segment.firstSession);
    if (!Number.isFinite(t) || t < first.t || t > last.t) return [];
    return [{ x: round(x(t)), engineVersion: segment.engineVersion, firstSession: segment.firstSession }];
  });
}

/**
 * The 1 January instants inside the points' span, as epoch ms, for the shared time
 * axis of the growth and drawdown panels. The first and last years are labelled
 * with the year, so a window that starts mid-year still reads from its first year.
 */
export function yearTicks(points: readonly GrowthPoint[]): Array<{ t: number; label: string }> {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  const y0 = new Date(first.t).getUTCFullYear();
  const y1 = new Date(last.t).getUTCFullYear();
  const ticks: Array<{ t: number; label: string }> = [];
  for (let y = y0; y <= y1; y++) {
    const t = Date.UTC(y, 0, 1);
    if (t >= first.t && t <= last.t) ticks.push({ t, label: String(y) });
  }
  return ticks;
}

/** The day after a YYYY-MM-DD date, as YYYY-MM-DD ("" when it is not a date). */
export function nextDay(iso: string): string {
  const t = dateToMs(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The height a drawn growth chart takes at a given width (CSS pixels). The placeholder
 * uses the same ratio, so the mount moves nothing (item 4).
 */
export const CHART_ASPECT = 0.66;
export function chartHeightFor(width: number): number {
  return Math.max(260, Math.round(width * CHART_ASPECT));
}

/**
 * Month-start ticks inside the points' span, for windows under a year: each month that
 * starts inside the span, labelled "Mon YY". Pure.
 */
export function monthTicks(points: readonly GrowthPoint[]): Array<{ t: number; label: string }> {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  const d0 = new Date(first.t);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ticks: Array<{ t: number; label: string }> = [];
  for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); ; m++) {
    if (m > 11) {
      m = 0;
      y++;
    }
    const t = Date.UTC(y, m, 1);
    if (t > last.t) break;
    if (t >= first.t) ticks.push({ t, label: `${names[m]} ${String(y).slice(2)}` });
  }
  return ticks;
}

/** One month of the coverage strip: its span on the time scale and its coverage (percent). */
export interface CoverageBand {
  month: string;
  t0: number;
  t1: number;
  coveragePct: number | null;
}

/**
 * The monthly coverage bands clipped to the points' span. A month without a measured
 * coverage keeps its span with a null coverage, so the strip says "not measured" there.
 */
export function coverageBands(
  months: ReadonlyArray<{ month: string; coveragePct: number | null; measurable: boolean }>,
  points: readonly GrowthPoint[],
): CoverageBand[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  return months.flatMap((m) => {
    const match = /^(\d{4})-(\d{2})$/.exec(m.month);
    if (!match) return [];
    const t0 = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
    const t1 = Date.UTC(Number(match[1]), Number(match[2]), 1);
    if (t1 < first.t || t0 > last.t) return [];
    return [{ month: m.month, t0: Math.max(t0, first.t), t1: Math.min(t1, last.t), coveragePct: m.measurable ? m.coveragePct : null }];
  });
}

/**
 * The y-axis tick formatter's precision: enough decimals that neighbouring ticks never
 * print the same label ("$100.0k, $99.5k"). Pure.
 */
export function moneyTickDecimals(step: number): number {
  if (step >= 1000) return 0;
  return step >= 100 ? 1 : 2;
}
