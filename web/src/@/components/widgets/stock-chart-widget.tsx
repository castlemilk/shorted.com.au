"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import MultiSeriesChart, {
  type HandleBrushClearAndReset,
  type MultiSeriesChartData,
  type ChartSeries,
  type IndicatorOverlay,
} from "~/@/components/ui/multi-series-chart";
import { Button } from "~/@/components/ui/button";
import { Badge } from "~/@/components/ui/badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "~/@/components/ui/toggle-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/@/components/ui/popover";
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  Settings2,
  RotateCcw,
} from "lucide-react";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { getStock } from "~/app/actions/getStock";
import {
  getMultipleStockQuotes,
  getHistoricalData,
  type StockQuote,
  type HistoricalDataPoint,
} from "@/lib/stock-data-service";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { StockSelector } from "./stock-selector";
import { IndicatorPanel } from "./indicator-panel";
import {
  type IndicatorConfig,
  calculateIndicator,
  getStockColor,
} from "@/lib/technical-indicators";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Checkbox } from "~/@/components/ui/checkbox";
import { Label } from "~/@/components/ui/label";

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "5y", "10y", "max"] as const;
const DEFAULT_PERIOD = "5y";

// Color scheme for market data (blue tones)
const getMarketColor = (index: number): string => {
  const marketColors = [
    "#3b82f6", // blue-500
    "#2563eb", // blue-600
    "#1d4ed8", // blue-700
    "#60a5fa", // blue-400
    "#93c5fd", // blue-300
  ];
  return marketColors[index % marketColors.length] ?? "#3b82f6";
};

// Transform market data to ChartSeries format
const transformMarketDataToSeries = (
  code: string,
  data: HistoricalDataPoint[],
  index: number,
): ChartSeries | null => {
  if (!data || data.length === 0) return null;

  return {
    stockCode: `PRICE:${code}`,
    color: getMarketColor(index),
    points: data.map((point) => ({
      timestamp: new Date(point.date),
      value: point.close,
    })),
  };
};

