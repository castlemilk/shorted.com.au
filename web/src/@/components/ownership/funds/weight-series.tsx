import { formatPct } from "~/@/lib/fundamentals/format";

/** One file date's weight of a holding. A null is a file that does not state it. */
export interface WeightPoint {
  asAt: string;
  weightPct: number | null;
}

export const SERIES_WIDTH = 240;
export const SERIES_HEIGHT = 64;
const PAD = 6;

export interface SeriesGeometry {
  /**
   * One polyline per run of consecutive stated weights, as "x,y" pairs. A file that
   * states no weight ends a run, so the line never bridges the gap.
   */
  runs: string[];
  /** Each stated point's centre, with its date and figure. */
  dots: { x: number; y: number; asAt: string; label: string }[];
}

/**
 * The line and its dots for a weight series (spec 14.3). The x axis is the file
 * dates in order, so the spacing is the snapshots, not the calendar; the y axis runs
 * from the lowest stated weight to the highest, and a flat series sits mid-height.
 * A file that does not state the weight leaves a gap, never a zero.
 */
export function seriesGeometry(points: readonly WeightPoint[], width = SERIES_WIDTH, height = SERIES_HEIGHT): SeriesGeometry {
  const stated = points.flatMap((point, index) =>
    point.weightPct === null || !Number.isFinite(point.weightPct) ? [] : [{ ...point, index }],
  );
  if (stated.length === 0 || points.length === 0) return { runs: [], dots: [] };
  const values = stated.map((point) => point.weightPct!);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const x = (index: number) => (points.length === 1 ? width / 2 : PAD + (index / (points.length - 1)) * (width - 2 * PAD));
  const y = (value: number) => (span === 0 ? height / 2 : PAD + (1 - (value - low) / span) * (height - 2 * PAD));
  const dots = stated.map((point) => ({
    x: x(point.index),
    y: y(point.weightPct!),
    asAt: point.asAt,
    label: `${point.asAt}: ${formatPct(point.weightPct, { digits: 2 })}`,
  }));
  // A run is the stated points with no unstated file between them.
  const runs: string[] = [];
  let run: string[] = [];
  points.forEach((point, index) => {
    if (point.weightPct === null || !Number.isFinite(point.weightPct)) {
      if (run.length > 0) runs.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${x(index).toFixed(1)},${y(point.weightPct).toFixed(1)}`);
  });
  if (run.length > 0) runs.push(run.join(" "));
  return { runs, dots };
}

/**
 * A holding's weight across its file dates: a small line with a dot per snapshot
 * (spec 14.3). The figures are printed beside it for a reader who cannot see the
 * drawing, so the line is never the only record.
 */
export function WeightSeries({ points, label }: { points: readonly WeightPoint[]; label: string }) {
  const geometry = seriesGeometry(points);
  const first = points[0];
  const last = points.at(-1);
  return (
    <figure className="space-y-2">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${SERIES_WIDTH} ${SERIES_HEIGHT}`}
        className="h-16 w-full max-w-[240px] overflow-visible text-primary"
      >
        {geometry.runs.map((run) => (
          <polyline key={run} points={run} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
        ))}
        {geometry.dots.map((dot) => (
          <circle key={dot.asAt} cx={dot.x} cy={dot.y} r={2.5} fill="currentColor">
            <title>{dot.label}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
        {first ? (
          <span>
            {first.asAt} {formatPct(first.weightPct, { digits: 2 })}
          </span>
        ) : null}
        {last && last !== first ? (
          <span>
            {last.asAt} {formatPct(last.weightPct, { digits: 2 })}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
