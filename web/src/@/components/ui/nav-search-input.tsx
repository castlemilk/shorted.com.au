"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Loader2, TrendingDown, ArrowRight } from "lucide-react";
import { cn } from "~/@/lib/utils";

interface StockResult {
  productCode: string;
  name: string;
  percentageShorted: number;
  industry?: string;
}

interface BackendStock {
  productCode: string;
  name: string;
  percentageShorted?: number;
  industry?: string;
}

interface BackendResponse {
  stocks?: BackendStock[];
}

interface LocalStock {
  code: string;
  name: string;
}

interface LocalResponse {
  results?: LocalStock[];
}

/**
 * Fetch search results using plain fetch to avoid Connect-RPC SSR import issues.
 * Tries the backend Connect-RPC endpoint first (JSON transport), falls back to local API route.
 */
async function fetchSearchResults(
  query: string,
  limit = 8
): Promise<StockResult[]> {
  if (!query.trim()) return [];

  // Try the backend Connect-RPC endpoint first (JSON transport, no protobuf imports)
  const baseUrl =
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
    "";

  if (baseUrl) {
    try {
      const res = await fetch(
        `${baseUrl}/shorts.v1alpha1.ShortedStocksService/SearchStocks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: query.trim(),
            limit,
            includeDetails: false,
          }),
        }
      );

      if (res.ok) {
        const data = (await res.json()) as BackendResponse;
        if (data.stocks?.length) {
          return data.stocks.map((s) => ({
            productCode: s.productCode,
            name: s.name,
            percentageShorted: s.percentageShorted ?? 0,
            industry: s.industry,
          }));
        }
      }
    } catch {
      // Fall through to local API
    }
  }

  // Fallback: use the local Next.js API route
  try {
    const res = await fetch(
      `/api/search/stocks?q=${encodeURIComponent(query)}`
    );
    if (res.ok) {
      const data = (await res.json()) as LocalResponse;
      return (data.results ?? []).map((s) => ({
        productCode: s.code,
        name: s.name,
        percentageShorted: 0,
        industry: undefined,
      }));
    }
  } catch {
    // ignore
  }

  return [];
}

export function NavSearchInput() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounced search
  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      void fetchSearchResults(q).then((r) => {
        setResults(r);
        setSelectedIndex(-1);
        setLoading(false);
      });
    }, 250);
  }, []);

  useEffect(() => {
    search(query);
  }, [query, search]);

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (window.innerWidth < 768) {
          setIsMobileOpen(true);
          setTimeout(() => mobileInputRef.current?.focus(), 50);
        } else {
          inputRef.current?.focus();
          setIsOpen(true);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (stock: StockResult) => {
    router.push(`/shorts/${stock.productCode}`);
    reset();
  };

  const reset = () => {
    setQuery("");
    setResults([]);
    setIsOpen(false);
    setIsMobileOpen(false);
    setSelectedIndex(-1);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          handleSelect(results[selectedIndex]!);
        } else if (query.length >= 2 && query.length <= 4) {
          router.push(`/shorts/${query.toUpperCase()}`);
          reset();
        }
        break;
      case "Escape":
        reset();
        break;
    }
  };

  const shortPercentColor = (pct: number) => {
    if (pct >= 10) return "text-red-400 bg-red-500/10 border-red-500/20";
    if (pct >= 5) return "text-orange-400 bg-orange-500/10 border-orange-500/20";
    return "text-muted-foreground bg-muted/50 border-border/50";
  };

  const showDropdown =
    isOpen && query.length >= 1 && (results.length > 0 || loading || query.length >= 2);
  const showMobileDropdown =
    isMobileOpen && query.length >= 1 && (results.length > 0 || loading || query.length >= 2);

  return (
    <div ref={containerRef} className="relative">
      {/* ─── Desktop: inline search input ─── */}
      <div className="relative group hidden md:block">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none transition-colors duration-200 group-focus-within:text-primary" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value.toUpperCase());
            setIsOpen(true);
          }}
          onFocus={() => {
            if (query) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search stocks..."
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "h-9 rounded-lg pl-9 pr-16 text-sm",
            "bg-muted/30 border border-border/40",
            "placeholder:text-muted-foreground/40",
            "focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 focus:bg-background/80",
            "transition-all duration-300 ease-out",
            "w-[200px] focus:w-[280px]"
          )}
        />
        {/* ⌘K badge */}
        {!query && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 pointer-events-none opacity-50 transition-opacity group-focus-within:opacity-0">
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono font-medium text-muted-foreground bg-muted/50 rounded border border-border/50">
              ⌘K
            </kbd>
          </div>
        )}
        {/* Clear / Loading indicator */}
        {query && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex">
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/50" />
            ) : (
              <button
                onClick={reset}
                className="text-muted-foreground/50 hover:text-foreground transition-colors"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* ─── Desktop: results dropdown ─── */}
      {showDropdown && (
        <div
          className={cn(
            "hidden md:block",
            "absolute z-[60] right-0 mt-2 w-[360px]",
            "rounded-xl border border-border/50 bg-popover/95 backdrop-blur-xl",
            "shadow-2xl shadow-black/20",
            "overflow-hidden",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200"
          )}
        >
          <ResultsContent
            results={results}
            loading={loading}
            query={query}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            onSelect={handleSelect}
            onNavigateDirect={() => {
              router.push(`/shorts/${query.toUpperCase()}`);
              reset();
            }}
            shortPercentColor={shortPercentColor}
          />
        </div>
      )}

      {/* ─── Mobile: search icon trigger ─── */}
      <button
        className={cn(
          "md:hidden flex items-center justify-center h-9 w-9 rounded-lg",
          "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          "transition-colors active:scale-95"
        )}
        onClick={() => {
          setIsMobileOpen(true);
          setTimeout(() => mobileInputRef.current?.focus(), 50);
        }}
        aria-label="Search stocks"
      >
        <Search className="h-4 w-4" />
      </button>

      {/* ─── Mobile: full-screen search overlay ─── */}
      {isMobileOpen && (
        <div className="md:hidden fixed inset-0 z-[60] animate-in fade-in-0 duration-150">
          {/* Backdrop */}
          <div
            role="button"
            tabIndex={-1}
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={reset}
            onKeyDown={(e) => {
              if (e.key === "Escape") reset();
            }}
            aria-label="Close search overlay"
          />

          {/* Search bar */}
          <div className="relative z-10 p-3 bg-background border-b border-border/50 animate-in slide-in-from-top-2 duration-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 pointer-events-none" />
              <input
                ref={mobileInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value.toUpperCase())}
                onKeyDown={handleKeyDown}
                placeholder="Search ASX stocks..."
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "w-full h-11 rounded-xl pl-10 pr-10 text-sm",
                  "bg-muted/30 border border-border/50",
                  "placeholder:text-muted-foreground/40",
                  "focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40"
                )}
              />
              <button
                onClick={reset}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close search"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Mobile results */}
          {showMobileDropdown && (
            <div className="relative z-10 mx-3 mt-2 rounded-xl border border-border/50 bg-popover/95 backdrop-blur-xl shadow-2xl overflow-hidden animate-in fade-in-0 slide-in-from-top-1 duration-200">
              <ResultsContent
                results={results}
                loading={loading}
                query={query}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                onSelect={handleSelect}
                onNavigateDirect={() => {
                  router.push(`/shorts/${query.toUpperCase()}`);
                  reset();
                }}
                shortPercentColor={shortPercentColor}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Shared results content used by both desktop dropdown and mobile overlay */
function ResultsContent({
  results,
  loading,
  query,
  selectedIndex,
  setSelectedIndex,
  onSelect,
  onNavigateDirect,
  shortPercentColor,
}: {
  results: StockResult[];
  loading: boolean;
  query: string;
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  onSelect: (stock: StockResult) => void;
  onNavigateDirect: () => void;
  shortPercentColor: (pct: number) => string;
}) {
  if (loading && results.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 gap-2.5 text-muted-foreground/50">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Searching...</span>
      </div>
    );
  }

  if (results.length === 0 && query.length >= 2) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <TrendingDown className="h-5 w-5 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground/50">
          No stocks found for &ldquo;{query}&rdquo;
        </p>
        {query.length >= 2 && query.length <= 4 && (
          <button
            onClick={onNavigateDirect}
            className="text-xs text-primary hover:text-primary/80 hover:underline underline-offset-2 mt-1 transition-colors"
          >
            Try viewing {query.toUpperCase()} directly &rarr;
          </button>
        )}
      </div>
    );
  }

  if (results.length === 0) return null;

  return (
    <>
      <ul
        className="max-h-[340px] overflow-auto py-1"
        role="listbox"
        aria-label="Stock search results"
      >
        {results.map((stock, index) => (
          <li
            key={stock.productCode}
            role="option"
            aria-selected={selectedIndex === index}
            tabIndex={0}
            onClick={() => onSelect(stock)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(stock);
              }
            }}
            onMouseEnter={() => setSelectedIndex(index)}
            className={cn(
              "relative flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-all duration-150",
              selectedIndex === index
                ? "bg-accent/80"
                : "hover:bg-accent/40"
            )}
          >
            {/* Stock code chip */}
            <div className="flex-shrink-0 w-[52px] h-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
              <span className="text-xs font-bold tracking-wide text-primary">
                {stock.productCode}
              </span>
            </div>

            {/* Name + industry */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate leading-tight">
                {stock.name}
              </p>
              {stock.industry && (
                <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
                  {stock.industry}
                </p>
              )}
            </div>

            {/* Short percentage badge */}
            {stock.percentageShorted > 0 && (
              <span
                className={cn(
                  "flex-shrink-0 text-[11px] font-semibold tabular-nums px-2 py-0.5 rounded-full border",
                  shortPercentColor(stock.percentageShorted)
                )}
              >
                {stock.percentageShorted.toFixed(1)}%
              </span>
            )}

            {/* Arrow indicator on selected */}
            <ArrowRight
              className={cn(
                "flex-shrink-0 h-3.5 w-3.5 transition-all duration-150",
                selectedIndex === index
                  ? "opacity-100 text-muted-foreground/60 translate-x-0"
                  : "opacity-0 -translate-x-1"
              )}
            />
          </li>
        ))}
      </ul>

      {/* Footer with keyboard hints */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/10">
        <span className="text-[10px] text-muted-foreground/40 tabular-nums">
          {results.length} result{results.length !== 1 ? "s" : ""}
        </span>
        <div className="hidden sm:flex items-center gap-2.5 text-[10px] text-muted-foreground/40">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-muted/40 font-mono border border-border/30 text-[9px]">
              ↑↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-muted/40 font-mono border border-border/30 text-[9px]">
              ↵
            </kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-muted/40 font-mono border border-border/30 text-[9px]">
              esc
            </kbd>
            close
          </span>
        </div>
      </div>
    </>
  );
}
