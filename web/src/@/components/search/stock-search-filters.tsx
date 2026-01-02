"use client";

import { X, Filter, Building2, Coins, Tag, Sparkles } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import type { StockSearchFilters } from "~/@/lib/use-search-filters";
import { cn } from "~/@/lib/utils";

const INDUSTRIES = [
  "Banks",
  "Mining",
  "Healthcare",
  "Technology",
  "Energy",
  "Real Estate",
  "Consumer Discretionary",
  "Consumer Staples",
  "Industrials",
  "Utilities",
  "Telecommunication Services",
];

const MARKET_CAP_RANGES = [
  { label: "Large Cap", sublabel: ">$10B", value: "large" },
  { label: "Mid Cap", sublabel: "$2B-$10B", value: "mid" },
  { label: "Small Cap", sublabel: "<$2B", value: "small" },
];

// Industry icon mapping
const getIndustryIcon = (industry: string) => {
  const icons: Record<string, string> = {
    Banks: "🏦",
    Mining: "⛏️",
    Healthcare: "🏥",
    Technology: "💻",
    Energy: "⚡",
    "Real Estate": "🏢",
    "Consumer Discretionary": "🛍️",
    "Consumer Staples": "🛒",
    Industrials: "🏭",
    Utilities: "💡",
    "Telecommunication Services": "📡",
  };
  return icons[industry] ?? "📊";
};

interface StockSearchFiltersProps {
  filters: StockSearchFilters;
  onUpdateFilter: (
    key: keyof StockSearchFilters,
    value: string | string[] | null,
  ) => void;
  onClearFilters: () => void;
}

export function StockSearchFiltersView({
  filters,
  onUpdateFilter,
  onClearFilters,
}: StockSearchFiltersProps) {
  const hasActiveFilters =
    (filters.industry !== null && filters.industry !== "") ||
    (filters.marketCap !== null && filters.marketCap !== "") ||
    filters.tags.length > 0;

  const activeFilterCount = [
    filters.industry ? 1 : 0,
    filters.marketCap ? 1 : 0,
    filters.tags.length,
  ].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      {/* Filter Row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Filter Label */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="p-1.5 rounded-lg bg-muted">
            <Filter className="w-3.5 h-3.5" />
          </div>
          <span className="font-medium">Filters</span>
          {activeFilterCount > 0 && (
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold">
              {activeFilterCount}
            </span>
          )}
        </div>

        {/* Industry Filter */}
        <Select
          value={filters.industry ?? "all"}
          onValueChange={(value) =>
            onUpdateFilter("industry", value === "all" ? null : value)
          }
        >
          <SelectTrigger 
            className={cn(
              "w-auto min-w-[160px] h-9 rounded-xl border-border/50 bg-muted/50",
              "hover:bg-muted hover:border-border transition-all duration-200",
              "focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50",
              filters.industry && "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400"
            )}
          >
            <div className="flex items-center gap-2">
              <Building2 className="w-3.5 h-3.5" />
              <SelectValue placeholder="Industry" />
            </div>
          </SelectTrigger>
          <SelectContent className="rounded-xl border-border/50 bg-card/95 backdrop-blur-xl shadow-xl">
            <SelectItem value="all" className="rounded-lg">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />
                <span>All Industries</span>
              </div>
            </SelectItem>
            {INDUSTRIES.map((industry) => (
              <SelectItem key={industry} value={industry} className="rounded-lg">
                <div className="flex items-center gap-2">
                  <span>{getIndustryIcon(industry)}</span>
                  <span>{industry}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Market Cap Filter */}
        <Select
          value={filters.marketCap ?? "all"}
          onValueChange={(value) =>
            onUpdateFilter("marketCap", value === "all" ? null : value)
          }
        >
          <SelectTrigger 
            className={cn(
              "w-auto min-w-[150px] h-9 rounded-xl border-border/50 bg-muted/50",
              "hover:bg-muted hover:border-border transition-all duration-200",
              "focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50",
              filters.marketCap && "bg-purple-500/10 border-purple-500/30 text-purple-600 dark:text-purple-400"
            )}
          >
            <div className="flex items-center gap-2">
              <Coins className="w-3.5 h-3.5" />
              <SelectValue placeholder="Market Cap" />
            </div>
          </SelectTrigger>
          <SelectContent className="rounded-xl border-border/50 bg-card/95 backdrop-blur-xl shadow-xl">
            <SelectItem value="all" className="rounded-lg">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />
                <span>Any Size</span>
              </div>
            </SelectItem>
            {MARKET_CAP_RANGES.map((range) => (
              <SelectItem key={range.value} value={range.value} className="rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{range.label}</span>
                  <span className="text-muted-foreground text-xs">{range.sublabel}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Clear All Button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
            className={cn(
              "h-9 px-3 rounded-xl text-muted-foreground",
              "hover:text-red-600 hover:bg-red-500/10 dark:hover:text-red-400",
              "transition-all duration-200"
            )}
          >
            <span>Clear all</span>
            <X className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Active Filters Pills */}
      {hasActiveFilters && (
        <div className="flex flex-wrap gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
          {filters.industry && (
            <div className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-full",
              "bg-gradient-to-r from-blue-500/10 to-blue-600/5",
              "border border-blue-500/20 text-sm",
              "animate-in fade-in zoom-in-95 duration-200"
            )}>
              <span className="text-blue-600 dark:text-blue-400 font-medium">
                {getIndustryIcon(filters.industry)} {filters.industry}
              </span>
              <button
                onClick={() => onUpdateFilter("industry", null)}
                className="p-0.5 rounded-full hover:bg-blue-500/20 transition-colors"
              >
                <X className="h-3 w-3 text-blue-500" />
              </button>
            </div>
          )}
          
          {filters.marketCap && (
            <div className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-full",
              "bg-gradient-to-r from-purple-500/10 to-purple-600/5",
              "border border-purple-500/20 text-sm",
              "animate-in fade-in zoom-in-95 duration-200"
            )}>
              <Coins className="w-3.5 h-3.5 text-purple-500" />
              <span className="text-purple-600 dark:text-purple-400 font-medium">
                {MARKET_CAP_RANGES.find((r) => r.value === filters.marketCap)?.label}
              </span>
              <button
                onClick={() => onUpdateFilter("marketCap", null)}
                className="p-0.5 rounded-full hover:bg-purple-500/20 transition-colors"
              >
                <X className="h-3 w-3 text-purple-500" />
              </button>
            </div>
          )}
          
          {filters.tags.map((tag) => (
            <div 
              key={tag}
              className={cn(
                "inline-flex items-center gap-2 px-3 py-1.5 rounded-full",
                "bg-gradient-to-r from-amber-500/10 to-amber-600/5",
                "border border-amber-500/20 text-sm",
                "animate-in fade-in zoom-in-95 duration-200"
              )}
            >
              <Tag className="w-3 h-3 text-amber-500" />
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                #{tag}
              </span>
              <button
                onClick={() =>
                  onUpdateFilter(
                    "tags",
                    filters.tags.filter((t) => t !== tag)
                  )
                }
                className="p-0.5 rounded-full hover:bg-amber-500/20 transition-colors"
              >
                <X className="h-3 w-3 text-amber-500" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
