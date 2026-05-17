"use client";
import { useMemo, useCallback } from "react";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import { scaleTime, scaleLinear } from "@visx/scale";
import { Group } from "@visx/group";
import { LinePath, Line } from "@visx/shape";
import { AxisLeft, AxisRight, AxisBottom } from "@visx/axis";
import { GridRows, GridColumns } from "@visx/grid";
import { extent, bisector as makeBisector, max, min } from "@visx/vendor/d3-array";
import { curveMonotoneX } from "@visx/curve";
import {
  TooltipWithBounds,
  defaultStyles,
  useTooltip,
} from "@visx/tooltip";
import { localPoint } from "@visx/event";
import { timeFormat } from "@visx/vendor/d3-time-format";

export interface OverlayPoint {
  date: Date;
  price: number | null;
  shortPct: number | null;
}

interface ShortPriceOverlayChartProps {
  width: number;
  height: number;
  data: OverlayPoint[];
  stockCode: string;
}

const margin = { top: 24, right: 60, bottom: 36, left: 60 };

const PRICE_COLOR = "hsl(217, 91%, 60%)"; // blue-500
const SHORT_COLOR = "hsl(0, 84%, 60%)"; // red-500

const tooltipStyles = {
  ...defaultStyles,
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 12,
  color: "hsl(var(--foreground))",
  boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
};

const formatDate = timeFormat("%b %d, %Y");
const dateBisector = makeBisector<OverlayPoint, Date>((d) => d.date);
const bisectDate = (arr: OverlayPoint[], target: Date): number =>
  dateBisector.left(arr, target, 1);

