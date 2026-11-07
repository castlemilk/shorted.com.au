import {
  areaPath,
  growthOf,
  linePath,
  paddedDomain,
  recordedBand,
  timeScale,
  troughOf,
  valueScale,
  yearTicks,
  niceTicks,
  dateToMs,
  type PlotBox,
} from "@/lib/strategies/backtest-series";
import type { SeriesPointView } from "@/lib/strategies/map-backtest";
import { drawdownFill, drawdownStroke } from "@/lib/strategies/returns-scale";
import {
  GROWTH_TITLE,
  frozenLabel,
  growthSummary,
  recordedSinceLabel,
} from "@/lib/strategies/backtest-copy";
import { formatSigned } from "@/lib/strategies/format";

export interface BacktestChartProps {
  /** The window's weekly (or daily) series, oldest first, as the API serves it. */
  series: readonly SeriesPointView[];
  /** The window's name, read in the chart's summary. */
  windowLabel: string;
  /** YYYY-MM-DD: the session the rules froze. "" when not frozen yet. */
  liveFrom: string;
  /** The benchmark's name for the legend, e.g. "S&P/ASX 200 Gross TR (XJT)". */
  benchmarkName: string;
  /** The same-data reference's name, when the run has one. */
  referenceName: string;
  /** Whether the window carries a reference series at all (the API's flag, via the run). */
  hasReference: boolean;
  /** The chart's accessible name. */
  label: string;
}

const WIDTH = 720;
const BOX: PlotBox = { width: WIDTH, height: 0, left: 58, right: 104, top: 12, bottom: 0 };
const GROWTH_TOP = 12;
const GROWTH_BOTTOM = 246;
const DD_TOP = 268;
const DD_BOTTOM = 352;
const AXIS_Y = 378;
const HEIGHT = 390;

const MONEY_FORMAT = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });

/** A dollar figure on the axis: "$80k" for a thousand and over, otherwise whole dollars. */
export function axisMoney(value: number): string {
  if (Math.abs(value) >= 1000) return `$${Math.round(value / 1000)}k`;
  return `$${MONEY_FORMAT.format(Math.round(value))}`;
}

/** A drawdown tick: "0%", "−5%". */
export function axisPercent(value: number): string {
  if (value === 0) return "0%";
  return `${value < 0 ? "−" : ""}${Math.abs(value)}%`;
}

/**
 * The growth of A$100,000 against the benchmark, with the drawdown beneath it on
 * the same time axis (design 1.5, 10.6). A server-rendered SVG: no script, no
 * state. The loader makes it client-only so the heavy path string is not part of
 * the first HTML.
 */
