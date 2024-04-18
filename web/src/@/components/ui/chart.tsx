"use client";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import BrushChart from "./brushChart";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type PlainMessage } from "@bufbuild/protobuf";
import { useEffect, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getStockData } from "~/app/actions/getStockData";
import { Button } from "./button";

const INITIAL_PERIOD = "6m";
export type ChartProps = {
  stockCode: string;
  initialData: PlainMessage<TimeSeriesData>;
};
const Chart = ({ stockCode, initialData }: ChartProps) => {
  const [period, setPeriod] = useState<string>(INITIAL_PERIOD);
  const chartRef = useRef<{ clear: () => void; reset: () => void }>(null);
  const [data, setData] = useState<PlainMessage<TimeSeriesData>>(initialData);
  useEffect(() => {
    getStockData(stockCode, period)
      .then((data) => setData(data))
      .catch(console.error);
  }, [period]);
  const handleClearClick = () => {
    chartRef?.current?.clear();
  };
  const handleResetClick = () => {
    chartRef?.current?.reset();
  };
  return (
    <div>
      <div className="flex flex-row-reverse">
        <div className="flex">
          <Button className="mr-1" size="sm" onClick={handleClearClick}>
            Clear
          </Button>
          <Button size="sm" onClick={handleResetClick}>
            Reset
          </Button>
        </div>
        <div>
          <ToggleGroup
            type="single"
            onValueChange={(v: string) => setPeriod(v)}
          >
            <ToggleGroupItem value="1m">1M</ToggleGroupItem>
            <ToggleGroupItem value="3m">3M</ToggleGroupItem>
            <ToggleGroupItem value="6m">6M</ToggleGroupItem>
            <ToggleGroupItem value="1y">1Y</ToggleGroupItem>
            <ToggleGroupItem value="2y">2Y</ToggleGroupItem>
            <ToggleGroupItem value="max">max</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <ParentSize>
        {({ width }) => (
          <BrushChart
            ref={chartRef}
            data={data}
            width={width}
            height={400}
          />
        )}
      </ParentSize>
    </div>
  );
};

export default Chart;
