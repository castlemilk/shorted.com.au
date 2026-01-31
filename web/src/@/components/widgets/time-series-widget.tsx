"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import { ParentSize } from "@visx/responsive";
import MultiSeriesChart, {
  type HandleBrushClearAndReset,
  type MultiSeriesChartData,
  type ChartSeries,
  type IndicatorOverlay,
} from "~/@/components/ui/multi-series-chart";
import { getStockData } from "~/app/actions/getStockData";
import {
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Button } from "~/@/components/ui/button";
import { Badge } from "~/@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "~/@/components/ui/toggle-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/@/components/ui/popover";
import { Settings2, Activity, RotateCcw, LineChart, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type IndicatorConfig,
  calculateIndicator,
  calculateAdvancedIndicator,
  getStockColor,
  INDICATOR_METADATA,
  isOscillator,
} from "@/lib/technical-indicators";
import { IndicatorPanel } from "./indicator-panel";
import { StockSelector } from "./stock-selector";

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "5y", "max"] as const;
const DEFAULT_PERIOD = "3m";

export function TimeSeriesWidget({ config, onSettingsChange }: WidgetProps) {
  const chartRef = useRef<HandleBrushClearAndReset>(null);

  // Get settings from config
  const stocks = useMemo(() => {
    const stocksArray = config.settings?.stocks as string[] | undefined;
    return stocksArray && stocksArray.length > 0 ? stocksArray : [];
  }, [config.settings?.stocks]);

  const period = useMemo(() => {
    return (config.settings?.period as string) || DEFAULT_PERIOD;
  }, [config.settings?.period]);

  const viewMode = useMemo(() => {
    return (config.settings?.viewMode as "absolute" | "normalized") || "absolute";
  }, [config.settings?.viewMode]);

  const indicators = useMemo(() => {
    return (config.settings?.indicators as IndicatorConfig[]) || [];
  }, [config.settings?.indicators]);

  const analysisMode = useMemo(() => {
    return (config.settings?.analysisMode as boolean) ?? false;
  }, [config.settings?.analysisMode]);

  // State
  const [loading, setLoading] = useState(true);
  const [stockData, setStockData] = useState<Map<string, TimeSeriesData>>(
    new Map()
  );
  const [showSettings, setShowSettings] = useState(false);

  // Fetch data
  useEffect(() => {
    if (stocks.length === 0) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      const newData = new Map<string, TimeSeriesData>();

      try {
        await Promise.all(
          stocks.map(async (stockCode) => {
            const data = await getStockData(stockCode, period);
            if (data) {
              newData.set(stockCode, data);
            }
          })
        );
        setStockData(newData);
      } catch (error) {
        console.error("Error fetching stock data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [stocks, period]);

  // Build chart data
  const chartData = useMemo<MultiSeriesChartData>(() => {
    const series: ChartSeries[] = [];

    stocks.forEach((code, index) => {
      const data = stockData.get(code);
      if (!data?.points || data.points.length === 0) return;

      series.push({
        stockCode: code,
        color: getStockColor(index),
        points: data.points.map((point: TimeSeriesPoint) => ({
          timestamp:
            typeof point.timestamp === "string"
              ? new Date(point.timestamp)
              : new Date(Number(point.timestamp?.seconds ?? 0) * 1000),
          value: point.shortPosition ?? 0,
        })),
        seriesType: "shorts" as const,
      });
    });

    // Calculate indicators
    const indicatorOverlays: IndicatorOverlay[] = indicators
      .filter((ind) => ind.enabled !== false)
      .map((ind) => {
        const seriesData = series.find((s) => s.stockCode === ind.stockCode);
        if (!seriesData) {
          return { config: ind, values: [], timestamps: [] };
        }

        const values = seriesData.points.map((p) => p.value);
        const timestamps = seriesData.points.map((p) => p.timestamp);

        // Use advanced calculation for multi-output/oscillator indicators
        const metadata = INDICATOR_METADATA[ind.type];
        if (metadata?.hasMultipleOutputs || isOscillator(ind.type)) {
          const result = calculateAdvancedIndicator(values, ind);
          return {
            config: ind,
            values: result.values,
            timestamps,
            multiOutput: result.multiOutput,
          };
        }

        const indicatorValues = calculateIndicator(values, ind.type, ind.period);
        return {
          config: ind,
          values: indicatorValues,
          timestamps,
        };
      });

    return {
      series,
      viewMode,
      indicators: indicatorOverlays,
      hasDualAxis: false,
      showOscillatorPanel: indicators.some((ind) => isOscillator(ind.type)),
    };
  }, [stocks, stockData, viewMode, indicators]);

  // Settings handlers
  const handleStocksChange = useCallback(
    (newStocks: string[]) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          stocks: newStocks,
        });
      }
    },
    [onSettingsChange, config.settings]
  );

  const handlePeriodChange = useCallback(
    (newPeriod: string) => {
      if (newPeriod && onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          period: newPeriod,
        });
      }
    },
    [onSettingsChange, config.settings]
  );

  const handleViewModeChange = useCallback(
    (newMode: "absolute" | "normalized") => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          viewMode: newMode,
        });
      }
    },
    [onSettingsChange, config.settings]
  );

  const handleIndicatorsChange = useCallback(
    (newIndicators: IndicatorConfig[]) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          indicators: newIndicators,
        });
      }
    },
    [onSettingsChange, config.settings]
  );

  const handleAnalysisModeChange = useCallback(
    (enabled: boolean) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          analysisMode: enabled,
        });
      }
    },
    [onSettingsChange, config.settings]
  );

  if (loading) {
    return (
      <div className="h-full p-4">
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 pt-3 pb-2 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LineChart className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">Time Series Analysis</span>
          </div>
          <Popover open={showSettings} onOpenChange={setShowSettings}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                <Settings2 className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72" align="end">
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium mb-2">Select Stocks</h4>
                  <StockSelector
                    selectedStocks={stocks}
                    onStocksChange={handleStocksChange}
                    maxStocks={8}
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm font-medium">No Stocks Selected</p>
            <p className="text-xs mt-2">
              Click the settings icon to add stocks for analysis
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <LineChart className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">Comparing</span>
            {stocks.map((code, index) => (
              <Badge
                key={code}
                variant="secondary"
                className="text-xs"
                style={{ borderLeft: `3px solid ${getStockColor(index)}` }}
              >
                {code}
              </Badge>
            ))}
          </div>

          <div className="flex items-center gap-1">
            {/* Analysis mode toggle */}
            <Button
              variant={analysisMode ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => handleAnalysisModeChange(!analysisMode)}
            >
              <Activity className="h-3 w-3" />
              {analysisMode ? "Analysis On" : "Analysis"}
            </Button>

            {/* Settings */}
            <Popover open={showSettings} onOpenChange={setShowSettings}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("h-7 w-7 p-0", showSettings && "text-primary")}
                >
                  <Settings2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72" align="end">
                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-medium mb-2">Stocks</h4>
                    <StockSelector
                      selectedStocks={stocks}
                      onStocksChange={handleStocksChange}
                      maxStocks={8}
                    />
                  </div>

                  <div>
                    <h4 className="text-sm font-medium mb-2">View Mode</h4>
                    <ToggleGroup
                      type="single"
                      value={viewMode}
                      onValueChange={(v) =>
                        v && handleViewModeChange(v as "absolute" | "normalized")
                      }
                      className="justify-start"
                    >
                      <ToggleGroupItem value="absolute" className="text-xs">
                        Absolute
                      </ToggleGroupItem>
                      <ToggleGroupItem value="normalized" className="text-xs">
                        % Change
                      </ToggleGroupItem>
                    </ToggleGroup>
                    {viewMode === "normalized" && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Shows percentage change from start of period
                      </p>
                    )}
                  </div>

                  {analysisMode && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Indicators</h4>
                      <IndicatorPanel
                        indicators={indicators}
                        onIndicatorsChange={handleIndicatorsChange}
                        stockCodes={stocks}
                        availableDataSources={["shorts"]}
                        hasOHLCV={false}
                        hasVolume={false}
                      />
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {/* Period selector and controls */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b">
        <div className="overflow-x-auto">
          <ToggleGroup
            type="single"
            value={period}
            onValueChange={handlePeriodChange}
            className="justify-start"
          >
            {PERIODS.map((p) => (
              <ToggleGroupItem key={p} value={p} className="text-xs h-7 px-2">
                {p.toUpperCase()}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => chartRef.current?.clear()}
          >
            Clear
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => chartRef.current?.reset()}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Indicator badges when in analysis mode */}
      {analysisMode && indicators.length > 0 && (
        <div className="px-4 py-2 border-b flex flex-wrap gap-1.5">
          {indicators.map((ind, index) => {
            const metadata = INDICATOR_METADATA[ind.type];
            return (
              <Badge
                key={`${ind.type}-${ind.period}-${index}`}
                variant={ind.enabled ? "secondary" : "outline"}
                className={cn(
                  "text-xs",
                  !ind.enabled && "opacity-50"
                )}
                style={{ borderLeft: `3px solid ${ind.color}` }}
              >
                {metadata?.shortName ?? ind.type}({ind.period})
                {stocks.length > 1 && <span className="ml-1 text-muted-foreground">• {ind.stockCode}</span>}
              </Badge>
            );
          })}
        </div>
      )}

      {/* Chart */}
      <div className="flex-1 min-h-0 p-2">
        {chartData.series.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm font-medium">No Data Available</p>
              <p className="text-xs">No short position data found for selected stocks</p>
            </div>
          </div>
        ) : (
          <ParentSize className="min-w-0">
            {({ width, height }) => (
              <MultiSeriesChart
                ref={chartRef}
                data={chartData}
                width={width}
                height={Math.max(height, 250)}
              />
            )}
          </ParentSize>
        )}
      </div>

      {/* Legend */}
      {chartData.series.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-3 border-t pt-2">
          {chartData.series.map((series) => {
            const data = stockData.get(series.stockCode);
            const latestPoint = data?.points?.[data.points.length - 1];
            return (
              <div
                key={series.stockCode}
                className="flex items-center gap-1.5 text-xs"
              >
                <div
                  className="w-3 h-0.5 rounded"
                  style={{ backgroundColor: series.color }}
                />
                <span className="font-medium">{series.stockCode}</span>
                {latestPoint && (
                  <span className="text-muted-foreground">
                    {latestPoint.shortPosition.toFixed(2)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