export function BacktestChart({
  series,
  windowLabel,
  liveFrom,
  benchmarkName,
  referenceName,
  hasReference,
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

  const x = timeScale(points, { ...BOX, height: HEIGHT });
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
  const band = recordedBand(points, x, { ...BOX, height: HEIGHT });
  const trough = troughOf(points);
  const frozenT = liveFrom ? dateToMs(liveFrom) : Number.NaN;
  const frozenX =
    Number.isFinite(frozenT) && frozenT > points[0]!.t && frozenT <= points[points.length - 1]!.t
      ? x(frozenT)
      : null;
  const last = points[points.length - 1]!;
  const endStrategy = yG(last.strategy);
  const endBenchmark = last.benchmark !== null ? yG(last.benchmark) : null;
  const endReference = last.reference !== null ? yG(last.reference) : null;
  const right = WIDTH - BOX.right + 6;

  return (
    <figure className="m-0 space-y-2">
      <figcaption className="sr-only">{growthSummary(points, series[0]?.date ?? "", last.date)}</figcaption>
      <ChartLegend
        windowLabel={windowLabel}
        benchmarkName={benchmarkName}
        referenceName={referenceName}
        hasReference={hasReference}
        strategy={last.strategy}
        benchmark={last.benchmark}
        reference={last.reference}
      />
      <svg
        role="img"
        aria-label={`${label}: ${GROWTH_TITLE}, ${windowLabel}, with drawdown beneath`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-auto w-full overflow-visible font-mono text-[10px] tabular-nums"
        data-backtest-chart
      >
        {/* growth grid and value axis */}
        {niceTicks(growthDomain[0], growthDomain[1], 4).map((v) => (
          <g key={`g-${v}`}>
            <line
              x1={BOX.left}
              x2={WIDTH - BOX.right}
              y1={yG(v)}
              y2={yG(v)}
              stroke="hsl(var(--border))"
              strokeDasharray="2 3"
            />
            <text x={BOX.left - 6} y={yG(v) + 3} textAnchor="end" fill="hsl(var(--muted-foreground))">
              {axisMoney(v)}
            </text>
          </g>
        ))}

        {/* recorded span: the paper track, recorded and not recomputed (light neutral tone) */}
        {band ? (
          <g data-recorded-band>
            <rect
              x={band.x}
              y={GROWTH_TOP}
              width={band.width}
              height={DD_BOTTOM - GROWTH_TOP}
              fill="hsl(var(--muted-foreground) / 0.08)"
            />
            <text
              x={band.x + band.width - 6}
              y={GROWTH_TOP + 12}
              textAnchor="end"
              fill="hsl(var(--muted-foreground))"
            >
              {recordedSinceLabel(liveFrom)}
            </text>
          </g>
        ) : null}

        {/* frozen marker */}
        {frozenX !== null ? (
          <g data-frozen-marker>
            <line
              x1={frozenX}
              x2={frozenX}
              y1={GROWTH_TOP}
              y2={DD_BOTTOM}
              stroke="hsl(var(--foreground) / 0.5)"
              strokeDasharray="4 3"
            />
            <text x={frozenX - 6} y={GROWTH_BOTTOM - 6} textAnchor="end" fill="hsl(var(--foreground) / 0.8)">
              {frozenLabel(liveFrom)}
            </text>
          </g>
        ) : null}

        {/* the lines: reference dotted, XJT dashed, the strategy solid */}
        {referencePath ? (
          <path d={referencePath} fill="none" stroke="hsl(var(--foreground) / 0.7)" strokeWidth={1.25} strokeDasharray="1 3" data-series="reference" />
        ) : null}
        {benchmarkPath ? (
          <path d={benchmarkPath} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={1.25} strokeDasharray="5 4" data-series="benchmark" />
        ) : null}
        <path d={strategyPath} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.75} strokeLinejoin="round" data-series="strategy" />

        {/* end labels, the benchmark's nudged clear of the strategy's */}
        <text x={right} y={endStrategy + 3} fill="hsl(var(--primary))" fontWeight={600}>
          {`A$${Math.round(last.strategy).toLocaleString("en-AU")}`}
        </text>
        {endBenchmark !== null ? (
          <text
            x={right}
            y={endBenchmark + (endBenchmark !== null && Math.abs(endBenchmark - endStrategy) < 12 ? 14 : 3)}
            fill="hsl(var(--muted-foreground))"
          >
            {`A$${Math.round(last.benchmark ?? 0).toLocaleString("en-AU")}`}
          </text>
        ) : null}
        {endReference !== null && hasReference ? (
          <text x={right} y={endReference + 3} fill="hsl(var(--foreground) / 0.7)">
            {`A$${Math.round(last.reference ?? 0).toLocaleString("en-AU")}`}
          </text>
        ) : null}

        {/* drawdown panel, same x */}
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
            <text
              x={x(trough.t) + 6}
              y={yD(trough.drawdownPct) + 4}
              fill="hsl(var(--foreground))"
            >
              {formatSigned(trough.drawdownPct, "%")}
            </text>
          </g>
        ) : null}

        {/* time axis: each 1 January, and the window's last session */}
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

/** The legend: the strategy and each line's last figure, as text the screen reader reads too. */
function ChartLegend({
  windowLabel,
  benchmarkName,
  referenceName,
  hasReference,
  strategy,
  benchmark,
  reference,
}: {
  windowLabel: string;
  benchmarkName: string;
  referenceName: string;
  hasReference: boolean;
  strategy: number;
  benchmark: number | null;
  reference: number | null;
}) {
  const money = (v: number) => `A$${Math.round(v).toLocaleString("en-AU")}`;
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs" aria-label={`Lines in ${windowLabel}`}>
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block h-0.5 w-6 bg-primary" />
        <span>Strategy</span>
        <span className="tabular-nums text-muted-foreground">{money(strategy)}</span>
      </li>
      {benchmark !== null ? (
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block w-6 border-t border-dashed border-muted-foreground" />
          <span>{benchmarkName}</span>
          <span className="tabular-nums text-muted-foreground">{money(benchmark)}</span>
        </li>
      ) : null}
      {hasReference && reference !== null ? (
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block w-6 border-t border-dotted border-foreground/70" />
          <span>{referenceName}</span>
          <span className="tabular-nums text-muted-foreground">{money(reference)}</span>
        </li>
      ) : null}
      <li className="text-muted-foreground">Base A$100,000</li>
    </ul>
  );
}

