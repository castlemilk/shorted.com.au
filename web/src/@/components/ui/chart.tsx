"use client";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import UnifiedBrushChart, {
  type HandleBrushClearAndReset,
  type UnifiedChartData,
} from "./unified-brush-chart";
import { Suspense, useRef, useState, useMemo } from "react";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { useStockData } from "./../../hooks/use-stock-data"; // Custom hook

const INITIAL_PERIOD = "5y";
export type ChartProps = {
  stockCode: string;
};

const Chart = ({ stockCode }: ChartProps) => {
  const [period, setPeriod] = useState<string>(INITIAL_PERIOD);
  const chartRef = useRef<HandleBrushClearAndReset>(null);
  const { data, loading, error } = useStockData(stockCode, period);

  // Convert protobuf data to unified chart format
  const chartData = useMemo((): UnifiedChartData | null => {
    if (!data?.points || data.points.length === 0) return null;

    return {
      type: "short-position",
      stockCode,
      points: data.points.map((point) => ({
        timestamp:
          typeof point.timestamp === "string"
            ? new Date(point.timestamp)
            : new Date(Number(point.timestamp?.seconds ?? 0) * 1000),
        shortPosition: point.shortPosition ?? 0,
      })),
    };
  }, [data, stockCode]);

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
              value={period}
              onValueChange={(v: string) => setPeriod(v)}
            >
              <ToggleGroupItem value="1m">1M</ToggleGroupItem>
              <ToggleGroupItem value="3m">3M</ToggleGroupItem>
              <ToggleGroupItem value="6m">6M</ToggleGroupItem>
              <ToggleGroupItem value="1y">1Y</ToggleGroupItem>
              <ToggleGroupItem value="2y">2Y</ToggleGroupItem>
              <ToggleGroupItem value="5y">5Y</ToggleGroupItem>
              <ToggleGroupItem value="10y">10Y</ToggleGroupItem>
              <ToggleGroupItem value="max">max</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {loading ? (
          <ChartLoadingPlaceholder withMenu={false} />
        ) : error ? (
          <div>Error loading data: {error.message}</div>
        ) : !chartData ? (
          <div className="flex items-center justify-center h-[400px] text-muted-foreground">
            <p>
              No short position data available for {stockCode} in the selected
              period
            </p>
          </div>
        ) : (
          <ParentSize className="min-w-0">
            {({ width }) => (
              <UnifiedBrushChart
                ref={chartRef}
                data={chartData}
                width={width}
                height={500}
              />
            )}
          </ParentSize>
        )}
      </div>
    </Suspense>
  );
};

const ChartLoadingPlaceholder = ({ withMenu }: { withMenu: boolean }) => (
  <div className="grid">
    {withMenu ? (
      <div className="flex flex-row-reverse">
        <div className="flex">
          <Skeleton className="h-[40px] w-[60px] ml-2" />
          <Skeleton className="h-[40px] w-[60px] ml-2" />
        </div>
        <div>
          <Skeleton className="h-[40px] w-[300px]" />
        </div>
      </div>
    ) : null}
    <div>
      <Skeleton className="h-[400px] w-full mt-2" />
    </div>
  </div>
);

export default Chart;
