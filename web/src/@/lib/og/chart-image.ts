/**
 * Pure geometry for the shareable chart image (`/chart/[code]/image`), the
 * og:image a chart link unfurls into on Discord, Slack, X and the rest.
 *
 * No React and no fetches: the route fetches, this module turns two series
 * into SVG path strings, tick positions and readouts, and the card
 * (./chart-card.tsx) draws them. Everything here is testable without satori.
 *
 * Mirrors the interactive chart's semantics (charts/adapters.ts and
 * charts/chart-views.ts): the short view is short interest alone as an area on
 * the left axis; the price view is the close as an area on the left axis; the
 * combined view is the price area on the left ($) and the short line on the
 * right (%). A combined chart with one side missing draws the side it has.
 */
import type { ChartViewId } from "~/@/components/charts/chart-views";

export interface SeriesPoint {
  /** Epoch ms, midnight UTC of the trading or report day. */
  t: number;
  v: number;
}

/** A 1200px plot gains nothing from more points than this. */
export const MAX_IMAGE_POINTS = 400;

/**
 * Evenly strided subsample that always keeps the first and last points, so
 * the readouts (latest value, change over the period) and the drawn line end
 * at the same place.
 */
export function downsample(
  points: SeriesPoint[],
  max = MAX_IMAGE_POINTS,
): SeriesPoint[] {
  if (points.length <= max) return points;
  if (max <= 1) return points.slice(-1);
  const step = (points.length - 1) / (max - 1);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/**
 * A timestamp in any of the shapes the API reaches us in: a protobuf Timestamp
 * (`seconds` as a bigint, or a number once unstable_cache has serialised it),
 * an ISO string (the edge read returns JSON), or epoch ms.
 */
export function timestampMs(value: unknown): number | null {
  let ms: number | null = null;
  if (typeof value === "string") {
    ms = Date.parse(value);
  } else if (typeof value === "number") {
    ms = value;
  } else if (value && typeof value === "object" && "seconds" in value) {
    const { seconds, nanos } = value as {
      seconds?: bigint | number | string;
      nanos?: number;
    };
    ms = Number(seconds ?? 0) * 1000 + Number(nanos ?? 0) / 1_000_000;
  }
  return ms !== null && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Ascending, one point per instant (the last wins), non-finite dropped. */
function normalise(points: SeriesPoint[]): SeriesPoint[] {
  const byT = new Map<number, number>();
  for (const p of points) {
    if (Number.isFinite(p.t) && p.t > 0 && Number.isFinite(p.v)) {
      byT.set(p.t, p.v);
    }
  }
  return [...byT.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, v]) => ({ t, v }));
}

/** GetStockData's points → the short series, as shortSeriesToPoints reads it. */
export function shortPointsFromSeries(
  series:
    | { points?: Array<{ timestamp?: unknown; shortPosition?: unknown }> }
    | null
    | undefined,
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const p of series?.points ?? []) {
    const t = timestampMs(p.timestamp);
    const v = typeof p.shortPosition === "number" ? p.shortPosition : NaN;
    if (t !== null) out.push({ t, v });
  }
  return normalise(out);
}

/**
 * GetHistoricalPrices' JSON → the close series, as getHistoricalData and
 * historicalToPoints read it (the date's calendar day, at midnight UTC).
 */
export function pricePointsFromResponse(data: unknown): SeriesPoint[] {
  const rows =
    data && typeof data === "object" && "prices" in data
      ? (data as { prices?: unknown }).prices
      : undefined;
  if (!Array.isArray(rows)) return [];
  const out: SeriesPoint[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const day =
      typeof row?.date === "string" ? row.date.split("T")[0] : undefined;
    const t = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
    const v = Number(row?.close);
    // A zero close is a missing bar, not a price.
    if (v > 0) out.push({ t, v });
  }
  return normalise(out);
}

export interface Domain {
  min: number;
  max: number;
}

/**
 * The value range to draw, padded so a line never rides the plot's edge. A
 * flat series gets a band around its value; a series that never goes below
 * zero (short interest) never gets a negative axis.
 */
