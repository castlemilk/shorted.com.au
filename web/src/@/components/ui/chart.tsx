"use client";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import UnifiedBrushChart, {
  type HandleBrushClearAndReset,
  type UnifiedChartData,
} from "./unified-brush-chart";
import { useRef, useState, useMemo, useEffect } from "react";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { fetchStockDataClient } from "~/@/lib/client-api";
import {
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";

const INITIAL_PERIOD = "5y";
export type ChartProps = {
  stockCode: string;
};

const Chart = ({ stockCode }: ChartProps) => {
  if (typeof window === "undefined") {
    return null;
  }

  const [period, setPeriod] = useState<string>(INITIAL_PERIOD);
  const chartRef = useRef<HandleBrushClearAndReset>(null);
  const [data, setData] = useState<TimeSeriesData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      try {
        setLoading(true);
        const response = await fetchStockDataClient(stockCode, period);
        if (isMounted) {
          setData(response ?? null);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err as Error);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };
    fetchData().catch((err) => {
      if (isMounted) {
        setError(err as Error);
        setLoading(false);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [stockCode, period]);

  const chartData = useMemo<UnifiedChartData>(() => {
    if (!data?.points || data.points.length === 0) {
      const now = Date.now();
      const fallbackPoints = Array.from({ length: 10 }, (_, idx) => {
        const timestamp = new Date(now - (9 - idx) * 86400000);
        return {
          timestamp,
          shortPosition: Math.random() * 10,
        };
      });
      return {
        type: "short-position",
        stockCode,
        points: fallbackPoints,
      };
    }

    return {
      type: "short-position",
      stockCode,
      points: data.points.map((point: TimeSeriesPoint) => {
        const timestamp = point.timestamp;
        return {
          timestamp:
            typeof timestamp === "string"
              ? new Date(timestamp)
              : new Date(Number(timestamp?.seconds ?? 0) * 1000),
          shortPosition: point.shortPosition ?? 0,
        };
      }),
    };
  }, [data, stockCode]);

  return (
    <div className="grid relative">
      <div className="flex flex-row-reverse">
        <div className="flex">
          <Button
            className="mr-1"
            size="sm"
            onClick={() => chartRef.current?.clear()}
          >
            Clear
          </Button>
          <Button size="sm" onClick={() => chartRef.current?.reset()}>
            Reset
          </Button>
        </div>
        <div>
          <ToggleGroup
            type="single"
            value={period}
            onValueChange={(v) => v && setPeriod(v)}
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

      <div className="relative min-h-[400px] mt-4">
        {loading ? (
          <ChartLoadingPlaceholder withMenu={false} />
        ) : error ? (
          <div className="text-sm text-red-500">
            Error loading data: {error.message}
          </div>
        ) : (
          <ParentSize className="min-w-0">
            {({ width }) => (
              <UnifiedBrushChart
                ref={chartRef}
                data={chartData}
                width={width}
                height={400}
              />
            )}
          </ParentSize>
        )}
      </div>
    </div>
  );
};

export const ChartLoadingPlaceholder = ({ withMenu }: { withMenu: boolean }) => (
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

export default Chart;
