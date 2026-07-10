"use client";

import { useCallback, useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, Bar, Line, LinePath } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";

import {
  AMBER,
  AXIS_LINE,
  AXIS_TEXT,
  TOOLTIP_STYLE,
} from "~/@/components/features/housing/charts/chart-theme";

const MARGIN = { top: 14, right: 12, bottom: 26, left: 40 };
const HEIGHT = 260;

export type CrowdingChartMode = "level" | "momentum" | "zscore";

/** One render-ready point in the active view's units. */
export interface CrowdingChartPoint {
  /** ISO date of the weekly bucket (Monday). */
  date: string;
  /** Center-line value; null when the view's math has no history yet. */
  value: number | null;
  /** Dispersion band (level view only). */
  bandLo?: number;
  bandHi?: number;
  /** Smoothing overlay value (level view only). */
  overlay?: number | null;
  /** Number of constituents contributing to the bucket. */
  constituents: number;
}

function signed(value: number, suffix: string): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function formatValue(mode: CrowdingChartMode, value: number): string {
  if (mode === "momentum") return signed(value, "pp");
  if (mode === "zscore") return signed(value, "σ");
  return `${value.toFixed(2)}%`;
}

function formatTick(mode: CrowdingChartMode, value: number): string {
  if (mode === "momentum") return `${value > 0 ? "+" : ""}${value}pp`;
  if (mode === "zscore") return `${value > 0 ? "+" : ""}${value}σ`;
  return `${value}%`;
}

