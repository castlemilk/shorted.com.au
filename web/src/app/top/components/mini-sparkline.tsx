"use client";

import { useMemo } from "react";
import { scaleLinear } from "@visx/scale";
import { LinePath, AreaClosed } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";

interface MiniSparklineProps {
  /** Short positions in time order (TopRow.sparkline). */
  values: number[];
  /** The row's stock code: keys the gradient id, which must be unique on the page. */
  id: string;
  height?: number;
  showArea?: boolean;
}

const WIDTH = 180;
const PADDING = { top: 4, bottom: 4, left: 0, right: 0 };

export function MiniSparkline({
  values,
  id,
  height = 32,
  showArea = true,
}: MiniSparklineProps) {
  const { xScale, yScale, trend } = useMemo(() => {
    if (values.length < 2) {
      return { xScale: null, yScale: null, trend: "neutral" as const };
    }

    const minY = Math.min(...values);
    const maxY = Math.max(...values);
    const yPadding = (maxY - minY) * 0.1 || 1;

    // By position, not by date: one value per sampled session, so the x axis
    // reads in trading days rather than calendar days.
    const xScale = scaleLinear({
      domain: [0, values.length - 1],
      range: [PADDING.left, WIDTH - PADDING.right],
    });

    const yScale = scaleLinear({
      domain: [minY - yPadding, maxY + yPadding],
      range: [height - PADDING.bottom, PADDING.top],
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
  }, [values, height]);

  if (!xScale || !yScale) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground"
        style={{ width: WIDTH, height }}
      >
        —
      </div>
    );
  }

  const strokeColor =
    trend === "up"
      ? "var(--red)"
      : trend === "down"
        ? "var(--green)"
        : "var(--line-stroke)";

  const gradientId = `sparkline-gradient-${id}`;
  const last = values.length - 1;

  return (
    <svg width={WIDTH} height={height} className="overflow-visible">
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
          data={values}
          x={(_, index) => xScale(index)}
          y={(value) => yScale(value)}
          yScale={yScale}
          curve={curveMonotoneX}
          fill={`url(#${gradientId})`}
        />
      )}

      {/* Line */}
      <LinePath
        data={values}
        x={(_, index) => xScale(index)}
        y={(value) => yScale(value)}
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        curve={curveMonotoneX}
      />

      {/* End dot */}
      <circle
        cx={xScale(last)}
        cy={yScale(values[last] ?? 0)}
        r={2.5}
        fill={strokeColor}
      />
    </svg>
  );
}