export function valueDomain(
  values: number[],
  { padFraction = 0.08, floorAtZero = false } = {},
): Domain | null {
  if (!values.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const pad = lo === hi ? Math.abs(lo) * 0.05 || 1 : (hi - lo) * padFraction;
  let min = lo - pad;
  const max = hi + pad;
  if (floorAtZero && lo >= 0 && min < 0) min = 0;
  return { min, max };
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

/** Decimal places needed to print every multiple of `step` exactly. */
export function decimalsFor(step: number): number {
  for (let d = 0; d <= 6; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(Math.round(scaled) - scaled) < 1e-7) return d;
  }
  return 6;
}

/** Round-number ticks inside the domain, about `target` of them. */
export function niceTicks(
  domain: Domain,
  target = 5,
): { values: number[]; step: number } {
  const step = niceStep((domain.max - domain.min) / target);
  const values: number[] = [];
  const first = Math.ceil(domain.min / step - 1e-9) * step;
  for (let v = first; v <= domain.max + step * 1e-9; v += step) {
    values.push(Number(v.toFixed(10)));
    if (values.length > 20) break;
  }
  return { values, step };
}

export type AxisKind = "price" | "short";

/** An axis label: at least two decimals, more when the step needs them. */
export function formatAxisValue(
  v: number,
  kind: AxisKind,
  step: number,
): string {
  const decimals = Math.max(2, decimalsFor(step));
  const text = v.toFixed(decimals);
  return kind === "price" ? `$${text}` : `${text}%`;
}

const MINUS = "−";

/** A price: cents, or a tenth of a cent below ten cents (ASX tick sizes). */
export function formatPrice(v: number): string {
  return `$${v.toFixed(v > 0 && v < 0.1 ? 3 : 2)}`;
}

/** Short interest, two decimals, as ASIC publishes it (charts' shortFmt). */
export function formatShort(v: number): string {
  return `${v.toFixed(2)}%`;
}

/** A change in short interest in percentage points: "+0.62 pp", "−0.31 pp". */
export function formatShortChange(deltaPp: number): string {
  const rounded = Math.abs(deltaPp) < 0.005 ? 0 : deltaPp;
  if (rounded === 0) return "0.00 pp";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded).toFixed(2)} pp`;
}

/** A price change in percent: "+4.2%", "−18.4%". */
export function formatPriceChange(pct: number): string {
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
  if (rounded === 0) return "0.0%";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded).toFixed(1)}%`;
}

export interface SeriesChange {
  first: number;
  last: number;
  delta: number;
  /** Percent change, or null when the first value is not positive. */
  pct: number | null;
}

/** First-to-last change over the drawn period. */
export function seriesChange(points: SeriesPoint[]): SeriesChange | null {
  if (!points.length) return null;
  const first = points[0]!.v;
  const last = points[points.length - 1]!.v;
  return {
    first,
    last,
    delta: last - first,
    pct: first > 0 ? ((last - first) / first) * 100 : null,
  };
}

const dateFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  // Points sit at midnight UTC of their day; UTC keeps that day.
  timeZone: "UTC",
});

