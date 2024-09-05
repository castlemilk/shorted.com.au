import React from "react";
import { Group } from "@visx/group";
import { AreaClosed } from "@visx/shape";
import { AxisLeft, AxisBottom, type AxisScale } from "@visx/axis";
import { LinearGradient } from "@visx/gradient";
import { curveMonotoneX } from "@visx/curve";
import { type TimeSeriesPoint } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type PlainMessage } from "@bufbuild/protobuf";

// Initialize some variables
const axisColor = "hsl(var(--primary))";
const axisBottomTickLabelProps = {
  textAnchor: "middle" as const,
  fontFamily: "Arial",
  fontSize: 10,
  fill: axisColor,
};

const axisLeftTickLabelProps = {
  dx: "-0.25em",
  dy: "0.25em",
  fontFamily: "inherit",
  fontSize: 10,
  textAnchor: "end" as const,
  fill: axisColor,
};

const getDate = (d: PlainMessage<TimeSeriesPoint>) =>
  new Date(Number(d.timestamp?.seconds) * 1000) ?? new Date();
const getStockValue = (d: PlainMessage<TimeSeriesPoint>) =>
  d.shortPosition ?? 0;

const AreaChart = ({
  data,
  gradientColor,
  width,
  yMax,
  margin,
  xScale,
  yScale,
  hideBottomAxis = false,
  hideLeftAxis = false,
  top,
  left,
  children,
  onTouchStart,
  onTouchMove,
  onMouseMove,
  onMouseLeave,
}: {
  data: PlainMessage<TimeSeriesPoint>[];
  gradientColor: string;
  xScale: AxisScale<number>;
  yScale: AxisScale<number>;
  width: number;
  yMax: number;
  margin: { top: number; right: number; bottom: number; left: number };
  hideBottomAxis?: boolean;
  hideLeftAxis?: boolean;
  top?: number;
  left?: number;
  children?: React.ReactNode;
  onTouchStart?: (event: React.TouchEvent<SVGRectElement>) => void;
  onTouchMove?: (event: React.TouchEvent<SVGRectElement>) => void;
  onMouseMove?: (event: React.MouseEvent<SVGRectElement>) => void;
  onMouseLeave?: () => void;
}) => {
  if (width < 10) return null;
  return (
    <Group left={left ?? margin.left} top={top ?? margin.top}>
      <defs>
        <filter id="area-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="2" dy="2" stdDeviation="3" floodOpacity="0.2" />
        </filter>
        <LinearGradient
          id="gradient"
          from={gradientColor}
          fromOpacity={1}
          to={gradientColor}
          toOpacity={0.2}
        />
      </defs>
      <AreaClosed<PlainMessage<TimeSeriesPoint>>
        data={data}
        x={(d) => xScale(getDate(d)) ?? 0}
        y={(d) => yScale(getStockValue(d)) ?? 0}
        yScale={yScale}
        strokeWidth={2}
        stroke="url(#gradient)"
        fill="url(#gradient)"
        curve={curveMonotoneX}
        onMouseMove={onMouseMove}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onMouseLeave={onMouseLeave}
        filter="url(#area-shadow)"
      />
      {!hideBottomAxis && (
        <AxisBottom
          top={yMax}
          scale={xScale}
          numTicks={width > 520 ? 10 : 5}
          stroke={axisColor}
          tickStroke={axisColor}
          tickLabelProps={() => ({
            ...axisBottomTickLabelProps,
            transform: `translate(0, -10px)`, // Slight upward adjustment
          })}
          hideTicks
        />
      )}
      {!hideLeftAxis && (
        <AxisLeft
          scale={yScale}
          numTicks={5}
          stroke={axisColor}
          tickStroke={axisColor}
          tickLabelProps={axisLeftTickLabelProps}
          tickLength={4}
          hideTicks
        />
      )}
      {children}
    </Group>
  );
};

export default AreaChart;
