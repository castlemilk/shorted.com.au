"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { Bar, LinePath } from "@visx/shape";
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

/** Returns one union time/value domain shared by every supplied series. */
export function getCombinedDomains(
  series: readonly HousingMultiLineSeries[],
): HousingCombinedDomains | null {
  const points = series
    .flatMap(({ points }) => points)
    .filter(
      (point) =>
        Number.isFinite(point.date.getTime()) && Number.isFinite(point.value),
    );
  if (points.length === 0) return null;

  const times = points.map(({ date }) => date.getTime());
  const values = points.map(({ value }) => value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum;
  const padding = spread > 0 ? spread * 0.1 : Math.abs(maximum) * 0.1 || 1;

  return {
    time: [new Date(Math.min(...times)), new Date(Math.max(...times))],
    value: [minimum - padding, maximum + padding],
  };
}

function observationDates(series: readonly HousingMultiLineSeries[]): Date[] {
  const timestamps = new Set<number>();
  for (const { points } of series) {
    for (const point of points) {
      const timestamp = point.date.getTime();
      if (Number.isFinite(timestamp)) timestamps.add(timestamp);
    }
  }
  return [...timestamps].sort((a, b) => a - b).map((timestamp) => new Date(timestamp));
}

function nearestDateIndex(
  dates: readonly Date[],
  target: Date,
): number {
  const targetTime = target.getTime();
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  dates.forEach((date, index) => {
    const distance = Math.abs(date.getTime() - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

export interface HousingSharedObservation {
  date: Date;
  points: Array<HousingSeriesPoint | undefined>;
  index: number;
  dates: Date[];
}

function observationAtIndex(
  series: readonly HousingMultiLineSeries[],
  dates: Date[],
  index: number,
): HousingSharedObservation | null {
  const date = dates[index];
  if (!date) return null;
  const timestamp = date.getTime();
  return {
    date,
    points: series.map(({ points }) =>
      points.find((point) => point.date.getTime() === timestamp),
    ),
    index,
    dates,
  };
}

/** Selects one union observation date and uses exact-period values for all series. */
export function getSharedObservation(
  series: readonly HousingMultiLineSeries[],
  target: Date,
): HousingSharedObservation | null {
  const dates = observationDates(series);
  if (dates.length === 0) return null;
  return observationAtIndex(series, dates, nearestDateIndex(dates, target));
}

function ChartInner({
  series,
  ariaLabel,
  format,
  width,
  height,
  summaryId,
}: Required<HousingMultiLineChartProps> & { width: number; summaryId: string }) {
  const [tooltipData, setTooltipData] =
    useState<HousingSharedObservation | null>(null);
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);
  const domains = useMemo(() => getCombinedDomains(series), [series]);
  const dates = useMemo(() => observationDates(series), [series]);

  const xScale = useMemo(
    () =>
      scaleTime({
        domain: domains?.time ?? [new Date(0), new Date(1)],
        range: [0, innerWidth],
      }),
    [domains, innerWidth],
  );
  const yScale = useMemo(() => {
    return scaleLinear({
      domain: domains?.value ?? [0, 1],
      range: [innerHeight, 0],
      nice: true,
    });
  }, [domains, innerHeight]);

  const formatValue = useCallback(
    (value: number) => formatHousingValue(value, format),
    [format],
  );

  const showObservation = useCallback(
    (index: number) => {
      const observation = observationAtIndex(series, dates, index);
      if (!observation) return;
      setTooltipData(observation);
    },
    [dates, series],
  );

  const hideTooltip = useCallback(() => setTooltipData(null), []);

  const handlePointerMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const pointer = localPoint(event);
      if (!pointer) return;

      const target = xScale.invert(pointer.x - MARGIN.left);
      showObservation(nearestDateIndex(dates, target));
    },
    [dates, showObservation, xScale],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const currentIndex = tooltipData?.index ?? dates.length - 1;
      const nextIndex = Math.max(
        0,
        Math.min(dates.length - 1, currentIndex + (event.key === "ArrowLeft" ? -1 : 1)),
      );
      showObservation(nextIndex);
    },
    [dates.length, showObservation, tooltipData?.index],
  );

  if (!domains || innerWidth <= 0 || innerHeight <= 0) return null;

  const tooltipAnchor = tooltipData?.points.find(
    (point) => point !== undefined,
  );
  const tooltipLeft = tooltipData
    ? xScale(tooltipData.date) + MARGIN.left
    : undefined;
  const tooltipTop = tooltipAnchor
    ? yScale(tooltipAnchor.value) + MARGIN.top
    : undefined;
  const tooltipOpen = tooltipData !== null && tooltipAnchor !== undefined;

  return (
    <div className="relative" style={{ width, height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={summaryId}
        aria-keyshortcuts="ArrowLeft ArrowRight"
        tabIndex={0}
        onFocus={() => showObservation(dates.length - 1)}
        onBlur={hideTooltip}
        onKeyDown={handleKeyDown}
      >
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
        <div
          className="pointer-events-none"
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            left: tooltipLeft,
            top: tooltipTop,
            zIndex: 1,
            transform: "translate(8px, 8px)",
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
        </div>
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
  const summaryId = useId();
  const summary = useMemo(
    () =>
      series
        .map(({ label, points }) => {
          const sorted = [...points].sort(
            (a, b) => a.date.getTime() - b.date.getTime(),
          );
          const first = sorted[0];
          const latest = sorted.at(-1);
          if (!first || !latest) return `${label}: no data.`;
          return `${label}: latest ${formatHousingValue(latest.value, format)} in ${formatDate(latest.date, "MMM yyyy")}; range ${formatDate(first.date, "MMM yyyy")} to ${formatDate(latest.date, "MMM yyyy")}.`;
        })
        .join(" "),
    [format, series],
  );

  return (
    <div className="flex flex-col" style={{ height }}>
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
        {series.map(({ label }, index) => (
          <LegendChip
            key={label}
            color={SERIES_COLORS[index] ?? SERIES_COLORS[0]}
            label={label}
          />
        ))}
      </div>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <div className="min-h-0 flex-1">
        <ParentSize className="min-w-0">
          {({ width, height: chartHeight }) =>
            width > 0 && chartHeight > 0 ? (
              <ChartInner
                series={series}
                ariaLabel={ariaLabel}
                format={format}
                width={width}
                height={chartHeight}
                summaryId={summaryId}
              />
            ) : null
          }
        </ParentSize>
      </div>
    </div>
  );
}
