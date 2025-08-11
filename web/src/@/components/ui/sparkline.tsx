"use client";

import { useMemo, useCallback } from "react";
import { scaleLinear, scaleTime } from "@visx/scale";
import { LinePath, AreaClosed, Bar } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
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
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<SparklineData, Date>((d: SparklineData): Date => d.date).left;

export function Sparkline({
  data,
  width,
  height,
  isPositive = true,
  showArea = true,
  onHover,
  strokeWidth = 2,
  gradientId = "sparkline-gradient",
}: SparklineProps) {
  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<SparklineData>();

  if (!data || data.length < 2) return null;

  const margin = { top: 2, right: 2, bottom: 2, left: 2 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  // Scales
  const xScale = useMemo(
    () =>
      scaleTime({
        domain: [data[0]?.date ?? new Date(), data[data.length - 1]?.date ?? new Date()],
        range: [0, innerWidth],
      }),
    [data, innerWidth]
  );

  const yScale = useMemo(() => {
    const values = data.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.1;
    
    return scaleLinear({
      domain: [min - padding, max + padding],
      range: [innerHeight, 0],
    });
  }, [data, innerHeight]);

  const color = isPositive ? "#10b981" : "#ef4444";
  const gradientColor = isPositive ? "#10b98120" : "#ef444420";

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGElement>) => {
      const point = localPoint(event);
      if (!point) return;

      const x = point.x - margin.left;
      const x0 = xScale.invert(x);
      const index = bisectDate(data, x0, 1);
      const d0 = data[index - 1];
      const d1 = data[index];
      
      if (!d0 || !d1) return;
      
      const d = x0.valueOf() - d0.date.valueOf() > d1.date.valueOf() - x0.valueOf() ? d1 : d0;
      
      showTooltip({
        tooltipData: d,
        tooltipLeft: xScale(d.date) + margin.left,
        tooltipTop: yScale(d.value) + margin.top,
      });
      
      onHover?.(d);
    },
    [data, xScale, yScale, margin, showTooltip, onHover]
  );

  const handleMouseLeave = useCallback(() => {
    hideTooltip();
    onHover?.(null);
  }, [hideTooltip, onHover]);

  return (
    <div style={{ position: "relative" }}>
      <svg width={width} height={height}>
        <LinearGradient
          id={gradientId}
          from={color}
          to={gradientColor}
          fromOpacity={0.3}
          toOpacity={0}
        />
        
        <g transform={`translate(${margin.left},${margin.top})`}>
          {showArea && (
            <AreaClosed
              data={data}
              x={(d) => xScale(d.date) ?? 0}
              y={(d) => yScale(d.value) ?? 0}
              yScale={yScale}
              fill={`url(#${gradientId})`}
              curve={curveMonotoneX}
            />
          )}
          
          <LinePath
            data={data}
            x={(d) => xScale(d.date) ?? 0}
            y={(d) => yScale(d.value) ?? 0}
            stroke={color}
            strokeWidth={strokeWidth}
            curve={curveMonotoneX}
            strokeLinecap="round"
            strokeLinejoin="round"
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
              <circle
                cx={xScale(tooltipData.date)}
                cy={yScale(tooltipData.value)}
                r={4}
                fill={color}
                stroke="white"
                strokeWidth={2}
              />
              <line
                x1={xScale(tooltipData.date)}
                x2={xScale(tooltipData.date)}
                y1={0}
                y2={innerHeight}
                stroke={color}
                strokeWidth={1}
                strokeDasharray="3,3"
                opacity={0.5}
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
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.9)",
            color: "white",
            padding: "8px",
            borderRadius: "4px",
            fontSize: "12px",
            pointerEvents: "none",
          }}
        >
          <div>
            <div style={{ fontWeight: "bold" }}>
              ${tooltipData.value.toFixed(2)}
            </div>
            <div style={{ fontSize: "10px", opacity: 0.8 }}>
              {format(tooltipData.date, "MMM d, yyyy")}
            </div>
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}