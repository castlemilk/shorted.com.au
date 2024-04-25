"use client";
import React, {
  useRef,
  useState,
  useMemo,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
  type RefAttributes,
  type RefObject,
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
import AreaChart from "./areaChart";
import {
  type TimeSeriesData,
  TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { type PlainMessage } from "@bufbuild/protobuf";
import {
  TooltipWithBounds,
  defaultStyles,
  Tooltip,
  withTooltip,
} from "@visx/tooltip";
import { localPoint } from "@visx/event";
import { Line } from "@visx/shape";
import { timeFormat } from "@visx/vendor/d3-time-format";
import { type WithTooltipProvidedProps } from "@visx/tooltip/lib/enhancers/withTooltip";
type TooltipData = PlainMessage<TimeSeriesPoint> | null;
// Initialize some variables
const brushMargin = { top: 10, bottom: 15, left: 50, right: 20 };
const chartSeparation = 30;
const PATTERN_ID = "brush_pattern";
const GRADIENT_ID = "brush_gradient";
export const accentColor = "hsl(var(--foreground))";
export const background = `hsl(var(--background))`;
export const background2 = `hsl(var(--primary))`;
export const accentColorDark = "hsl(var(--primary))";
const selectedBrushStyle = {
  fill: `url(#${PATTERN_ID})`,
  stroke: "hsl(var(--foreground))",
};
const tooltipStyles = {
  ...defaultStyles,
  background,
  border: "1px solid hsl(var(--primary))",
  color: "hsl(var(--primary))",
};

// accessors
const getDate = (d: PlainMessage<TimeSeriesPoint> | undefined) =>
  d ? new Date(Number(d.timestamp?.seconds) * 1000) : new Date();
const getStockValue = (d: PlainMessage<TimeSeriesPoint> | undefined) =>
  d ? d.shortPosition ?? 0 : 0;
// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<TooltipData, Date>(
  (d) => new Date(Number(d?.timestamp?.seconds) * 1000),
).left;

const formatDate = timeFormat("%b %d, '%y");

export type HandleBrushClearAndReset = { clear: () => void; reset: () => void };
type BrushChartProps = BrushProps & RefAttributes<HandleBrushClearAndReset>;
export type BrushProps = {
  width: number;
  height: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  compact?: boolean;
  data: PlainMessage<TimeSeriesData>;
  onClearClick?: () => void;
  onResetClick?: () => void;
};

const BrushChart = withTooltip<BrushChartProps, TooltipData>(
  forwardRef<
    HandleBrushClearAndReset,
    BrushProps & WithTooltipProvidedProps<TooltipData>
  >(
    (
      {
        compact = false,
        data,
        width,
        height,
        margin = { top: 0, right: 0, bottom: 0, left: 0 },
        showTooltip,
        hideTooltip,
        tooltipData,
        tooltipTop = 0,
        tooltipLeft = 0,
      },
      ref,
    ) => {
      if (width < 10) return null;
      const brushRef = useRef<BaseBrush | null>(null);
      const [filteredStock, setFilteredStock] = useState(data.points);
      useEffect(() => {
        setFilteredStock(data.points);
      }, [data]);

      const onBrushChange = (domain: Bounds | null) => {
        if (!domain) return;
        const { x0, x1, y0, y1 } = domain;
        const stockCopy = data.points.filter((s) => {
          const x = getDate(s).getTime();
          const y = getStockValue(s);
          return x > x0 && x < x1 && y > y0 && y < y1;
        });
        setFilteredStock(stockCopy);
      };

      const innerHeight = height - margin.top - margin.bottom;
      const topChartBottomMargin = compact
        ? chartSeparation / 2
        : chartSeparation + 10;
      const topChartHeight = 0.8 * innerHeight - topChartBottomMargin;
      const bottomChartHeight = innerHeight - topChartHeight - chartSeparation;

      // bounds
      const xMax = Math.max(width - margin.left - margin.right, 0);
      const yMax = Math.max(topChartHeight, 0);
      const xBrushMax = Math.max(
        width - brushMargin.left - brushMargin.right,
        0,
      );
      const yBrushMax = Math.max(
        bottomChartHeight - brushMargin.top - brushMargin.bottom,
        0,
      );

      // scales
      const dateScale = useMemo(
        () =>
          scaleTime<number>({
            range: [0, xMax],
            domain: extent(filteredStock, getDate) as [Date, Date],
          }),
        [xMax, filteredStock, data],
      );
      const stockScale = useMemo(
        () =>
          scaleLinear<number>({
            range: [yMax, 0],
            domain: [0, max(filteredStock, getStockValue) ?? 0],
            nice: true,
          }),
        [yMax, filteredStock, data],
      );
      const brushDateScale = useMemo(
        () =>
          scaleTime<number>({
            range: [0, xBrushMax],
            domain: extent(data.points, getDate) as [Date, Date],
          }),
        [xBrushMax, data],
      );
      const brushStockScale = useMemo(
        () =>
          scaleLinear({
            range: [yBrushMax, 0],
            domain: [0, max(data.points, getStockValue) ?? 0],
            nice: true,
          }),
        [yBrushMax, data],
      );

      const initialBrushPosition = useMemo(
        () => ({
          start: {
            x: brushDateScale(
              getDate(data.points?.at(-1) ?? new TimeSeriesPoint()),
            ),
          },
          end: {
            x: brushDateScale(
              getDate(
                data.points?.[Math.round(data.points.length * 0.8)] ??
                  new TimeSeriesPoint(),
              ),
            ),
          },
        }),
        [brushDateScale, data.points],
      );
      useImperativeHandle(ref, () => ({
        // event handlers
        clear() {
          console.log("clear inside brushChart");
          handleClearClick();
        },
        reset() {
          handleResetClick();
        },
      }));

      const handleClearClick = () => {
        if (brushRef?.current) {
          setFilteredStock(data.points);
          brushRef.current.reset();
        }
      };

      // tooltip handler
      const handleTooltip = useCallback(
        (
          event:
            | React.TouchEvent<SVGRectElement>
            | React.MouseEvent<SVGRectElement>,
        ) => {
          const { x } = localPoint(event) ?? { x: 0 };
          const x0 = dateScale.invert(x);
          const index = bisectDate(data.points, x0, 1);
          const d0 = data.points[index - 1];
          const d1 = data.points[index];
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
            tooltipTop: stockScale(getStockValue(d)),
          });
        },
        [showTooltip, stockScale, dateScale],
      );

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

      return (
        <div>
          <svg width={width} height={height}>
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
              height={height}
              fill={`url(#${GRADIENT_ID})`}
              rx={14}
            />
            <AreaChart
              hideBottomAxis={compact}
              data={filteredStock}
              width={width}
              margin={{ ...margin, bottom: topChartBottomMargin }}
              yMax={yMax}
              xScale={dateScale}
              yScale={stockScale}
              gradientColor={background2}
              onTouchStart={handleTooltip}
              onTouchMove={handleTooltip}
              onMouseMove={handleTooltip}
              onMouseLeave={() => hideTooltip()}
            />
            <AreaChart
              hideBottomAxis
              hideLeftAxis
              data={data.points}
              width={width}
              yMax={yBrushMax}
              xScale={brushDateScale}
              yScale={brushStockScale}
              margin={brushMargin}
              top={topChartHeight + topChartBottomMargin + margin.top}
              gradientColor={background2}
            >
              <PatternLines
                id={PATTERN_ID}
                height={8}
                width={8}
                stroke={accentColor}
                strokeWidth={1}
                orientation={["diagonal"]}
              />
              <Brush
                xScale={brushDateScale}
                yScale={brushStockScale}
                width={xBrushMax}
                height={yBrushMax}
                margin={brushMargin}
                handleSize={8}
                innerRef={brushRef}
                resizeTriggerAreas={["left", "right"]}
                brushDirection="horizontal"
                initialBrushPosition={initialBrushPosition}
                onChange={onBrushChange}
                onClick={() => setFilteredStock(data.points)}
                selectedBoxStyle={selectedBrushStyle}
                useWindowMoveEvents
                renderBrushHandle={(props) => <BrushHandle {...props} />}
              />
            </AreaChart>
            {tooltipData && (
              <g>
                <Line
                  from={{ x: tooltipLeft ?? 0, y: margin.top }}
                  to={{
                    x: tooltipLeft ?? 0,
                    y: innerHeight + margin.top,
                  }}
                  stroke={accentColorDark}
                  strokeWidth={2}
                  pointerEvents="none"
                  strokeDasharray="5,2"
                />
                <circle
                  cx={tooltipLeft ?? 0}
                  cy={(tooltipTop ?? 0) + 1}
                  r={4}
                  fill="black"
                  fillOpacity={0.1}
                  stroke="black"
                  strokeOpacity={0.1}
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <circle
                  cx={tooltipLeft ?? 0}
                  cy={tooltipTop ?? 0}
                  r={4}
                  fill={accentColorDark}
                  stroke="white"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              </g>
            )}
          </svg>
          {tooltipData && (
            <div>
              <TooltipWithBounds
                key={Math.random()}
                top={tooltipTop - 12}
                left={(tooltipLeft ?? 0) + 12}
                style={tooltipStyles}
              >
                <p>{`${getStockValue(tooltipData).toFixed(3)}%`}</p>
              </TooltipWithBounds>
              <Tooltip
                top={innerHeight + margin.top - 130}
                left={tooltipLeft}
                style={{
                  ...defaultStyles,
                  minWidth: 72,
                  textAlign: "center",
                  transform: "translateX(-50%)",
                }}
              >
                {formatDate(getDate(tooltipData))}
              </Tooltip>
            </div>
          )}
        </div>
      );
    },
  ),
);
// We need to manually offset the handles for them to be rendered at the right position
function BrushHandle({ x, height, isBrushActive }: BrushHandleRenderProps) {
  const pathWidth = 8;
  const pathHeight = 15;
  if (!isBrushActive) {
    return null;
  }
  return (
    <Group left={x + pathWidth / 2} top={(height - pathHeight) / 2}>
      <path
        fill="#f2f2f2"
        d="M -4.5 0.5 L 3.5 0.5 L 3.5 15.5 L -4.5 15.5 L -4.5 0.5 M -1.5 4 L -1.5 12 M 0.5 4 L 0.5 12"
        stroke="hsl(var(--foreground))"
        strokeWidth="1"
        style={{ cursor: "ew-resize" }}
      />
    </Group>
  );
}

export default BrushChart;
