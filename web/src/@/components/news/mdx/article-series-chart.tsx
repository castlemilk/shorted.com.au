"use client";

import { useCallback, useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, Bar, LinePath } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import { format } from "date-fns";

export interface SeriesPoint {
  date: Date;
  value: number;
}

// Amber accent + muted axes pulled from the theme so the chart matches the
// editorial dark palette without hardcoding hex values.
const ACCENT = "hsl(var(--primary))";
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const AXIS_LINE = "hsl(var(--border))";

const MARGIN = { top: 8, right: 8, bottom: 24, left: 44 };

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<SeriesPoint, Date>((d) => d.date).left;

interface ArticleSeriesChartProps {
  points: SeriesPoint[];
  height?: number;
  formatValue?: (value: number) => string;
  gradientId?: string;
  ariaLabel: string;
}

function ChartInner({
  points,
  width,
  height,
  formatValue,
  gradientId,
  ariaLabel,
}: Required<ArticleSeriesChartProps> & { width: number }) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<SeriesPoint>();

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const xScale = useMemo(
    () =>
      scaleTime({
        domain: [points[0]!.date, points[points.length - 1]!.date],
        range: [0, innerWidth],
      }),
    [points, innerWidth],
  );

  const yScale = useMemo(() => {
    const values = points.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = max - min > 0 ? (max - min) * 0.1 : Math.abs(max) * 0.1 || 1;
    return scaleLinear({
      domain: [min - pad, max + pad],
      range: [innerHeight, 0],
      nice: true,
    });
  }, [points, innerHeight]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const point = localPoint(event);
      if (!point) return;
      const x0 = xScale.invert(point.x - MARGIN.left);
      const index = bisectDate(points, x0, 1);
      const d0 = points[index - 1];
      const d1 = points[index];
      if (!d0) return;
      const d =
        d1 && x0.valueOf() - d0.date.valueOf() > d1.date.valueOf() - x0.valueOf() ? d1 : d0;
      showTooltip({
        tooltipData: d,
        tooltipLeft: xScale(d.date) + MARGIN.left,
        tooltipTop: yScale(d.value) + MARGIN.top,
      });
    },
    [points, xScale, yScale, showTooltip],
  );

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <LinearGradient
          id={gradientId}
          from={ACCENT}
          fromOpacity={0.25}
          to={ACCENT}
          toOpacity={0.02}
        />
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          <AreaClosed<SeriesPoint>
            data={points}
            x={(d) => xScale(d.date)}
            y={(d) => yScale(d.value)}
            yScale={yScale}
            curve={curveMonotoneX}
            fill={`url(#${gradientId})`}
          />
          <LinePath<SeriesPoint>
            data={points}
            x={(d) => xScale(d.date)}
            y={(d) => yScale(d.value)}
            curve={curveMonotoneX}
            stroke={ACCENT}
            strokeWidth={1.75}
          />
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
            tickFormat={(v) => formatValue(Number(v))}
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "end" as const,
              dx: "-0.25em",
              dy: "0.3em",
            })}
          />
          {tooltipOpen && tooltipData && (
            <circle
              cx={xScale(tooltipData.date)}
              cy={yScale(tooltipData.value)}
              r={3}
              fill={ACCENT}
              pointerEvents="none"
            />
          )}
          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onTouchMove={handleMouseMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData && (
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
            padding: "4px 8px",
            fontSize: 11,
          }}
        >
          <span className="font-mono">{formatValue(tooltipData.value)}</span>
          <span className="ml-2 text-muted-foreground">
            {format(tooltipData.date, "d MMM yyyy")}
          </span>
        </TooltipWithBounds>
      )}
    </div>
  );
}

/**
 * Compact amber area/line chart for editorial articles. Purely presentational —
 * data fetching lives in the wrapping MDX chart components.
 */
export function ArticleSeriesChart({
  points,
  height = 280,
  formatValue = (v) => v.toFixed(2),
  gradientId = "article-series-gradient",
  ariaLabel,
}: ArticleSeriesChartProps) {
  if (points.length < 2) return null;
  return (
    <div style={{ height }}>
      <ParentSize className="min-w-0">
        {({ width }) =>
          width > 0 ? (
            <ChartInner
              points={points}
              width={width}
              height={height}
              formatValue={formatValue}
              gradientId={gradientId}
              ariaLabel={ariaLabel}
            />
          ) : null
        }
      </ParentSize>
    </div>
  );
}
