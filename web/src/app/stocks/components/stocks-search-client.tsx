"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Input } from "~/@/components/ui/input";
import { Search, Sparkles, X, ArrowRight, TrendingUp, TrendingDown } from "lucide-react";
import {
  searchStocksEnriched,
  type StockSearchResult,
} from "~/@/lib/stock-data-service";
import {
  StockSearchResultItem,
  StockSearchResultItemSkeleton,
} from "~/@/components/search/stock-search-result-item";
import { StockSearchFiltersView } from "~/@/components/search/stock-search-filters";
import { useSearchFilters, type StockSearchFilters } from "~/@/lib/use-search-filters";
import { cn } from "~/@/lib/utils";

interface PopularStock {
  code: string;
  name: string;
  sector?: string;
}

interface StocksSearchClientProps {
  popularStocks: PopularStock[];
}

export function StocksSearchClient({ popularStocks }: StocksSearchClientProps) {
  const router = useRouter();
  const { filters, updateFilter, clearFilters } = useSearchFilters();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  // Debounced search
  const searchDebounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Search stocks using enriched API
  const searchStocksAPI = useCallback(async (query: string, filtersOverride?: StockSearchFilters) => {
    if (!query.trim() || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);

    try {
      const activeFilters = filtersOverride ?? filters;
      const results = await searchStocksEnriched(query.trim(), activeFilters, 10);
      setSearchResults(results);
    } catch (error) {
      console.error("Failed to search stocks:", error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [filters]);

  // Re-run search when filters change
  useEffect(() => {
    if (searchQuery.trim().length >= 2) {
      void searchStocksAPI(searchQuery);
    }
  }, [filters, searchStocksAPI]);

  // Handle search input change with debouncing
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);

    // Clear existing timeout
    if (searchDebounceTimeoutRef.current) {
      clearTimeout(searchDebounceTimeoutRef.current);
    }

    // Set new timeout for debounced search
    if (value.trim().length >= 2) {
      searchDebounceTimeoutRef.current = setTimeout(() => {
        void searchStocksAPI(value);
      }, 300);
    } else {
      setSearchResults([]);
    }
  };

  // Handle search result selection
  const handleSelectStock = (stockCode: string) => {
    router.push(`/shorts/${stockCode}`);
  };

  // Handle popular stock click
  const handlePopularStockClick = (stockCode: string) => {
    router.push(`/shorts/${stockCode}`);
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
  };

  // Get sector color
  const getSectorColor = (sector?: string) => {
    const colors: Record<string, string> = {
      Banking: "from-emerald-500/20 to-emerald-600/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
      Mining: "from-amber-500/20 to-amber-600/10 border-amber-500/30 text-amber-600 dark:text-amber-400",
      Healthcare: "from-pink-500/20 to-pink-600/10 border-pink-500/30 text-pink-600 dark:text-pink-400",
      Technology: "from-blue-500/20 to-blue-600/10 border-blue-500/30 text-blue-600 dark:text-blue-400",
      Retail: "from-purple-500/20 to-purple-600/10 border-purple-500/30 text-purple-600 dark:text-purple-400",
      Telecom: "from-cyan-500/20 to-cyan-600/10 border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
      Financial: "from-indigo-500/20 to-indigo-600/10 border-indigo-500/30 text-indigo-600 dark:text-indigo-400",
      Conglomerate: "from-orange-500/20 to-orange-600/10 border-orange-500/30 text-orange-600 dark:text-orange-400",
    };
    return colors[sector ?? ""] ?? "from-gray-500/20 to-gray-600/10 border-gray-500/30 text-gray-600 dark:text-gray-400";
  };

  return (
    <div className="space-y-6">
      {/* Search Section - Glassmorphism Card */}
      <div className={cn(
        "relative rounded-2xl p-[1px] transition-all duration-500",
        "bg-gradient-to-br from-border/50 via-border/30 to-border/50",
        isFocused && "from-blue-500/50 via-indigo-500/30 to-purple-500/50 shadow-lg shadow-blue-500/10 dark:shadow-blue-500/20"
      )}>
        {/* Glow effect */}
        <div className={cn(
          "absolute -inset-[1px] rounded-2xl bg-gradient-to-br from-blue-500/30 via-indigo-500/20 to-purple-500/30 blur-xl transition-opacity duration-500",
          isFocused ? "opacity-100" : "opacity-0"
        )} />
        
        <div className="relative rounded-2xl bg-card/95 backdrop-blur-xl p-6 md:p-8">
          <div className="max-w-4xl mx-auto">
            {/* Search Input */}
            <div className="relative mb-6 group">
              <div className={cn(
                "absolute left-4 top-1/2 -translate-y-1/2 transition-all duration-300",
                isFocused ? "text-blue-500" : "text-muted-foreground"
              )}>
                <Search className="h-5 w-5" />
              </div>
              <Input
                type="text"
                placeholder="Search by ticker, company name, or industry..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                className={cn(
                  "pl-12 pr-12 h-14 text-lg rounded-xl border-0 bg-muted/50",
                  "placeholder:text-muted-foreground/60",
                  "focus:ring-2 focus:ring-blue-500/20 focus:bg-muted/80",
                  "transition-all duration-300"
                )}
              />
              {searchQuery && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-muted transition-colors"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            </div>

            {/* Filters */}
            <StockSearchFiltersView 
              filters={filters}
              onUpdateFilter={updateFilter}
              onClearFilters={clearFilters}
            />

            {/* Popular Stocks */}
            {!searchQuery && !isSearching && searchResults.length === 0 && (
              <div className="mt-8 animate-in fade-in duration-500">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="w-4 h-4 text-amber-500" />
                  <p className="text-sm font-medium text-muted-foreground">
                    Popular Stocks
                  </p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {popularStocks.map((stock, index) => (
                    <button
                      key={stock.code}
                      onClick={() => handlePopularStockClick(stock.code)}
                      className={cn(
                        "group relative flex flex-col items-start p-4 rounded-xl border transition-all duration-300",
                        "bg-gradient-to-br hover:scale-[1.02] hover:shadow-lg",
                        getSectorColor(stock.sector),
                        "animate-in fade-in slide-in-from-bottom-2"
                      )}
                      style={{ animationDelay: `${index * 50}ms` }}
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className="font-bold text-base">{stock.code}</span>
                        <ArrowRight className="w-3.5 h-3.5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
                      </div>
                      <span className="text-xs text-muted-foreground truncate w-full text-left">
                        {stock.name}
                      </span>
                      {stock.sector && (
                        <span className="text-[10px] mt-1.5 font-medium opacity-70">
                          {stock.sector}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Search Results */}
      {(isSearching || searchResults.length > 0 || (searchQuery.trim().length >= 2 && !isSearching)) && (
        <div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
          {/* Results Header */}
          <div className="border-b border-border/50 px-6 py-4 bg-muted/30">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                {isSearching ? (
                  <>
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-muted-foreground">Searching...</span>
                  </>
                ) : searchResults.length > 0 ? (
                  <>
                    <span className="text-foreground">
                      {searchResults.length} Result{searchResults.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      for "{searchQuery}"
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No results found</span>
                )}
              </h2>
              {searchResults.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                  <span>{searchResults.filter(s => s.priceChange && s.priceChange >= 0).length} up</span>
                  <span className="text-border">•</span>
                  <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                  <span>{searchResults.filter(s => s.priceChange && s.priceChange < 0).length} down</span>
                </div>
              )}
            </div>
          </div>

          {/* Results List */}
          <div className="divide-y divide-border/30">
            {isSearching ? (
              <>
                <StockSearchResultItemSkeleton />
                <StockSearchResultItemSkeleton />
                <StockSearchResultItemSkeleton />
              </>
            ) : searchResults.length > 0 ? (
              searchResults.map((stock, index) => (
                <div
                  key={stock.product_code}
                  className="animate-in fade-in slide-in-from-left-2"
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  <StockSearchResultItem
                    stock={stock}
                    onClick={() => handleSelectStock(stock.product_code)}
                  />
                </div>
              ))
            ) : searchQuery.trim().length >= 2 ? (
              <div className="px-6 py-16 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-muted/50 flex items-center justify-center">
                  <Search className="h-8 w-8 text-muted-foreground/50" />
                </div>
                <p className="text-lg font-medium mb-2 text-foreground">
                  No stocks found
                </p>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  Try searching for a different stock code, company name, or adjust your filters
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
