"use client";

// The growth, drawdown and monthly-coverage chart of the Backtest tab (design 1.5, 10.6).
// It is a client module: it measures its own width with ParentSize and draws in CSS
// pixels, so its text is the size the reader reads (never a scaled viewBox). Its loader
// (backtest-chart-loader.tsx) keeps it out of the first HTML.

import { ParentSize } from "@/components/charts/parent-size";
import { layoutEndLabels } from "@/components/charts/end-labels";
import { CHART_LABEL_ROW_PX, labelBox, placeLabel, type LabelBox, type PlacedLabel } from "./chart-labels";
import {
  areaPath,
  chartHeightFor,
  coverageBands,
  dateToMs,
  engineMarks,
  growthOf,
  linePath,
  monthTicks,
  moneyTickDecimals,
  niceTicks,
  paddedDomain,
  recordedBand,
  timeScale,
  valueScale,
  yearTicks,
  type GrowthPoint,
} from "@/lib/strategies/backtest-series";
import type {
  EngineSegmentView,
  SeriesPointView,
} from "@/lib/strategies/map-backtest";
import { drawdownFill, drawdownStroke } from "@/lib/strategies/returns-scale";
import {
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
  /** The window's name, read in the chart's summary. */
  windowLabel: string;
  /** The window's first and last sessions (YYYY-MM-DD). */
  windowFrom: string;
  windowTo: string;
  /** The window's own deepest fall: its figure and the session it falls on (the callout). */
  maxDrawdownPct: number;
  troughDate: string | null;
  /** YYYY-MM-DD: the session the rules froze (in-sample end plus one day). "" when not frozen. */
  liveFrom: string;
  /** YYYY-MM-DD: the paper track's first recorded session. "" when the run has no track. */
  recordedFrom: string;
  engineSegments: readonly EngineSegmentView[];
  /** Monthly coverage (percent) for the strip under the drawdown. */
  coverageMonthly: ReadonlyArray<{ month: string; coveragePct: number | null; measurable: boolean }>;
  /** The coverage measure's name, printed on the strip. */
  coverageLabel: string;
  /** XJT's full name for the legend (never the bare code). */
  benchmarkName: string;
  /** The same-data reference's name, and the session its figures run to (reference_to; "" when none). */
  referenceName: string;
  referenceTo: string;
  /** The chart's accessible name. */
  label: string;
}

/** Below this width the end labels leave the plot: the legend carries the values (item 4). */
export const PHONE_WIDTH = 640;

const TOP = 12;
const BOTTOM = 30;
const LEFT = 56;

