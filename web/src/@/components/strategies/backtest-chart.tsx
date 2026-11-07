import {
  areaPath,
  dateToMs,
  engineMarks,
  growthOf,
  linePath,
  niceTicks,
  paddedDomain,
  recordedBand,
  timeScale,
  troughOf,
  valueScale,
  yearTicks,
  type GrowthPoint,
  type PlotBox,
} from "@/lib/strategies/backtest-series";
import type { EngineSegmentView, SeriesPointView } from "@/lib/strategies/map-backtest";
import { drawdownFill, drawdownStroke } from "@/lib/strategies/returns-scale";
import {
  GROWTH_TITLE,
  engineChangeLabel,
  frozenLabel,
  growthSummary,
  recordedSinceLabel,
  shortDate,
} from "@/lib/strategies/backtest-copy";
import { formatSigned } from "@/lib/strategies/format";

export interface BacktestChartProps {
  /** The served window's points, oldest first. */
  series: readonly SeriesPointView[];
  /** The window's name, read in the chart's summary and legend. */
  windowLabel: string;
  /** YYYY-MM-DD: the session the rules froze (in-sample end plus one day). "" when not frozen. */
  liveFrom: string;
  /** YYYY-MM-DD: the paper track's first recorded session. "" when the run has no track. */
  recordedFrom: string;
  /** The engine segments of the paper track, in order; a change inside the span is marked. */
  engineSegments: readonly EngineSegmentView[];
  /** XJT's name for the legend, e.g. "S&P/ASX 200 Gross Total Return (XJT)". */
  benchmarkName: string;
  /** The same-data reference's name for the legend. */
  referenceName: string;
  /** The chart's accessible name. */
  label: string;
}

const WIDTH = 720;
const BOX: PlotBox = { width: WIDTH, height: 0, left: 58, right: 112, top: 12, bottom: 0 };
const GROWTH_TOP = 12;
const GROWTH_BOTTOM = 246;
const DD_TOP = 268;
const DD_BOTTOM = 352;
const AXIS_Y = 378;
const HEIGHT = 390;