function formatTickDate(date: Date): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function ChartInner({
  width,
  points,
  industryName,
  mode,
  centerLabel,
  bandLabel,
  overlayLabel,
}: {
  width: number;
  points: CrowdingChartPoint[];
  industryName: string;
  mode: CrowdingChartMode;
  centerLabel: string;
  bandLabel: string | null;
  overlayLabel: string | null;
}) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<CrowdingChartPoint>();

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const small = width < 480;

  const dates = useMemo(
    () => points.map((p) => new Date(`${p.date}T00:00:00Z`).getTime()),
    [points],
  );

  const xScale = useMemo(
    () =>
      scaleTime({
        domain: [new Date(dates[0]!), new Date(dates[dates.length - 1]!)],
        range: [0, innerWidth],
      }),
    [dates, innerWidth],
  );

  const hasBand = mode === "level" && points.some((p) => p.bandHi != null);
  const yDomain = useMemo<[number, number]>(() => {
    if (mode === "level") {
      const highs = points.map((p) =>
        Math.max(p.bandHi ?? 0, p.value ?? 0, p.overlay ?? 0),
      );
      return [0, Math.max(...highs, 1) * 1.1];
    }
    // Momentum / z-score oscillate around zero: pad the extremes and always
    // include the zero line in the domain.
    const values = points
      .map((p) => p.value)
      .filter((v): v is number => v != null);
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const pad = Math.max((hi - lo) * 0.12, 0.1);
    return [lo - pad, hi + pad];
  }, [mode, points]);

  const yScale = useMemo(
    () =>
      scaleLinear({ domain: yDomain, range: [innerHeight, 0], nice: true }),
    [innerHeight, yDomain],
  );

  // Zero line for oscillators; ±1σ guides for the z-score view.
  const referenceLines = useMemo(() => {
    if (mode === "momentum") return [0];
    if (mode === "zscore") return [0, 1, -1];
    return [];
  }, [mode]);

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const p = localPoint(event);
      if (!p) return;
      const x = p.x - MARGIN.left;
      const t = xScale.invert(x).getTime();
      let best = points[0]!;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const dist = Math.abs(dates[i]! - t);
        if (dist < bestD) {
          bestD = dist;
          best = points[i]!;
        }
      }
      showTooltip({
        tooltipData: best,
        tooltipLeft: xScale(new Date(`${best.date}T00:00:00Z`)) + MARGIN.left,
        tooltipTop:
          yScale(best.value ?? (yDomain[0] + yDomain[1]) / 2) + MARGIN.top,
      });
    },
    [dates, points, showTooltip, xScale, yDomain, yScale],
  );

  if (innerWidth <= 0) return null;

  const xOf = (d: CrowdingChartPoint) => xScale(new Date(`${d.date}T00:00:00Z`));
  const ariaLabel =
    mode === "level"
      ? `Weekly ${centerLabel.toLowerCase()} short interest for ${industryName}${bandLabel ? ` with a ${bandLabel} dispersion band` : ""}, from ${points[0]!.date} to ${points[points.length - 1]!.date}`
      : mode === "momentum"
        ? `Four-week change in ${industryName} short-interest ${centerLabel.toLowerCase()}, in percentage points`
        : `${industryName} short-interest ${centerLabel.toLowerCase()} z-score against its trailing 26-week distribution`;

  return (
    <div className="relative" style={{ width, height: HEIGHT }}>
      <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
        <LinearGradient
          id="crowding-band-grad"
          from={AMBER}
          fromOpacity={0.16}
          to={AMBER}
          toOpacity={0.04}
        />
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {hasBand ? (
            <AreaClosed<CrowdingChartPoint>
              data={points}
              x={xOf}
              y0={(d) => yScale(d.bandLo ?? 0)}
              y1={(d) => yScale(d.bandHi ?? 0)}
              defined={(d) => d.bandLo != null && d.bandHi != null}
              yScale={yScale}
              curve={curveMonotoneX}
              fill="url(#crowding-band-grad)"
            />
          ) : null}

          {referenceLines.map((ref) =>
            ref >= yDomain[0] && ref <= yDomain[1] ? (
              <Line
                key={`ref-${ref}`}
                from={{ x: 0, y: yScale(ref) }}
                to={{ x: innerWidth, y: yScale(ref) }}
                stroke={AXIS_LINE}
                strokeWidth={1}
                strokeDasharray={ref === 0 ? undefined : "3,3"}
                opacity={ref === 0 ? 0.8 : 0.5}
                pointerEvents="none"
              />
            ) : null,
          )}

          <LinePath<CrowdingChartPoint>
            data={points}
            x={xOf}
            y={(d) => yScale(d.value ?? 0)}
            defined={(d) => d.value != null}
            curve={curveMonotoneX}
            stroke={AMBER}
            strokeWidth={2}
          />

          {mode === "level" && points.some((p) => p.overlay != null) ? (
            <LinePath<CrowdingChartPoint>
              data={points}
              x={xOf}
              y={(d) => yScale(d.overlay ?? 0)}
              defined={(d) => d.overlay != null}
              curve={curveMonotoneX}
              stroke={AMBER}
              strokeWidth={1.5}
              strokeDasharray="5,4"
              opacity={0.75}
            />
          ) : null}

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={small ? 3 : 6}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => formatTickDate(v as Date)}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "middle",
            })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => formatTick(mode, Number(v))}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 9,
              textAnchor: "end",
              dx: "-0.25em",
              dy: "0.3em",
            })}
          />

          {tooltipOpen && tooltipData ? (
            <>
              <Line
                from={{ x: xOf(tooltipData), y: 0 }}
                to={{ x: xOf(tooltipData), y: innerHeight }}
                stroke={AXIS_TEXT}
                strokeWidth={1}
                opacity={0.4}
                pointerEvents="none"
              />
              {tooltipData.value != null ? (
                <circle
                  cx={xOf(tooltipData)}
                  cy={yScale(tooltipData.value)}
                  r={3.5}
                  fill={AMBER}
                  pointerEvents="none"
                />
              ) : null}
            </>
          ) : null}

          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMove}
            onTouchMove={handleMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>

      {tooltipOpen && tooltipData ? (
        <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={TOOLTIP_STYLE}>
          <div className="font-mono font-semibold">
            Week of {tooltipData.date}
          </div>
          <div>
            <span style={{ color: AMBER }}>{centerLabel}</span>{" "}
            <span className="font-mono tabular-nums">
              {tooltipData.value != null
                ? formatValue(mode, tooltipData.value)
                : "—"}
            </span>
          </div>
          {mode === "level" && bandLabel && tooltipData.bandLo != null && tooltipData.bandHi != null ? (
            <div className="text-muted-foreground">
              {bandLabel}{" "}
              <span className="font-mono tabular-nums">
                {formatValue(mode, tooltipData.bandLo)} –{" "}
                {formatValue(mode, tooltipData.bandHi)}
              </span>
            </div>
          ) : null}
          {mode === "level" && overlayLabel && tooltipData.overlay != null ? (
            <div className="text-muted-foreground">
              {overlayLabel}{" "}
              <span className="font-mono tabular-nums">
                {formatValue(mode, tooltipData.overlay)}
              </span>
            </div>
          ) : null}
          <div className="text-muted-foreground">
            {tooltipData.constituents} stocks
          </div>
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

/**
 * Weekly short-interest crowding for one industry. Level view renders the
 * chosen center (mean/median) with a dispersion band and optional SMA
 * overlay; momentum and z-score views render oscillators around a zero
 * reference. All statistics are precomputed by the caller — this component
 * only draws.
 */
export function IndustryCrowdingChart({
  points,
  industryName,
  mode = "level",
  centerLabel = "Average",
  bandLabel = "p10–p90",
  overlayLabel = null,
}: {
  points: CrowdingChartPoint[];
  industryName: string;
  mode?: CrowdingChartMode;
  centerLabel?: string;
  bandLabel?: string | null;
  overlayLabel?: string | null;
}) {
  if (points.filter((p) => p.value != null).length < 3) return null;
  return (
    <ParentSize className="min-w-0">
      {({ width }) =>
        width > 0 ? (
          <ChartInner
            width={width}
            points={points}
            industryName={industryName}
            mode={mode}
            centerLabel={centerLabel}
            bandLabel={bandLabel}
            overlayLabel={overlayLabel}
          />
        ) : null
      }
    </ParentSize>
  );
}