export function StockChartWidget({ config, onSettingsChange }: WidgetProps) {
  const chartRef = useRef<HandleBrushClearAndReset>(null);

  // Get settings from config or use defaults
  const stocks = useMemo(() => {
    // Support both old format (stockCode) and new format (stocks)
    const stocksArray = config.settings?.stocks as string[] | undefined;
    if (stocksArray && stocksArray.length > 0) {
      return stocksArray;
    }
    // Fallback to old single stock format
    const singleStock = config.settings?.stockCode as string | undefined;
    return singleStock ? [singleStock] : ["CBA"];
  }, [config.settings?.stocks, config.settings?.stockCode]);

  const period = useMemo(() => {
    return (config.settings?.period as string) || DEFAULT_PERIOD;
  }, [config.settings?.period]);

  const viewMode = useMemo(() => {
    return (
      (config.settings?.viewMode as "absolute" | "normalized") || "absolute"
    );
  }, [config.settings?.viewMode]);

  const indicators = useMemo(() => {
    return (config.settings?.indicators as IndicatorConfig[]) || [];
  }, [config.settings?.indicators]);

  const dataTypes = useMemo(() => {
    const types = config.settings?.dataTypes as string[] | undefined;
    return types && types.length > 0 ? types : ["market"];
  }, [config.settings?.dataTypes]);

  const stockShortsVisibility = useMemo(() => {
    const visibility = config.settings?.stockShortsVisibility as
      | Record<string, boolean>
      | undefined;
    return visibility ?? {};
  }, [config.settings?.stockShortsVisibility]);

  // State
  const [stocksData, setStocksData] = useState<Map<string, TimeSeriesData>>(
    new Map(),
  );
  const [marketData, setMarketData] = useState<
    Map<string, HistoricalDataPoint[]>
  >(new Map());
  const [stocksInfo, setStocksInfo] = useState<Map<string, Stock>>(new Map());
  const [stocksQuotes, setStocksQuotes] = useState<Map<string, StockQuote>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [marketLoading, setMarketLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Fetch shorts data for all stocks
  useEffect(() => {
    const fetchShortsData = async () => {
      if (stocks.length === 0) {
        setLoading(false);
        return;
      }

      if (!dataTypes.includes("shorts")) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        // Fetch time series data for all stocks in parallel
        const dataPromises = stocks.map((code) =>
          fetchStockDataClient(code, period).catch(() => null),
        );
        const infoPromises = stocks.map((code) =>
          getStock(code).catch(() => null),
        );

        const [dataResults, infoResults, quotesResult] = await Promise.all([
          Promise.all(dataPromises),
          Promise.all(infoPromises),
          getMultipleStockQuotes(stocks).catch(() => new Map()),
        ]);

        // Build maps
        const dataMap = new Map<string, TimeSeriesData>();
        const infoMap = new Map<string, Stock>();

        stocks.forEach((code, i) => {
          if (dataResults[i]) {
            dataMap.set(code, dataResults[i]!);
          }
          if (infoResults[i]) {
            infoMap.set(code, infoResults[i]!);
          }
        });

        setStocksData(dataMap);
        setStocksInfo(infoMap);
        setStocksQuotes(quotesResult);
      } catch (error) {
        console.error("Error fetching stock data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchShortsData();
  }, [stocks, period, dataTypes]);

  // Fetch market data when needed
  useEffect(() => {
    const fetchMarketData = async () => {
      if (stocks.length === 0 || !dataTypes.includes("market")) {
        setMarketData(new Map());
        setMarketLoading(false);
        return;
      }

      setMarketLoading(true);
      try {
        const marketPromises = stocks.map((code) =>
          getHistoricalData(code, period).catch(() => []),
        );
        const marketResults = await Promise.all(marketPromises);

        const marketMap = new Map<string, HistoricalDataPoint[]>();
        stocks.forEach((code, i) => {
          if (marketResults[i] && marketResults[i]!.length > 0) {
            marketMap.set(code, marketResults[i]!);
          }
        });

        setMarketData(marketMap);
      } catch (error) {
        console.error("Error fetching market data:", error);
        setMarketData(new Map());
      } finally {
        setMarketLoading(false);
      }
    };

    void fetchMarketData();
  }, [stocks, period, dataTypes]);

  // Build chart data
  const chartData = useMemo<MultiSeriesChartData>(() => {
    const series: ChartSeries[] = [];

    // Add shorts series if enabled
    if (dataTypes.includes("shorts")) {
      const shortsSeries = stocks
        .map((code, index) => {
          // Check if shorts visibility is enabled for this stock (defaults to true)
          const isShortsVisible = stockShortsVisibility[code] ?? true;
          if (!isShortsVisible) return null;

          const data = stocksData.get(code);
          if (!data?.points || data.points.length === 0) return null;

          return {
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
          };
        })
        .filter((s): s is ChartSeries & { seriesType: "shorts" } => s !== null);
      series.push(...shortsSeries);
    }

    // Add market series if enabled
    if (dataTypes.includes("market")) {
      const marketSeries = stocks
        .map((code, index) => {
          const data = marketData.get(code);
          if (!data || data.length === 0) return null;
          return transformMarketDataToSeries(code, data, index);
        })
        .filter((s): s is ChartSeries => s !== null)
        .map((s) => ({ ...s, seriesType: "market" as const }));
      series.push(...marketSeries);
    }

    // Calculate indicators (only for shorts data)
    const indicatorOverlays: IndicatorOverlay[] = indicators
      .filter((ind) => ind.enabled !== false)
      .map((ind) => {
        const seriesData = series.find((s) => s.stockCode === ind.stockCode);
        if (!seriesData) {
          return { config: ind, values: [] };
        }

        const values = seriesData.points.map((p) => p.value);
        const indicatorValues = calculateIndicator(
          values,
          ind.type,
          ind.period,
        );

        return {
          config: ind,
          values: indicatorValues,
        };
      });

    const hasDualAxis =
      dataTypes.includes("shorts") && dataTypes.includes("market");

    return {
      series,
      viewMode,
      indicators: indicatorOverlays,
      hasDualAxis,
    };
  }, [
    stocks,
    stocksData,
    marketData,
    viewMode,
    indicators,
    dataTypes,
    stockShortsVisibility,
  ]);

  // Settings change handlers
  const handleStocksChange = useCallback(
    (newStocks: string[]) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          stocks: newStocks,
          // Remove old format
          stockCode: undefined,
        });
      }
    },
    [onSettingsChange, config.settings],
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
    [onSettingsChange, config.settings],
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
    [onSettingsChange, config.settings],
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
    [onSettingsChange, config.settings],
  );

  const handleDataTypesChange = useCallback(
    (newDataTypes: string[]) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          dataTypes: newDataTypes.length > 0 ? newDataTypes : ["shorts"],
        });
      }
    },
    [onSettingsChange, config.settings],
  );

  const handleShortsVisibilityChange = useCallback(
    (stockCode: string, visible: boolean) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          stockShortsVisibility: {
            ...stockShortsVisibility,
            [stockCode]: visible,
          },
        });
      }
    },
    [onSettingsChange, config.settings, stockShortsVisibility],
  );

  const handleStocksChangeWithDefaults = useCallback(
    (newStocks: string[]) => {
      // When stocks are added, default shorts visibility to true for new stocks
      const newVisibility: Record<string, boolean> = {
        ...stockShortsVisibility,
      };
      newStocks.forEach((code) => {
        if (!(code in newVisibility)) {
          newVisibility[code] = true;
        }
      });
      // Remove visibility entries for stocks that are no longer selected
      Object.keys(newVisibility).forEach((code) => {
        if (!newStocks.includes(code)) {
          delete newVisibility[code];
        }
      });

      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          stocks: newStocks,
          stockCode: undefined,
          stockShortsVisibility: newVisibility,
        });
      }
    },
    [onSettingsChange, config.settings, stockShortsVisibility],
  );

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(price);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  // Get primary stock info for header
  const primaryStock = stocks[0] ?? "";
  const primaryInfo = primaryStock ? stocksInfo.get(primaryStock) : undefined;
  const primaryQuote = primaryStock
    ? stocksQuotes.get(primaryStock)
    : undefined;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b space-y-2">
        {/* Stock info row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            {loading ? (
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-12" />
                <Skeleton className="h-4 w-24" />
              </div>
            ) : stocks.length === 1 ? (
              // Single stock view
              <>
                <Link
                  href={`/shorts/${primaryStock}`}
                  className="flex items-center gap-2 hover:opacity-80"
                >
                  <span className="font-bold text-lg">{primaryStock}</span>
                  {primaryInfo?.name && (
                    <span className="text-sm text-muted-foreground truncate max-w-[150px]">
                      {primaryInfo.name}
                    </span>
                  )}
                </Link>

                {primaryQuote && (
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {formatPrice(primaryQuote.price)}
                    </span>
                    <Badge
                      variant={
                        primaryQuote.change >= 0 ? "default" : "destructive"
                      }
                      className="text-xs h-5"
                    >
                      <span className="inline-flex items-center gap-1">
                        {primaryQuote.change >= 0 ? (
                          <TrendingUp className="h-3 w-3" />
                        ) : (
                          <TrendingDown className="h-3 w-3" />
                        )}
                        {formatPercent(primaryQuote.changePercent)}
                      </span>
                    </Badge>
                  </div>
                )}

                {primaryInfo && dataTypes.includes("shorts") && (
                  <Badge variant="outline" className="text-xs h-5">
                    <BarChart3 className="h-3 w-3 mr-1" />
                    {primaryInfo.percentageShorted.toFixed(2)}% shorted
                  </Badge>
                )}
                {dataTypes.includes("market") &&
                  !dataTypes.includes("shorts") &&
                  primaryQuote && (
                    <Badge variant="outline" className="text-xs h-5">
                      💰 Market Data
                    </Badge>
                  )}
                {dataTypes.includes("shorts") &&
                  dataTypes.includes("market") && (
                    <Badge variant="outline" className="text-xs h-5">
                      📊💰 Dual View
                    </Badge>
                  )}
              </>
            ) : (
              // Multi-stock comparison view
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-lg">Comparing</span>
                {stocks.map((code, index) => (
                  <Badge
                    key={code}
                    variant="secondary"
                    className="text-xs"
                    style={{ borderLeft: `3px solid ${getStockColor(index)}` }}
                  >
                    <Link href={`/shorts/${code}`} className="hover:underline">
                      {code}
                    </Link>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Settings button */}
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
            <PopoverContent className="w-80" align="end">
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium mb-2">Data Types</h4>
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="data-type-shorts"
                        checked={dataTypes.includes("shorts")}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            handleDataTypesChange([
                              ...dataTypes.filter((t) => t !== "shorts"),
                              "shorts",
                            ]);
                          } else {
                            const newTypes = dataTypes.filter(
                              (t) => t !== "shorts",
                            );
                            handleDataTypesChange(
                              newTypes.length > 0 ? newTypes : ["market"],
                            );
                          }
                        }}
                      />
                      <Label
                        htmlFor="data-type-shorts"
                        className="text-sm font-normal cursor-pointer"
                      >
                        Show Shorts Data
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="data-type-market"
                        checked={dataTypes.includes("market")}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            handleDataTypesChange([
                              ...dataTypes.filter((t) => t !== "market"),
                              "market",
                            ]);
                          } else {
                            const newTypes = dataTypes.filter(
                              (t) => t !== "market",
                            );
                            handleDataTypesChange(
                              newTypes.length > 0 ? newTypes : ["shorts"],
                            );
                          }
                        }}
                      />
                      <Label
                        htmlFor="data-type-market"
                        className="text-sm font-normal cursor-pointer"
                      >
                        Show Market Data
                      </Label>
                    </div>
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium mb-2">Stocks</h4>
                  <StockSelector
                    selectedStocks={stocks}
                    onStocksChange={handleStocksChangeWithDefaults}
                    maxStocks={5}
                    stockShortsVisibility={stockShortsVisibility}
                    onShortsVisibilityChange={handleShortsVisibilityChange}
                    showShortsToggle={dataTypes.includes("shorts")}
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

                <div>
                  <h4 className="text-sm font-medium mb-2">Indicators</h4>
                  <IndicatorPanel
                    indicators={indicators}
                    onIndicatorsChange={handleIndicatorsChange}
                    stockCodes={stocks}
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Controls bar */}
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

      {/* Chart */}
      <div className="flex-1 min-h-0 p-2">
        {loading || marketLoading ? (
          <div className="h-full flex items-center justify-center">
            <Skeleton className="w-full h-full min-h-[300px]" />
          </div>
        ) : chartData.series.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm font-medium mb-2">No Data Available</p>
              <p className="text-xs">
                {stocks.length === 0
                  ? "Add stocks using the settings button above"
                  : dataTypes.includes("shorts") && dataTypes.includes("market")
                    ? "No data available for selected stocks. Try selecting different stocks or data types."
                    : dataTypes.includes("shorts")
                      ? "No shorts data available for selected stocks."
                      : "No market data available for selected stocks."}
              </p>
            </div>
          </div>
        ) : (
          <ParentSize className="min-w-0">
            {({ width, height }) => (
              <MultiSeriesChart
                ref={chartRef}
                data={chartData}
                width={width}
                height={Math.max(height, 300)}
              />
            )}
          </ParentSize>
        )}
      </div>

      {/* Legend */}
      {!loading && chartData.series.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-2 border-t pt-2">
          {chartData.series.map((series) => {
            const isMarket = series.stockCode.startsWith("PRICE:");
            const stockCode = isMarket
              ? series.stockCode.replace("PRICE:", "")
              : series.stockCode;
            const info = stocksInfo.get(stockCode);
            const quote = stocksQuotes.get(stockCode);
            return (
              <div
                key={series.stockCode}
                className="flex items-center gap-1.5 text-xs"
              >
                <div
                  className="w-3 h-0.5 rounded"
                  style={{ backgroundColor: series.color }}
                />
                <span className="font-medium">{stockCode}</span>
                {isMarket ? (
                  <>
                    <span className="text-muted-foreground">💰</span>
                    {quote && (
                      <span className="font-medium">
                        {formatPrice(quote.price)}
                      </span>
                    )}
                    {quote && (
                      <span
                        className={
                          quote.change >= 0
                            ? "text-emerald-500"
                            : "text-red-500"
                        }
                      >
                        {formatPercent(quote.changePercent)}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground">📊</span>
                    {info && (
                      <span className="text-muted-foreground">
                        {info.percentageShorted.toFixed(2)}%
                      </span>
                    )}
                    {quote && (
                      <span
                        className={
                          quote.change >= 0
                            ? "text-emerald-500"
                            : "text-red-500"
                        }
                      >
                        {formatPercent(quote.changePercent)}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
