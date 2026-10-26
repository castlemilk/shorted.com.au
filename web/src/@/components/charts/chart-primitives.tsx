import React from "react";
import { LinePath, AreaClosed, Line } from "@visx/shape";
import { LinearGradient } from "@visx/gradient";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { curveLinear } from "@visx/curve";
import { chartTheme } from "./chart-theme";
import {
  AXIS_FONT_PX,
  AXIS_LABEL_DX_PX,
  AXIS_NUM_TICKS,
  AXIS_TICK_PX,
} from "./axis-margin";
import type { ChartPoint, ChartSeriesSpec } from "./types";
import type { ChartScales } from "./use-chart-scales";
import { volumeBarsPath } from "./volume-bars";

type TimeScale = ChartScales["dateScale"];
type LinearScale = ChartScales["leftScale"];

const sx = (xScale: TimeScale) => (d: ChartPoint) => xScale(new Date(d.t)) ?? 0;
const sy = (yScale: LinearScale) => (d: ChartPoint) => yScale(d.v) ?? 0;

// Primitives are React.memo'd: on pointer-move StockChart re-renders, but the
// (memoized) scales/series props are stable, so these heavy path renderers skip
// regenerating their `d` attributes — only the Crosshair (hover-dependent) redraws.

/** Horizontal grid lines off a value scale's ticks (no @visx/grid dependency). */
export const Grid = React.memo(function Grid({
  yScale,
  width,
  ticks = 4,
}: {
  yScale: LinearScale;
  width: number;
  ticks?: number;
}) {
  return (
    <g pointerEvents="none">
      {yScale.ticks(ticks).map((t) => (
        <Line
          key={t}
          from={{ x: 0, y: yScale(t) ?? 0 }}
          to={{ x: width, y: yScale(t) ?? 0 }}
          stroke={chartTheme.grid}
          strokeOpacity={0.5}
          strokeDasharray="2,3"
        />
      ))}
    </g>
  );
});

/** The estimated advance of one character of a time-axis label, in px (10px type, mixed case). */
const TIME_LABEL_CHAR_PX = 6.5;
/** The clear space kept between two time-axis labels. */
const TIME_LABEL_GAP_PX = 12;

/**
 * The time ticks an axis draws. d3 asks for a count and ignores the width, so the ticks are
 * thinned until neighbours keep a gap. The gap is 64px (48 compact). A caller whose labels
 * are long passes `labelChars`, the longest label in characters, and the gap becomes that
 * label's estimated width: a long label then never sits touching the next.
 */
export function timeTickValues(
  xScale: TimeScale,
  innerW: number,
  opts: { compact?: boolean; labelChars?: number } = {},
): Date[] {
  const raw = xScale.ticks(opts.compact ? 3 : 5);
  if (raw.length < 2 || innerW <= 0) return raw;
  if (opts.labelChars !== undefined) {
    // Each tick is kept only when it is clear of the last one kept by the label's width. The
    // gaps are measured, not assumed even: a 31-day month is wider in px than a 28-day one.
    const minGap = Math.ceil(opts.labelChars * TIME_LABEL_CHAR_PX + TIME_LABEL_GAP_PX);
    const kept: Date[] = [];
    let lastX = -Infinity;
    for (const tick of raw) {
      const x = xScale(tick) ?? 0;
      if (x - lastX >= minGap) {
        kept.push(tick);
        lastX = x;
      }
    }
    return kept;
  }
  // The stock chart's ticks, unchanged: the spacing is the average gap, and the step is whole ticks.
  const minGap = opts.compact ? 48 : 64;
  const spacing = innerW / (raw.length - 1);
  const step = Math.max(1, Math.ceil(minGap / spacing));
  return step === 1 ? raw : raw.filter((_, i) => i % step === 0);
}

export const Axes = React.memo(function Axes({
  xScale,
  leftScale,
  rightScale,
  innerW,
  innerH,
  hasRight,
  leftFormat,
  rightFormat,
  timeFormat,
  timeLabelChars,
  compact,
}: {
  xScale: TimeScale;
  leftScale: LinearScale;
  rightScale: LinearScale;
  innerW: number;
  innerH: number;
  hasRight: boolean;
  leftFormat?: (v: number) => string;
  rightFormat?: (v: number) => string;
  /**
   * The label of each time tick, given the ticks the axis draws (so a thinned axis can
   * compare each with the one before it). Unset, the scale's own format is used.
   */
  timeFormat?: (value: Date, index: number, ticks: readonly Date[]) => string;
  /** The longest time label, in characters, so the ticks are thinned to fit it. See timeTickValues. */
  timeLabelChars?: number;
  compact?: boolean;
}) {
  // `numTicks` is only a hint to d3: a two-month domain asked for 5 ticks gets
  // every week (9 labels), which on a phone-width plot (~330px) collide into
  // "Apr 05Apr 12Apr 19…". Thin the generated ticks so neighbouring labels
  // keep at least `minGap` px — at desktop widths nothing is dropped.
  const xTickValues = timeTickValues(xScale, innerW, { compact, labelChars: timeLabelChars });
  return (
    <g pointerEvents="none">
      <AxisBottom
        top={innerH}
        scale={xScale}
        tickValues={xTickValues}
        tickFormat={
          timeFormat
            ? (value, index, values) =>
                timeFormat(
                  new Date(value.valueOf()),
                  index,
                  values.map((tick) => new Date(tick.value.valueOf())),
                )
            : undefined
        }
        stroke={chartTheme.axis}
        tickStroke={chartTheme.axis}
        tickLabelProps={() => ({
          fill: chartTheme.axisLabel,
          fontSize: compact ? 9 : AXIS_FONT_PX,
          textAnchor: "middle" as const,
        })}
      />
      <AxisLeft
        scale={leftScale}
        numTicks={compact ? 3 : AXIS_NUM_TICKS}
        tickLength={AXIS_TICK_PX}
        stroke={chartTheme.axis}
        tickStroke={chartTheme.axis}
        tickFormat={leftFormat ? (v) => leftFormat(Number(v)) : undefined}
        tickLabelProps={() => ({
          fill: chartTheme.axisLabel,
          fontSize: compact ? 9 : AXIS_FONT_PX,
          textAnchor: "end" as const,
          dx: -AXIS_LABEL_DX_PX,
          dy: 3,
        })}
      />
      {hasRight && (
        <AxisRight
          left={innerW}
          scale={rightScale}
          numTicks={compact ? 3 : AXIS_NUM_TICKS}
          tickLength={AXIS_TICK_PX}
          stroke={chartTheme.axis}
          tickStroke={chartTheme.axis}
          tickFormat={rightFormat ? (v) => rightFormat(Number(v)) : undefined}
          tickLabelProps={() => ({
            fill: chartTheme.axisLabel,
            fontSize: compact ? 9 : AXIS_FONT_PX,
            textAnchor: "start" as const,
            dx: AXIS_LABEL_DX_PX,
            dy: 3,
          })}
        />
      )}
    </g>
  );
});

