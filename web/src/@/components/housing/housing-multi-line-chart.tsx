"use client";

import { useCallback, useMemo } from "react";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { Bar, LinePath } from "@visx/shape";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import { format as formatDate } from "date-fns";
import {
  formatHousingValue,
  type HousingSeriesFormat,
  type HousingSeriesPoint,
} from "./series-data";

export interface HousingMultiLineSeries {
  label: string;
  points: HousingSeriesPoint[];
}

export interface HousingMultiLineChartProps {
  series: HousingMultiLineSeries[];
  ariaLabel: string;
  format: HousingSeriesFormat;
  height?: number;
}

export interface HousingCombinedDomains {
  time: [Date, Date];
  value: [number, number];
}

const SERIES_COLORS = [
  "hsl(var(--primary))",
  "#64748b",
  "hsl(var(--accent))",
] as const;
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const AXIS_LINE = "hsl(var(--border))";
const MARGIN = { top: 10, right: 12, bottom: 24, left: 48 };

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<HousingSeriesPoint, Date>((point) => point.date).left;

/** Returns one union time/value domain shared by every supplied series. */
export function getCombinedDomains(
  series: readonly HousingMultiLineSeries[],
): HousingCombinedDomains | null {
  const points = series.flatMap(({ points }) => points);
  if (points.length === 0) return null;

  const times = points.map(({ date }) => date.getTime());
  const values = points.map(({ value }) => value);

  return {
    time: [new Date(Math.min(...times)), new Date(Math.max(...times))],
    value: [Math.min(...values), Math.max(...values)],
  };
}

function nearestPoint(
  points: HousingSeriesPoint[],
  target: Date,
): HousingSeriesPoint | undefined {
  if (points.length === 0) return undefined;
  const index = bisectDate(points, target, 1);
  const before = points[index - 1];
  const after = points[index];
  if (!before) return after;
  if (!after) return before;
  return target.getTime() - before.date.getTime() >
    after.date.getTime() - target.getTime()
    ? after
    : before;
}

interface HoverState {
  date: Date;
  points: Array<HousingSeriesPoint | undefined>;
}

function ChartInner({
  series,
  ariaLabel,
  format,
  width,
  height,
}: Required<HousingMultiLineChartProps> & { width: number }) {
  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<HoverState>();
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);
  const domains = useMemo(() => getCombinedDomains(series), [series]);

  const xScale = useMemo(
    () =>
      scaleTime({
        domain: domains?.time ?? [new Date(0), new Date(1)],
        range: [0, innerWidth],
      }),
    [domains, innerWidth],
  );
  const yScale = useMemo(() => {
    const domain = domains?.value ?? [0, 1];
    const spread = domain[1] - domain[0];
    const scaleDomain: [number, number] =
      spread === 0
        ? [domain[0] - (Math.abs(domain[0]) * 0.1 || 1), domain[1] + (Math.abs(domain[1]) * 0.1 || 1)]
        : domain;
    return scaleLinear({
      domain: scaleDomain,
      range: [innerHeight, 0],
      nice: true,
    });
  }, [domains, innerHeight]);

  const formatValue = useCallback(
    (value: number) => formatHousingValue(value, format),
    [format],
  );

  const handlePointerMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const pointer = localPoint(event);
      if (!pointer) return;

      const target = xScale.invert(pointer.x - MARGIN.left);
      const points = series.map(({ points }) => nearestPoint(points, target));
      const anchor = points.find((point) => point !== undefined);
      if (!anchor) return;

      showTooltip({
        tooltipData: { date: anchor.date, points },
        tooltipLeft: xScale(anchor.date) + MARGIN.left,
        tooltipTop: yScale(anchor.value) + MARGIN.top,
      });
    },
    [series, showTooltip, xScale, yScale],
  );

  if (!domains || innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {series.map(({ label, points }, index) => (
            <LinePath<HousingSeriesPoint>
              key={label}
              data={points}
              x={(point) => xScale(point.date)}
              y={(point) => yScale(point.value)}
              curve={curveMonotoneX}
              stroke={SERIES_COLORS[index] ?? SERIES_COLORS[0]}
              strokeWidth={1.75}
            />
          ))}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={width > 480 ? 6 : 4}
            stroke={AXIS_LINE}
            hideTicks
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "middle" as const,
            })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(value) => formatValue(Number(value))}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "end" as const,
              dx: "-0.25em",
              dy: "0.3em",
            })}
          />
          {tooltipOpen &&
            tooltipData?.points.map((point, index) =>
              point ? (
                <circle
                  key={series[index]?.label}
                  cx={xScale(point.date)}
                  cy={yScale(point.value)}
                  r={3}
                  fill={SERIES_COLORS[index] ?? SERIES_COLORS[0]}
                  pointerEvents="none"
                />
              ) : null,
            )}
          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handlePointerMove}
            onTouchMove={handlePointerMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData ? (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          className="pointer-events-none"
          style={{
            position: "absolute",
            backgroundColor: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 11,
          }}
        >
          <div className="mb-1 text-muted-foreground">
            {formatDate(tooltipData.date, "MMM yyyy")}
          </div>
          {series.map(({ label }, index) => {
            const point = tooltipData.points[index];
            return (
              <div key={label} className="mt-0.5 flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: SERIES_COLORS[index] ?? SERIES_COLORS[0],
                  }}
                />
                <span className="text-muted-foreground">{label}</span>
                <span className="ml-auto font-mono">
                  {point ? formatValue(point.value) : "—"}
                </span>
              </div>
            );
          })}
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <svg width={16} height={8} aria-hidden>
        <line x1={0} y1={4} x2={16} y2={4} stroke={color} strokeWidth={2} />
      </svg>
      {label}
    </span>
  );
}

/** Responsive shared-scale line chart for two or three like-unit series. */
export function HousingMultiLineChart({
  series,
  ariaLabel,
  format,
  height = 280,
}: HousingMultiLineChartProps) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map(({ label }, index) => (
          <LegendChip
            key={label}
            color={SERIES_COLORS[index] ?? SERIES_COLORS[0]}
            label={label}
          />
        ))}
      </div>
      <div style={{ height }}>
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <ChartInner
                series={series}
                ariaLabel={ariaLabel}
                format={format}
                width={width}
                height={height}
              />
            ) : null
          }
        </ParentSize>
      </div>
    </div>
  );
}
