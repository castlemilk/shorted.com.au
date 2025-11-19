"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card } from "~/@/components/ui/card";
import { Input } from "~/@/components/ui/input";
import { Button } from "~/@/components/ui/button";
import { Search } from "lucide-react";
import {
  searchStocksEnriched,
  type StockSearchResult,
} from "~/@/lib/stock-data-service";
import {
  StockSearchResultItem,
  StockSearchResultItemSkeleton,
} from "~/@/components/search/stock-search-result-item";

interface PopularStock {
  code: string;
  name: string;
}

interface StocksSearchClientProps {
  popularStocks: PopularStock[];
}

export function StocksSearchClient({ popularStocks }: StocksSearchClientProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounced search
  const searchDebounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  return (
    <>
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
                {popularStocks.map((stock) => (
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
    </>
  );
}