/** Money on the axis: "$80k" from a thousand up, with the decimals that keep ticks distinct. */
export function axisMoney(value: number, step = 1000): string {
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(moneyTickDecimals(step))}k`;
  return `$${Math.round(value)}`;
}

/** A drawdown tick: "0%", "−5%". */
export function axisPercent(value: number): string {
  if (value === 0) return "0%";
  return `${value < 0 ? "−" : ""}${Math.abs(value)}%`;
}

const dollars = (v: number) => `A$${Math.round(v).toLocaleString("en-AU")}`;

/** The chart with its own measured width. */
export function BacktestChart(props: BacktestChartProps) {
  return (
    <ParentSize debounceTime={150} enableDebounceLeadingCall>
      {({ width }) =>
        width > 0 ? (
          <ChartBody {...props} width={Math.round(width)} />
        ) : (
          <div aria-hidden="true" className="w-full" style={{ aspectRatio: `100 / ${Math.round(CHART_ASPECT_PERCENT)}` }} />
        )
      }
    </ParentSize>
  );
}

const CHART_ASPECT_PERCENT = 66;

function ChartBody({
  width,
  series,
  windowLabel,
  windowFrom,
  windowTo,
  maxDrawdownPct,
  troughDate,
  liveFrom,
  recordedFrom,
  engineSegments,
  coverageMonthly,
  coverageLabel,
  benchmarkName,
  referenceName,
  referenceTo,
  label,
}: BacktestChartProps & { width: number }) {
  const points = growthOf(series);
  const height = chartHeightFor(width);
  if (points.length < 2) {
    return (
      <div
        role="img"
        aria-label={`${label}: no series for this window`}
        style={{ height }}
        className="hatch-empty flex items-center justify-center rounded-sm font-mono text-xs text-foreground"
      >
        No series for this window
      </div>
    );
  }
  const phone = width < PHONE_WIDTH;
  const right = phone ? 8 : 112;
  const box = { width, height, left: LEFT, right, top: TOP, bottom: BOTTOM };
  const plotW = width - LEFT - right;

  // Vertical bands, as fractions of the plot height: growth, drawdown, then coverage.
  const plotH = height - TOP - BOTTOM;
  const gTop = TOP;
  const gBottom = TOP + plotH * 0.58;
  const dTop = TOP + plotH * 0.64;
  const dBottom = TOP + plotH * 0.86;
  const cTop = TOP + plotH * 0.9;
  const cBottom = TOP + plotH;

  const x = timeScale(points, box);
  const growthDomain = paddedDomain(
    points.flatMap((p) => [p.strategy, p.benchmark, p.reference].filter((v): v is number => v !== null)),
  );
  const growthStep = niceTicks(growthDomain[0], growthDomain[1], 4);
  const yG = valueScale(growthDomain, gTop, gBottom);
  const minDd = Math.min(-1, ...points.map((p) => p.drawdownPct));
  const ddDomain: [number, number] = [Math.floor(minDd / 5) * 5, 0];
  const yD = valueScale(ddDomain, dTop, dBottom);

  const strategyPath = linePath(points, (p) => p.strategy, x, yG);
  const benchmarkPath = linePath(points, (p) => p.benchmark, x, yG);
  const referencePath = linePath(points, (p) => p.reference, x, yG);
  const ddPath = areaPath(points, x, yD);
  const ddLine = linePath(points, (p) => p.drawdownPct, x, yD);
  const band = recordedBand(points, x, box, recordedFrom);
  const marks = engineMarks(engineSegments.map((s) => ({ engineVersion: s.engineVersion, firstSession: s.firstSession })), points, x);
  const frozenT = liveFrom ? dateToMs(liveFrom) : Number.NaN;
  const frozenX =
    Number.isFinite(frozenT) && frozenT > points[0]!.t && frozenT <= points[points.length - 1]!.t ? x(frozenT) : null;

  // The callout: the summary's maximum drawdown, placed on its trough session.
  const troughT = troughDate ? dateToMs(troughDate) : Number.NaN;
  const troughInWindow = Number.isFinite(troughT) && troughT >= points[0]!.t && troughT <= points[points.length - 1]!.t;
  const calloutX = troughInWindow ? x(troughT) : null;

  const last = points[points.length - 1]!;
  const lastBenchmark = lastDefined(points, (p) => p.benchmark);
  const lastReference = lastDefined(points, (p) => p.reference);
  const endLabels = layoutEndLabels(
    [
      { id: "strategy", y: yG(last.strategy) - gTop, text: dollars(last.strategy), color: "hsl(var(--primary))" },
      ...(lastBenchmark ? [{ id: "benchmark", y: yG(lastBenchmark.value) - gTop, text: dollars(lastBenchmark.value), color: "hsl(var(--muted-foreground))" }] : []),
      ...(lastReference ? [{ id: "reference", y: yG(lastReference.value) - gTop, text: dollars(lastReference.value), color: "hsl(var(--foreground) / 0.7)" }] : []),
    ],
    { innerW: plotW, innerH: gBottom - gTop },
  );

  // The in-plot labels at the right edge: the recorded band's, the frozen marker's and each engine
  // change's. Each takes the first row that clears the boxes placed before it (chart-labels.ts).
  const taken: LabelBox[] = [];
  let recordedLabel: PlacedLabel | null = null;
  if (band) {
    recordedLabel = placeLabel(recordedSinceLabel(recordedFrom), band.x + band.width - 6, "end", gTop + 12, CHART_LABEL_ROW_PX, gTop + 12, taken);
    taken.push(recordedLabel.box);
  }
  if (frozenX !== null) taken.push(labelBox(frozenLabel(liveFrom), frozenX - 6, gBottom - 6, "end"));
  const engineLabels = marks.map((mark) => {
    const nearEdge = mark.x > width - right - 120;
    const placed = placeLabel(
      engineChangeLabel(mark.engineVersion, mark.firstSession),
      nearEdge ? mark.x - 4 : mark.x + 4,
      nearEdge ? "end" : "start",
      gTop + 24,
      CHART_LABEL_ROW_PX,
      gBottom - 12,
      taken,
    );
    taken.push(placed.box);
    return placed;
  });

  const bands = coverageBands(coverageMonthly, points);
  const yearLabels = windowIsUnderYear(windowFrom, windowTo) ? monthTicks(points) : yearTicks(points);
  const step = growthStep.length > 1 ? growthStep[1]! - growthStep[0]! : 1000;
  // The reference's line runs to reference_to (item 9); the legend names that session unless it is the last.
  const refToEnd = Boolean(referenceTo) && referenceTo === last.date;

  return (
    <figure className="m-0 space-y-2">
      <figcaption className="sr-only">{growthSummary(points, windowFrom, windowTo)}</figcaption>
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
            <span>
              {referenceName}
              {refToEnd || !referenceTo ? "" : `, to ${shortDate(referenceTo)}`}
            </span>
            <span className="tabular-nums text-muted-foreground">{dollars(lastReference.value)}</span>
          </li>
        ) : null}
        <li className="text-muted-foreground">Base A$100,000</li>
      </ul>
      <svg
        role="img"
        aria-label={`${label}: ${windowLabel}, with drawdown and monthly coverage beneath`}
        width={width}
        height={height}
        className="block font-mono text-[11px] tabular-nums"
        data-backtest-chart
      >
        <text x={LEFT} y={gTop - 2} className="fill-muted-foreground" fontSize={11}>Growth</text>
        {growthStep.map((v) => (
          <g key={`g-${v}`}>
            <line x1={LEFT} x2={width - right} y1={yG(v)} y2={yG(v)} stroke="hsl(var(--border))" strokeDasharray="2 3" />
            <text x={LEFT - 6} y={yG(v) + 4} textAnchor="end" fill="hsl(var(--muted-foreground))">{axisMoney(v, step)}</text>
          </g>
        ))}

        {band ? (
          <g data-recorded-band>
            <rect x={band.x} y={gTop} width={band.width} height={cBottom - gTop} fill="hsl(var(--muted-foreground) / 0.08)" />
            <text x={recordedLabel?.x ?? 0} y={recordedLabel?.y ?? gTop + 12} textAnchor="end" fill="hsl(var(--muted-foreground))">
              {recordedSinceLabel(recordedFrom)}
            </text>
          </g>
        ) : null}

        {marks.map((mark, i) => {
          const placed = engineLabels[i]!;
          return (
            <g key={`engine-${mark.firstSession}`} data-engine-mark={mark.engineVersion}>
              <line x1={mark.x} x2={mark.x} y1={gTop} y2={cBottom} stroke="hsl(var(--foreground) / 0.6)" strokeWidth={1} />
              <text x={placed.x} y={placed.y} textAnchor={placed.anchor} fill="hsl(var(--foreground) / 0.8)" data-engine-label>
                {engineChangeLabel(mark.engineVersion, mark.firstSession)}
              </text>
            </g>
          );
        })}

        {frozenX !== null ? (
          <g data-frozen-marker>
            <line x1={frozenX} x2={frozenX} y1={gTop} y2={cBottom} stroke="hsl(var(--foreground) / 0.5)" strokeDasharray="4 3" />
            <text x={frozenX - 6} y={gBottom - 6} textAnchor="end" fill="hsl(var(--foreground) / 0.8)">{frozenLabel(liveFrom)}</text>
          </g>
        ) : null}

        {referencePath ? (
          <path d={referencePath} fill="none" stroke="hsl(var(--foreground) / 0.7)" strokeWidth={1.25} strokeDasharray="1 3" data-series="reference" />
        ) : null}
        {benchmarkPath ? (
          <path d={benchmarkPath} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={1.25} strokeDasharray="5 4" data-series="benchmark" />
        ) : null}
        <path d={strategyPath} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.75} strokeLinejoin="round" data-series="strategy" />

        {phone
          ? null
          : endLabels.map((l) => (
              <text key={l.id} x={width - right + 6} y={l.y + gTop} fill={l.color} fontWeight={l.id === "strategy" ? 600 : 400} data-end-label={l.id}>
                {l.text}
              </text>
            ))}

        {/* drawdown panel on the same time scale; its callout is the window's summary figure */}
        <text x={LEFT} y={dTop - 4} fill="hsl(var(--muted-foreground))" fontSize={11}>Drawdown (strategy)</text>
        <line x1={LEFT} x2={width - right} y1={yD(0)} y2={yD(0)} stroke="hsl(var(--border))" />
        {niceTicks(ddDomain[0], ddDomain[1], 3).map((v) => (
          <text key={`d-${v}`} x={LEFT - 6} y={yD(v) + 4} textAnchor="end" fill="hsl(var(--muted-foreground))">{axisPercent(v)}</text>
        ))}
        <path d={ddPath} fill={drawdownFill()} data-series="drawdown" />
        <path d={ddLine} fill="none" stroke={drawdownStroke()} strokeWidth={1} data-series="drawdown-line" />
        {calloutX !== null ? (
          <g data-trough data-callout-pct={maxDrawdownPct}>
            <circle cx={calloutX} cy={yD(maxDrawdownPct)} r={2.5} fill="hsl(var(--foreground))" />
            <text x={calloutX + 6} y={yD(maxDrawdownPct) + 4} fill="hsl(var(--foreground))">{formatSigned(maxDrawdownPct, "%")}</text>
          </g>
        ) : null}

        {/* monthly coverage, inside the chart, each month across its dates; hatched under 80% */}
        <text x={LEFT} y={cTop - 3} fill="hsl(var(--muted-foreground))" fontSize={11}>{coverageLabel}, monthly</text>
        {bands.map((b) => {
          const bx = x(b.t0);
          const bw = Math.max(1, x(b.t1) - bx - 0.5);
          const hatched = b.coveragePct !== null && b.coveragePct < 80;
          return (
            <g key={b.month} data-coverage-month={b.month} data-hatched={hatched ? "" : undefined}>
              <rect x={bx} y={cTop} width={bw} height={cBottom - cTop} fill="hsl(var(--muted))" />
              {b.coveragePct !== null ? (
                <rect x={bx} y={cTop + (cBottom - cTop) * (1 - b.coveragePct / 100)} width={bw} height={(cBottom - cTop) * (b.coveragePct / 100)} className={hatched ? "hatch-bar" : undefined} fill={hatched ? undefined : "hsl(var(--muted-foreground) / 0.6)"} />
              ) : null}
            </g>
          );
        })}

        {yearLabels.map((tick) => (
          <g key={`y-${tick.label}`}>
            <line x1={x(tick.t)} x2={x(tick.t)} y1={cBottom} y2={cBottom + 4} stroke="hsl(var(--border))" />
            <text x={x(tick.t)} y={cBottom + 16} textAnchor="middle" fill="hsl(var(--muted-foreground))">{tick.label}</text>
          </g>
        ))}
      </svg>
      <p className="font-mono text-[11px] text-muted-foreground">
        Drawdown is measured from the window&rsquo;s own peak, on the same time axis.
      </p>
    </figure>
  );
}

const DAYS_IN_YEAR = 366;
function windowIsUnderYear(from: string, to: string): boolean {
  const a = dateToMs(from);
  const b = dateToMs(to);
  return Number.isFinite(a) && Number.isFinite(b) && b - a < DAYS_IN_YEAR * 86_400_000;
}

/** The last point, read from the end, whose value is defined. */
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
