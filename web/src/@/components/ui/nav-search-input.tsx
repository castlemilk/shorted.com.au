"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Input } from "~/@/components/ui/input";
import { Button } from "~/@/components/ui/button";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "~/@/lib/utils";
import debounce from "lodash/debounce";
import { searchStocksClient } from "~/app/actions/searchStocks";

interface StockResult {
  productCode: string;
  name: string;
  percentageShorted: number;
  industry?: string;
}

/**
 * Compact search input for the navigation bar with dropdown results.
 * Navigates to /shorts/[stockCode] when a stock is selected.
 */
export function NavSearchInput() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobileExpanded, setIsMobileExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch search results from Connect-RPC API
  const fetchResults = async (searchQuery: string) => {
    if (searchQuery.length < 1) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      const response = await searchStocksClient(searchQuery, 8);
      if (response?.stocks) {
        setResults(
          response.stocks.map((stock) => ({
            productCode: stock.productCode,
            name: stock.name,
            percentageShorted: stock.percentageShorted,
            industry: stock.industry,
          }))
        );
      } else {
        setResults([]);
      }
    } catch (error) {
      console.error("Error searching stocks:", error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  // Debounced search function - empty deps is intentional to create stable reference
  const debouncedSearch = useCallback(
    debounce((searchQuery: string) => {
      void fetchResults(searchQuery);
    }, 300),
    []
  );

  useEffect(() => {
    if (query) {
      debouncedSearch(query);
      setIsOpen(true);
    } else {
      setResults([]);
      setIsOpen(false);
    }
  }, [query, debouncedSearch]);

  // Handle clicking outside to close dropdown and mobile input
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setIsMobileExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        if (!isOpen || results.length === 0) return;
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < results.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        if (!isOpen || results.length === 0) return;
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          const result = results[selectedIndex];
          if (result) {
            handleSelect(result);
          }
        } else if (query.length >= 2 && query.length <= 4) {
          // Navigate directly if user typed a valid stock code
          router.push(`/shorts/${query.toUpperCase()}`);
          resetSearch();
        }
        break;
      case "Escape":
        setIsOpen(false);
        setSelectedIndex(-1);
        setIsMobileExpanded(false);
        inputRef.current?.blur();
        break;
    }
  };

  const handleSelect = (stock: StockResult) => {
    router.push(`/shorts/${stock.productCode}`);
    resetSearch();
  };

  const resetSearch = () => {
    setQuery("");
    setResults([]);
    setIsOpen(false);
    setSelectedIndex(-1);
    setIsMobileExpanded(false);
  };

  const handleMobileToggle = () => {
    setIsMobileExpanded(true);
    // Focus input after state update
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Mobile: Search icon button */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "md:hidden h-9 w-9",
          isMobileExpanded && "hidden"
        )}
        onClick={handleMobileToggle}
        aria-label="Search stocks"
      >
        <Search className="h-4 w-4" />
      </Button>

      {/* Desktop: Always visible input / Mobile: Expanded input */}
      <div
        className={cn(
          "relative",
          // Desktop: always show
          "hidden md:block",
          // Mobile: show when expanded
          isMobileExpanded && "!block absolute right-0 top-1/2 -translate-y-1/2 z-50"
        )}
      >
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            onFocus={() => query && setIsOpen(true)}
            placeholder="Search stocks..."
            className={cn(
              "h-9 pl-8 pr-8 text-sm bg-muted/50 border-transparent",
              "focus:bg-background focus:border-input",
              "transition-all duration-200",
              // Desktop width
              "md:w-[200px] md:focus:w-[260px]",
              // Mobile expanded width
              isMobileExpanded && "w-[260px] bg-background border-input"
            )}
            autoComplete="off"
          />
          {/* Loading spinner or clear button */}
          {loading ? (
            <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : query ? (
            <button
              type="button"
              onClick={resetSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {/* Results dropdown */}
        {isOpen && results.length > 0 && (
          <div className="absolute z-50 mt-1.5 w-full min-w-[280px] rounded-lg border bg-popover shadow-lg overflow-hidden">
            <ul className="max-h-[320px] overflow-auto py-1" role="listbox" aria-label="Stock search results">
              {results.map((stock, index) => (
                <li
                  key={stock.productCode}
                  onClick={() => handleSelect(stock)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSelect(stock);
                    }
                  }}
                  role="option"
                  aria-selected={selectedIndex === index}
                  tabIndex={0}
                  className={cn(
                    "cursor-pointer px-3 py-2.5 transition-colors",
                    "hover:bg-accent",
                    selectedIndex === index && "bg-accent"
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">
                          {stock.productCode}
                        </span>
                        {stock.industry && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {stock.industry}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {stock.name}
                      </p>
                    </div>
                    <div className="flex-shrink-0">
                      <span
                        className={cn(
                          "text-xs font-medium px-1.5 py-0.5 rounded",
                          stock.percentageShorted >= 10
                            ? "bg-red-500/15 text-red-600 dark:text-red-400"
                            : stock.percentageShorted >= 5
                              ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                              : "bg-muted text-muted-foreground"
                        )}
                      >
                        {stock.percentageShorted.toFixed(1)}% short
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {/* Footer hint */}
            <div className="px-3 py-2 border-t bg-muted/30 text-[10px] text-muted-foreground">
              Press <kbd className="px-1 py-0.5 rounded bg-muted font-mono">Enter</kbd> to select
              {" · "}
              <kbd className="px-1 py-0.5 rounded bg-muted font-mono">Esc</kbd> to close
            </div>
          </div>
        )}

        {/* No results message */}
        {isOpen && query.length >= 2 && results.length === 0 && !loading && (
          <div className="absolute z-50 mt-1.5 w-full min-w-[280px] rounded-lg border bg-popover shadow-lg p-4">
            <p className="text-sm text-muted-foreground text-center">
              No stocks found for &quot;{query}&quot;
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
