import { timeFormat } from "@visx/vendor/d3-time-format";
import { useState, useEffect, useRef, useLayoutEffect } from "react";

import { LineSeries, XYChart, Tooltip, GlyphSeries } from "@visx/xychart";
import { GlyphCircle } from "@visx/glyph";
import {
  type TimeSeriesPoint,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { ParentSize } from "@visx/responsive";
import { Skeleton } from "~/@/components/ui/skeleton";

type TimeSeriesPointData = TimeSeriesPoint;

const accessors = {
  xAccessor: (d: TimeSeriesPointData | undefined): Date => {
    if (!d) return new Date();
    if (!d.timestamp) return new Date();
    const timestamp: Timestamp = d.timestamp;
    const seconds = timestamp.seconds ?? 0;
    return new Date(Number(seconds) * 1000) || new Date();
  },
  yAccessor: (d: TimeSeriesPointData | undefined): number => {
    return d ? d.shortPosition || 0 : 0;
  },
};

const formatDate = timeFormat("%b %d, '%y");
interface SparklineProps {
  width: number;
  height: number;
  data: TimeSeriesData;
  margin?: { top: number; right: number; bottom: number; left: number };
}
const strokeColor = "var(--line-stroke)";
const redColor = `var(--red)`;
const greenColor = `var(--green)`;

const Chart = ({ width, height, data }: SparklineProps) => {
  const points = data.points ?? [];
  if (points.length === 0) {
    return <div>Loading or no data available...</div>;
  }

  // Calculate the min and max values
  const minY = Math.min(...points.map(accessors.yAccessor));
  const maxY = Math.max(...points.map(accessors.yAccessor));

  // Calculate the padding (e.g., 10% of the range)
  const padding = (maxY - minY) * 0.1;

  return (
    <XYChart
      width={width}
      height={height}
      margin={{ top: 40, right: 10, bottom: 20, left: 10 }}
      xScale={{ type: "time" }}
      yScale={{
        type: "linear",
        domain: [minY - padding, maxY + padding],
      }}
    >
      <LineSeries
        dataKey="Shorts"
        data={points}
        {...accessors}
        stroke={strokeColor}
        strokeWidth={1.5}
      />
      {/* Remove the GlyphSeries for regular points */}
      {data.min && (
        <GlyphSeries
          dataKey="Min"
          data={[data.min]}
          {...accessors}
          renderGlyph={({ x, y }) => (
            <GlyphCircle
              left={x}
              top={y}
              size={20}
              fill={greenColor}
              stroke={greenColor}
            />
          )}
        />
      )}
      {data.max && (
        <GlyphSeries
          dataKey="Max"
          data={[data.max]}
          {...accessors}
          renderGlyph={({ x, y }) => (
            <GlyphCircle
              left={x}
              top={y}
              size={20}
              fill={redColor}
              stroke={redColor}
            />
          )}
        />
      )}
      <Tooltip
        snapTooltipToDatumX
        snapTooltipToDatumY
        showSeriesGlyphs
        renderGlyph={({ x, y, datum }) => {
          const minPoint = data.min;
          const maxPoint = data.max;
          const isMin = datum === minPoint;
          const isMax = datum === maxPoint;
          return (
            <g>
              <circle
                cx={x}
                cy={y}
                r={3}
                fill={isMin ? greenColor : isMax ? redColor : strokeColor}
                strokeWidth={0}
              />
            </g>
          );
        }}
        renderTooltip={({ tooltipData }) => {
          const datum = tooltipData?.nearestDatum?.datum as TimeSeriesPoint;
          return (
            <>
              <div style={{ fontWeight: "600" }}>
                {formatDate(accessors.xAccessor(datum))}
              </div>
              <div
                style={{ color: "#2563EB" }}
              >{`${accessors.yAccessor(datum).toFixed(2)}%`}</div>
            </>
          );
        }}
      />
    </XYChart>
  );
};

type SparkLineStrategy = "parent" | "observer";

interface SparkLineProps {
  data: TimeSeriesData;
  height?: number;
  minWidth?: number;
  strategy?: SparkLineStrategy;
}

const SparkLine = ({
  data,
  height = 140,
  minWidth,
  strategy = "parent",
}: SparkLineProps) => {
  if (strategy === "observer") {
    const containerRef = useRef<HTMLDivElement>(null);
    const widthRef = useRef<number>(0);
    const [width, setWidth] = useState<number>(0);
    const [ready, setReady] = useState(false);

    useLayoutEffect(() => {
      const node = containerRef.current;
      if (!node) return;

      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextWidth = entry.contentRect.width;
        if (nextWidth <= 0) return;

        if (Math.abs(widthRef.current - nextWidth) > 0.5) {
          widthRef.current = nextWidth;
          setWidth(nextWidth);
        }
        setReady(true);
      });

      resizeObserver.observe(node);

      return () => {
        resizeObserver.disconnect();
      };
    }, []);

    const showSkeleton = !ready || width <= 0;

    return (
      <div
        ref={containerRef}
        className="relative w-full"
        style={{
          height: `${height}px`,
          minHeight: `${height}px`,
          minWidth: minWidth ? `${minWidth}px` : undefined,
          boxSizing: "border-box",
        }}
      >
        {showSkeleton && (
          <Skeleton className="absolute inset-0 w-full h-full" />
        )}
        {!showSkeleton && (
          <div className="absolute inset-0">
            <Chart width={width} height={height} data={data} />
          </div>
        )}
      </div>
    );
  }

  const [isInitialLoad, setIsInitialLoad] = useState(true);

  useEffect(() => {
    setIsInitialLoad(true);
  }, [data]);

  return (
    <div
      className="w-full relative"
      style={{
        height: `${height}px`,
        minHeight: `${height}px`,
        minWidth: minWidth ? `${minWidth}px` : undefined,
      }}
    >
      {isInitialLoad && <Skeleton className="absolute inset-0 w-full h-full" />}
      <div
        style={{
          opacity: isInitialLoad ? 0 : 1,
          transition: "opacity 150ms ease-in",
          width: "100%",
          height: "100%",
        }}
      >
        <ParentSize>
          {({ width, height }) => {
            if (width === 0 || height === 0) {
              return null;
            }

            if (isInitialLoad) {
              setTimeout(() => {
                setIsInitialLoad(false);
              }, 50);
              return null;
            }

            return <Chart width={width} height={height} data={data} />;
          }}
        </ParentSize>
      </div>
    </div>
  );
};

export { SparkLine };
export default SparkLine;
