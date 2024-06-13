"use client";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import BrushChart, { type HandleBrushClearAndReset } from "./brushChart";
import { Suspense, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { useStockData } from "./../../hooks/use-stock-data"; // Custom hook

const INITIAL_PERIOD = "6m";
export type ChartProps = {
  stockCode: string;
};

const Chart = ({ stockCode }: ChartProps) => {
  const [period, setPeriod] = useState<string>(INITIAL_PERIOD);
  const chartRef = useRef<HandleBrushClearAndReset>(null);
  const { data, loading, error } = useStockData(stockCode, period);

  const handleClearClick = () => {
    chartRef?.current?.clear();
  };

  const handleResetClick = () => {
    chartRef?.current?.reset();
  };

  return (
    <Suspense fallback={<ChartLoadingPlaceholder withMenu={true} />}>
      <div className="grid">
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

        {(loading || data == null)  ? (
          <ChartLoadingPlaceholder withMenu={false} />
        ) : error ? (
          <div>Error loading data</div>
        ) : (
          <ParentSize className="min-w-0">
            {({ width }) => (
              <BrushChart ref={chartRef} data={data} width={width} height={400} />
            )}
          </ParentSize>
        )}
      </div>
    </Suspense>
  );
};

const ChartLoadingPlaceholder = ({ withMenu }: { withMenu: boolean }) => (
  <div className="grid">
    {withMenu ? <div className="flex flex-row-reverse">
      <div className="flex">
        <Skeleton className="h-[40px] w-[60px] ml-2" />
        <Skeleton className="h-[40px] w-[60px] ml-2" />
      </div>
      <div>
        <Skeleton className="h-[40px] w-[300px]" />
      </div>
    </div> : null}
    <div>
      <Skeleton className="h-[400px] w-full mt-2" />
    </div>
  </div>
);

export default Chart;
