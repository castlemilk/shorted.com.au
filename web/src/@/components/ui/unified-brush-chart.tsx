"use client";
import React, {
  useRef,
  useState,
  useMemo,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";
import { scaleTime, scaleLinear } from "@visx/scale";
import { Brush } from "@visx/brush";
import { type Bounds } from "@visx/brush/lib/types";
import {
  type BaseBrushState,
  type UpdateBrush,
} from "@visx/brush/lib/BaseBrush";
import type BaseBrush from "@visx/brush/lib/BaseBrush";
import { PatternLines } from "@visx/pattern";
import { Group } from "@visx/group";
import { LinearGradient } from "@visx/gradient";
import { max, extent, bisector } from "@visx/vendor/d3-array";
import { type BrushHandleRenderProps } from "@visx/brush/lib/BrushHandle";
import { AreaClosed, Line, Bar } from "@visx/shape";
import { AxisLeft, AxisBottom } from "@visx/axis";
import {
  TooltipWithBounds,
  defaultStyles,
  useTooltip,
  useTooltipInPortal,
} from "@visx/tooltip";
import { localPoint } from "@visx/event";
import { timeFormat } from "@visx/vendor/d3-time-format";
import useWindowSize from "@/hooks/use-window-size";
import { curveMonotoneX } from "@visx/curve";

// Chart data types
export type ShortPositionDataPoint = {
  timestamp: Date;
  shortPosition: number;
};

export type PriceDataPoint = {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type UnifiedChartData = {
  type: "short-position" | "price";
  stockCode: string;
  points: (ShortPositionDataPoint | PriceDataPoint)[];
};

type TooltipData = ShortPositionDataPoint | PriceDataPoint | null;

// Styling constants
const brushMargin = { top: 10, bottom: 15, left: 50, right: 20 };
const chartSeparation = 30;

// Color schemes for different chart types
const colorSchemes = {
  "short-position": {
    primary: "#ef4444", // red-500
    secondary: "#dc2626", // red-600
    light: "#fee2e2", // red-100
    dark: "#991b1b", // red-800
  },
  price: {
    primary: "#3b82f6", // blue-500
    secondary: "#2563eb", // blue-600
    light: "#dbeafe", // blue-100
    dark: "#1e40af", // blue-800
  },
};

export const accentColor = "hsl(var(--foreground))";
export const background = `hsl(var(--background))`;
export const background2 = `hsl(var(--primary))`;
export const accentColorDark = "hsl(var(--primary))";

// Type guards
function isShortPositionData(
  data: UnifiedChartData,
): data is UnifiedChartData & { points: ShortPositionDataPoint[] } {
  return data.type === "short-position";
}

function isPriceData(
  data: UnifiedChartData,
): data is UnifiedChartData & { points: PriceDataPoint[] } {
  return data.type === "price";
}

// Accessors
const getDate = (
  d: ShortPositionDataPoint | PriceDataPoint | undefined,
): Date => {
  if (!d) return new Date();
  return "timestamp" in d ? d.timestamp : d.date;
};

const getValue = (
  d: ShortPositionDataPoint | PriceDataPoint | undefined,
  dataType: "short-position" | "price",
): number => {
  if (!d) return 0;
  if (dataType === "short-position") {
    return (d as ShortPositionDataPoint).shortPosition ?? 0;
  }
  return (d as PriceDataPoint).close ?? 0;
};

const getVolume = (d: PriceDataPoint | undefined): number => {
  return d?.volume ?? 0;
};

const bisectDate = (
  array: (ShortPositionDataPoint | PriceDataPoint)[],
  date: Date,
  low?: number,
  high?: number,
) =>
  bisector<ShortPositionDataPoint | PriceDataPoint, Date>((d) =>
    getDate(d),
  ).left(array, date, low, high);

const formatDate = timeFormat("%b %d, '%y");
const formatValue = (value: number, isPercent: boolean) =>
  isPercent ? `${value.toFixed(3)}%` : `$${value.toFixed(2)}`;

export type HandleBrushClearAndReset = { clear: () => void; reset: () => void };

export type UnifiedBrushChartProps = {
  width: number;
  height: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  compact?: boolean;
  data: UnifiedChartData;
};

const UnifiedBrushChart = forwardRef<
  HandleBrushClearAndReset,
  UnifiedBrushChartProps
>(
  (
    {
      compact = false,
      data,
      width,
      height,
      margin = { top: 20, right: 20, bottom: 20, left: 50 },
    },
    innerRef,
  ) => {
    const { width: windowWidth } = useWindowSize();
    const isMobile = windowWidth ? windowWidth <= 500 : false;
    const showVolume = isPriceData(data) && !isMobile;

    // Get color scheme and unique IDs based on data type
    const colors = colorSchemes[data.type];
    const PATTERN_ID = `brush_pattern_${data.type}`;
    const GRADIENT_ID = `brush_gradient_${data.type}`;
    const selectedBrushStyle = {
      fill: `url(#${PATTERN_ID})`,
      stroke: colors.secondary,
    };
    const tooltipStyles = {
      ...defaultStyles,
      background,
      border: `2px solid ${colors.primary}`,
      color: "hsl(var(--foreground))",
    };

    const { containerRef, containerBounds: _containerBounds } =
      useTooltipInPortal({
        scroll: true,
        detectBounds: true,
      });

    const {
      tooltipData,
      tooltipLeft = 0,
      tooltipTop = 0,
      showTooltip,
      hideTooltip,
    } = useTooltip<TooltipData>({
      tooltipOpen: false,
      tooltipData: null,
    });

    const brushRef = useRef<BaseBrush | null>(null);
    const [filteredData, setFilteredData] = useState(data.points);

    useEffect(() => {
      setFilteredData(data.points);
    }, [data]);

    const onBrushChange = (domain: Bounds | null) => {
      if (!domain) return;
      const { x0, x1 } = domain;
      const filtered = data.points.filter((d) => {
        const x = getDate(d).getTime();
        return x >= x0 && x <= x1;
      });
      setFilteredData(filtered);
    };

    // Calculate heights
    const innerHeight = height - margin.top - margin.bottom;
    const volumeChartHeight = showVolume ? 70 : 0;
    const volumeChartGap = showVolume ? 25 : 0;
    const topChartBottomMargin = compact
      ? chartSeparation / 2
      : chartSeparation + 10;
    const availableChartHeight =
      innerHeight - volumeChartHeight - volumeChartGap;
    const topChartHeight = isMobile
      ? availableChartHeight
      : 0.8 * availableChartHeight - topChartBottomMargin;
    const bottomChartHeight = isMobile
      ? 0
      : availableChartHeight - topChartHeight - chartSeparation;

    const svgHeight = isMobile
      ? topChartHeight +
        volumeChartHeight +
        margin.top +
        margin.bottom +
        volumeChartGap
      : height;

    // bounds
    const xMax = Math.max(width - margin.left - margin.right, 0);
    const yMax = Math.max(topChartHeight, 0);
    const yVolumeMax = Math.max(volumeChartHeight, 0);
    const xBrushMax = Math.max(width - brushMargin.left - brushMargin.right, 0);
    const yBrushMax = Math.max(
      bottomChartHeight - brushMargin.top - brushMargin.bottom,
      0,
    );

    // Scales
    const dateScale = useMemo(
      () =>
        scaleTime<number>({
          range: [0, xMax],
          domain: extent(filteredData, getDate) as [Date, Date],
        }),
      [xMax, filteredData],
    );

    const valueScale = useMemo(
      () =>
        scaleLinear<number>({
          range: [yMax, 0],
          domain: [0, max(filteredData, (d) => getValue(d, data.type)) ?? 0],
          nice: true,
        }),
      [yMax, filteredData, data.type],
    );

    const volumeScale = useMemo(() => {
      if (!isPriceData(data))
        return scaleLinear({ range: [yVolumeMax, 0], domain: [0, 1] });
      return scaleLinear<number>({
        range: [yVolumeMax, 0],
        domain: [0, max(filteredData as PriceDataPoint[], getVolume) ?? 0],
        nice: true,
      });
    }, [yVolumeMax, filteredData, data.type]);

    const brushDateScale = useMemo(
      () =>
        scaleTime<number>({
          range: [0, xBrushMax],
          domain: extent(data.points, getDate) as [Date, Date],
        }),
      [xBrushMax, data.points],
    );

    const brushValueScale = useMemo(
      () =>
        scaleLinear({
          range: [yBrushMax, 0],
          domain: [0, max(data.points, (d) => getValue(d, data.type)) ?? 0],
          nice: true,
        }),
      [yBrushMax, data.points, data.type],
    );

    const initialBrushPosition = useMemo(
      () => ({
        start: {
          x: brushDateScale(
            getDate(
              data.points[
                Math.max(
                  0,
                  data.points.length - Math.floor(data.points.length * 0.2),
                )
              ],
            ),
          ),
        },
        end: {
          x: brushDateScale(getDate(data.points[data.points.length - 1])),
        },
      }),
      [brushDateScale, data.points],
    );

    useImperativeHandle(innerRef, () => ({
      clear() {
        handleClearClick();
      },
      reset() {
        handleResetClick();
      },
    }));

    const handleClearClick = () => {
      if (brushRef?.current) {
        setFilteredData(data.points);
        brushRef.current.reset();
      }
    };

    const handleResetClick = () => {
      if (brushRef?.current) {
        const updater: UpdateBrush = (prevBrush) => {
          const newExtent = brushRef.current!.getExtent(
            initialBrushPosition.start,
            initialBrushPosition.end,
          );

          const newState: BaseBrushState = {
            ...prevBrush,
            start: { y: newExtent.y0, x: newExtent.x0 },
            end: { y: newExtent.y1, x: newExtent.x1 },
            extent: newExtent,
          };

          return newState;
        };
        brushRef.current.updateBrush(updater);
      }
    };

    const handlePointerMove = useCallback(
      (
        event:
          | React.TouchEvent<SVGRectElement>
          | React.MouseEvent<SVGRectElement>,
      ) => {
        const { x } = localPoint(event) ?? { x: 0 };
        const x0 = dateScale.invert(x);
        const index = bisectDate(filteredData, x0, 1);
        const d0 = filteredData[index - 1];
        const d1 = filteredData[index];
        let d = d0;
        if (d1 && getDate(d1)) {
          d =
            x0.valueOf() - getDate(d0).valueOf() >
            getDate(d1).valueOf() - x0.valueOf()
              ? d1
              : d0;
        }
        showTooltip({
          tooltipData: d,
          tooltipLeft: x,
          tooltipTop: valueScale(getValue(d, data.type)),
        });
      },
      [showTooltip, valueScale, dateScale, filteredData, data.type],
    );

    if (width < 10) return null;

    return (
      <div ref={containerRef} style={{ position: "relative" }}>
        <svg width={width} height={svgHeight}>
          <LinearGradient
            id={GRADIENT_ID}
            from={background}
            to={background2}
            toOffset={"1%"}
            rotate={180}
          />
          <rect
            x={0}
            y={0}
            width={width}
            height={svgHeight}
            fill={`url(#${GRADIENT_ID})`}
            rx={14}
          />

          {/* Main Chart */}
          <Group top={margin.top} left={margin.left}>
            <AreaClosed<ShortPositionDataPoint | PriceDataPoint>
              data={filteredData}
              x={(d) => dateScale(getDate(d)) ?? 0}
              y={(d) => valueScale(getValue(d, data.type)) ?? 0}
              yScale={valueScale}
              strokeWidth={2.5}
              stroke={colors.primary}
              fill={colors.primary}
              fillOpacity={0.15}
              curve={curveMonotoneX}
            />
            <rect
              x={0}
              y={0}
              width={xMax}
              height={yMax}
              fill="transparent"
              onTouchStart={handlePointerMove}
              onTouchMove={handlePointerMove}
              onMouseMove={handlePointerMove}
              onMouseLeave={() => hideTooltip()}
            />
            <AxisLeft
              scale={valueScale}
              stroke={colors.secondary}
              tickStroke={colors.secondary}
              tickLabelProps={() => ({
                fill: colors.primary,
                fontSize: 11,
                textAnchor: "end",
                dx: -4,
                dy: 3,
              })}
            />
            {!compact && (
              <AxisBottom
                top={yMax}
                scale={dateScale}
                stroke={colors.secondary}
                tickStroke={colors.secondary}
                numTicks={isMobile ? 4 : 8}
                tickLabelProps={() => ({
                  fill: colors.primary,
                  fontSize: 11,
                  textAnchor: "middle",
                  dy: 4,
                })}
              />
            )}
          </Group>

          {/* Volume Chart */}
          {showVolume && isPriceData(data) && (
            <Group
              top={margin.top + topChartHeight + volumeChartGap}
              left={margin.left}
            >
              {(filteredData as PriceDataPoint[]).map((d, i) => {
                const barHeight = yVolumeMax - volumeScale(getVolume(d));
                const barWidth = Math.max(1, xMax / filteredData.length - 1);
                const barX = dateScale(getDate(d));
                const barY = volumeScale(getVolume(d));
                return (
                  <Bar
                    key={`bar-${i}`}
                    x={barX - barWidth / 2}
                    y={barY}
                    width={barWidth}
                    height={barHeight}
                    fill={colors.secondary}
                    fillOpacity={0.3}
                  />
                );
              })}
              <AxisLeft
                scale={volumeScale}
                stroke={colors.secondary}
                tickStroke={colors.secondary}
                numTicks={3}
                tickFormat={(value) => {
                  const num = Number(value);
                  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
                  if (num >= 1000) return `${(num / 1000).toFixed(0)}K`;
                  return num.toString();
                }}
                tickLabelProps={() => ({
                  fill: colors.primary,
                  fontSize: 10,
                  textAnchor: "end",
                  dx: -4,
                  dy: 3,
                })}
              />
              <text
                x={-margin.left + 10}
                y={yVolumeMax / 2}
                fontSize={11}
                fontWeight="600"
                fill={colors.primary}
                textAnchor="middle"
                transform={`rotate(-90, ${-margin.left + 10}, ${yVolumeMax / 2})`}
              >
                Volume
              </text>
            </Group>
          )}

          {/* Brush Chart */}
          {!isMobile && (
            <Group
              top={
                margin.top +
                topChartHeight +
                topChartBottomMargin +
                (showVolume ? volumeChartHeight + volumeChartGap : 0)
              }
              left={brushMargin.left}
            >
              <AreaClosed<ShortPositionDataPoint | PriceDataPoint>
                data={data.points}
                x={(d) => brushDateScale(getDate(d)) ?? 0}
                y={(d) => brushValueScale(getValue(d, data.type)) ?? 0}
                yScale={brushValueScale}
                strokeWidth={1}
                stroke={colors.secondary}
                fill={colors.secondary}
                fillOpacity={0.15}
                curve={curveMonotoneX}
              />
              <PatternLines
                id={PATTERN_ID}
                height={8}
                width={8}
                stroke={colors.primary}
                strokeWidth={1}
                orientation={["diagonal"]}
              />
              <Brush
                xScale={brushDateScale}
                yScale={brushValueScale}
                width={xBrushMax}
                height={yBrushMax}
                margin={brushMargin}
                handleSize={8}
                innerRef={brushRef}
                resizeTriggerAreas={["left", "right"]}
                brushDirection="horizontal"
                initialBrushPosition={initialBrushPosition}
                onChange={onBrushChange}
                onClick={() => setFilteredData(data.points)}
                selectedBoxStyle={selectedBrushStyle}
                useWindowMoveEvents
                renderBrushHandle={(props) => <BrushHandle {...props} />}
              />
            </Group>
          )}

          {/* Tooltip crosshair */}
          {tooltipData && (
            <g>
              <Line
                from={{ x: tooltipLeft, y: margin.top }}
                to={{
                  x: tooltipLeft,
                  y:
                    margin.top +
                    topChartHeight +
                    (showVolume ? volumeChartHeight + volumeChartGap : 0),
                }}
                stroke={colors.dark}
                strokeWidth={2}
                pointerEvents="none"
                strokeDasharray="5,2"
              />
              <circle
                cx={tooltipLeft}
                cy={margin.top + tooltipTop + 1}
                r={4}
                fill="black"
                fillOpacity={0.1}
                stroke="black"
                strokeOpacity={0.1}
                strokeWidth={2}
                pointerEvents="none"
              />
              <circle
                cx={tooltipLeft}
                cy={margin.top + tooltipTop}
                r={4}
                fill={colors.primary}
                stroke="white"
                strokeWidth={2}
                pointerEvents="none"
              />
            </g>
          )}
        </svg>

        {/* Tooltip */}
        {tooltipData && (
          <TooltipWithBounds
            key={Math.random()}
            top={tooltipTop + margin.top}
            left={tooltipLeft}
            style={{
              ...tooltipStyles,
              borderRadius: "8px",
              boxShadow: `0 4px 12px ${colors.primary}40`,
              padding: "0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                backgroundColor: colors.primary,
                height: "4px",
                width: "100%",
              }}
            />
            <div className="flex flex-col gap-1" style={{ padding: "12px" }}>
              <p className="text-[color:hsl(var(--foreground))] text-sm font-bold">
                {formatDate(getDate(tooltipData))}
              </p>
              <p
                className="text-lg font-semibold"
                style={{ color: colors.primary }}
              >
                {formatValue(
                  getValue(tooltipData, data.type),
                  isShortPositionData(data),
                )}
              </p>
              {isPriceData(data) && (
                <>
                  <p className="text-[color:hsl(var(--foreground))] text-xs">
                    O:{" "}
                    {formatValue((tooltipData as PriceDataPoint).open, false)}{" "}
                    H:{" "}
                    {formatValue((tooltipData as PriceDataPoint).high, false)}
                  </p>
                  <p className="text-[color:hsl(var(--foreground))] text-xs">
                    L: {formatValue((tooltipData as PriceDataPoint).low, false)}{" "}
                    C:{" "}
                    {formatValue((tooltipData as PriceDataPoint).close, false)}
                  </p>
                  <p className="text-[color:hsl(var(--foreground))] text-xs">
                    Volume:{" "}
                    {getVolume(tooltipData as PriceDataPoint).toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </TooltipWithBounds>
        )}
      </div>
    );
  },
);

UnifiedBrushChart.displayName = "UnifiedBrushChart";

// Brush handle component
function BrushHandle({ x, height, isBrushActive }: BrushHandleRenderProps) {
  const pathWidth = 8;
  const pathHeight = 15;
  if (!isBrushActive) {
    return null;
  }
  return (
    <Group left={x + pathWidth / 2} top={(height - pathHeight) / 2}>
      <path
        fill="hsl(var(--muted))"
        d="M -4.5 0.5 L 3.5 0.5 L 3.5 15.5 L -4.5 15.5 L -4.5 0.5 M -1.5 4 L -1.5 12 M 0.5 4 L 0.5 12"
        stroke="hsl(var(--foreground))"
        strokeWidth="1"
        style={{ cursor: "ew-resize" }}
      />
    </Group>
  );
}

export default UnifiedBrushChart;
