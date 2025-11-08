import { type PlainMessage } from "@bufbuild/protobuf";
import { timeFormat } from "@visx/vendor/d3-time-format";
import { useState, useEffect } from "react";

import { LineSeries, XYChart, Tooltip, GlyphSeries } from "@visx/xychart";
import { GlyphCircle } from "@visx/glyph";
import {
  type TimeSeriesPoint,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { ParentSize } from "@visx/responsive";
import { Skeleton } from "~/@/components/ui/skeleton";

const accessors = {
  xAccessor: (d: PlainMessage<TimeSeriesPoint> | undefined) =>
    d
      ? new Date(Number(d.timestamp?.seconds) * 1000) || new Date()
      : new Date(),
  yAccessor: (d: PlainMessage<TimeSeriesPoint> | undefined) =>
    d ? d.shortPosition || 0 : 0,
};

const formatDate = timeFormat("%b %d, '%y");
interface SparklineProps {
  width: number;
  height: number;
  data: PlainMessage<TimeSeriesData>;
  margin?: { top: number; right: number; bottom: number; left: number };
}
const strokeColor = "var(--line-stroke)";
const redColor = `var(--red)`;
const greenColor = `var(--green)`;

const Chart = ({ width, height, data }: SparklineProps) => {
  if (data.points.length === 0) {
    return <div>Loading or no data available...</div>;
  }

  // Calculate the min and max values
  const minY = Math.min(...data.points.map(accessors.yAccessor));
  const maxY = Math.max(...data.points.map(accessors.yAccessor));

  // Calculate the padding (15% of the range to give room for badges)
  const padding = (maxY - minY) * 0.15;

  return (
    <svg width={width} height={height} style={{ overflow: "hidden" }}>
      <defs>
        <clipPath id={`clip-sparkline-${data.productCode}`}>
          <rect x="0" y="0" width={width} height={height} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-sparkline-${data.productCode})`}>
        <XYChart
          width={width}
          height={height}
          margin={{ top: 20, right: 2, bottom: 10, left: 2 }}
          xScale={{ type: "time" }}
          yScale={{
            type: "linear",
            domain: [minY - padding, maxY + padding],
          }}
        >
          <LineSeries
            dataKey="Shorts"
            data={data.points}
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
                  size={15}
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
                  size={15}
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
              const isMin = datum === data.min;
              const isMax = datum === data.max;
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
      </g>
    </svg>
  );
};

const SparkLine = ({ data }: { data: PlainMessage<TimeSeriesData> }) => {
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  useEffect(() => {
    // Reset to show skeleton when data changes
    setIsInitialLoad(true);
  }, [data]);

  return (
    <div className="w-full h-[140px] relative overflow-hidden">
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
            // Once we get valid dimensions on initial load, show the chart
            if (width > 0 && height > 0 && isInitialLoad) {
              // Delay showing the chart to ensure everything is measured
              setTimeout(() => {
                setIsInitialLoad(false);
              }, 50);
              // Return null while waiting for the timeout
              return null;
            }

            // Don't render chart until we have dimensions
            if (width === 0 || height === 0) {
              return null;
            }

            // Always render chart with current dimensions (handles resize)
            return <Chart width={width} height={height} data={data} />;
          }}
        </ParentSize>
      </div>
    </div>
  );
};

export { SparkLine };
export default SparkLine;