/**
 * Make a string safe to use as an SVG id referenced by `url(#id)`.
 *
 * Anything outside [A-Za-z0-9_-] is replaced. A leading digit is prefixed,
 * because an id starting with a digit is not a valid CSS identifier either.
 */
export function svgRefId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-");
  return /^[0-9-]/.test(cleaned) ? `id-${cleaned}` : cleaned;
}

/** One path per series (line, or area+gradient). Never per-point nodes. */
export const SeriesPath = React.memo(function SeriesPath({
  series,
  xScale,
  yScale,
  gradientId,
}: {
  series: ChartSeriesSpec;
  xScale: TimeScale;
  yScale: LinearScale;
  gradientId: string;
}) {
  if (!series.points.length) return null;
  const x = sx(xScale);
  const y = sy(yScale);
  // Sanitised at the point of USE, so every caller is covered by one fix.
  // Callers build ids out of domain identifiers, and a suburb's region code is
  // "SUBURB:NSW-BONDI BEACH" — the colon and the space both terminate the
  // reference inside url(#…), so the fill silently resolves to rgb(0,0,0) and
  // the area renders as a solid black slab. Shipped that way on every priced
  // suburb page until it was caught on production.
  const safeGradientId = svgRefId(gradientId);
  return (
    <g data-series={series.id}>
      {series.kind === "area" && (
        <>
          <LinearGradient
            id={safeGradientId}
            from={series.color}
            to={series.color}
            fromOpacity={0.28}
            toOpacity={0.02}
          />
          <AreaClosed<ChartPoint>
            data={series.points}
            x={x}
            y={y}
            yScale={yScale}
            fill={`url(#${safeGradientId})`}
            stroke="none"
            curve={curveLinear}
          />
        </>
      )}
      <LinePath<ChartPoint>
        data={series.points}
        x={x}
        y={y}
        stroke={series.color}
        strokeWidth={1.75}
        curve={curveLinear}
      />
    </g>
  );
});

/**
 * Volume as a bar per session, all of them ONE path (volume-bars.ts), never a
 * node per point. `width` is the plot's, so the end bars stop at its edges.
 */
export const VolumePath = React.memo(function VolumePath({
  data,
  xScale,
  yScale,
  width,
}: {
  data: ChartPoint[];
  xScale: TimeScale;
  yScale: LinearScale;
  width: number;
}) {
  const d = React.useMemo(
    () =>
      volumeBarsPath(data, {
        x: (t) => xScale(new Date(t)) ?? 0,
        y: (v) => yScale(v) ?? 0,
        baseline: yScale(0) ?? 0,
        width,
      }),
    [data, xScale, yScale, width],
  );
  if (!d) return null;
  return (
    <g data-chart="volume" pointerEvents="none">
      <path
        d={d}
        fill={chartTheme.volume}
        fillOpacity={chartTheme.volumeOpacity}
        stroke="none"
      />
    </g>
  );
});

/** Indicator overlay line, index-aligned to the decimated series points. */
export const IndicatorPath = React.memo(function IndicatorPath({
  points,
  values,
  xScale,
  yScale,
  color,
  dash,
}: {
  points: ChartPoint[];
  values: (number | null)[];
  xScale: TimeScale;
  yScale: LinearScale;
  color: string;
  dash?: string;
}) {
  const data: ChartPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) data.push({ t: points[i]!.t, v });
  }
  if (data.length < 2) return null;
  return (
    <LinePath<ChartPoint>
      data={data}
      x={sx(xScale)}
      y={sy(yScale)}
      stroke={color}
      strokeWidth={1.25}
      strokeDasharray={dash}
      opacity={0.9}
      curve={curveLinear}
    />
  );
});

/** Vertical guide + a dot per series at the hovered x. */
export function Crosshair({
  x,
  dots,
  innerH,
}: {
  x: number;
  dots: { y: number; color: string }[];
  innerH: number;
}) {
  return (
    <g pointerEvents="none">
      <Line
        from={{ x, y: 0 }}
        to={{ x, y: innerH }}
        stroke={chartTheme.crosshair}
        strokeOpacity={0.35}
        strokeWidth={1}
        strokeDasharray="3,3"
      />
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={x}
          cy={d.y}
          r={3.5}
          fill={d.color}
          stroke="hsl(var(--background))"
          strokeWidth={1.5}
        />
      ))}
    </g>
  );
}
