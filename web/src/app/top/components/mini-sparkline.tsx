"use client";

import { useMemo } from "react";
import { scaleTime, scaleLinear } from "@visx/scale";
import { LinePath, AreaClosed } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";
import { type SerializedTimeSeriesData, type SerializedTimeSeriesPoint } from "~/app/actions/top/getTopPageData";

interface MiniSparklineProps {
  data: SerializedTimeSeriesData;
  height?: number;
  showArea?: boolean;
}

export function MiniSparkline({
  data,
  height = 32,
  showArea = true,
}: MiniSparklineProps) {
  const width = 180;
  const padding = { top: 4, bottom: 4, left: 0, right: 0 };

  const points = useMemo(() => {
    const rawPoints = data.points ?? [];
    // Sort by timestamp (serialized as ISO string)
    return [...rawPoints].sort((a, b) => {
      const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return timeA - timeB;
    });
  }, [data.points]);

  const { xScale, yScale, trend } = useMemo(() => {
    if (points.length < 2) {
      return { xScale: null, yScale: null, trend: "neutral" as const };
    }

    const getTime = (p: SerializedTimeSeriesPoint) => {
      if (!p.timestamp) return 0;
      return new Date(p.timestamp).getTime();
    };

    const times = points.map(getTime);
    const values = points.map((p) => p.shortPosition ?? 0);

    const minY = Math.min(...values);
    const maxY = Math.max(...values);
    const yPadding = (maxY - minY) * 0.1 || 1;

    const xScale = scaleTime({
      domain: [new Date(Math.min(...times)), new Date(Math.max(...times))],
      range: [padding.left, width - padding.right],
    });

    const yScale = scaleLinear({
      domain: [minY - yPadding, maxY + yPadding],
      range: [height - padding.bottom, padding.top],
    });

    // Determine trend
    const firstValue = values[0] ?? 0;
    const lastValue = values[values.length - 1] ?? 0;
    const trend =
      lastValue > firstValue + 0.5
        ? ("up" as const)
        : lastValue < firstValue - 0.5
          ? ("down" as const)
          : ("neutral" as const);

    return { xScale, yScale, trend };
  }, [points, height]);

  if (!xScale || !yScale || points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground"
        style={{ width, height }}
      >
        —
      </div>
    );
  }

  const getTime = (p: SerializedTimeSeriesPoint) => {
    if (!p.timestamp) return new Date(0);
    return new Date(p.timestamp);
  };

  const strokeColor =
    trend === "up"
      ? "var(--red)"
      : trend === "down"
        ? "var(--green)"
        : "var(--line-stroke)";

  const gradientId = `sparkline-gradient-${data.productCode}`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor={strokeColor}
            stopOpacity={showArea ? 0.3 : 0}
          />
          <stop offset="100%" stopColor={strokeColor} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Area fill */}
      {showArea && (
        <AreaClosed
          data={points}
          x={(d) => xScale(getTime(d))}
          y={(d) => yScale(d.shortPosition ?? 0)}
          yScale={yScale}
          curve={curveMonotoneX}
          fill={`url(#${gradientId})`}
        />
      )}

      {/* Line */}
      <LinePath
        data={points}
        x={(d) => xScale(getTime(d))}
        y={(d) => yScale(d.shortPosition ?? 0)}
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        curve={curveMonotoneX}
      />

      {/* End dot */}
      <circle
        cx={xScale(getTime(points[points.length - 1]!))}
        cy={yScale(points[points.length - 1]?.shortPosition ?? 0)}
        r={2.5}
        fill={strokeColor}
      />
    </svg>
  );
}
