"use client";

import { X } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { Badge } from "~/@/components/ui/badge";
import { StockSearchFilters } from "~/@/lib/use-search-filters";

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
  { label: "Large Cap (>$10B)", value: "large" },
  { label: "Mid Cap ($2B - $10B)", value: "mid" },
  { label: "Small Cap (<$2B)", value: "small" },
];

interface StockSearchFiltersProps {
  filters: StockSearchFilters;
  onUpdateFilter: (key: keyof StockSearchFilters, value: any) => void;
  onClearFilters: () => void;
}

export function StockSearchFiltersView({
  filters,
  onUpdateFilter,
  onClearFilters,
}: StockSearchFiltersProps) {
  const hasActiveFilters =
    filters.industry || filters.marketCap || filters.tags.length > 0;

  return (
    <div className="flex flex-col gap-4 mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={filters.industry || "all"}
          onValueChange={(value) =>
            onUpdateFilter("industry", value === "all" ? null : value)
          }
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Select Industry" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Industries</SelectItem>
            {INDUSTRIES.map((industry) => (
              <SelectItem key={industry} value={industry}>
                {industry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.marketCap || "all"}
          onValueChange={(value) =>
            onUpdateFilter("marketCap", value === "all" ? null : value)
          }
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Market Cap" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any Market Cap</SelectItem>
            {MARKET_CAP_RANGES.map((range) => (
              <SelectItem key={range.value} value={range.value}>
                {range.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
            className="text-muted-foreground hover:text-foreground"
          >
            Clear all
            <X className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Active Filters Display */}
      {hasActiveFilters && (
        <div className="flex flex-wrap gap-2">
          {filters.industry && (
            <Badge variant="secondary" className="text-sm">
              {filters.industry}
              <button
                onClick={() => onUpdateFilter("industry", null)}
                className="ml-2 hover:text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {filters.marketCap && (
            <Badge variant="secondary" className="text-sm">
              {MARKET_CAP_RANGES.find((r) => r.value === filters.marketCap)?.label}
              <button
                onClick={() => onUpdateFilter("marketCap", null)}
                className="ml-2 hover:text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {filters.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-sm">
              #{tag}
              <button
                onClick={() =>
                  onUpdateFilter(
                    "tags",
                    filters.tags.filter((t) => t !== tag)
                  )
                }
                className="ml-2 hover:text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

