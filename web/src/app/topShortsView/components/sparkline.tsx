import { type PlainMessage } from "@bufbuild/protobuf";
import { timeFormat } from "@visx/vendor/d3-time-format";

import { LineSeries, XYChart, Tooltip, GlyphSeries } from "@visx/xychart";
import { GlyphCircle } from "@visx/glyph";
import {
  type TimeSeriesPoint,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { ParentSize } from "@visx/responsive";

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
        domain: [minY - padding, maxY + padding]
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
  );
};

const SparkLine = ({ data }: { data: PlainMessage<TimeSeriesData> }) => {
  return (
    <div className="w-full h-[150px]">
      <ParentSize>
        {({ width, height }) => (
          <Chart
            width={Math.max(width, 100)}
            height={Math.max(height, 100)}
            data={data}
          />
        )}
      </ParentSize>
    </div>
  );
};

export default SparkLine;
