import React from "react";
import { LinePath, AreaClosed, Line } from "@visx/shape";
import { LinearGradient } from "@visx/gradient";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { curveLinear } from "@visx/curve";
import { chartTheme } from "./chart-theme";
import type { ChartPoint, ChartSeriesSpec } from "./types";
import type { ChartScales } from "./use-chart-scales";

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

export const Axes = React.memo(function Axes({
  xScale,
  leftScale,
  rightScale,
  innerW,
  innerH,
  hasRight,
  leftFormat,
  rightFormat,
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
  compact?: boolean;
}) {
  return (
    <g pointerEvents="none">
      <AxisBottom
        top={innerH}
        scale={xScale}
        numTicks={compact ? 3 : 5}
        stroke={chartTheme.axis}
        tickStroke={chartTheme.axis}
        tickLabelProps={() => ({
          fill: chartTheme.axisLabel,
          fontSize: compact ? 9 : 10,
          textAnchor: "middle" as const,
        })}
      />
      <AxisLeft
        scale={leftScale}
        numTicks={compact ? 3 : 4}
        stroke={chartTheme.axis}
        tickStroke={chartTheme.axis}
        tickFormat={leftFormat ? (v) => leftFormat(Number(v)) : undefined}
        tickLabelProps={() => ({
          fill: chartTheme.axisLabel,
          fontSize: compact ? 9 : 10,
          textAnchor: "end" as const,
          dx: -2,
          dy: 3,
        })}
      />
      {hasRight && (
        <AxisRight
          left={innerW}
          scale={rightScale}
          numTicks={compact ? 3 : 4}
          stroke={chartTheme.axis}
          tickStroke={chartTheme.axis}
          tickFormat={rightFormat ? (v) => rightFormat(Number(v)) : undefined}
          tickLabelProps={() => ({
            fill: chartTheme.axisLabel,
            fontSize: compact ? 9 : 10,
            textAnchor: "start" as const,
            dx: 2,
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

/** Single AreaClosed for volume (replaces the per-point <Bar> map). */
export const VolumePath = React.memo(function VolumePath({
  data,
  xScale,
  yScale,
}: {
  data: ChartPoint[];
  xScale: TimeScale;
  yScale: LinearScale;
}) {
  if (!data.length) return null;
  return (
    <g data-chart="volume" pointerEvents="none">
      <AreaClosed<ChartPoint>
        data={data}
        x={sx(xScale)}
        y={sy(yScale)}
        yScale={yScale}
        fill={chartTheme.volume}
        fillOpacity={chartTheme.volumeOpacity}
        stroke="none"
        curve={curveLinear}
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
