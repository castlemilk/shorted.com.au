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
import { max, min, extent, bisector } from "@visx/vendor/d3-array";
import { type BrushHandleRenderProps } from "@visx/brush/lib/BrushHandle";
import { LinePath, Line } from "@visx/shape";
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
import {
  type IndicatorConfig,
  normalizeToPercentChange,
} from "@/lib/technical-indicators";

// Data point type
export type DataPoint = {
  timestamp: Date;
  value: number;
};

// Series type for multi-stock chart
export type ChartSeries = {
  stockCode: string;
  color: string;
  points: DataPoint[];
  seriesType?: "shorts" | "market";
};

// Indicator overlay type
export type IndicatorOverlay = {
  config: IndicatorConfig;
  values: (number | null)[];
};

// Chart data for multi-series
export type MultiSeriesChartData = {
  series: ChartSeries[];
  viewMode: "absolute" | "normalized";
  indicators?: IndicatorOverlay[];
  hasDualAxis?: boolean;
};

type TooltipData = {
  date: Date;
  values: {
    stockCode: string;
    value: number;
    color: string;
    seriesType?: "shorts" | "market";
  }[];
  indicators: { label: string; value: number | null; color: string }[];
};

// Styling constants
const brushMargin = { top: 10, bottom: 15, left: 50, right: 20 };
const chartSeparation = 30;

export const background = `hsl(var(--background))`;
export const background2 = `hsl(var(--primary))`;

// Accessors
const getDate = (d: DataPoint): Date => d.timestamp;
const getValue = (d: DataPoint): number => d.value;

const bisectDateFn = bisector<DataPoint, Date>(getDate);
const bisectDate = (array: DataPoint[], date: Date, lo?: number, hi?: number) =>
  bisectDateFn.left(array, date, lo, hi);

const formatDate = timeFormat("%b %d, '%y");
const formatValue = (value: number, isPercent: boolean) =>
  isPercent
    ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
    : `${value.toFixed(3)}%`;
const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export type HandleBrushClearAndReset = { clear: () => void; reset: () => void };

export type MultiSeriesChartProps = {
  width: number;
  height: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  compact?: boolean;
  data: MultiSeriesChartData;
};

