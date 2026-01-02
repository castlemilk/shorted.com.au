"use client";

import { useEffect, useState } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import { Card } from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import { getMultipleStockQuotes, getHistoricalData, type StockQuote, type HistoricalDataPoint } from "@/lib/stock-data-service";
import { TrendingUp, TrendingDown, Plus, X } from "lucide-react";
import Link from "next/link";
import { Sparkline, type SparklineData } from "~/@/components/ui/sparkline";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/@/components/ui/select";

// Default watchlist for demo
const DEFAULT_WATCHLIST = ["CBA", "BHP", "CSL", "WBC", "ANZ", "RIO", "WOW", "TLS"];

// Time interval options
const TIME_INTERVALS = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "1y", label: "1Y" },
];

export function WatchlistWidget({ config }: WidgetProps) {
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<Map<string, StockQuote>>(new Map());
  const [historicalData, setHistoricalData] = useState<Map<string, HistoricalDataPoint[]>>(new Map());
  const [watchlist, setWatchlist] = useState<string[]>(
    (config.settings?.watchlist as string[]) || DEFAULT_WATCHLIST
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddStock, setShowAddStock] = useState(false);
  const [hoveredStock, setHoveredStock] = useState<string | null>(null);
  const [hoveredData, setHoveredData] = useState<SparklineData | null>(null);
  const [timeInterval, setTimeInterval] = useState("1m");

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const selectedInterval = TIME_INTERVALS.find(i => i.value === timeInterval) ?? TIME_INTERVALS[2];
        
        // Fetch quotes and historical data in parallel
        const [stockQuotes, historicalDataResults] = await Promise.all([
          getMultipleStockQuotes(watchlist),
          Promise.all(
            watchlist.map(async (symbol) => {
              try {
                const data = await getHistoricalData(symbol, selectedInterval?.value ?? "1m");
                return { symbol, data };
              } catch (error) {
                console.error(`Error fetching historical data for ${symbol}:`, error);
                return { symbol, data: [] };
              }
            })
          ),
        ]);

        setQuotes(stockQuotes);
        
        // Convert historical data results to map
        const historicalMap = new Map<string, HistoricalDataPoint[]>();
        historicalDataResults.forEach(({ symbol, data }) => {
          historicalMap.set(symbol, data);
        });
        setHistoricalData(historicalMap);
      } catch (error) {
        console.error("Error fetching watchlist data:", error);
      } finally {
        setLoading(false);
      }
    };

    let intervalId: NodeJS.Timeout | undefined;

    if (watchlist.length > 0) {
      void fetchData();
      
      // Refresh every minute
      intervalId = setInterval(() => void fetchData(), 60 * 1000);
    } else {
      setLoading(false);
    }
    
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [watchlist, timeInterval]);

  const addStock = (symbol: string) => {
    const upperSymbol = symbol.toUpperCase().trim();
    if (upperSymbol && !watchlist.includes(upperSymbol)) {
      setWatchlist([...watchlist, upperSymbol]);
      setSearchQuery("");
      setShowAddStock(false);
    }
  };

  const removeStock = (symbol: string) => {
    setWatchlist(watchlist.filter(s => s !== symbol));
  };

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

  if (loading && watchlist.length > 0) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 pb-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Watchlist</h3>
          <div className="flex items-center gap-2">
            <Select value={timeInterval} onValueChange={setTimeInterval}>
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
              
              const historicalPrices = historicalData.get(symbol) ?? [];
              const sparklineData: SparklineData[] = historicalPrices.map(d => ({
                date: new Date(d.date),
                value: d.close,
              }));
              const isPositive = quote ? quote.change >= 0 : true;
              
              return (
                <Card 
                  key={symbol} 
                  className={`p-3 transition-all ${hoveredStock === symbol ? 'shadow-md scale-[1.02]' : ''}`}
                  onMouseEnter={() => setHoveredStock(symbol)}
                  onMouseLeave={() => setHoveredStock(null)}
                >
                  <div className="flex items-center justify-between">
                    <Link 
                      href={`/shorts/${symbol}`}
                      className="flex-1"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm">{symbol}</p>
                            {quote && (
                              <Badge
                                variant={quote.change >= 0 ? "default" : "destructive"}
                                className="text-xs h-5"
                              >
                                <span className="inline-flex items-center gap-1">
                                  {quote.change >= 0 ? (
                                    <TrendingUp className="h-3 w-3" />
                                  ) : (
                                    <TrendingDown className="h-3 w-3" />
                                  )}
                                  {formatPercent(quote.changePercent)}
                                </span>
                              </Badge>
                            )}
                          </div>
                          {quote ? (
                            <div className="flex items-center gap-3 mt-1">
                              <p className="text-sm font-medium">
                                {formatPrice(quote.price)}
                                {hoveredData && (
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
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}