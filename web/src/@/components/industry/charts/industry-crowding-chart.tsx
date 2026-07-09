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

import type { CrowdingPoint } from "~/@/lib/industry-intelligence";
import {
  AMBER,
  AXIS_LINE,
  AXIS_TEXT,
  TOOLTIP_STYLE,
} from "~/@/components/features/housing/charts/chart-theme";

const MARGIN = { top: 14, right: 12, bottom: 26, left: 40 };
const HEIGHT = 260;

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatTickDate(date: Date): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function ChartInner({
  width,
  points,
  industryName,
}: {
  width: number;
  points: CrowdingPoint[];
  industryName: string;
}) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<CrowdingPoint>();

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

  const yMax = useMemo(
    () => Math.max(...points.map((p) => p.p90), 1) * 1.1,
    [points],
  );
  const yScale = useMemo(
    () =>
      scaleLinear({ domain: [0, yMax], range: [innerHeight, 0], nice: true }),
    [innerHeight, yMax],
  );

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
        tooltipTop: yScale(best.avg) + MARGIN.top,
      });
    },
    [dates, points, showTooltip, xScale, yScale],
  );

  if (innerWidth <= 0) return null;

  const xOf = (d: CrowdingPoint) => xScale(new Date(`${d.date}T00:00:00Z`));

  return (
    <div className="relative" style={{ width, height: HEIGHT }}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Weekly average short interest for ${industryName} with a 10th to 90th percentile dispersion band, from ${points[0]!.date} to ${points[points.length - 1]!.date}`}
      >
        <LinearGradient
          id="crowding-band-grad"
          from={AMBER}
          fromOpacity={0.16}
          to={AMBER}
          toOpacity={0.04}
        />
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* p10–p90 dispersion band */}
          <AreaClosed<CrowdingPoint>
            data={points}
            x={xOf}
            y0={(d) => yScale(d.p10)}
            y1={(d) => yScale(d.p90)}
            yScale={yScale}
            curve={curveMonotoneX}
            fill="url(#crowding-band-grad)"
          />
          {/* industry mean */}
          <LinePath<CrowdingPoint>
            data={points}
            x={xOf}
            y={(d) => yScale(d.avg)}
            curve={curveMonotoneX}
            stroke={AMBER}
            strokeWidth={2}
          />

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
            tickFormat={(v) => `${Number(v)}%`}
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
              <circle
                cx={xOf(tooltipData)}
                cy={yScale(tooltipData.avg)}
                r={3.5}
                fill={AMBER}
                pointerEvents="none"
              />
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
            <span style={{ color: AMBER }}>Average</span>{" "}
            <span className="font-mono tabular-nums">
              {formatPercent(tooltipData.avg)}
            </span>
          </div>
          <div className="text-muted-foreground">
            p10–p90{" "}
            <span className="font-mono tabular-nums">
              {formatPercent(tooltipData.p10)} – {formatPercent(tooltipData.p90)}
            </span>
          </div>
          <div className="text-muted-foreground">
            {tooltipData.constituents} stocks
          </div>
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

/**
 * Weekly short-interest crowding for one industry: the constituent mean with a
 * p10–p90 dispersion band, aggregated from ASIC daily short positions.
 */
export function IndustryCrowdingChart({
  points,
  industryName,
}: {
  points: CrowdingPoint[];
  industryName: string;
}) {
  if (points.length < 3) return null;
  return (
    <ParentSize className="min-w-0">
      {({ width }) =>
        width > 0 ? (
          <ChartInner width={width} points={points} industryName={industryName} />
        ) : null
      }
    </ParentSize>
  );
}
