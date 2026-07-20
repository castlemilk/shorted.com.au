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

  return (
    <div className="space-y-6">
      {/* Search Section — warm terminal card (no gradient/glass) */}
      <div
        className={cn(
          "rounded-lg border bg-card p-6 shadow-sm transition-colors duration-300 md:p-8",
          isFocused ? "border-primary/40" : "border-border",
        )}
      >
        <div className="max-w-4xl mx-auto">
          {/* Search Input */}
          <div className="relative mb-6 group">
            <div
              className={cn(
                "absolute left-4 top-1/2 -translate-y-1/2 transition-colors duration-200",
                isFocused ? "text-primary" : "text-muted-foreground",
              )}
            >
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
                "h-14 rounded-lg bg-muted/40 pl-12 pr-12 text-lg",
                "placeholder:text-muted-foreground/60",
                "focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary/30",
                "transition-colors duration-200",
              )}
            />
            {searchQuery && (
              <button
                onClick={handleClearSearch}
                aria-label="Clear search"
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
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
              <div className="mb-4 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Popular stocks
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {popularStocks.map((stock, index) => (
                  <button
                    key={stock.code}
                    onClick={() => handlePopularStockClick(stock.code)}
                    className={cn(
                      "group flex flex-col items-start rounded-lg border border-border bg-muted/30 p-4 text-left transition-colors duration-200",
                      "hover:border-primary/40 hover:bg-muted/60",
                      "animate-in fade-in slide-in-from-bottom-2",
                    )}
                    style={{ animationDelay: `${index * 40}ms` }}
                  >
                    <div className="mb-1 flex w-full items-center justify-between">
                      <span className="font-mono text-base font-semibold tracking-tight text-foreground">
                        {stock.code}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 -translate-x-2 text-primary opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
                    </div>
                    <span className="w-full truncate text-xs text-muted-foreground">
                      {stock.name}
                    </span>
                    {stock.sector && (
                      <span className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
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

      {/* Search Results */}
      {(isSearching || searchResults.length > 0 || (searchQuery.trim().length >= 2 && !isSearching)) && (
        <div className="overflow-hidden rounded-lg border border-border bg-card animate-in fade-in slide-in-from-bottom-4 duration-500">
          {/* Results Header */}
          <div className="border-b border-border bg-muted/30 px-6 py-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                {isSearching ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
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
                <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>{searchResults.filter(s => s.priceChange && s.priceChange >= 0).length} up</span>
                  <span className="text-border">•</span>
                  <TrendingDown className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                  <span>{searchResults.filter(s => s.priceChange && s.priceChange < 0).length} down</span>
                </div>
              )}
            </div>
          </div>

          {/* Results List */}
          <div className="divide-y divide-border/60">
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
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg border border-border bg-muted/40">
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
