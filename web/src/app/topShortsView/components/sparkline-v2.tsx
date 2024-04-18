import { type PlainMessage } from "@bufbuild/protobuf";
import { timeFormat } from "@visx/vendor/d3-time-format";
import { AnimatedLineSeries, XYChart, Tooltip } from "@visx/xychart";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import { GlyphCircle, GlyphDot } from "@visx/glyph";
import {
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { scaleTime, scaleLinear } from "@visx/scale";
import { min, extent, max } from "@visx/vendor/d3-array";

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
const secondaryColor = `hls(var(--secondary))`;
const Chart = ({ width, height, margin, data }: SparklineProps) => {
  const points = data.points.map((point) => ({
    x: accessors.xAccessor(point),
    y: accessors.yAccessor(point),
  }));

  // Ensure data for scales is valid
  if (points.length === 0) {
    return <div>Loading or no data available...</div>;
  }

  const minValue = min(points, (d) => d.y);
  const maxValue = max(points, (d) => d.y);
  const minData = points.find((p) => p.y === minValue);
  const maxData = points.find((p) => p.y === maxValue);

  const xScale = scaleTime<number>({
    domain: extent(points, (d) => d.x),
  });
  const yScale = scaleLinear<number>({
    domain: [0, maxValue],
  });

  // bounds
  const innerWidth = width - (margin?.left ?? 0) - (margin?.right ?? 0);
  const innerHeight = height - (margin?.top ?? 0) + (margin?.bottom ?? 0);
  // update scale range to match bounds
  xScale.range([0, innerWidth]);
  yScale.range([innerHeight, 0]);

  console.log("minValue", minValue);
  console.log("minData", minData);
  console.log("maxValue", maxValue);
  console.log("maxData", maxData);
  console.log("xScale:min", xScale(minData.x));
  console.log("yScale:min", yScale(minData.y));
  return (
    <XYChart
      height={height}
      width={width}
      margin={margin}
      xScale={{ type: "time" }}
      yScale={{ type: "linear" }}
    >
      <AnimatedLineSeries dataKey="Shorts" data={data.points} {...accessors} />
      <GlyphCircle
        className="min-glyph"
        left={xScale(minData.x)}
        top={yScale(minData.y)}
        fill="red"
      />
      <GlyphCircle
        className="max-glyph"
        left={xScale(maxData.x)}
        top={yScale(maxData.y)}
        fill="green"
      />
      <Tooltip
        snapTooltipToDatumX
        snapTooltipToDatumY
        showVerticalCrosshair
        showSeriesGlyphs
        renderTooltip={({ tooltipData, colorScale }) => (
          <div>
            <div>{`${formatDate(accessors.xAccessor(tooltipData.nearestDatum.datum))}`}</div>
            <div>{`${accessors.yAccessor(tooltipData.nearestDatum.datum).toFixed(2)}%`}</div>
          </div>
        )}
      />
    </XYChart>
  );
};

const SparkLine = ({ data }: { data: PlainMessage<TimeSeriesData> }) => {
  return (
    <div>
      <ParentSize>
        {({ width }) => (
          <Chart
            width={width}
            height={150}
            data={data}
            margin={{ top: 10, right: 0, bottom: 0, left: 0 }}
          />
        )}
      </ParentSize>
    </div>
  );
};

export default SparkLine;
