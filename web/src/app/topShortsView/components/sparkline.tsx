import { timeFormat } from "@visx/vendor/d3-time-format";
import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";

import {
  type TimeSeriesPoint,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { ParentSize } from "@visx/responsive";
import { Skeleton } from "~/@/components/ui/skeleton";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { localPoint } from "@visx/event";
import { scaleTime, scaleLinear } from "@visx/scale";
import { bisector } from "@visx/vendor/d3-array";
import { LinePath, Line } from "@visx/shape";

type TimeSeriesPointData = TimeSeriesPoint;

const xAccessor = (d: TimeSeriesPointData | undefined): Date => {
  if (!d) return new Date();
  if (!d.timestamp) return new Date();
  const timestamp: Timestamp = d.timestamp;
  const seconds = timestamp.seconds ?? 0;
  return new Date(Number(seconds) * 1000) || new Date();
};

const yAccessor = (d: TimeSeriesPointData | undefined): number => {
  return d ? d.shortPosition || 0 : 0;
};

const accessors = {
  xAccessor,
  yAccessor,
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

// Bisector for finding nearest data point
const bisectorFn = bisector<TimeSeriesPointData, Date>(
  (d: TimeSeriesPointData): Date => {
    if (!d) return new Date();
    if (!d.timestamp) return new Date();
    const timestamp: Timestamp = d.timestamp;
    const seconds = timestamp.seconds ?? 0;
    return new Date(Number(seconds) * 1000) || new Date();
  }
);
const bisectDate = (array: TimeSeriesPointData[], x: Date, lo?: number, hi?: number): number => {
  return bisectorFn.left(array, x, lo, hi);
};

const Chart = ({ width, height, data }: SparklineProps) => {
  const points = data.points ?? [];
  
  const {
    tooltipOpen,
    tooltipLeft,
    tooltipTop,
    tooltipData,
    showTooltip,
    hideTooltip,
  } = useTooltip<TimeSeriesPointData>();

  const { containerRef: portalRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  const margin = { top: 20, right: 24, bottom: 20, left: 10 };
  
  if (points.length === 0) {
    return <div>Loading or no data available...</div>;
  }

  // Calculate the min and max values
  const minY = Math.min(...points.map(accessors.yAccessor));
  const maxY = Math.max(...points.map(accessors.yAccessor));
  const padding = (maxY - minY) * 0.1;

  // Create scales
  const xScale = scaleTime({
    domain: [accessors.xAccessor(points[0]), accessors.xAccessor(points[points.length - 1])],
    range: [margin.left, width - margin.right],
  });

  const yScale = scaleLinear({
    domain: [minY - padding, maxY + padding],
    range: [height - margin.bottom, margin.top],
  });

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const point = localPoint(event);
      if (!point) return;

      const x0 = xScale.invert(point.x);
      const index = bisectDate(points, x0, 1);
      const d0 = points[index - 1];
      const d1 = points[index];
      
      let d = d0;
      if (d1 && accessors.xAccessor(d1)) {
        d = x0.valueOf() - accessors.xAccessor(d0).valueOf() >
            accessors.xAccessor(d1).valueOf() - x0.valueOf()
          ? d1
          : d0;
      }

      if (d) {
        const tooltipX = xScale(accessors.xAccessor(d));
        const tooltipY = yScale(accessors.yAccessor(d));
        showTooltip({
          tooltipData: d,
          tooltipLeft: tooltipX,
          tooltipTop: tooltipY,
        });
      }
    },
    [points, xScale, yScale, showTooltip]
  );

  return (
    <div ref={portalRef} style={{ position: 'relative', width, height }}>
      <svg
        width={width}
        height={height}
        onMouseMove={handleMouseMove}
        onMouseLeave={hideTooltip}
        style={{ cursor: 'crosshair' }}
      >
        {/* Main line */}
        <LinePath
          data={points}
          x={(d) => xScale(accessors.xAccessor(d))}
          y={(d) => yScale(accessors.yAccessor(d))}
          stroke={strokeColor}
          strokeWidth={1.5}
        />
        
        {/* Min point marker */}
        {data.min && (
          <circle
            cx={xScale(accessors.xAccessor(data.min))}
            cy={yScale(accessors.yAccessor(data.min))}
            r={4}
            fill={greenColor}
            stroke={greenColor}
          />
        )}
        
        {/* Max point marker */}
        {data.max && (
          <circle
            cx={xScale(accessors.xAccessor(data.max))}
            cy={yScale(accessors.yAccessor(data.max))}
            r={4}
            fill={redColor}
            stroke={redColor}
          />
        )}
        
        {/* Hover indicator */}
        {tooltipOpen && tooltipData && (
          <>
            {/* Vertical crosshair line */}
            <Line
              from={{ x: tooltipLeft ?? 0, y: margin.top }}
              to={{ x: tooltipLeft ?? 0, y: height - margin.bottom }}
              stroke="rgba(255,255,255,0.3)"
              strokeWidth={1}
              strokeDasharray="4,3"
              pointerEvents="none"
            />
            {/* Hover dot */}
            <circle
              cx={tooltipLeft ?? 0}
              cy={tooltipTop ?? 0}
              r={5}
              fill={strokeColor}
              stroke="white"
              strokeWidth={2}
              pointerEvents="none"
            />
          </>
        )}
      </svg>
      
      {/* Tooltip rendered in portal */}
      {tooltipOpen && tooltipData && (
        <TooltipInPortal
          left={tooltipLeft}
          top={tooltipTop}
          offsetTop={-50}
          offsetLeft={0}
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            zIndex: 10000,
          }}
        >
          <div style={{ 
            background: "rgba(15, 23, 42, 0.95)", 
            padding: "8px 12px", 
            borderRadius: "8px",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}>
            <div style={{ fontWeight: "500", color: "white", fontSize: "11px", opacity: 0.8 }}>
              {formatDate(accessors.xAccessor(tooltipData))}
            </div>
            <div style={{ color: "#60a5fa", fontWeight: "700", fontSize: "14px", marginTop: "2px" }}>
              {`${accessors.yAccessor(tooltipData).toFixed(2)}%`}
            </div>
          </div>
        </TooltipInPortal>
      )}
    </div>
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
    const [width, setWidth] = useState<number>(0);

    useLayoutEffect(() => {
      const node = containerRef.current;
      if (!node) return;

      // Get initial width
      const initialWidth = node.getBoundingClientRect().width;
      if (initialWidth > 0) {
        setWidth(initialWidth);
      }

      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextWidth = entry.contentRect.width;
        if (nextWidth > 0) {
          setWidth(nextWidth);
        }
      });

      resizeObserver.observe(node);

      return () => {
        resizeObserver.disconnect();
      };
    }, []);

    return (
      <div
        ref={containerRef}
        className="relative w-full overflow-visible"
        style={{
          height: `${height}px`,
          minHeight: `${height}px`,
          minWidth: minWidth ? `${minWidth}px` : undefined,
          boxSizing: "border-box",
        }}
      >
        {width > 0 ? (
          <Chart width={width} height={height} data={data} />
        ) : (
          <Skeleton className="absolute inset-0 w-full h-full" />
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
