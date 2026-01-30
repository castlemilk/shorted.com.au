"use client";

import { useState, useCallback } from "react";
import { type WidgetProps, type WatchlistSettings, WidgetType } from "~/@/types/dashboard";
import { Card } from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import { TrendingUp, TrendingDown, Plus, X, BarChart3 } from "lucide-react";
import Link from "next/link";
import { Sparkline, type SparklineData } from "~/@/components/ui/sparkline";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/@/components/ui/tooltip";
import { useWatchlistData } from "~/@/hooks/use-stock-queries";
import { getTypedSettings } from "~/@/lib/widget-settings";
import { useWidgetVisibility } from "~/@/hooks/use-widget-visibility";
import { cn } from "~/@/lib/utils";

// Time interval options
const TIME_INTERVALS = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "1y", label: "1Y" },
] as const;

export function WatchlistWidget({ config, onSettingsChange, sizeVariant = "standard" }: WidgetProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddStock, setShowAddStock] = useState(false);
  const [hoveredStock, setHoveredStock] = useState<string | null>(null);
  const [hoveredData, setHoveredData] = useState<SparklineData | null>(null);
  const [timeInterval, setTimeInterval] = useState<WatchlistSettings["timeInterval"]>("1m");
  const { ref, hasBeenVisible } = useWidgetVisibility();

  // Get typed settings with defaults
  const settings = getTypedSettings(WidgetType.WATCHLIST, config.settings as Partial<WatchlistSettings>);
  const watchlist = settings.watchlist;

  // Use TanStack Query for data fetching
  const { quotes, historicalData, shortPositions, isLoading } = useWatchlistData(
    hasBeenVisible ? watchlist : [],
    timeInterval
  );

  // Update watchlist in settings
  const updateWatchlist = useCallback((newWatchlist: string[]) => {
    if (onSettingsChange) {
      onSettingsChange({
        ...config.settings,
        watchlist: newWatchlist,
      } as Partial<WatchlistSettings>);
    }
  }, [onSettingsChange, config.settings]);

  const addStock = useCallback((symbol: string) => {
    const upperSymbol = symbol.toUpperCase().trim();
    if (upperSymbol && !watchlist.includes(upperSymbol)) {
      updateWatchlist([...watchlist, upperSymbol]);
      setSearchQuery("");
      setShowAddStock(false);
    }
  }, [watchlist, updateWatchlist]);

  const removeStock = useCallback((symbol: string) => {
    updateWatchlist(watchlist.filter(s => s !== symbol));
  }, [watchlist, updateWatchlist]);

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(price);
  };

  const formatPercent = (value: number | undefined | null) => {
    if (value === undefined || value === null) {
      return "—";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  // Format short percentage with color coding
  const getShortIntensity = (percentage: number): string => {
    if (percentage >= 15) return "text-red-600 font-semibold";
    if (percentage >= 10) return "text-orange-500 font-medium";
    if (percentage >= 5) return "text-yellow-600";
    return "text-muted-foreground";
  };

  if (isLoading && watchlist.length > 0) {
    return (
      <div ref={ref} className="p-4 space-y-2">
        {Array.from({ length: Math.min(watchlist.length, 5) }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  // Compact mode: simplified card layout
  if (sizeVariant === "compact") {
    return (
      <TooltipProvider>
        <div ref={ref} className="flex flex-col h-full">
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {watchlist.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground">
                  <p className="text-xs">No stocks</p>
                </div>
              ) : (
                watchlist.map((symbol) => {
                  const quote = quotes.get(symbol);
                  const shortData = shortPositions.get(symbol);
                  const isPositive = quote?.change !== undefined ? quote.change >= 0 : true;

                  return (
                    <Link
                      key={symbol}
                      href={`/shorts/${symbol}`}
                      className="flex items-center justify-between p-2 rounded hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{symbol}</span>
                        {shortData && (
                          <Badge variant="outline" className={cn("text-[10px] h-4", getShortIntensity(shortData.percentageShorted))}>
                            {shortData.percentageShorted.toFixed(1)}%
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {quote && (
                          <>
                            <span className="text-xs">{formatPrice(quote.price)}</span>
                            <Badge
                              variant={isPositive ? "default" : "destructive"}
                              className="text-[10px] h-4"
                            >
                              {formatPercent(quote.changePercent)}
                            </Badge>
                          </>
                        )}
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div ref={ref} className="flex flex-col h-full">
        <div className="p-4 pb-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Watchlist</h3>
            <div className="flex items-center gap-2">
              <Select value={timeInterval} onValueChange={(v) => setTimeInterval(v as WatchlistSettings["timeInterval"])}>
                <SelectTrigger className="h-8 w-16">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_INTERVALS.map((interval) => (
                    <SelectItem key={interval.value} value={interval.value}>
                      {interval.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowAddStock(!showAddStock)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {showAddStock && (
            <div className="flex gap-2 mb-2">
              <Input
                placeholder="Stock code (e.g., CBA)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    addStock(searchQuery);
                  }
                }}
                className="h-8"
              />
              <Button
                size="sm"
                onClick={() => addStock(searchQuery)}
                disabled={!searchQuery.trim()}
              >
                Add
              </Button>
            </div>
          )}
        </div>

        <ScrollArea className="flex-1">
          <div className="px-4 pb-4 space-y-2">
            {watchlist.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">No stocks in watchlist</p>
                <p className="text-xs mt-1">Click + to add stocks</p>
              </div>
            ) : (
              watchlist.map((symbol) => {
                const quote = quotes.get(symbol);
                const shortData = shortPositions.get(symbol);

                const historicalPrices = historicalData.get(symbol) ?? [];
                const sparklineData: SparklineData[] = historicalPrices.map(d => ({
                  date: new Date(d.date),
                  value: d.close,
                }));
                const isPositive = quote?.change !== undefined ? quote.change >= 0 : true;

                return (
                  <Card
                    key={symbol}
                    className={cn(
                      "p-3 transition-all",
                      hoveredStock === symbol && "shadow-md scale-[1.02]"
                    )}
                    onMouseEnter={() => setHoveredStock(symbol)}
                    onMouseLeave={() => {
                      setHoveredStock(null);
                      setHoveredData(null);
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <Link href={`/shorts/${symbol}`} className="flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm">{symbol}</p>
                              {quote?.changePercent !== undefined && (
                                <Badge
                                  variant={(quote.change ?? 0) >= 0 ? "default" : "destructive"}
                                  className="text-xs h-5"
                                >
                                  <span className="inline-flex items-center gap-1">
                                    {(quote.change ?? 0) >= 0 ? (
                                      <TrendingUp className="h-3 w-3" />
                                    ) : (
                                      <TrendingDown className="h-3 w-3" />
                                    )}
                                    {formatPercent(quote.changePercent)}
                                  </span>
                                </Badge>
                              )}
                              {/* Short Position Badge */}
                              {shortData && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge
                                      variant="outline"
                                      className={cn("text-xs h-5", getShortIntensity(shortData.percentageShorted))}
                                    >
                                      <BarChart3 className="h-3 w-3 mr-1" />
                                      {shortData.percentageShorted.toFixed(2)}%
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs">
                                    <div className="space-y-1">
                                      <p className="font-medium">Short Position</p>
                                      <p>Shorted: {(shortData.reportedShortPositions / 1e6).toFixed(2)}M shares</p>
                                      <p>Total Issue: {(shortData.totalProductInIssue / 1e6).toFixed(2)}M shares</p>
                                      {shortData.industry && <p>Industry: {shortData.industry}</p>}
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            {quote ? (
                              <div className="flex items-center gap-3 mt-1">
                                <p className="text-sm font-medium">
                                  {formatPrice(quote.price)}
                                  {hoveredData && hoveredStock === symbol && (
                                    <span className="text-xs text-muted-foreground ml-2">
                                      ${hoveredData.value.toFixed(2)}
                                    </span>
                                  )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Vol: {((quote.volume ?? 0) / 1000000).toFixed(1)}M
                                </p>
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">Loading...</p>
                            )}
                            {/* Show company name on hover */}
                            {shortData?.name && hoveredStock === symbol && (
                              <p className="text-xs text-muted-foreground truncate mt-1">
                                {shortData.name}
                              </p>
                            )}
                          </div>

                          {/* Sparkline */}
                          {sparklineData.length > 0 && quote && (
                            <div className="flex items-center">
                              <Sparkline
                                data={sparklineData}
                                width={100}
                                height={40}
                                isPositive={isPositive}
                                showArea={true}
                                strokeWidth={2}
                                gradientId={`gradient-${symbol}`}
                                onHover={(data) => {
                                  if (hoveredStock === symbol) {
                                    setHoveredData(data);
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </Link>

                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-2 h-6 w-6 p-0"
                        onClick={() => removeStock(symbol)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Hover details */}
                    {hoveredStock === symbol && quote && (
                      <div className="mt-2 pt-2 border-t text-xs text-muted-foreground grid grid-cols-2 gap-2">
                        <div>
                          <span className="font-medium">Open:</span> {formatPrice(quote.open ?? 0)}
                        </div>
                        <div>
                          <span className="font-medium">Prev Close:</span> {formatPrice(quote.previousClose ?? 0)}
                        </div>
                        <div>
                          <span className="font-medium">Day Range:</span> {formatPrice(quote.low ?? 0)} - {formatPrice(quote.high ?? 0)}
                        </div>
                        <div>
                          <span className="font-medium">Volume:</span> {(quote.volume ?? 0) > 1000000 ? `${((quote.volume ?? 0) / 1000000).toFixed(1)}M` : (quote.volume ?? 0).toLocaleString()}
                        </div>
                        {/* Short position details on hover */}
                        {shortData && (
                          <>
                            <div className="col-span-2 border-t pt-2 mt-1">
                              <span className="font-medium text-foreground">Short Position Data</span>
                            </div>
                            <div>
                              <span className="font-medium">% Shorted:</span>{" "}
                              <span className={getShortIntensity(shortData.percentageShorted)}>
                                {shortData.percentageShorted.toFixed(2)}%
                              </span>
                            </div>
                            <div>
                              <span className="font-medium">Shares Shorted:</span> {(shortData.reportedShortPositions / 1e6).toFixed(2)}M
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
