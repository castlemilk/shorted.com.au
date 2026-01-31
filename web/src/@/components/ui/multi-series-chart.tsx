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
  type MultiOutputIndicator,
  normalizeToPercentChange,
  isOscillator,
  INDICATOR_METADATA,
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

// Indicator overlay type (extended for multi-output)
export type IndicatorOverlay = {
  config: IndicatorConfig;
  values: (number | null)[];
  timestamps?: Date[]; // Timestamps for matching values to filtered series
  multiOutput?: MultiOutputIndicator;
};

// Chart data for multi-series
export type MultiSeriesChartData = {
  series: ChartSeries[];
  viewMode: "absolute" | "normalized";
  indicators?: IndicatorOverlay[];
  hasDualAxis?: boolean;
  /** Show oscillator panel */
  showOscillatorPanel?: boolean;
};

type TooltipData = {
  date: Date;
  values: {
    stockCode: string;
    value: number;
    color: string;
    seriesType?: "shorts" | "market";
  }[];
  indicators: { label: string; value: number | null; color: string; isOscillator?: boolean }[];
  oscillators: { label: string; value: number | null; color: string }[];
};

// Styling constants
const brushMargin = { top: 10, bottom: 15, left: 50, right: 20 };
const chartSeparation = 30;
const oscillatorPanelHeight = 100;

export const background = `hsl(var(--background))`;
export const background2 = `hsl(var(--primary))`;

// Accessors
const getDate = (d: DataPoint): Date => d.timestamp;
const getValue = (d: DataPoint): number => d.value;

const bisectDateFn = bisector<DataPoint, Date>(getDate);
const bisectDate = (array: DataPoint[], date: Date, lo?: number, hi?: number) =>
  bisectDateFn.left(array, date, lo, hi);