const MultiSeriesChart = forwardRef<
  HandleBrushClearAndReset,
  MultiSeriesChartProps
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
    const isNormalized = data.viewMode === "normalized";
    const hasDualAxis = data.hasDualAxis ?? false;

    const PATTERN_ID = "multi_series_brush_pattern";
    const GRADIENT_ID = "multi_series_brush_gradient";

    const selectedBrushStyle = {
      fill: `url(#${PATTERN_ID})`,
      stroke: "hsl(var(--primary))",
    };

    const tooltipStyles = {
      ...defaultStyles,
      background,
      border: "2px solid hsl(var(--border))",
      color: "hsl(var(--foreground))",
    };

    const { containerRef } = useTooltipInPortal({
      scroll: true,
      detectBounds: true,
    });

    const {
      tooltipData,
      tooltipLeft = 0,
      showTooltip,
      hideTooltip,
    } = useTooltip<TooltipData>({
      tooltipOpen: false,
      tooltipData: undefined,
    });

    const brushRef = useRef<BaseBrush | null>(null);

    // Process data - normalize if needed
    const processedSeries = useMemo((): ChartSeries[] => {
      if (!data.series || data.series.length === 0) return [];

      return data.series.map((series): ChartSeries => {
        if (isNormalized) {
          const values = series.points.map((p) => p.value);
          const normalizedValues = normalizeToPercentChange(values);
          return {
            ...series,
            points: series.points.map(
              (p, i): DataPoint => ({
                timestamp: p.timestamp,
                value: normalizedValues[i] ?? p.value,
              }),
            ),
          };
        }
        return series;
      });
    }, [data.series, isNormalized]);

    // Separate shorts and market series
    const shortsSeries = useMemo(() => {
      return processedSeries.filter(
        (s) => !s.seriesType || s.seriesType === "shorts",
      );
    }, [processedSeries]);

    const marketSeries = useMemo(() => {
      return processedSeries.filter((s) => s.seriesType === "market");
    }, [processedSeries]);

    // Get all points for calculating scales
    const allPoints = useMemo(() => {
      return processedSeries.flatMap((s) => s.points);
    }, [processedSeries]);

    // Get shorts and market points separately for dual axis
    const shortsPoints = useMemo(() => {
      return shortsSeries.flatMap((s) => s.points);
    }, [shortsSeries]);

    const marketPoints = useMemo(() => {
      return marketSeries.flatMap((s) => s.points);
    }, [marketSeries]);

    // Filtered data for zoom
    const [filteredSeries, setFilteredSeries] = useState(processedSeries);

    useEffect(() => {
      setFilteredSeries(processedSeries);
    }, [processedSeries]);

    const filteredPoints = useMemo(() => {
      return filteredSeries.flatMap((s) => s.points);
    }, [filteredSeries]);

    const filteredShortsPoints = useMemo(() => {
      return filteredSeries
        .filter((s) => !s.seriesType || s.seriesType === "shorts")
        .flatMap((s) => s.points);
    }, [filteredSeries]);

    const filteredMarketPoints = useMemo(() => {
      return filteredSeries
        .filter((s) => s.seriesType === "market")
        .flatMap((s) => s.points);
    }, [filteredSeries]);

    const onBrushChange = useCallback(
      (domain: Bounds | null) => {
        if (!domain) return;
        const { x0, x1 } = domain;
        const filtered: ChartSeries[] = processedSeries.map((series) => ({
          ...series,
          points: series.points.filter((d: DataPoint) => {
            const x = getDate(d).getTime();
            return x >= x0 && x <= x1;
          }),
        }));
        setFilteredSeries(filtered);
      },
      [processedSeries],
    );

    // Calculate heights
    const innerHeight = height - margin.top - margin.bottom;
    const topChartBottomMargin = compact
      ? chartSeparation / 2
      : chartSeparation + 10;
    const topChartHeight = isMobile
      ? innerHeight
      : 0.8 * innerHeight - topChartBottomMargin;
    const bottomChartHeight = isMobile
      ? 0
      : innerHeight - topChartHeight - chartSeparation;

    const svgHeight = isMobile
      ? topChartHeight + margin.top + margin.bottom
      : height;

    // Adjust margins for dual axis (need more space on right)
    const adjustedMargin = hasDualAxis ? { ...margin, right: 60 } : margin;

    // bounds
    const xMax = Math.max(
      width - adjustedMargin.left - adjustedMargin.right,
      0,
    );
    const yMax = Math.max(topChartHeight, 0);
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
          domain: extent(filteredPoints, getDate) as [Date, Date],
        }),
      [xMax, filteredPoints],
    );

    // Left axis scale (for shorts data)
    const shortsValueScale = useMemo(() => {
      if (hasDualAxis && filteredShortsPoints.length > 0) {
        const minVal = min(filteredShortsPoints, getValue) ?? 0;
        const maxVal = max(filteredShortsPoints, getValue) ?? 0;
        const padding = (maxVal - minVal) * 0.1;

        return scaleLinear<number>({
          range: [yMax, 0],
          domain: [
            isNormalized
              ? Math.min(minVal - padding, -5)
              : Math.max(0, minVal - padding),
            maxVal + padding,
          ],
          nice: true,
        });
      }
      // Fallback to combined scale if no dual axis
      const minVal = min(filteredPoints, getValue) ?? 0;
      const maxVal = max(filteredPoints, getValue) ?? 0;
      const padding = (maxVal - minVal) * 0.1;

      return scaleLinear<number>({
        range: [yMax, 0],
        domain: [
          isNormalized
            ? Math.min(minVal - padding, -5)
            : Math.max(0, minVal - padding),
          maxVal + padding,
        ],
        nice: true,
      });
    }, [yMax, filteredPoints, filteredShortsPoints, isNormalized, hasDualAxis]);

    // Right axis scale (for market data)
    const marketValueScale = useMemo(() => {
      if (!hasDualAxis || filteredMarketPoints.length === 0) {
        return shortsValueScale; // Fallback to shorts scale
      }
      const minVal = min(filteredMarketPoints, getValue) ?? 0;
      const maxVal = max(filteredMarketPoints, getValue) ?? 0;
      const padding = (maxVal - minVal) * 0.1;

      return scaleLinear<number>({
        range: [yMax, 0],
        domain: [Math.max(0, minVal - padding), maxVal + padding],
        nice: true,
      });
    }, [yMax, filteredMarketPoints, hasDualAxis, shortsValueScale]);

    // Use appropriate scale based on series type
    const getValueScale = (seriesType?: "shorts" | "market") => {
      if (hasDualAxis) {
        return seriesType === "market" ? marketValueScale : shortsValueScale;
      }
      return shortsValueScale;
    };

    const valueScale = shortsValueScale; // Keep for backward compatibility

    const brushDateScale = useMemo(
      () =>
        scaleTime<number>({
          range: [0, xBrushMax],
          domain: extent(allPoints, getDate) as [Date, Date],
        }),
      [xBrushMax, allPoints],
    );

    const brushValueScale = useMemo(() => {
      const minVal = min(allPoints, getValue) ?? 0;
      const maxVal = max(allPoints, getValue) ?? 0;

      return scaleLinear({
        range: [yBrushMax, 0],
        domain: [
          isNormalized ? Math.min(minVal, -5) : Math.max(0, minVal),
          maxVal,
        ],
        nice: true,
      });
    }, [yBrushMax, allPoints, isNormalized]);

    const initialBrushPosition = useMemo(() => {
      if (allPoints.length === 0)
        return { start: { x: 0 }, end: { x: xBrushMax } };

      const startIdx = Math.max(
        0,
        allPoints.length - Math.floor(allPoints.length * 0.2),
      );
      const startPoint = allPoints[startIdx];
      const endPoint = allPoints[allPoints.length - 1];

      if (!startPoint || !endPoint)
        return { start: { x: 0 }, end: { x: xBrushMax } };

      return {
        start: { x: brushDateScale(getDate(startPoint)) },
        end: { x: brushDateScale(getDate(endPoint)) },
      };
    }, [brushDateScale, allPoints, xBrushMax]);

    useImperativeHandle(innerRef, () => ({
      clear() {
        if (brushRef?.current) {
          setFilteredSeries(processedSeries);
          brushRef.current.reset();
        }
      },
      reset() {
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
      },
    }));

    const handlePointerMove = useCallback(
      (
        event:
          | React.TouchEvent<SVGRectElement>
          | React.MouseEvent<SVGRectElement>,
      ) => {
        const { x } = localPoint(event) ?? { x: 0 };
        const chartX = x - adjustedMargin.left;
        const date = dateScale.invert(chartX);

        // Find values for each series at this date
        const values = filteredSeries.map((series) => {
          const index = bisectDate(series.points, date, 1);
          const d0 = series.points[index - 1];
          const d1 = series.points[index];
          let d = d0;
          if (d0 && d1) {
            d =
              date.valueOf() - getDate(d0).valueOf() >
              getDate(d1).valueOf() - date.valueOf()
                ? d1
                : d0;
          } else if (d1) {
            d = d1;
          }
          return {
            stockCode: series.stockCode.replace("PRICE:", ""),
            value: d ? getValue(d) : 0,
            color: series.color,
            seriesType: series.seriesType,
          };
        });

        // Find indicator values at this date
        const indicatorValues =
          data.indicators?.map((ind) => {
            // Find the index in the original series
            const series = filteredSeries.find(
              (s) => s.stockCode === ind.config.stockCode,
            );
            if (!series)
              return { label: "", value: null, color: ind.config.color };

            const index = bisectDate(series.points, date, 1);
            const adjustedIndex = Math.min(index, ind.values.length - 1);

            return {
              label: `${ind.config.type}(${ind.config.period})`,
              value: ind.values[adjustedIndex] ?? null,
              color: ind.config.color,
            };
          }) ?? [];

        const firstValue = values[0];
        const tooltipY = firstValue
          ? getValueScale(firstValue.seriesType)(firstValue.value)
          : valueScale(0);

        showTooltip({
          tooltipData: {
            date,
            values,
            indicators: indicatorValues,
          },
          tooltipLeft: x,
          tooltipTop: tooltipY,
        });
      },
      [
        showTooltip,
        valueScale,
        dateScale,
        filteredSeries,
        data.indicators,
        adjustedMargin.left,
        getValueScale,
      ],
    );

    if (width < 10 || allPoints.length === 0) return null;

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
          <Group top={adjustedMargin.top} left={adjustedMargin.left}>
            {/* Zero line for normalized view (only for shorts data) */}
            {isNormalized && shortsSeries.length > 0 && (
              <Line
                from={{ x: 0, y: shortsValueScale(0) }}
                to={{ x: xMax, y: shortsValueScale(0) }}
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1}
                strokeDasharray="4,4"
                opacity={0.5}
              />
            )}

            {/* Stock lines */}
            {filteredSeries.map((series) => {
              const scale = getValueScale(series.seriesType);
              return (
                <LinePath<DataPoint>
                  key={series.stockCode}
                  data={series.points}
                  x={(d) => dateScale(getDate(d)) ?? 0}
                  y={(d) => scale(getValue(d)) ?? 0}
                  stroke={series.color}
                  strokeWidth={2}
                  curve={curveMonotoneX}
                />
              );
            })}

            {/* Indicator lines */}
            {data.indicators?.map((indicator, idx) => {
              const series = filteredSeries.find(
                (s) => s.stockCode === indicator.config.stockCode,
              );
              if (!series || !indicator.config.enabled) return null;

              // Create points for indicator line
              const indicatorPoints = series.points
                .map((point, i) => {
                  const value = indicator.values[i];
                  if (value === null) return null;
                  return { timestamp: point.timestamp, value };
                })
                .filter((p): p is DataPoint => p !== null);

              const indicatorScale = getValueScale(series.seriesType);

              return (
                <LinePath<DataPoint>
                  key={`indicator-${idx}`}
                  data={indicatorPoints}
                  x={(d) => dateScale(getDate(d)) ?? 0}
                  y={(d) => indicatorScale(getValue(d)) ?? 0}
                  stroke={indicator.config.color}
                  strokeWidth={1.5}
                  strokeDasharray="4,2"
                  curve={curveMonotoneX}
                />
              );
            })}

            {/* Hover area */}
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

            {/* Left Y-axis (shorts data) */}
            <AxisLeft
              scale={shortsValueScale}
              stroke="hsl(var(--muted-foreground))"
              tickStroke="hsl(var(--muted-foreground))"
              numTicks={5}
              tickFormat={(value) =>
                isNormalized
                  ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`
                  : `${Number(value).toFixed(2)}%`
              }
              tickLabelProps={() => ({
                fill: "hsl(var(--muted-foreground))",
                fontSize: 11,
                textAnchor: "end",
                dx: -4,
                dy: 3,
              })}
            />

            {/* Right Y-axis (market data) - only when dual axis */}
            {hasDualAxis && marketSeries.length > 0 && (
              <AxisLeft
                scale={marketValueScale}
                left={xMax}
                stroke="hsl(var(--muted-foreground))"
                tickStroke="hsl(var(--muted-foreground))"
                numTicks={5}
                tickFormat={(value) => formatPrice(Number(value))}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 11,
                  textAnchor: "start",
                  dx: 4,
                  dy: 3,
                })}
              />
            )}
            {!compact && (
              <AxisBottom
                top={yMax}
                scale={dateScale}
                stroke="hsl(var(--muted-foreground))"
                tickStroke="hsl(var(--muted-foreground))"
                numTicks={isMobile ? 4 : 8}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 11,
                  textAnchor: "middle",
                  dy: 4,
                })}
              />
            )}
          </Group>

          {/* Brush Chart */}
          {!isMobile && (
            <Group
              top={margin.top + topChartHeight + topChartBottomMargin}
              left={brushMargin.left}
            >
              {/* Mini lines for brush */}
              {processedSeries.map((series) => (
                <LinePath<DataPoint>
                  key={`brush-${series.stockCode}`}
                  data={series.points}
                  x={(d) => brushDateScale(getDate(d)) ?? 0}
                  y={(d) => brushValueScale(getValue(d)) ?? 0}
                  stroke={series.color}
                  strokeWidth={1}
                  curve={curveMonotoneX}
                  opacity={0.6}
                />
              ))}

              <PatternLines
                id={PATTERN_ID}
                height={8}
                width={8}
                stroke="hsl(var(--primary))"
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
                onClick={() => setFilteredSeries(processedSeries)}
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
                from={{ x: tooltipLeft, y: adjustedMargin.top }}
                to={{ x: tooltipLeft, y: adjustedMargin.top + topChartHeight }}
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1}
                pointerEvents="none"
                strokeDasharray="4,2"
              />
              {/* Dots for each series */}
              {tooltipData.values.map((v) => {
                const scale = getValueScale(v.seriesType);
                return (
                  <circle
                    key={v.stockCode}
                    cx={tooltipLeft}
                    cy={adjustedMargin.top + scale(v.value)}
                    r={4}
                    fill={v.color}
                    stroke="white"
                    strokeWidth={2}
                    pointerEvents="none"
                  />
                );
              })}
            </g>
          )}
        </svg>

        {/* Tooltip */}
        {tooltipData && (
          <TooltipWithBounds
            key={Math.random()}
            top={adjustedMargin.top + 10}
            left={tooltipLeft}
            style={{
              ...tooltipStyles,
              borderRadius: "8px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              padding: "0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                backgroundColor: "hsl(var(--primary))",
                height: "3px",
                width: "100%",
              }}
            />
            <div className="flex flex-col gap-1 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {formatDate(tooltipData.date)}
              </p>
              {tooltipData.values.map((v) => {
                const isMarket = v.seriesType === "market";
                const displayValue = isMarket
                  ? formatPrice(v.value)
                  : formatValue(v.value, isNormalized);
                return (
                  <div key={v.stockCode} className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: v.color }}
                    />
                    <span className="text-xs font-medium">
                      {v.stockCode}
                      {isMarket && " (Price)"}
                      {!isMarket && " (Shorts)"}
                    </span>
                    <span
                      className="text-sm font-bold"
                      style={{ color: v.color }}
                    >
                      {displayValue}
                    </span>
                  </div>
                );
              })}
              {tooltipData.indicators
                .filter((i) => i.value !== null)
                .map((ind, idx) => (
                  <div key={idx} className="flex items-center gap-2 opacity-75">
                    <div
                      className="w-2 h-2 rounded-full border"
                      style={{ borderColor: ind.color }}
                    />
                    <span className="text-xs">{ind.label}</span>
                    <span className="text-xs" style={{ color: ind.color }}>
                      {formatValue(ind.value!, isNormalized)}
                    </span>
                  </div>
                ))}
            </div>
          </TooltipWithBounds>
        )}
      </div>
    );
  },
);

MultiSeriesChart.displayName = "MultiSeriesChart";

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

export default MultiSeriesChart;