function ChartInner({ width, height, data, stockCode }: ShortPriceOverlayChartProps) {
  const {
    tooltipOpen,
    tooltipLeft,
    tooltipTop,
    tooltipData,
    showTooltip,
    hideTooltip,
  } = useTooltip<OverlayPoint>();

  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = Math.max(0, height - margin.top - margin.bottom);

  const validPriceData = useMemo(
    () => data.filter((d) => d.price !== null && !Number.isNaN(d.price)),
    [data],
  );
  const validShortData = useMemo(
    () => data.filter((d) => d.shortPct !== null && !Number.isNaN(d.shortPct)),
    [data],
  );

  const xScale = useMemo(() => {
    const dom = extent(data, (d) => d.date) as [Date, Date];
    return scaleTime({
      range: [0, innerWidth],
      domain: dom,
    });
  }, [data, innerWidth]);

  const priceScale = useMemo(() => {
    const lo = min(validPriceData, (d) => d.price ?? 0) ?? 0;
    const hi = max(validPriceData, (d) => d.price ?? 0) ?? 1;
    const pad = (hi - lo) * 0.05 || 1;
    return scaleLinear({
      range: [innerHeight, 0],
      domain: [Math.max(0, lo - pad), hi + pad],
      nice: true,
    });
  }, [validPriceData, innerHeight]);

  const shortScale = useMemo(() => {
    const hi = max(validShortData, (d) => d.shortPct ?? 0) ?? 1;
    const pad = hi * 0.1 || 0.5;
    return scaleLinear({
      range: [innerHeight, 0],
      domain: [0, hi + pad],
      nice: true,
    });
  }, [validShortData, innerHeight]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGRectElement>) => {
      const { x } = localPoint(event) ?? { x: 0 };
      const adjustedX = x - margin.left;
      const x0 = xScale.invert(adjustedX);
      const index = bisectDate(data, x0);
      const d0 = data[index - 1];
      const d1 = data[index];
      let point = d0;
      if (d1 && d0) {
        point =
          x0.valueOf() - d0.date.valueOf() > d1.date.valueOf() - x0.valueOf()
            ? d1
            : d0;
      }
      if (!point) return;

      const priceY = point.price !== null ? priceScale(point.price) : null;
      const tooltipY = priceY ?? innerHeight / 2;

      showTooltip({
        tooltipData: point,
        tooltipLeft: xScale(point.date) + margin.left,
        tooltipTop: tooltipY + margin.top,
      });
    },
    [data, xScale, priceScale, innerHeight, showTooltip],
  );

  if (width < 10 || height < 10 || data.length === 0) return null;

  return (
    <div className="relative">
      <svg width={width} height={height}>
        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={priceScale}
            width={innerWidth}
            stroke="hsl(var(--border))"
            strokeOpacity={0.4}
            strokeDasharray="2,2"
          />
          <GridColumns
            scale={xScale}
            height={innerHeight}
            stroke="hsl(var(--border))"
            strokeOpacity={0.4}
            strokeDasharray="2,2"
          />

          {/* Price line (blue, left axis) */}
          <LinePath<OverlayPoint>
            data={validPriceData}
            x={(d) => xScale(d.date)}
            y={(d) => priceScale(d.price ?? 0)}
            stroke={PRICE_COLOR}
            strokeWidth={2}
            strokeOpacity={0.9}
            curve={curveMonotoneX}
          />

          {/* Short % line (red, right axis) */}
          <LinePath<OverlayPoint>
            data={validShortData}
            x={(d) => xScale(d.date)}
            y={(d) => shortScale(d.shortPct ?? 0)}
            stroke={SHORT_COLOR}
            strokeWidth={2}
            strokeOpacity={0.9}
            curve={curveMonotoneX}
            strokeDasharray="0"
          />

          <AxisLeft
            scale={priceScale}
            numTicks={5}
            tickFormat={(v) => `$${Number(v).toFixed(2)}`}
            stroke={PRICE_COLOR}
            tickStroke={PRICE_COLOR}
            tickLabelProps={{
              fill: PRICE_COLOR,
              fontSize: 10,
              textAnchor: "end",
              dx: -4,
              dy: 4,
            }}
          />

          <AxisRight
            scale={shortScale}
            left={innerWidth}
            numTicks={5}
            tickFormat={(v) => `${Number(v).toFixed(1)}%`}
            stroke={SHORT_COLOR}
            tickStroke={SHORT_COLOR}
            tickLabelProps={{
              fill: SHORT_COLOR,
              fontSize: 10,
              textAnchor: "start",
              dx: 4,
              dy: 4,
            }}
          />

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={width > 600 ? 8 : 4}
            stroke="hsl(var(--border))"
            tickStroke="hsl(var(--muted-foreground))"
            tickLabelProps={{
              fill: "hsl(var(--muted-foreground))",
              fontSize: 10,
              textAnchor: "middle",
              dy: 4,
            }}
          />

          {tooltipOpen && tooltipData && (
            <Line
              from={{ x: xScale(tooltipData.date), y: 0 }}
              to={{ x: xScale(tooltipData.date), y: innerHeight }}
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.3}
              strokeWidth={1}
              pointerEvents="none"
              strokeDasharray="4,2"
            />
          )}

          {tooltipOpen && tooltipData?.price !== null && tooltipData && (
            <circle
              cx={xScale(tooltipData.date)}
              cy={priceScale(tooltipData.price)}
              r={4}
              fill={PRICE_COLOR}
              stroke="white"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}

          {tooltipOpen && tooltipData?.shortPct !== null && tooltipData && (
            <circle
              cx={xScale(tooltipData.date)}
              cy={shortScale(tooltipData.shortPct)}
              r={4}
              fill={SHORT_COLOR}
              stroke="white"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}

          <rect
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => hideTooltip()}
          />
        </Group>
      </svg>

      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          top={tooltipTop}
          left={tooltipLeft}
          style={tooltipStyles}
        >
          <div className="font-mono text-[11px] text-muted-foreground">
            {formatDate(tooltipData.date)}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: PRICE_COLOR }}
            />
            <span className="text-foreground">
              {stockCode} price:{" "}
              <strong>
                {tooltipData.price !== null
                  ? `$${tooltipData.price.toFixed(2)}`
                  : "—"}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: SHORT_COLOR }}
            />
            <span className="text-foreground">
              Short %:{" "}
              <strong>
                {tooltipData.shortPct !== null
                  ? `${tooltipData.shortPct.toFixed(2)}%`
                  : "—"}
              </strong>
            </span>
          </div>
        </TooltipWithBounds>
      )}

      {/* Legend */}
      <div className="absolute right-3 top-1 flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: PRICE_COLOR }}
          />
          <span className="text-muted-foreground">Price (AUD)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: SHORT_COLOR }}
          />
          <span className="text-muted-foreground">Short %</span>
        </span>
      </div>
    </div>
  );
}

export function ShortPriceOverlayChart({
  data,
  stockCode,
  height = 360,
}: {
  data: OverlayPoint[];
  stockCode: string;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">
        No overlay data available
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full">
      <ParentSize>
        {({ width }) => (
          <ChartInner
            width={width}
            height={height}
            data={data}
            stockCode={stockCode}
          />
        )}
      </ParentSize>
    </div>
  );
}

export default ShortPriceOverlayChart;
