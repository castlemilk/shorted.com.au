"use client";

import { useMemo, useCallback } from "react";
import { scaleLinear, scaleTime } from "@visx/scale";
import { LinePath, AreaClosed, Bar } from "@visx/shape";
import { curveCatmullRom } from "@visx/curve";
import { localPoint } from "@visx/event";
import { bisector } from "d3-array";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { format } from "date-fns";

export interface SparklineData {
  date: Date;
  value: number;
}

interface SparklineProps {
  data: SparklineData[];
  width: number;
  height: number;
  isPositive?: boolean;
  showArea?: boolean;
  onHover?: (data: SparklineData | null) => void;
  strokeWidth?: number;
  gradientId?: string;
  smooth?: boolean;
  /** Show min/max value badges below the chart */
  showMinMax?: boolean;
  /** Format function for min/max values */
  formatValue?: (value: number) => string;
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<SparklineData, Date>(
  (d: SparklineData): Date => d.date,
).left;

// Smooth data using a simple moving average to reduce noise
function smoothData(data: SparklineData[], windowSize = 3): SparklineData[] {
  if (data.length <= windowSize) return data;
  
  const result: SparklineData[] = [];
  const halfWindow = Math.floor(windowSize / 2);
  
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(data.length - 1, i + halfWindow);
    let sum = 0;
    let count = 0;
    
    for (let j = start; j <= end; j++) {
      sum += data[j]?.value ?? 0;
      count++;
    }
    
    result.push({
      date: data[i]?.date ?? new Date(),
      value: count > 0 ? sum / count : 0,
    });
  }
  
  return result;
}

// Catmull-Rom curve with configurable tension for smoother lines
const smoothCurve = curveCatmullRom.alpha(0.5);

