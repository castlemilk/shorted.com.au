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
import { useMarketData } from "@/hooks/use-market-data";

const INITIAL_PERIOD = "5y";

export type MarketChartProps = {
  stockCode: string;
};

const MarketChart = ({ stockCode }: MarketChartProps) => {
  const [period, setPeriod] = useState<string>(INITIAL_PERIOD);
  const chartRef = useRef<HandleBrushClearAndReset>(null);
  const [isFirstLoad, setIsFirstLoad] = useState<boolean>(true);
  const { data, loading, error } = useMarketData(stockCode, period);

  // Track if this is the initial load or a refresh
  const isRefreshing = !isFirstLoad && loading;

  // Convert market data to unified chart format
  const chartData = useMemo((): UnifiedChartData | null => {
    if (!data?.points || data.points.length === 0) return null;

    // Mark first load as complete once we have data
    if (isFirstLoad && data.points.length > 0) {
      setIsFirstLoad(false);
    }

    return {
      type: "price",
      stockCode,
      points: data.points.map((point) => ({
        date: point.date,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume,
      })),
    };
  }, [data, stockCode, isFirstLoad]);

  const handleClearClick = () => {
    chartRef?.current?.clear();
  };

  const handleResetClick = () => {
    chartRef?.current?.reset();
  };

  return (
    <Suspense fallback={<ChartLoadingPlaceholder withMenu={true} />}>
      <div className="grid relative">
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

        {isFirstLoad && loading ? (
          <ChartLoadingPlaceholder withMenu={false} />
        ) : error ? (
          <div className="flex items-center justify-center h-[500px] min-h-[500px] text-red-500">
            <p>Error loading market data: {error.message}</p>
          </div>
        ) : !chartData ? (
          <div className="flex items-center justify-center h-[500px] min-h-[500px] text-muted-foreground">
            <p>
              No market data available for {stockCode} in the selected period
            </p>
          </div>
        ) : (
          <div className="relative min-h-[500px]">
            {isRefreshing && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-sm rounded-lg">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                <p className="text-sm text-muted-foreground">Updating chart…</p>
              </div>
            )}
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
          </div>
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
      <Skeleton className="h-[500px] min-h-[500px] w-full mt-2" />
    </div>
  </div>
);

export default MarketChart;
