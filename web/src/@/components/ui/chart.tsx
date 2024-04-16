"use client";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import BrushChart from "./brushChart";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type PlainMessage } from "@bufbuild/protobuf";
export type ChartProps = {
  data: PlainMessage<TimeSeriesData>;
};
const Chart = ({ data }: ChartProps) => {
  return (
    <ParentSize>
      {({ width, height }) => (
        <BrushChart data={data} width={width} height={400} />
      )}
    </ParentSize>
  );
};

export default Chart;
