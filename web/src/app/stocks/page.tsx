"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
  getStockPrice,
  searchStocks,
  type StockQuote,
  type HistoricalDataPoint,
  type StockSearchResult,
} from "@/lib/stock-data-service";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

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
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [stockQuote, setStockQuote] = useState<StockQuote | null>(null);
  const [historicalData, setHistoricalData] = useState<HistoricalDataPoint[]>(
    [],
  );
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>("1m");
  const [loading, setLoading] = useState(false);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Filter popular stocks based on search query
  const filteredStocks = useMemo(() => {
    if (!searchQuery) return POPULAR_STOCKS;
    const query = searchQuery.toLowerCase();
    return POPULAR_STOCKS.filter(
      (stock) =>
        stock.code.toLowerCase().includes(query) ||
        stock.name.toLowerCase().includes(query),
    );
  }, [searchQuery]);

  // Load stock data
  const loadStockData = useCallback(async (stockCode: string) => {
    setLoading(true);
    setSelectedStock(stockCode);
    setSearchQuery(stockCode);

    try {
      const quote = await getStockPrice(stockCode);
      if (quote) {
        setStockQuote(quote);
      }
    } catch (error) {
      console.error("Failed to load stock quote:", error);
    } finally {
      setLoading(false);
    }
  }, []);

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

  // Search stocks using API
  const searchStocksAPI = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const results = await searchStocks(query.trim(), 10);
      if (results) {
        setSearchResults(results.stocks);
      }
    } catch (error) {
      console.error("Failed to search stocks:", error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Handle search submission
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      // Close search results dropdown
      setSearchResults([]);
      void loadStockData(searchQuery.trim().toUpperCase());
    }
  };

  // Handle search input change with debounced API search
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (value.trim().length >= 2) {
      void searchStocksAPI(value);
    } else {
      setSearchResults([]);
    }
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
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Stock Analysis</h1>
        <p className="text-muted-foreground">
          Search and analyze ASX stocks with historical price data
        </p>
      </div>

      {/* Search Section */}
      <Card className="p-6 mb-8">
        <form onSubmit={handleSearch} className="flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              type="text"
              placeholder="Search by stock code or company name (e.g., CBA, BHP, Bank)"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setSearchResults([]);
                  void loadStockData(searchQuery.trim().toUpperCase());
                }
              }}
              className="pl-10"
            />
            {/* Search Results Dropdown */}
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-10 max-h-60 overflow-y-auto">
                {searchResults.map((stock) => (
                  <button
                    key={stock.product_code}
                    type="button"
                    onClick={() => {
                      setSearchQuery(stock.product_code);
                      setSearchResults([]);
                      void loadStockData(stock.product_code);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                  >
                    <div className="font-medium">{stock.product_code}</div>
                    <div className="text-sm text-gray-600">{stock.name}</div>
                    <div className="text-xs text-gray-500">
                      {stock.percentage_shorted.toFixed(2)}% shorted
                    </div>
                  </button>
                ))}
              </div>
            )}
            {isSearching && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-10 p-4 text-center text-gray-500">
                Searching...
              </div>
            )}
          </div>
          <Button type="submit" disabled={!searchQuery.trim()}>
            Search
          </Button>
        </form>

        {/* Popular Stocks */}
        <div className="mt-6">
          <p className="text-sm text-muted-foreground mb-3">Popular stocks:</p>
          <div className="flex flex-wrap gap-2">
            {filteredStocks.map((stock) => (
              <Button
                key={stock.code}
                variant="outline"
                size="sm"
                onClick={() => void loadStockData(stock.code)}
                className="text-xs"
              >
                {stock.code}
                <span className="ml-1 text-muted-foreground">{stock.name}</span>
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {/* Stock Data Section */}
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
                        tickFormatter={(value) => `$${value.toFixed(3)}`}
                        domain={[
                          (dataMin: number) => Math.max(0, dataMin * 0.95),
                          (dataMax: number) => dataMax * 1.05,
                        ]}
                      />
                      <Tooltip
                        formatter={(value: number) => formatCurrency(value)}
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