export function Sparkline({
  data,
  width,
  height,
  isPositive = true,
  showArea = true,
  onHover,
  strokeWidth = 1.5,
  gradientId = "sparkline-gradient",
  smooth = true,
  showMinMax = false,
  formatValue = (v) => `$${v.toFixed(2)}`,
}: SparklineProps) {
  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<SparklineData>();

  // Apply smoothing to reduce jaggedness
  const smoothedData = useMemo(() => {
    if (!data || data.length < 2) return data;
    return smooth ? smoothData(data, 3) : data;
  }, [data, smooth]);

  if (!smoothedData || smoothedData.length < 2) return null;

  const chartHeight = showMinMax ? height - 24 : height;
  const margin = { top: 4, right: 4, bottom: 4, left: 4 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = chartHeight - margin.top - margin.bottom;

  // Scales
  const xScale = useMemo(
    () =>
      scaleTime({
        domain: [
          smoothedData[0]?.date ?? new Date(),
          smoothedData[smoothedData.length - 1]?.date ?? new Date(),
        ],
        range: [0, innerWidth],
      }),
    [smoothedData, innerWidth],
  );

  const { yScale, minValue, maxValue } = useMemo(() => {
    const values = smoothedData.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Add more padding to prevent clipping at edges
    const range = max - min;
    const padding = range > 0 ? range * 0.15 : 1;

    return {
      yScale: scaleLinear({
        domain: [min - padding, max + padding],
        range: [innerHeight, 0],
        nice: true,
      }),
      minValue: min,
      maxValue: max,
    };
  }, [smoothedData, innerHeight]);

  // More vibrant colors
  const color = isPositive ? "#22c55e" : "#ef4444";
  const colorLight = isPositive ? "#4ade80" : "#f87171";

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGElement>) => {
      const point = localPoint(event);
      if (!point) return;

      const x = point.x - margin.left;
      const x0 = xScale.invert(x);
      // Use original data for tooltip to show actual values
      const index = bisectDate(data, x0, 1);
      const d0 = data[index - 1];
      const d1 = data[index];

      if (!d0 || !d1) return;

      const d =
        x0.valueOf() - d0.date.valueOf() > d1.date.valueOf() - x0.valueOf()
          ? d1
          : d0;

      showTooltip({
        tooltipData: d,
        tooltipLeft: xScale(d.date) + margin.left,
        tooltipTop: yScale(d.value) + margin.top,
      });

      onHover?.(d);
    },
    [data, xScale, yScale, margin, showTooltip, onHover],
  );

  const handleMouseLeave = useCallback(() => {
    hideTooltip();
    onHover?.(null);
  }, [hideTooltip, onHover]);

  return (
    <div style={{ position: "relative", width, height, display: "flex", flexDirection: "column" }}>
      <svg
        width={width}
        height={chartHeight}
        style={{ overflow: "visible", flexShrink: 0 }}
      >
        <defs>
          {/* Main gradient for area fill */}
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="50%" stopColor={color} stopOpacity={0.15} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
          
          {/* Glow filter for the line */}
          <filter id={`${gradientId}-glow`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        <g transform={`translate(${margin.left},${margin.top})`}>
          {showArea && (
            <AreaClosed
              data={smoothedData}
              x={(d) => xScale(d.date) ?? 0}
              y={(d) => yScale(d.value) ?? 0}
              yScale={yScale}
              fill={`url(#${gradientId})`}
              curve={smoothCurve}
            />
          )}

          {/* Main line with glow effect */}
          <LinePath
            data={smoothedData}
            x={(d) => xScale(d.date) ?? 0}
            y={(d) => yScale(d.value) ?? 0}
            stroke={color}
            strokeWidth={strokeWidth}
            curve={smoothCurve}
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${gradientId}-glow)`}
            shapeRendering="geometricPrecision"
          />

          {/* Invisible overlay for mouse events */}
          <Bar
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          />

          {/* Hover indicator */}
          {tooltipOpen && tooltipData && (
            <>
              {/* Vertical line */}
              <line
                x1={xScale(tooltipData.date)}
                x2={xScale(tooltipData.date)}
                y1={0}
                y2={innerHeight}
                stroke={color}
                strokeWidth={1}
                strokeDasharray="2,2"
                opacity={0.4}
              />
              {/* Outer glow circle */}
              <circle
                cx={xScale(tooltipData.date)}
                cy={yScale(tooltipData.value)}
                r={6}
                fill={color}
                opacity={0.2}
              />
              {/* Main indicator dot */}
              <circle
                cx={xScale(tooltipData.date)}
                cy={yScale(tooltipData.value)}
                r={3.5}
                fill={colorLight}
                stroke="white"
                strokeWidth={1.5}
              />
            </>
          )}
        </g>
      </svg>

      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          key={Math.random()}
          top={tooltipTop}
          left={tooltipLeft}
          offsetLeft={10}
          offsetTop={-10}
          style={{
            position: "absolute",
            backgroundColor: "rgba(15, 23, 42, 0.95)",
            color: "white",
            padding: "8px 10px",
            borderRadius: "6px",
            fontSize: "11px",
            pointerEvents: "none",
            zIndex: 1000,
            whiteSpace: "nowrap",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          <div>
            <div style={{ fontWeight: "600", fontSize: "12px" }}>
              ${tooltipData.value.toFixed(2)}
            </div>
            <div style={{ fontSize: "9px", opacity: 0.7, marginTop: "3px" }}>
              {format(tooltipData.date, "MMM d, yyyy")}
            </div>
          </div>
        </TooltipWithBounds>
      )}

      {showMinMax && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: "9px",
            lineHeight: 1.2,
            marginTop: "2px",
            paddingLeft: margin.left,
            paddingRight: margin.right,
          }}
        >
          <span style={{ color: "#22c55e" }}>H: {formatValue(maxValue)}</span>
          <span style={{ color: "#ef4444" }}>L: {formatValue(minValue)}</span>
        </div>
      )}
    </div>
  );
}