export function formatDate(t: number): string {
  return dateFmt.format(new Date(t));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

type Scale = (v: number) => number;

export function linePath(points: SeriesPoint[], x: Scale, y: Scale): string {
  return points
    .map((p, i) => `${i ? "L" : "M"}${round1(x(p.t))},${round1(y(p.v))}`)
    .join("");
}

/** The line closed down to `baseline`, for a filled area. */
export function areaPath(
  points: SeriesPoint[],
  x: Scale,
  y: Scale,
  baseline: number,
): string {
  if (!points.length) return "";
  const first = round1(x(points[0]!.t));
  const last = round1(x(points[points.length - 1]!.t));
  const b = round1(baseline);
  return `${linePath(points, x, y)}L${last},${b}L${first},${b}Z`;
}

export interface PlottedSeries {
  role: "price" | "short";
  axis: "left" | "right";
  /** Filled area (drawn under the line), or null for a line-only series. */
  area: string | null;
  line: string;
  last: { x: number; y: number };
}

export interface AxisTick {
  /** Pixels from the top of the plot. */
  y: number;
  label: string;
}

export interface DateLabel {
  /** Pixels from the left of the plot. */
  x: number;
  label: string;
  align: "start" | "middle" | "end";
}

export interface ChartGeometry {
  width: number;
  height: number;
  /** Bottom first, so the area fills read under the lines. */
  series: PlottedSeries[];
  leftAxis: AxisKind;
  rightAxis: AxisKind | null;
  leftTicks: AxisTick[];
  rightTicks: AxisTick[];
  dateLabels: DateLabel[];
}

export interface ChartGeometryInput {
  view: ChartViewId;
  short: SeriesPoint[];
  price: SeriesPoint[];
  /** Plot size in px. */
  width: number;
  height: number;
  /** Inset so a stroke on the domain's edge is not clipped. */
  inset?: number;
  /** Room on the right for the last point's dot. */
  insetRight?: number;
}

/**
 * Lay out the view's series in a `width` x `height` plot, or null when there
 * is nothing to draw (the card then says so instead of drawing empty axes).
 */
export function buildChartGeometry({
  view,
  short: rawShort,
  price: rawPrice,
  width,
  height,
  inset = 8,
  insetRight = 12,
}: ChartGeometryInput): ChartGeometry | null {
  const short = view === "price" ? [] : downsample(rawShort);
  const price = view === "short" ? [] : downsample(rawPrice);

  // Left axis: price when there is one, else short. Right: short beside price.
  const left: { kind: AxisKind; points: SeriesPoint[] } | null = price.length
    ? { kind: "price", points: price }
    : short.length
      ? { kind: "short", points: short }
      : null;
  if (!left) return null;
  const right =
    left.kind === "price" && short.length
      ? { kind: "short" as const, points: short }
      : null;

  const drawn = right ? [left, right] : [left];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of drawn) {
    tMin = Math.min(tMin, s.points[0]!.t);
    tMax = Math.max(tMax, s.points[s.points.length - 1]!.t);
  }
  const xRight = width - insetRight;
  const x: Scale =
    tMax > tMin
      ? (t) => ((t - tMin) / (tMax - tMin)) * xRight
      : () => width / 2;

  const top = inset;
  const bottom = height - inset;
  const axisScale =
    (d: Domain): Scale =>
    (v) =>
      bottom - ((v - d.min) / (d.max - d.min)) * (bottom - top);

  const axisFor = (s: { kind: AxisKind; points: SeriesPoint[] }) => {
    // Neither a price nor short interest is ever negative.
    const domain = valueDomain(
      s.points.map((p) => p.v),
      { floorAtZero: true },
    )!;
    const y = axisScale(domain);
    const { values, step } = niceTicks(domain);
    const ticks = values.map((v) => ({
      y: round1(y(v)),
      label: formatAxisValue(v, s.kind, step),
    }));
    return { y, ticks };
  };

  const leftAxis = axisFor(left);
  const rightAxis = right ? axisFor(right) : null;

  const plot = (
    s: { kind: AxisKind; points: SeriesPoint[] },
    y: Scale,
    axis: "left" | "right",
  ): PlottedSeries => {
    const lastPoint = s.points[s.points.length - 1]!;
    return {
      role: s.kind,
      axis,
      // The left series is the filled one; a right-axis series is a line
      // over it, as in the interactive combined view.
      area: axis === "left" ? areaPath(s.points, x, y, bottom) : null,
      line: linePath(s.points, x, y),
      last: { x: round1(x(lastPoint.t)), y: round1(y(lastPoint.v)) },
    };
  };

  const series = [plot(left, leftAxis.y, "left")];
  if (right && rightAxis) series.push(plot(right, rightAxis.y, "right"));

  // The middle label names a real point (the left series' nearest to the
  // midpoint), never an instant that may be a weekend.
  const mid = tMin + (tMax - tMin) / 2;
  let midPoint = left.points[0]!;
  for (const p of left.points) {
    if (Math.abs(p.t - mid) < Math.abs(midPoint.t - mid)) midPoint = p;
  }
  const midX = round1(x(midPoint.t));
  const dateLabels: DateLabel[] =
    tMax > tMin
      ? [
          { x: 0, label: formatDate(tMin), align: "start" },
          // Only where it cannot collide with the end labels.
          ...(midX > xRight * 0.3 && midX < xRight * 0.7
            ? [
                {
                  x: midX,
                  label: formatDate(midPoint.t),
                  align: "middle" as const,
                },
              ]
            : []),
          { x: xRight, label: formatDate(tMax), align: "end" },
        ]
      : [{ x: round1(width / 2), label: formatDate(tMin), align: "middle" }];

  return {
    width,
    height,
    series,
    leftAxis: left.kind,
    rightAxis: right ? right.kind : null,
    leftTicks: leftAxis.ticks,
    rightTicks: rightAxis ? rightAxis.ticks : [],
    dateLabels,
  };
}
