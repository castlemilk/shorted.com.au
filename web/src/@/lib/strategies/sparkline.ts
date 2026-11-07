/**
 * Geometry for EquitySparkline: a strategy's growth line, an optional benchmark
 * line, and the span after the rules were frozen (the recorded track). Pure: no
 * React and no DOM. The strategy and benchmark share one x and one y scale, so
 * the two lines compare by eye.
 */

export interface SparkPoint {
  /** Epoch milliseconds. */
  t: number;
  v: number;
}

export interface SparkOptions {
  strategy: readonly SparkPoint[];
  benchmark?: readonly SparkPoint[];
  /** Epoch ms the rules were frozen; the span from here to the end is "recorded". */
  liveFrom?: number;
  width: number;
  height: number;
  /** The space kept clear of the lines at each edge, in px. */
  pad?: number;
}

export interface SparkGeometry {
  /** The strategy's line as an SVG path `d`; "" when it has no finite point. */
  strategy: string;
  /** The benchmark's line; null when there is none. */
  benchmark: string | null;
  /** The recorded span, as an x and a width in px; null when it does not show. */
  live: { x: number; width: number } | null;
}

const r = (n: number) => Math.round(n * 100) / 100;

const finite = (p: SparkPoint) => Number.isFinite(p.t) && Number.isFinite(p.v);

export function sparkline(opts: SparkOptions): SparkGeometry {
  const pad = opts.pad ?? 2;
  const strategy = opts.strategy.filter(finite);
  const benchmark = (opts.benchmark ?? []).filter(finite);
  const all = [...strategy, ...benchmark];
  if (!all.length) return { strategy: "", benchmark: null, live: null };

  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const v0 = Math.min(...all.map((p) => p.v));
  const v1 = Math.max(...all.map((p) => p.v));
  const innerW = Math.max(0, opts.width - 2 * pad);
  const innerH = Math.max(0, opts.height - 2 * pad);

  const x = (t: number) =>
    t1 > t0 ? pad + ((t - t0) / (t1 - t0)) * innerW : pad;
  // A flat series sits mid-height, not on an edge.
  const y = (v: number) =>
    v1 > v0 ? pad + (1 - (v - v0) / (v1 - v0)) * innerH : pad + innerH / 2;

  const pathOf = (pts: readonly SparkPoint[]) =>
    pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${r(x(p.t))},${r(y(p.v))}`)
      .join("");

  let live: SparkGeometry["live"] = null;
  if (
    opts.liveFrom !== undefined &&
    Number.isFinite(opts.liveFrom) &&
    opts.liveFrom <= t1
  ) {
    const left = x(Math.max(opts.liveFrom, t0));
    const right = pad + innerW;
    if (right > left) live = { x: r(left), width: r(right - left) };
  }

  return {
    strategy: pathOf(strategy),
    benchmark: benchmark.length ? pathOf(benchmark) : null,
    live,
  };
}