/** A dollar figure on the axis: "$80k" for a thousand and over, otherwise whole dollars. */
export function axisMoney(value: number): string {
  if (Math.abs(value) >= 1000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value)}`;
}

/** A drawdown tick: "0%", "−5%". */
export function axisPercent(value: number): string {
  if (value === 0) return "0%";
  return `${value < 0 ? "−" : ""}${Math.abs(value)}%`;
}

const dollars = (v: number) => `A$${Math.round(v).toLocaleString("en-AU")}`;

/**
 * The growth of A$100,000 against XJT and the same-data reference, with the drawdown
 * beneath on the same time axis (design 1.5, 10.6). A server-rendered SVG with no script.
 *
 * Lines: the strategy (primary, solid), XJT (muted, dashed), the reference (ink, dotted).
 * The reference is not recorded after the freeze, so its line, legend figure and end
 * label all stop at its last measured session, named in the label. The recorded band starts
 * at the paper track's own first session (recorded_from), and each engine change inside it
 * is a tick with a label.
 */
export function BacktestChart({
  series,
  windowLabel,
  liveFrom,
  recordedFrom,
  engineSegments,
  benchmarkName,
  referenceName,
  label,
}: BacktestChartProps) {
  const points = growthOf(series);
  if (points.length < 2) {
    return (
      <div
        role="img"
        aria-label={`${label}: no series for this window`}
        className="hatch-empty flex h-[300px] items-center justify-center rounded-sm font-mono text-xs text-foreground"
      >
        No series for this window
      </div>
    );
  }

  const box = { ...BOX, height: HEIGHT };
  const x = timeScale(points, box);
  const growthDomain = paddedDomain(
    points.flatMap((p) => [p.strategy, p.benchmark, p.reference].filter((v): v is number => v !== null)),
  );
  const yG = valueScale(growthDomain, GROWTH_TOP, GROWTH_BOTTOM);
  const minDd = Math.min(-1, ...points.map((p) => p.drawdownPct));
  const ddDomain: [number, number] = [Math.floor(minDd / 5) * 5, 0];
  const yD = valueScale(ddDomain, DD_TOP, DD_BOTTOM);

  const strategyPath = linePath(points, (p) => p.strategy, x, yG);
  const benchmarkPath = linePath(points, (p) => p.benchmark, x, yG);
  const referencePath = linePath(points, (p) => p.reference, x, yG);
  const ddPath = areaPath(points, x, yD);
  const ddLine = linePath(points, (p) => p.drawdownPct, x, yD);
  const band = recordedBand(points, x, box, recordedFrom);
  const marks = engineMarks(engineSegments, points, x);
  const trough = troughOf(points);
  const frozenT = liveFrom ? dateToMs(liveFrom) : Number.NaN;
  const frozenX =
    Number.isFinite(frozenT) && frozenT > points[0]!.t && frozenT <= points[points.length - 1]!.t
      ? x(frozenT)
      : null;

  const last = points[points.length - 1]!;
  const lastBenchmark = lastDefined(points, (p) => p.benchmark);
  const lastReference = lastDefined(points, (p) => p.reference);
  const endStrategy = yG(last.strategy);
  const endBenchmark = lastBenchmark ? yG(lastBenchmark.value) : null;
  const endReference = lastReference ? yG(lastReference.value) : null;
  const right = WIDTH - BOX.right + 6;
  const referenceLabel = lastReference
    ? `${referenceName}, to ${shortDate(lastReference.point.date)}`
    : referenceName;

  return (
    <figure className="m-0 space-y-2">
      <figcaption className="sr-only">{growthSummary(points, series[0]?.date ?? "", last.date)}</figcaption>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs" aria-label={`Lines in ${windowLabel}`}>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-0.5 w-6 bg-primary" />
          <span>Strategy</span>
          <span className="tabular-nums text-muted-foreground">{dollars(last.strategy)}</span>
        </li>
        {lastBenchmark ? (
          <li className="flex items-center gap-2" data-legend="benchmark">
            <span aria-hidden="true" className="inline-block w-6 border-t border-dashed border-muted-foreground" />
            <span>{benchmarkName}</span>
            <span className="tabular-nums text-muted-foreground">{dollars(lastBenchmark.value)}</span>
          </li>
        ) : null}
        {lastReference ? (
          <li className="flex items-center gap-2" data-legend="reference">
            <span aria-hidden="true" className="inline-block w-6 border-t border-dotted border-foreground/70" />
            <span>{referenceLabel}</span>
            <span className="tabular-nums text-muted-foreground">{dollars(lastReference.value)}</span>
          </li>
        ) : null}
        <li className="text-muted-foreground">Base A$100,000</li>
      </ul>
      <svg
        role="img"
        aria-label={`${label}: ${GROWTH_TITLE}, ${windowLabel}, with drawdown beneath`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-auto w-full overflow-visible font-mono text-[10px] tabular-nums"
        data-backtest-chart
      >
        {niceTicks(growthDomain[0], growthDomain[1], 4).map((v) => (
          <g key={`g-${v}`}>
            <line x1={BOX.left} x2={WIDTH - BOX.right} y1={yG(v)} y2={yG(v)} stroke="hsl(var(--border))" strokeDasharray="2 3" />
            <text x={BOX.left - 6} y={yG(v) + 3} textAnchor="end" fill="hsl(var(--muted-foreground))">
              {axisMoney(v)}
            </text>
          </g>
        ))}

        {band ? (
          <g data-recorded-band>
            <rect x={band.x} y={GROWTH_TOP} width={band.width} height={DD_BOTTOM - GROWTH_TOP} fill="hsl(var(--muted-foreground) / 0.08)" />
            <text x={band.x + band.width - 6} y={GROWTH_TOP + 12} textAnchor="end" fill="hsl(var(--muted-foreground))">
              {recordedSinceLabel(recordedFrom)}
            </text>
          </g>
        ) : null}

        {marks.map((mark) => (
          <g key={`engine-${mark.firstSession}`} data-engine-mark={mark.engineVersion}>
            <line x1={mark.x} x2={mark.x} y1={GROWTH_TOP} y2={DD_BOTTOM} stroke="hsl(var(--foreground) / 0.6)" strokeWidth={1} />
            <path d={`M${mark.x - 4},${DD_BOTTOM} L${mark.x},${DD_BOTTOM - 6} L${mark.x + 4},${DD_BOTTOM} Z`} fill="hsl(var(--foreground) / 0.6)" />
            <text x={mark.x + 4} y={GROWTH_TOP + 24} fill="hsl(var(--foreground) / 0.8)">
              {engineChangeLabel(mark.engineVersion, mark.firstSession)}
            </text>
          </g>
        ))}

        {frozenX !== null ? (
          <g data-frozen-marker>
            <line x1={frozenX} x2={frozenX} y1={GROWTH_TOP} y2={DD_BOTTOM} stroke="hsl(var(--foreground) / 0.5)" strokeDasharray="4 3" />
            <text x={frozenX - 6} y={GROWTH_BOTTOM - 6} textAnchor="end" fill="hsl(var(--foreground) / 0.8)">
              {frozenLabel(liveFrom)}
            </text>
          </g>
        ) : null}

        {referencePath ? (
          <path d={referencePath} fill="none" stroke="hsl(var(--foreground) / 0.7)" strokeWidth={1.25} strokeDasharray="1 3" data-series="reference" />
        ) : null}
        {benchmarkPath ? (
          <path d={benchmarkPath} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={1.25} strokeDasharray="5 4" data-series="benchmark" />
        ) : null}
        <path d={strategyPath} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.75} strokeLinejoin="round" data-series="strategy" />

        <text x={right} y={endStrategy + 3} fill="hsl(var(--primary))" fontWeight={600}>
          {dollars(last.strategy)}
        </text>
        {endBenchmark !== null && lastBenchmark ? (
          <text
            x={right}
            y={endBenchmark + (Math.abs(endBenchmark - endStrategy) < 12 ? 14 : 3)}
            fill="hsl(var(--muted-foreground))"
          >
            {dollars(lastBenchmark.value)}
          </text>
        ) : null}
        {endReference !== null && lastReference ? (
          <text
            x={right}
            y={endReference + (endBenchmark !== null && Math.abs(endReference - endStrategy) < 12 ? 28 : 3)}
            fill="hsl(var(--foreground) / 0.7)"
            data-end-label="reference"
          >
            {dollars(lastReference.value)}
          </text>
        ) : null}

        <line x1={BOX.left} x2={WIDTH - BOX.right} y1={yD(0)} y2={yD(0)} stroke="hsl(var(--border))" />
        {niceTicks(ddDomain[0], ddDomain[1], 3).map((v) => (
          <text key={`d-${v}`} x={BOX.left - 6} y={yD(v) + 3} textAnchor="end" fill="hsl(var(--muted-foreground))">
            {axisPercent(v)}
          </text>
        ))}
        <path d={ddPath} fill={drawdownFill()} data-series="drawdown" />
        <path d={ddLine} fill="none" stroke={drawdownStroke()} strokeWidth={1} data-series="drawdown-line" />
        {trough ? (
          <g data-trough>
            <circle cx={x(trough.t)} cy={yD(trough.drawdownPct)} r={2.5} fill="hsl(var(--foreground))" />
            <text x={x(trough.t) + 6} y={yD(trough.drawdownPct) + 4} fill="hsl(var(--foreground))">
              {formatSigned(trough.drawdownPct, "%")}
            </text>
          </g>
        ) : null}

        {yearTicks(points).map((tick) => (
          <g key={`y-${tick.label}`}>
            <line x1={x(tick.t)} x2={x(tick.t)} y1={DD_BOTTOM} y2={DD_BOTTOM + 4} stroke="hsl(var(--border))" />
            <text x={x(tick.t)} y={AXIS_Y} textAnchor="middle" fill="hsl(var(--muted-foreground))">
              {tick.label}
            </text>
          </g>
        ))}
      </svg>
      <p className="font-mono text-[10px] text-muted-foreground">
        Drawdown is measured from the window&rsquo;s own peak, on the same time axis.
      </p>
    </figure>
  );
}

/** The last point, read from the end, whose value is defined, with its value. */
function lastDefined(
  points: readonly GrowthPoint[],
  value: (p: GrowthPoint) => number | null,
): { point: GrowthPoint; value: number } | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = value(points[i]!);
    if (v !== null) return { point: points[i]!, value: v };
  }
  return null;
}
