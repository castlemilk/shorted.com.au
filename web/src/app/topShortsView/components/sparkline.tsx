import { type PlainMessage } from "@bufbuild/protobuf";
import { timeFormat } from "@visx/vendor/d3-time-format";

import { LineSeries, XYChart, Tooltip } from "@visx/xychart";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import { GlyphCircle } from "@visx/glyph";
import {
  type TimeSeriesPoint,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { scaleTime, scaleLinear } from "@visx/scale";
import { extent } from "@visx/vendor/d3-array";
import { Suspense } from "react";

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

const Chart = ({ width, height, margin, data }: SparklineProps) => {
  if (data.points.length === 0) {
    return <div>Loading or no data available...</div>;
  }

  const marginTop = margin?.top ?? 0;
  const marginLeft = margin?.left ?? 0;
  const marginRight = margin?.right ?? 0;
  const marginBottom = margin?.bottom ?? 0;

  const xScale = scaleTime<number>().domain(
    extent(data.points, accessors.xAccessor) as [Date, Date],
  );
  const yScale = scaleLinear<number>({
    domain: [0, accessors.yAccessor(data.max) ?? 0],
  });

  // bounds
  const innerWidth = width - marginLeft - marginRight;
  const innerHeight = height - marginTop - marginBottom;
  // update scale range to match bounds
  xScale.range([0, innerWidth]);
  // xScale.range([xScale(accessors.xAccessor(data.points[0])), xScale(accessors.xAccessor(data.points[data.points.length - 1]))]);
  yScale.range([innerHeight, 0]);
  return (
    <XYChart
      height={height}
      width={width}
      margin={margin}
      xScale={{ type: "time" }}
      yScale={{ type: "linear" }}
    >
      <LineSeries
        stroke={strokeColor}
        strokeWidth={1.5}
        dataKey="Shorts"
        data={data.points}
        {...accessors}
      />
      <GlyphCircle
        className="min-glyph"
        left={xScale(accessors.xAccessor(data.min)) + marginLeft}
        top={yScale(accessors.yAccessor(data.min)) + marginTop}
        fill={greenColor}
      />
      <GlyphCircle
        className="max-glyph"
        left={xScale(accessors.xAccessor(data.max)) + marginLeft}
        top={yScale(accessors.yAccessor(data.max)) + marginTop}
        fill={redColor}
      />
      <Tooltip
        snapTooltipToDatumX
        snapTooltipToDatumY
        showVerticalCrosshair
        showSeriesGlyphs
        renderTooltip={({ tooltipData }) => (
          <div>
            <div>{`${formatDate(accessors.xAccessor(tooltipData?.nearestDatum?.datum as TimeSeriesPoint))}`}</div>
            <div>{`${accessors.yAccessor(tooltipData?.nearestDatum?.datum as TimeSeriesPoint).toFixed(2)}%`}</div>
          </div>
        )}
      />
    </XYChart>
  );
};

const SparkLine = ({ data }: { data: PlainMessage<TimeSeriesData> }) => {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <div className="min-w-30">
        <ParentSize debounceTime={300} className="min-w-30">
          {({ width }) => (
            <Chart
              width={width}
              height={150}
              data={data}
              margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
            />
          )}
        </ParentSize>
      </div>
    </Suspense>
  );
};

export default SparkLine;
