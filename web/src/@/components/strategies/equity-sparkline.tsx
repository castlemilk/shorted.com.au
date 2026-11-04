import { sparkline, type SparkPoint } from "@/lib/strategies/sparkline";

export interface EquitySparklineProps {
  /** Names the chart and says what it spans, e.g. "Backtest, in-sample to 1 Jan 2026, then recorded". */
  label: string;
  /** The strategy's growth, oldest first. */
  strategy: readonly SparkPoint[];
  /** The benchmark, drawn dashed in muted ink. */
  benchmark?: readonly SparkPoint[];
  /** Epoch ms the rules were frozen. The span after it is shaded as the recorded track. */
  liveFrom?: number;
  /** Shown instead of a line when there is no strategy series yet. */
  emptyLabel?: string;
  width?: number;
  height?: number;
}

/**
 * A small line of growth, as a server-rendered SVG with no script: the strategy
 * in the primary ink, the benchmark dashed, and the span after the rules were
 * frozen in a neutral token tint. The lines are non-scaling, so the stroke stays
 * a pixel wide whatever the box.
 */
export function EquitySparkline({
  label,
  strategy,
  benchmark,
  liveFrom,
  emptyLabel = "No backtest yet",
  width = 240,
  height = 56,
}: EquitySparklineProps) {
  const geometry = sparkline({ strategy, benchmark, liveFrom, width, height });
  if (!geometry.strategy) {
    // The name says what the box is for and that it is empty, so a screen reader
    // hears the same state a sighted reader sees (the text is hidden behind the role).
    return (
      <div
        role="img"
        aria-label={`${label}: ${emptyLabel}`}
        className="hatch-empty flex h-14 items-center justify-center rounded-sm font-mono text-xs"
        style={{ color: "hsl(var(--foreground))" }}
      >
        {emptyLabel}
      </div>
    );
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-14 w-full overflow-visible"
    >
      {geometry.live ? (
        <rect
          data-spark-live
          x={geometry.live.x}
          y={0}
          width={geometry.live.width}
          height={height}
          style={{ fill: "hsl(var(--primary) / 0.06)" }}
        />
      ) : null}
      {geometry.benchmark ? (
        <path
          data-spark-benchmark
          d={geometry.benchmark}
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        data-spark-strategy
        d={geometry.strategy}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={1.75}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
