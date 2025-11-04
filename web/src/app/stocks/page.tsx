"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
} from "lucide-react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";
import {
  getHistoricalData,
  searchStocksEnriched,
  type StockQuote,
  type HistoricalDataPoint,
  type StockSearchResult,
} from "@/lib/stock-data-service";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
  StockSearchResultItem,
  StockSearchResultItemSkeleton,
} from "@/components/search/stock-search-result-item";

// Popular ASX stocks for quick access
const POPULAR_STOCKS = [
  { code: "CBA", name: "Commonwealth Bank" },
  { code: "BHP", name: "BHP Group" },
  { code: "CSL", name: "CSL Limited" },
  { code: "WBC", name: "Westpac" },
  { code: "ANZ", name: "ANZ Bank" },
  { code: "NAB", name: "National Australia Bank" },
  { code: "WOW", name: "Woolworths" },
  { code: "WES", name: "Wesfarmers" },
  { code: "RIO", name: "Rio Tinto" },
  { code: "TLS", name: "Telstra" },
  { code: "XRO", name: "Xero" },
  { code: "MQG", name: "Macquarie Group" },
];

type TimePeriod = "1d" | "1w" | "1m" | "3m" | "6m" | "1y" | "5y" | "10y";

export default function StocksPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStock, _setSelectedStock] = useState<string | null>(null);
  const [stockQuote, _setStockQuote] = useState<StockQuote | null>(null);
  const [historicalData, setHistoricalData] = useState<HistoricalDataPoint[]>(
    [],
  );
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>("1m");
  const [loading, _setLoading] = useState(false);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounced search
  const searchDebounceTimeoutRef = useState<NodeJS.Timeout | null>(null)[0];

  // Load historical data
  const loadHistoricalData = useCallback(async () => {
    if (!selectedStock) return;

    setLoadingHistorical(true);
    try {
      const data = await getHistoricalData(selectedStock, selectedPeriod);
      setHistoricalData(data);
    } catch (error) {
      console.error("Failed to load historical data:", error);
    } finally {
      setLoadingHistorical(false);
    }
  }, [selectedStock, selectedPeriod]);

  // Load historical data when stock or period changes
  useEffect(() => {
    if (selectedStock) {
      void loadHistoricalData();
    }
  }, [selectedStock, selectedPeriod, loadHistoricalData]);

  // Search stocks using enriched API
  const searchStocksAPI = useCallback(async (query: string) => {
    if (!query.trim() || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);

    try {
      const results = await searchStocksEnriched(query.trim(), 10);
      setSearchResults(results);
    } catch (error) {
      console.error("Failed to search stocks:", error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Handle search input change with debouncing
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);

    // Clear existing timeout
    if (searchDebounceTimeoutRef) {
      clearTimeout(searchDebounceTimeoutRef);
    }

    // Set new timeout for debounced search
    if (value.trim().length >= 2) {
      const timeout = setTimeout(() => {
        void searchStocksAPI(value);
      }, 300);
      // Store timeout reference (using state would cause re-renders)
      Object.assign(searchDebounceTimeoutRef, timeout);
    } else {
      setSearchResults([]);
    }
  };

  // Handle search result selection
  const handleSelectStock = (stockCode: string) => {
    // Keep search query and results visible when navigating
    router.push(`/shorts/${stockCode}`);
  };

  // Handle popular stock click
  const handlePopularStockClick = (stockCode: string) => {
    router.push(`/shorts/${stockCode}`);
  };

  // Format currency
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  // Format number
  const formatNumber = (value: number) => {
    return new Intl.NumberFormat("en-AU").format(value);
  };

  // Format percentage
  const formatPercent = (value: number | undefined) => {
    if (value === undefined || value === null || isNaN(value)) {
      return "N/A";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  // Format date for chart
  const formatChartDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (selectedPeriod === "1d" || selectedPeriod === "1w") {
      return date.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
      });
    } else if (selectedPeriod === "1m" || selectedPeriod === "3m") {
      return date.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
      });
    } else {
      return date.toLocaleDateString("en-AU", {
        month: "short",
        year: "2-digit",
      });
    }
  };

  return (
    <DashboardLayout>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Stock Search & Analysis</h1>
        <p className="text-muted-foreground">
          Search ASX stocks by code, company name, or industry
        </p>
      </div>

      {/* Search Section */}
      <Card className="p-8 mb-8">
        <div className="max-w-3xl mx-auto">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-muted-foreground h-5 w-5" />
            <Input
              type="text"
              placeholder="Search stocks by code, name, or industry (e.g., CBA, mining, technology)"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-12 h-14 text-lg"
            />
          </div>

          {/* Popular Stocks */}
          {!searchQuery && !isSearching && searchResults.length === 0 && (
            <div className="mt-8">
              <p className="text-sm text-muted-foreground mb-4">
                Popular stocks:
              </p>
              <div className="flex flex-wrap gap-2">
                {POPULAR_STOCKS.map((stock) => (
                  <Button
                    key={stock.code}
                    variant="outline"
                    size="sm"
                    onClick={() => handlePopularStockClick(stock.code)}
                    className="text-sm"
                  >
                    <span className="font-semibold">{stock.code}</span>
                    <span className="ml-2 text-muted-foreground font-normal">
                      {stock.name}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Search Results List View */}
      {(isSearching ||
        searchResults.length > 0 ||
        (searchQuery.trim().length >= 2 && !isSearching)) && (
        <Card className="mb-8 overflow-hidden">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-lg font-semibold">
              {isSearching
                ? "Searching..."
                : searchResults.length > 0
                  ? `Found ${searchResults.length} result${searchResults.length !== 1 ? "s" : ""}`
                  : "No results found"}
            </h2>
          </div>
          <div className="divide-y divide-border">
            {isSearching ? (
              <>
                <StockSearchResultItemSkeleton />
                <StockSearchResultItemSkeleton />
                <StockSearchResultItemSkeleton />
              </>
            ) : searchResults.length > 0 ? (
              <>
                {searchResults.map((stock) => (
                  <StockSearchResultItem
                    key={stock.product_code}
                    stock={stock}
                    onClick={() => handleSelectStock(stock.product_code)}
                  />
                ))}
              </>
            ) : searchQuery.trim().length >= 2 ? (
              <div className="px-6 py-12 text-center text-muted-foreground">
                <Search className="h-12 w-12 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium mb-2">No stocks found</p>
                <p className="text-sm">
                  Try searching for a different stock code, company name, or
                  industry
                </p>
              </div>
            ) : null}
          </div>
        </Card>
      )}

      {/* Stock Data Section - Keep existing functionality */}
      {selectedStock && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Stock Info Card */}
          <Card className="p-6">
            <div className="space-y-4">
              {loading ? (
                <>
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-10 w-32" />
                  <Skeleton className="h-6 w-20" />
                  <div className="space-y-2 pt-4">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                </>
              ) : stockQuote ? (
                <>
                  <div>
                    <h2 className="text-2xl font-bold">{stockQuote.symbol}</h2>
                    <p className="text-3xl font-bold mt-2">
                      {formatCurrency(stockQuote.price)}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      {stockQuote.change >= 0 ? (
                        <TrendingUp className="h-4 w-4 text-green-600" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-red-600" />
                      )}
                      <span
                        className={cn(
                          "font-medium",
                          stockQuote.change >= 0
                            ? "text-green-600"
                            : "text-red-600",
                        )}
                      >
                        {formatCurrency(Math.abs(stockQuote.change))}
                        <span className="ml-1">
                          ({formatPercent(stockQuote.changePercent)})
                        </span>
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3 pt-4 border-t">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        Open
                      </span>
                      <span className="font-medium">
                        {stockQuote.open
                          ? formatCurrency(stockQuote.open)
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        High
                      </span>
                      <span className="font-medium">
                        {stockQuote.high
                          ? formatCurrency(stockQuote.high)
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">Low</span>
                      <span className="font-medium">
                        {stockQuote.low ? formatCurrency(stockQuote.low) : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        Volume
                      </span>
                      <span className="font-medium">
                        {stockQuote.volume
                          ? formatNumber(stockQuote.volume)
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        Previous Close
                      </span>
                      <span className="font-medium">
                        {formatCurrency(stockQuote.previousClose)}
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Activity className="h-12 w-12 mx-auto mb-4 opacity-20" />
                  <p>No data available for {selectedStock}</p>
                </div>
              )}
            </div>
          </Card>

          {/* Historical Chart */}
          <Card className="lg:col-span-2 p-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Price History</h3>
                <Tabs
                  value={selectedPeriod}
                  onValueChange={(v) => setSelectedPeriod(v as TimePeriod)}
                >
                  <TabsList>
                    <TabsTrigger value="1w">1W</TabsTrigger>
                    <TabsTrigger value="1m">1M</TabsTrigger>
                    <TabsTrigger value="3m">3M</TabsTrigger>
                    <TabsTrigger value="6m">6M</TabsTrigger>
                    <TabsTrigger value="1y">1Y</TabsTrigger>
                    <TabsTrigger value="5y">5Y</TabsTrigger>
                    <TabsTrigger value="10y">10Y</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              <div className="h-[400px]">
                {loadingHistorical ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <BarChart3 className="h-12 w-12 mx-auto mb-4 animate-pulse text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        Loading chart data...
                      </p>
                    </div>
                  </div>
                ) : historicalData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historicalData}>
                      <defs>
                        <linearGradient
                          id="colorPrice"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="#3b82f6"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="95%"
                            stopColor="#3b82f6"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={formatChartDate}
                        stroke="#6b7280"
                        fontSize={12}
                      />
                      <YAxis
                        stroke="#6b7280"
                        fontSize={12}
                        tickFormatter={(value: unknown) =>
                          `$${(value as number).toFixed(3)}`
                        }
                        domain={[
                          (dataMin: number) => Math.max(0, dataMin * 0.95),
                          (dataMax: number) => dataMax * 1.05,
                        ]}
                      />
                      <Tooltip
                        formatter={(value: unknown) =>
                          formatCurrency(value as number)
                        }
                        labelFormatter={(label: string) =>
                          new Date(label).toLocaleDateString("en-AU")
                        }
                        contentStyle={{
                          backgroundColor: "rgba(255, 255, 255, 0.95)",
                          border: "1px solid #e5e7eb",
                          borderRadius: "6px",
                          color: "#374151",
                        }}
                        labelStyle={{
                          color: "#374151",
                          fontWeight: "600",
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        fill="url(#colorPrice)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-20" />
                      <p>No historical data available</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Volume Chart */}
              {historicalData.length > 0 && (
                <div className="h-[150px] mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historicalData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={formatChartDate}
                        stroke="#6b7280"
                        fontSize={12}
                      />
                      <YAxis
                        stroke="#6b7280"
                        fontSize={12}
                        tickFormatter={(value) =>
                          `${(value / 1000000).toFixed(0)}M`
                        }
                      />
                      <Tooltip
                        formatter={(value: number) => formatNumber(value)}
                        labelFormatter={(label: string) =>
                          new Date(label).toLocaleDateString("en-AU")
                        }
                        contentStyle={{
                          backgroundColor: "rgba(255, 255, 255, 0.95)",
                          border: "1px solid #e5e7eb",
                          borderRadius: "6px",
                          color: "#374151",
                        }}
                        labelStyle={{
                          color: "#374151",
                          fontWeight: "600",
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="volume"
                        stroke="#6b7280"
                        fill="#9ca3af"
                        fillOpacity={0.3}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}