// Helper to find indicator value by matching timestamp
const getIndicatorValueByTimestamp = (
  indicator: IndicatorOverlay,
  timestamp: Date,
  outputKey?: "primary" | "upper" | "middle" | "lower" | "signal" | "histogram" | "percentK" | "percentD" | "plusDI" | "minusDI"
): number | null => {
  if (!indicator.timestamps) {
    // Fallback to index-based lookup (legacy)
    return null;
  }

  const targetTime = timestamp.getTime();
  const index = indicator.timestamps.findIndex(
    (t) => t.getTime() === targetTime
  );

  if (index === -1) return null;

  if (outputKey && indicator.multiOutput) {
    const output = indicator.multiOutput[outputKey];
    if (output) return output[index] ?? null;
  }

  return indicator.values[index] ?? null;
};

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

    // Separate oscillator and overlay indicators
    const oscillatorIndicators = useMemo(() => {
      return (data.indicators ?? []).filter(
        (ind) => ind.config.enabled !== false && isOscillator(ind.config.type)
      );
    }, [data.indicators]);

    const overlayIndicators = useMemo(() => {
      return (data.indicators ?? []).filter(
        (ind) => ind.config.enabled !== false && !isOscillator(ind.config.type)
      );
    }, [data.indicators]);

    const showOscillatorPanel =
      data.showOscillatorPanel !== false && oscillatorIndicators.length > 0;

    const PATTERN_ID = "multi_series_brush_pattern";
    const GRADIENT_ID = "multi_series_brush_gradient";
    const BB_GRADIENT_ID = "bollinger_bands_gradient";

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
    const oscillatorHeight = showOscillatorPanel ? oscillatorPanelHeight : 0;
    const topChartBottomMargin = compact
      ? chartSeparation / 2
      : chartSeparation + 10;
    const topChartHeight = isMobile
      ? innerHeight - oscillatorHeight
      : 0.8 * innerHeight - topChartBottomMargin - oscillatorHeight;
    const bottomChartHeight = isMobile
      ? 0
      : innerHeight - topChartHeight - chartSeparation - oscillatorHeight;

    const svgHeight = isMobile
      ? topChartHeight + margin.top + margin.bottom + oscillatorHeight
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

    // Oscillator scale (0-100 or -100-0)
    const oscillatorScale = useMemo(() => {
      // Default to 0-100 for RSI/Stochastic
      return scaleLinear<number>({
        range: [oscillatorPanelHeight - 20, 10],
        domain: [0, 100],
      });
    }, []);

    // Williams %R scale (-100 to 0)
    const williamsRScale = useMemo(() => {
      return scaleLinear<number>({
        range: [oscillatorPanelHeight - 20, 10],
        domain: [-100, 0],
      });
    }, []);

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

        // Find overlay indicator values
        const indicatorValues =
          overlayIndicators?.map((ind) => {
            const series = filteredSeries.find(
              (s) => s.stockCode === ind.config.stockCode,
            );
            if (!series)
              return { label: "", value: null, color: ind.config.color };

            // Find closest point in the series to get its exact timestamp
            const index = bisectDate(series.points, date, 1);
            const d0 = series.points[index - 1];
            const d1 = series.points[index];
            let closestPoint = d0;
            if (d0 && d1) {
              closestPoint =
                date.valueOf() - getDate(d0).valueOf() >
                getDate(d1).valueOf() - date.valueOf()
                  ? d1
                  : d0;
            } else if (d1) {
              closestPoint = d1;
            }

            const value = closestPoint
              ? getIndicatorValueByTimestamp(ind, closestPoint.timestamp)
              : null;

            const metadata = INDICATOR_METADATA[ind.config.type];
            return {
              label: `${metadata?.shortName ?? ind.config.type}(${ind.config.period})`,
              value,
              color: ind.config.color,
            };
          }) ?? [];

        // Find oscillator values
        const oscillatorValues =
          oscillatorIndicators?.map((ind) => {
            const series = filteredSeries.find(
              (s) => s.stockCode === ind.config.stockCode,
            );
            if (!series)
              return { label: "", value: null, color: ind.config.color };

            // Find closest point in the series to get its exact timestamp
            const index = bisectDate(series.points, date, 1);
            const d0 = series.points[index - 1];
            const d1 = series.points[index];
            let closestPoint = d0;
            if (d0 && d1) {
              closestPoint =
                date.valueOf() - getDate(d0).valueOf() >
                getDate(d1).valueOf() - date.valueOf()
                  ? d1
                  : d0;
            } else if (d1) {
              closestPoint = d1;
            }

            const value = closestPoint
              ? getIndicatorValueByTimestamp(ind, closestPoint.timestamp)
              : null;

            const metadata = INDICATOR_METADATA[ind.config.type];
            return {
              label: `${metadata?.shortName ?? ind.config.type}(${ind.config.period})`,
              value,
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
            oscillators: oscillatorValues,
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
        overlayIndicators,
        oscillatorIndicators,
        adjustedMargin.left,
        getValueScale,
      ],
    );

    // Get Bollinger Bands indicator if present
    const bollingerBandsIndicator = useMemo(() => {
      return overlayIndicators.find(
        (ind) => ind.config.type === "BBANDS" && ind.multiOutput
      );
    }, [overlayIndicators]);

    if (width < 10 || allPoints.length === 0) return null;

    return (
      <div ref={containerRef} style={{ position: "relative" }}>
        <svg width={width} height={svgHeight}>
          <defs>
            <LinearGradient
              id={GRADIENT_ID}
              from={background}
              to={background2}
              toOffset={"1%"}
              rotate={180}
            />
            {/* Gradient for Bollinger Bands fill */}
            <linearGradient id={BB_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.1} />
              <stop offset="50%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.1} />
            </linearGradient>
          </defs>
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

            {/* Bollinger Bands fill area */}
            {bollingerBandsIndicator?.multiOutput?.upper &&
              bollingerBandsIndicator?.multiOutput?.lower && (() => {
                const series = filteredSeries.find(
                  (s) => s.stockCode === bollingerBandsIndicator.config.stockCode
                );
                if (!series) return null;

                const upperPoints = series.points
                  .map((point) => {
                    const upper = getIndicatorValueByTimestamp(bollingerBandsIndicator, point.timestamp, "upper");
                    if (upper === null) return null;
                    return { timestamp: point.timestamp, value: upper };
                  })
                  .filter((p): p is DataPoint => p !== null);

                const lowerPoints = series.points
                  .map((point) => {
                    const lower = getIndicatorValueByTimestamp(bollingerBandsIndicator, point.timestamp, "lower");
                    if (lower === null) return null;
                    return { timestamp: point.timestamp, value: lower };
                  })
                  .filter((p): p is DataPoint => p !== null);

                // Create area between upper and lower
                const areaPoints = [
                  ...upperPoints.map(p => ({ x: dateScale(p.timestamp), y: shortsValueScale(p.value) })),
                  ...lowerPoints.reverse().map(p => ({ x: dateScale(p.timestamp), y: shortsValueScale(p.value) })),
                ];

                if (areaPoints.length < 4) return null;

                return (
                  <path
                    d={`M ${areaPoints.map(p => `${p.x},${p.y}`).join(' L ')} Z`}
                    fill={`url(#${BB_GRADIENT_ID})`}
                    opacity={0.5}
                  />
                );
              })()}

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

            {/* Overlay indicator lines (non-oscillators) */}
            {overlayIndicators?.map((indicator, idx) => {
              const series = filteredSeries.find(
                (s) => s.stockCode === indicator.config.stockCode,
              );
              if (!series) return null;

              const metadata = INDICATOR_METADATA[indicator.config.type];

              // For multi-output indicators, render all outputs
              if (indicator.multiOutput && metadata?.hasMultipleOutputs) {
                const outputs = [];

                // Bollinger Bands: upper, middle, lower
                if (indicator.config.type === "BBANDS") {
                  const keys = ["upper", "middle", "lower"] as const;
                  keys.forEach((key) => {
                    const points = series.points
                      .map((point) => {
                        const value = getIndicatorValueByTimestamp(indicator, point.timestamp, key);
                        if (value === null) return null;
                        return { timestamp: point.timestamp, value };
                      })
                      .filter((p): p is DataPoint => p !== null);

                    const indicatorScale = getValueScale(series.seriesType);
                    const color = indicator.config.color;
                    const opacity = key === "middle" ? 1 : 0.7;
                    const dasharray = key === "middle" ? undefined : "4,2";

                    outputs.push(
                      <LinePath<DataPoint>
                        key={`indicator-${idx}-${key}`}
                        data={points}
                        x={(d) => dateScale(getDate(d)) ?? 0}
                        y={(d) => indicatorScale(getValue(d)) ?? 0}
                        stroke={color}
                        strokeWidth={key === "middle" ? 1.5 : 1}
                        strokeDasharray={dasharray}
                        opacity={opacity}
                        curve={curveMonotoneX}
                      />
                    );
                  });
                }
                // MACD: line, signal (histogram in separate panel)
                else if (indicator.config.type === "MACD") {
                  // Primary MACD line
                  const primaryPoints = series.points
                    .map((point) => {
                      const value = getIndicatorValueByTimestamp(indicator, point.timestamp, "primary");
                      if (value === null) return null;
                      return { timestamp: point.timestamp, value };
                    })
                    .filter((p): p is DataPoint => p !== null);

                  outputs.push(
                    <LinePath<DataPoint>
                      key={`indicator-${idx}-macd`}
                      data={primaryPoints}
                      x={(d) => dateScale(getDate(d)) ?? 0}
                      y={(d) => shortsValueScale(getValue(d)) ?? 0}
                      stroke={indicator.config.color}
                      strokeWidth={1.5}
                      curve={curveMonotoneX}
                    />
                  );

                  // Signal line
                  if (indicator.multiOutput?.signal) {
                    const signalPoints = series.points
                      .map((point) => {
                        const value = getIndicatorValueByTimestamp(indicator, point.timestamp, "signal");
                        if (value === null) return null;
                        return { timestamp: point.timestamp, value };
                      })
                      .filter((p): p is DataPoint => p !== null);

                    outputs.push(
                      <LinePath<DataPoint>
                        key={`indicator-${idx}-signal`}
                        data={signalPoints}
                        x={(d) => dateScale(getDate(d)) ?? 0}
                        y={(d) => shortsValueScale(getValue(d)) ?? 0}
                        stroke="#f59e0b"
                        strokeWidth={1.5}
                        strokeDasharray="4,2"
                        curve={curveMonotoneX}
                      />
                    );
                  }
                }
                // ADX: ADX line, +DI, -DI
                else if (indicator.config.type === "ADX") {
                  const adxOutputs = [] as React.ReactNode[];
                  const adxLines = [
                    { key: "primary" as const, color: indicator.config.color, label: "ADX" },
                    { key: "plusDI" as const, color: "#10b981", label: "+DI" },
                    { key: "minusDI" as const, color: "#ef4444", label: "-DI" },
                  ];

                  adxLines.forEach(({ key, color }) => {
                    const points = series.points
                      .map((point) => {
                        const value = getIndicatorValueByTimestamp(indicator, point.timestamp, key);
                        if (value === null) return null;
                        return { timestamp: point.timestamp, value };
                      })
                      .filter((p): p is DataPoint => p !== null);

                    adxOutputs.push(
                      <LinePath<DataPoint>
                        key={`indicator-${idx}-${key}`}
                        data={points}
                        x={(d) => dateScale(getDate(d)) ?? 0}
                        y={(d) => shortsValueScale(getValue(d)) ?? 0}
                        stroke={color}
                        strokeWidth={key === "primary" ? 2 : 1}
                        strokeDasharray={key === "primary" ? undefined : "3,2"}
                        curve={curveMonotoneX}
                      />
                    );
                  });

                  return adxOutputs;
                }

                return outputs;
              }

              // Single output indicator
              const indicatorPoints = series.points
                .map((point) => {
                  const value = getIndicatorValueByTimestamp(indicator, point.timestamp);
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

          {/* Oscillator Panel */}
          {showOscillatorPanel && (
            <Group
              top={adjustedMargin.top + topChartHeight + 10}
              left={adjustedMargin.left}
            >
              {/* Panel background */}
              <rect
                x={-5}
                y={-5}
                width={xMax + 10}
                height={oscillatorPanelHeight}
                fill="hsl(var(--muted))"
                fillOpacity={0.3}
                rx={4}
              />

              {/* Overbought/Oversold reference lines */}
              {/* RSI/Stochastic levels: 70/30 */}
              <Line
                from={{ x: 0, y: oscillatorScale(70) }}
                to={{ x: xMax, y: oscillatorScale(70) }}
                stroke="hsl(var(--destructive))"
                strokeWidth={1}
                strokeDasharray="3,3"
                opacity={0.5}
              />
              <Line
                from={{ x: 0, y: oscillatorScale(30) }}
                to={{ x: xMax, y: oscillatorScale(30) }}
                stroke="hsl(var(--primary))"
                strokeWidth={1}
                strokeDasharray="3,3"
                opacity={0.5}
              />
              {/* 50 line */}
              <Line
                from={{ x: 0, y: oscillatorScale(50) }}
                to={{ x: xMax, y: oscillatorScale(50) }}
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1}
                strokeDasharray="2,4"
                opacity={0.3}
              />

              {/* Labels */}
              <text
                x={xMax + 5}
                y={oscillatorScale(70) + 3}
                fontSize={9}
                fill="hsl(var(--destructive))"
                opacity={0.7}
              >
                70
              </text>
              <text
                x={xMax + 5}
                y={oscillatorScale(30) + 3}
                fontSize={9}
                fill="hsl(var(--primary))"
                opacity={0.7}
              >
                30
              </text>

              {/* Oscillator lines */}
              {oscillatorIndicators.map((indicator, idx) => {
                const series = filteredSeries.find(
                  (s) => s.stockCode === indicator.config.stockCode
                );
                if (!series) return null;

                const isWilliamsR = indicator.config.type === "WILLR";
                const scale = isWilliamsR ? williamsRScale : oscillatorScale;

                // For Stochastic, render both %K and %D
                if (indicator.config.type === "STOCH" && indicator.multiOutput) {
                  const stochOutputs = [];

                  // %K line
                  if (indicator.multiOutput.percentK) {
                    const kPoints = series.points
                      .map((point) => {
                        const value = getIndicatorValueByTimestamp(indicator, point.timestamp, "percentK");
                        if (value === null) return null;
                        return { timestamp: point.timestamp, value };
                      })
                      .filter((p): p is DataPoint => p !== null);

                    stochOutputs.push(
                      <LinePath<DataPoint>
                        key={`osc-${idx}-k`}
                        data={kPoints}
                        x={(d) => dateScale(getDate(d)) ?? 0}
                        y={(d) => scale(getValue(d)) ?? 0}
                        stroke={indicator.config.color}
                        strokeWidth={1.5}
                        curve={curveMonotoneX}
                      />
                    );
                  }

                  // %D line
                  if (indicator.multiOutput.percentD) {
                    const dPoints = series.points
                      .map((point) => {
                        const value = getIndicatorValueByTimestamp(indicator, point.timestamp, "percentD");
                        if (value === null) return null;
                        return { timestamp: point.timestamp, value };
                      })
                      .filter((p): p is DataPoint => p !== null);

                    stochOutputs.push(
                      <LinePath<DataPoint>
                        key={`osc-${idx}-d`}
                        data={dPoints}
                        x={(d) => dateScale(getDate(d)) ?? 0}
                        y={(d) => scale(getValue(d)) ?? 0}
                        stroke="#f59e0b"
                        strokeWidth={1}
                        strokeDasharray="3,2"
                        curve={curveMonotoneX}
                      />
                    );
                  }

                  return stochOutputs;
                }

                // Single line oscillator (RSI, Williams %R)
                const points = series.points
                  .map((point) => {
                    const value = getIndicatorValueByTimestamp(indicator, point.timestamp);
                    if (value === null) return null;
                    return { timestamp: point.timestamp, value };
                  })
                  .filter((p): p is DataPoint => p !== null);

                return (
                  <LinePath<DataPoint>
                    key={`osc-${idx}`}
                    data={points}
                    x={(d) => dateScale(getDate(d)) ?? 0}
                    y={(d) => scale(getValue(d)) ?? 0}
                    stroke={indicator.config.color}
                    strokeWidth={1.5}
                    curve={curveMonotoneX}
                  />
                );
              })}

              {/* Oscillator Y-axis */}
              <AxisLeft
                scale={oscillatorScale}
                stroke="hsl(var(--muted-foreground))"
                tickStroke="hsl(var(--muted-foreground))"
                numTicks={3}
                tickValues={[0, 50, 100]}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 9,
                  textAnchor: "end",
                  dx: -2,
                  dy: 3,
                })}
              />
            </Group>
          )}

          {/* Brush Chart */}
          {!isMobile && (
            <Group
              top={
                margin.top +
                topChartHeight +
                topChartBottomMargin +
                (showOscillatorPanel ? oscillatorPanelHeight + 10 : 0)
              }
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
                to={{
                  x: tooltipLeft,
                  y:
                    adjustedMargin.top +
                    topChartHeight +
                    (showOscillatorPanel ? oscillatorPanelHeight + 10 : 0),
                }}
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
              {/* Dots for oscillators */}
              {showOscillatorPanel &&
                tooltipData.oscillators.map((osc, idx) => {
                  if (osc.value === null) return null;
                  return (
                    <circle
                      key={`osc-dot-${idx}`}
                      cx={tooltipLeft}
                      cy={
                        adjustedMargin.top +
                        topChartHeight +
                        10 +
                        oscillatorScale(osc.value)
                      }
                      r={3}
                      fill={osc.color}
                      stroke="white"
                      strokeWidth={1.5}
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
              {/* Oscillator values */}
              {tooltipData.oscillators.length > 0 && (
                <>
                  <div className="border-t border-border my-1" />
                  {tooltipData.oscillators
                    .filter((i) => i.value !== null)
                    .map((osc, idx) => (
                      <div
                        key={`osc-${idx}`}
                        className="flex items-center gap-2"
                      >
                        <div
                          className="w-2 h-2 rounded-sm"
                          style={{ backgroundColor: osc.color }}
                        />
                        <span className="text-xs">{osc.label}</span>
                        <span
                          className="text-xs font-medium"
                          style={{ color: osc.color }}
                        >
                          {osc.value!.toFixed(1)}
                        </span>
                      </div>
                    ))}
                </>
              )}
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
