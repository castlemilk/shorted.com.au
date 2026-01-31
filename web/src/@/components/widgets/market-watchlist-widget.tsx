"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import { Card } from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import {
  TrendingUp,
  TrendingDown,
  Plus,
  X,
  Search,
  Loader2,
  BarChart3,
} from "lucide-react";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import Link from "next/link";
import { Sparkline, type SparklineData } from "~/@/components/ui/sparkline";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { cn } from "~/@/lib/utils";
import debounce from "lodash/debounce";
import { searchStocksClient } from "~/app/actions/searchStocks";
import { useWatchlistData } from "~/@/hooks/use-stock-queries";
import { useWidgetVisibility } from "~/@/hooks/use-widget-visibility";

// Default watchlist
const DEFAULT_WATCHLIST = ["CBA", "BHP", "CSL", "WBC", "ANZ"];

// Time interval options
const TIME_INTERVALS = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "1y", label: "1Y" },
] as const;

interface StockSearchResult {
  productCode: string;
  name: string;
  percentageShorted: number;
  industry?: string;
}

export function MarketWatchlistWidget({
  config,
  onSettingsChange,
}: WidgetProps) {
  const [timeInterval, setTimeInterval] = useState<typeof TIME_INTERVALS[number]["value"]>("1m");

  // Stock search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Visibility-based lazy loading
  const { ref, hasBeenVisible } = useWidgetVisibility();

  // Get watchlist from config or use default
  const watchlist = useMemo(() => {
    const configWatchlist = config.settings?.stocks as string[] | undefined;
    return configWatchlist && configWatchlist.length > 0
      ? configWatchlist
      : DEFAULT_WATCHLIST;
  }, [config.settings?.stocks]);

  // Use TanStack Query for data fetching - only when visible
  const { quotes, historicalData, shortPositions, isLoading } = useWatchlistData(
    hasBeenVisible ? watchlist : [],
    timeInterval
  );

  // Update watchlist in settings
  const updateWatchlist = useCallback(
    (newWatchlist: string[]) => {
      if (onSettingsChange) {
        onSettingsChange({
          ...config.settings,
          stocks: newWatchlist,
        });
      }
    },
    [onSettingsChange, config.settings]
  );

  // Fetch search results
  const fetchSearchResults = useCallback(async (query: string) => {
    if (query.length < 1) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await searchStocksClient(query, 8);
      if (response?.stocks) {
        setSearchResults(
          response.stocks.map((stock) => ({
            productCode: stock.productCode,
            name: stock.name,
            percentageShorted: stock.percentageShorted,
            industry: stock.industry,
          }))
        );
      } else {
        setSearchResults([]);
      }
    } catch (error) {
      console.error("Error searching stocks:", error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  // Debounced search
  const debouncedSearch = useMemo(
    () =>
      debounce((query: string) => {
        void fetchSearchResults(query);
      }, 300),
    [fetchSearchResults]
  );

  useEffect(() => {
    if (searchQuery) {
      debouncedSearch(searchQuery);
    } else {
      setSearchResults([]);
    }
  }, [searchQuery, debouncedSearch]);

  // Handle clicking outside to close search
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target as Node)
      ) {
        setShowSearch(false);
        setSearchQuery("");
        setSearchResults([]);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Add stock to watchlist
  const addStock = useCallback(
    (stock: StockSearchResult) => {
      if (!watchlist.includes(stock.productCode)) {
        updateWatchlist([...watchlist, stock.productCode]);
      }
      setSearchQuery("");
      setSearchResults([]);
      setShowSearch(false);
      setSelectedIndex(-1);
    },
    [watchlist, updateWatchlist]
  );

  // Remove stock from watchlist
  const removeStock = useCallback(
    (symbol: string) => {
      updateWatchlist(watchlist.filter((s) => s !== symbol));
    },
    [watchlist, updateWatchlist]
  );

  // Handle keyboard navigation in search
  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        if (searchResults.length === 0) return;
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < searchResults.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        if (searchResults.length === 0) return;
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < searchResults.length) {
          const result = searchResults[selectedIndex];
          if (result) {
            addStock(result);
          }
        }
        break;
      case "Escape":
        setShowSearch(false);
        setSearchQuery("");
        setSearchResults([]);
        setSelectedIndex(-1);
        break;
    }
  };

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

  const getShortIntensity = (percentage: number): string => {
    if (percentage >= 15) return "text-red-600 font-semibold";
    if (percentage >= 10) return "text-orange-500 font-medium";
    if (percentage >= 5) return "text-yellow-600";
    return "text-muted-foreground";
  };

  // Loading state
  if (isLoading && watchlist.length > 0 && hasBeenVisible) {
    return (
      <div ref={ref} className="p-4 space-y-3">
        {Array.from({ length: Math.min(watchlist.length, 5) }).map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-12 w-16" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-10 w-24" />
          </div>
        ))}
      </div>
    );
  }

  // Not yet visible - show placeholder
  if (!hasBeenVisible) {
    return (
      <div ref={ref} className="p-4 space-y-3">
        <div className="flex items-center justify-between mb-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-7 w-20" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-12 w-16" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-10 w-24" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={ref} className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 pb-2 border-b">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Market Watchlist</h3>
          <div className="flex items-center gap-2">
            <Select value={timeInterval} onValueChange={(v) => setTimeInterval(v as typeof TIME_INTERVALS[number]["value"])}>
              <SelectTrigger className="h-7 w-14 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_INTERVALS.map((interval) => (
                  <SelectItem
                    key={interval.value}
                    value={interval.value}
                    className="text-xs"
                  >
                    {interval.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => {
                setShowSearch(!showSearch);
                setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Stock Search with Autocomplete */}
        {showSearch && (
          <div ref={searchContainerRef} className="relative">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value.toUpperCase())}
                onKeyDown={handleKeyDown}
                placeholder="Search stocks to add..."
                className="h-8 pl-8 pr-8 text-sm"
                autoComplete="off"
              />
              {searchLoading ? (
                <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults([]);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>

            {/* Search Results Dropdown */}
            {searchResults.length > 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
                <ul className="max-h-[200px] overflow-auto py-1" role="listbox" aria-label="Stock search results">
                  {searchResults.map((stock, index) => {
                    const alreadyAdded = watchlist.includes(stock.productCode);
                    return (
                      <li
                        key={stock.productCode}
                        onClick={() => !alreadyAdded && addStock(stock)}
                        onKeyDown={(e) => {
                          if (!alreadyAdded && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            addStock(stock);
                          }
                        }}
                        role="option"
                        aria-selected={selectedIndex === index}
                        aria-disabled={alreadyAdded}
                        tabIndex={alreadyAdded ? -1 : 0}
                        className={cn(
                          "px-3 py-2 transition-colors text-sm",
                          alreadyAdded
                            ? "opacity-50 cursor-not-allowed"
                            : "cursor-pointer hover:bg-accent",
                          selectedIndex === index && !alreadyAdded && "bg-accent"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-xs">
                                {stock.productCode}
                              </span>
                              {stock.industry && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                                  {stock.industry}
                                </span>
                              )}
                              {alreadyAdded && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-green-500/20 text-green-600">
                                  Added
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {stock.name}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] h-5",
                              getShortIntensity(stock.percentageShorted)
                            )}
                          >
                            {stock.percentageShorted.toFixed(1)}%
                          </Badge>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* No results */}
            {searchQuery.length >= 2 &&
              searchResults.length === 0 &&
              !searchLoading && (
                <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg p-3">
                  <p className="text-xs text-muted-foreground text-center">
                    No stocks found for &quot;{searchQuery}&quot;
                  </p>
                </div>
              )}
          </div>
        )}
      </div>

      {/* Stock List with Sparklines */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {watchlist.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm font-medium">No stocks in watchlist</p>
              <p className="text-xs mt-1">
                Click + to search and add stocks
              </p>
            </div>
          ) : (
            watchlist.map((symbol) => {
              const quote = quotes.get(symbol);
              const shortData = shortPositions.get(symbol);
              const historicalPrices = historicalData.get(symbol) ?? [];
              const sparklineData: SparklineData[] = historicalPrices.map(
                (d) => ({
                  date: new Date(d.date),
                  value: d.close,
                })
              );
              const isPositive = quote?.change !== undefined ? quote.change >= 0 : true;

              return (
                <Card
                  key={symbol}
                  className="p-2 hover:shadow-sm transition-shadow"
                >
                  <div className="flex items-center gap-3">
                    {/* Stock Info */}
                    <Link
                      href={`/shorts/${symbol}`}
                      className="flex-shrink-0 min-w-[80px]"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-sm">{symbol}</span>
                        {quote?.changePercent !== undefined && (
                          <Badge
                            variant={(quote.change ?? 0) >= 0 ? "default" : "destructive"}
                            className="text-[10px] h-4 px-1"
                          >
                            {(quote.change ?? 0) >= 0 ? (
                              <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
                            ) : (
                              <TrendingDown className="h-2.5 w-2.5 mr-0.5" />
                            )}
                            {formatPercent(quote.changePercent)}
                          </Badge>
                        )}
                      </div>
                      {quote && (
                        <p className="text-xs font-medium mt-0.5">
                          {formatPrice(quote.price)}
                        </p>
                      )}
                      {shortData && (
                        <p
                          className={cn(
                            "text-[10px]",
                            getShortIntensity(shortData.percentageShorted)
                          )}
                        >
                          {shortData.percentageShorted.toFixed(2)}% shorted
                        </p>
                      )}
                    </Link>

                    {/* Sparkline */}
                    <div className="flex-1 min-w-0 h-[70px]">
                      {sparklineData.length > 0 && quote ? (
                        <ParentSize>
                          {({ width, height }) => (
                            <Sparkline
                              data={sparklineData}
                              width={Math.max(width, 60)}
                              height={Math.max(height, 60)}
                              isPositive={isPositive}
                              showArea={true}
                              strokeWidth={1.5}
                              gradientId={`market-watchlist-${symbol}`}
                              showMinMax={true}
                            />
                          )}
                        </ParentSize>
                      ) : (
                        <Skeleton className="h-[70px] w-full" />
                      )}
                    </div>

                    {/* Remove button */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 flex-shrink-0 opacity-50 hover:opacity-100"
                      onClick={() => removeStock(symbol)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
