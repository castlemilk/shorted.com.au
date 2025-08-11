"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import debounce from "lodash/debounce";

interface StockSuggestion {
  code: string;
  name: string;
  exchange?: string;
}

interface StockAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (stock: StockSuggestion) => void;
  placeholder?: string;
  className?: string;
}

// Common ASX stocks for quick suggestions
const COMMON_STOCKS: StockSuggestion[] = [
  { code: "CBA", name: "Commonwealth Bank of Australia" },
  { code: "BHP", name: "BHP Group Limited" },
  { code: "CSL", name: "CSL Limited" },
  { code: "NAB", name: "National Australia Bank" },
  { code: "WBC", name: "Westpac Banking Corporation" },
  { code: "ANZ", name: "Australia and New Zealand Banking Group" },
  { code: "WES", name: "Wesfarmers Limited" },
  { code: "MQG", name: "Macquarie Group Limited" },
  { code: "WOW", name: "Woolworths Group Limited" },
  { code: "TLS", name: "Telstra Corporation Limited" },
  { code: "RIO", name: "Rio Tinto Limited" },
  { code: "FMG", name: "Fortescue Metals Group" },
  { code: "GMG", name: "Goodman Group" },
  { code: "TCL", name: "Transurban Group" },
  { code: "WDS", name: "Woodside Energy Group" },
  { code: "NCM", name: "Newcrest Mining Limited" },
  { code: "ALL", name: "Aristocrat Leisure Limited" },
  { code: "COL", name: "Coles Group Limited" },
  { code: "REA", name: "REA Group Limited" },
  { code: "QBE", name: "QBE Insurance Group Limited" },
];

export function StockAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Search for a stock...",
  className,
}: StockAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<StockSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch stock suggestions from the API
  const fetchSuggestions = async (query: string) => {
    if (query.length < 1) {
      setSuggestions([]);
      return;
    }

    setLoading(true);
    try {
      // Try to fetch from company metadata endpoint
      const response = await fetch(`/api/search/stocks?q=${encodeURIComponent(query)}`);
      if (response.ok) {
        const data = await response.json() as { results?: StockSuggestion[] };
        setSuggestions(data.results ?? []);
      } else {
        // Fallback to filtering common stocks
        const filtered = COMMON_STOCKS.filter(
          stock =>
            stock.code.toLowerCase().includes(query.toLowerCase()) ||
            stock.name.toLowerCase().includes(query.toLowerCase())
        );
        setSuggestions(filtered);
      }
    } catch (error) {
      console.error("Error fetching stock suggestions:", error);
      // Fallback to common stocks on error
      const filtered = COMMON_STOCKS.filter(
        stock =>
          stock.code.toLowerCase().includes(query.toLowerCase()) ||
          stock.name.toLowerCase().includes(query.toLowerCase())
      );
      setSuggestions(filtered);
    } finally {
      setLoading(false);
    }
  };

  // Debounced search function
  const debouncedSearch = useCallback(
    debounce((query: string) => {
      void fetchSuggestions(query);
    }, 300),
    []
  );

  useEffect(() => {
    if (value) {
      debouncedSearch(value);
      setIsOpen(true);
    } else {
      setSuggestions([]);
      setIsOpen(false);
    }
  }, [value, debouncedSearch]);

  // Handle clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || suggestions.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex(prev => 
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          const suggestion = suggestions[selectedIndex];
          if (suggestion) {
            handleSelect(suggestion);
          }
        }
        break;
      case "Escape":
        setIsOpen(false);
        setSelectedIndex(-1);
        break;
    }
  };

  const handleSelect = (stock: StockSuggestion) => {
    onChange(stock.code);
    onSelect?.(stock);
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          onFocus={() => value && setIsOpen(true)}
          placeholder={placeholder}
          className={cn("pl-9", className)}
          autoComplete="off"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md"
        >
          <ul className="max-h-60 overflow-auto">
            {suggestions.map((stock, index) => (
              <li
                key={stock.code}
                onClick={() => handleSelect(stock)}
                className={cn(
                  "cursor-pointer rounded-sm px-3 py-2 text-sm transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  selectedIndex === index && "bg-accent text-accent-foreground"
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{stock.code}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {stock.name}
                    </span>
                  </div>
                  {stock.exchange && (
                    <span className="text-xs text-muted-foreground">
                      {stock.exchange}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}