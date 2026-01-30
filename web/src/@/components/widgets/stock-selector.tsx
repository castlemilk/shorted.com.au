"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Input } from "~/@/components/ui/input";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { X, Plus, Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchStocksClient } from "~/app/actions/searchStocks";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getStockColor } from "@/lib/technical-indicators";
import { Switch } from "~/@/components/ui/switch";
import { Label } from "~/@/components/ui/label";

interface StockSelectorProps {
  selectedStocks: string[];
  onStocksChange: (stocks: string[]) => void;
  maxStocks?: number;
  className?: string;
  stockShortsVisibility?: Record<string, boolean>;
  onShortsVisibilityChange?: (stockCode: string, visible: boolean) => void;
  showShortsToggle?: boolean;
}

export function StockSelector({
  selectedStocks,
  onStocksChange,
  maxStocks = 5,
  className,
  stockShortsVisibility = {},
  onShortsVisibilityChange,
  showShortsToggle = false,
}: StockSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Stock[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (searchQuery.trim().length < 1) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await searchStocksClient(searchQuery.trim(), 10);
          if (response?.stocks) {
            // Filter out already selected stocks
            const filtered = response.stocks.filter(
              (stock: Stock) => !selectedStocks.includes(stock.productCode),
            );
            setSearchResults(filtered);
          } else {
            setSearchResults([]);
          }
        } catch (error) {
          console.error("Error searching stocks:", error);
          setSearchResults([]);
        } finally {
          setIsSearching(false);
        }
      })();
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery, selectedStocks]);

  const addStock = useCallback(
    (stockCode: string) => {
      const code = stockCode.toUpperCase().trim();
      if (
        code &&
        !selectedStocks.includes(code) &&
        selectedStocks.length < maxStocks
      ) {
        onStocksChange([...selectedStocks, code]);
        setSearchQuery("");
        setSearchResults([]);
      }
    },
    [selectedStocks, onStocksChange, maxStocks],
  );

  const removeStock = useCallback(
    (stockCode: string) => {
      onStocksChange(selectedStocks.filter((s) => s !== stockCode));
    },
    [selectedStocks, onStocksChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const firstResult = searchResults[0];
        if (firstResult) {
          addStock(firstResult.productCode);
        } else if (searchQuery.trim()) {
          addStock(searchQuery);
        }
      } else if (e.key === "Escape") {
        setIsOpen(false);
        setSearchQuery("");
      }
    },
    [addStock, searchQuery, searchResults],
  );

  const canAddMore = selectedStocks.length < maxStocks;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Selected stocks */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {selectedStocks.map((stock, index) => (
          <div key={stock} className="flex items-center gap-1.5">
            <Badge
              variant="secondary"
              className="pl-2 pr-1 py-1 text-xs font-medium"
              style={{
                borderLeft: `3px solid ${getStockColor(index)}`,
              }}
            >
              {stock}
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 ml-1 hover:bg-destructive/20"
                onClick={() => removeStock(stock)}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
            {showShortsToggle && onShortsVisibilityChange && (
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-border bg-background hover:bg-accent/50 transition-colors">
                <Switch
                  id={`shorts-toggle-${stock}`}
                  checked={stockShortsVisibility[stock] ?? true}
                  onCheckedChange={(checked) =>
                    onShortsVisibilityChange(stock, checked)
                  }
                  className="h-3.5 w-6"
                />
                <Label
                  htmlFor={`shorts-toggle-${stock}`}
                  className="text-[10px] text-muted-foreground cursor-pointer whitespace-nowrap ml-0.5"
                >
                  Shorts
                </Label>
              </div>
            )}
          </div>
        ))}

        {canAddMore && !isOpen && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setIsOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Stock
          </Button>
        )}
      </div>

      {/* Search input */}
      {isOpen && canAddMore && (
        <div className="relative">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              type="text"
              placeholder="Search by code or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-8 h-8 text-sm"
              autoFocus
            />
            {isSearching && (
              <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Search results dropdown */}
          {(searchResults.length > 0 || searchQuery.trim()) && (
            <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
              {searchResults.length > 0 ? (
                searchResults.map((stock) => (
                  <button
                    key={stock.productCode}
                    className="w-full px-3 py-2 text-left hover:bg-accent transition-colors flex items-center justify-between"
                    onClick={() => addStock(stock.productCode)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        {stock.productCode}
                      </span>
                      <span className="text-xs text-muted-foreground truncate max-w-[150px]">
                        {stock.name}
                      </span>
                    </div>
                    {stock.percentageShorted > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {stock.percentageShorted.toFixed(2)}%
                      </span>
                    )}
                  </button>
                ))
              ) : searchQuery.trim() && !isSearching ? (
                <button
                  className="w-full px-3 py-2 text-left hover:bg-accent transition-colors"
                  onClick={() => addStock(searchQuery)}
                >
                  <span className="text-sm">
                    Add{" "}
                    <span className="font-medium">
                      {searchQuery.toUpperCase()}
                    </span>
                  </span>
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Stock limit indicator */}
      {selectedStocks.length > 0 && (
        <p className="text-xs text-muted-foreground mt-1">
          {selectedStocks.length}/{maxStocks} stocks selected
        </p>
      )}
    </div>
  );
}
