"use client";

import { useState } from "react";
import Image from "next/image";
import { normalizedLogoUrl } from "~/@/lib/logo";
import { Badge } from "~/@/components/ui/badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Sparkline } from "~/@/components/ui/sparkline";
import { type StockSearchResult } from "@/lib/stock-data-service";
import { getIndustryColor } from "@/lib/industry-colors";
import { useSparklineData } from "@/hooks/use-sparkline-data";
import { cn } from "~/@/lib/utils";
import { TrendingUp, TrendingDown, ArrowRight, Percent } from "lucide-react";

interface StockSearchResultItemProps {
  stock: StockSearchResult;
  onClick: () => void;
}

export function StockSearchResultItem({
  stock,
  onClick,
}: StockSearchResultItemProps) {
  const [imageError, setImageError] = useState(false);
  const {
    data: sparklineData,
    loading: sparklineLoading,
    isPositive,
  } = useSparklineData(stock.product_code);
  const industryColor = getIndustryColor(stock.industry);

  // Validate logo URL - only use if it's from an allowed domain
  const isValidLogoUrl = (url: string | undefined): boolean => {
    if (!url) return false;
    try {
      const parsedUrl = new URL(url);
      const allowedHosts = [
        "storage.googleapis.com",
        "lh3.googleusercontent.com",
        "shorted.com.au",
      ];
      return allowedHosts.some(
        (host) =>
          parsedUrl.hostname === host ||
          parsedUrl.hostname.endsWith(`.${host}`),
      );
    } catch {
      return false;
    }
  };

  // Prefer the normalized logo (256×256 trimmed + centred). The valid
  // check still runs against the raw URL we got from the API to decide
  // whether to render any logo at all (a few stocks have no metadata).
  const validLogoUrl = isValidLogoUrl(stock.logoUrl)
    ? normalizedLogoUrl(stock.product_code)
    : null;

  // Deterministic warm tint for the monogram placeholder. Flat, not a
  // gradient: the system has no decorative gradient vocabulary, and every
  // pair is hand-paired light/dark so it survives the theme flip.
  const getStockTint = (code: string) => {
    const tints = [
      "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/25",
      "bg-orange-500/10 text-orange-700 dark:text-orange-300 ring-orange-500/25",
      "bg-yellow-500/10 text-yellow-800 dark:text-yellow-300 ring-yellow-500/25",
      "bg-lime-600/10 text-lime-800 dark:text-lime-300 ring-lime-600/25",
      "bg-stone-500/10 text-stone-700 dark:text-stone-300 ring-stone-500/25",
    ];
    const hash = code
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return tints[hash % tints.length];
  };

  const tintClass = getStockTint(stock.product_code);
  const priceChange = stock.priceChange ?? 0;
  const isPricePositive = priceChange >= 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full px-6 py-5 text-left transition-colors duration-200 ease-out cursor-pointer group relative",
        "hover:bg-gradient-to-r hover:from-muted/80 hover:via-muted/50 hover:to-transparent",
        "focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
      )}
    >
      {/* Hover accent line */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary rounded-r-full opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      
      <div className="flex items-center gap-5">
        {/* Logo Container */}
        <div className="flex-shrink-0 relative">
          {validLogoUrl && !imageError ? (
            <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-muted ring-1 ring-border/50 group-hover:ring-2 group-hover:ring-primary/40 transition-shadow duration-200 ease-out">
              <Image
                src={validLogoUrl}
                alt={`${stock.product_code} logo`}
                fill
                className="object-contain p-1.5"
                sizes="48px"
                onError={() => {
                  setImageError(true);
                }}
              />
            </div>
          ) : (
            <div
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center font-bold text-sm",
                "ring-1 ring-inset transition-[box-shadow,transform] duration-200 ease-out",
                "group-hover:ring-2 group-hover:scale-105",
                tintClass,
              )}
            >
              {stock.product_code.slice(0, 2)}
            </div>
          )}
        </div>

        {/* Stock Info */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2.5">
            <span className="font-bold text-base group-hover:text-primary transition-colors">
              {stock.product_code}
            </span>
            {stock.industry && (
              <Badge
                variant={industryColor.variant}
                className={cn(
                  "text-[10px] font-medium px-2 py-0.5 rounded-md",
                  industryColor.className
                )}
              >
                {stock.industry}
              </Badge>
            )}
          </div>
          
          <div className="text-sm text-muted-foreground truncate font-medium">
            {stock.companyName ?? stock.name}
          </div>
          
          {/* Metrics Row */}
          <div className="flex items-center gap-4 text-xs">
            {/* Short Interest */}
            <div className="flex items-center gap-1.5">
              <div className="p-1 rounded bg-red-500/10 dark:bg-red-500/15">
                <Percent className="w-3 h-3 text-red-500" />
              </div>
              <span className="text-muted-foreground">Short:</span>
              <span className="font-semibold text-red-700 dark:text-red-400">
                {stock.percentage_shorted.toFixed(2)}%
              </span>
            </div>
            
            {/* Market Cap */}
            {stock.marketCap && stock.marketCap > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">MCap:</span>
                <span className="font-semibold text-foreground">
                  {stock.marketCap >= 1e9
                    ? `$${(stock.marketCap / 1e9).toFixed(1)}B`
                    : `$${(stock.marketCap / 1e6).toFixed(0)}M`}
                </span>
              </div>
            )}
            
            {/* Price & Change */}
            {stock.currentPrice !== undefined && (
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">
                  ${stock.currentPrice.toFixed(2)}
                </span>
                {stock.priceChange !== undefined && (
                  <div className={cn(
                    "flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-medium",
                    isPricePositive 
                      ? "bg-green-500/10 text-green-600 dark:text-green-400" 
                      : "bg-red-500/10 text-red-700 dark:text-red-400"
                  )}>
                    {isPricePositive ? (
                      <TrendingUp className="w-3 h-3" />
                    ) : (
                      <TrendingDown className="w-3 h-3" />
                    )}
                    <span>
                      {isPricePositive ? "+" : ""}
                      {stock.priceChange.toFixed(2)}%
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tags */}
          {stock.tags && stock.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {stock.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium"
                >
                  #{tag}
                </span>
              ))}
              {stock.tags.length > 4 && (
                <span className="text-[10px] text-muted-foreground/70 self-center font-medium">
                  +{stock.tags.length - 4} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Sparkline & Arrow */}
        <div className="flex items-center gap-4 flex-shrink-0">
          {/* Sparkline */}
          <div className="hidden sm:block">
            {sparklineLoading ? (
              <Skeleton className="w-24 h-12 rounded-lg" />
            ) : sparklineData && sparklineData.length > 1 ? (
              <div className={cn(
                "w-24 h-12 p-1 rounded-lg transition-colors duration-200 ease-out",
                "bg-gradient-to-br",
                isPositive 
                  ? "from-green-500/5 to-green-500/10" 
                  : "from-red-500/5 to-red-500/10"
              )}>
                <Sparkline
                  data={sparklineData}
                  width={88}
                  height={40}
                  isPositive={isPositive}
                  showArea={true}
                  strokeWidth={1.5}
                  gradientId={`sparkline-${stock.product_code}`}
                />
              </div>
            ) : (
              <div className="w-24 h-12 flex items-center justify-center text-[10px] text-muted-foreground/60 bg-muted/30 rounded-lg">
                No chart data
              </div>
            )}
          </div>

          {/* Arrow */}
          <div className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-[background-color,color,box-shadow] duration-200 ease-out",
            "bg-muted/50 group-hover:bg-primary group-hover:text-primary-foreground",
            "group-hover:shadow-amber"
          )}>
            <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-0.5" />
          </div>
        </div>
      </div>
    </button>
  );
}

/**
 * Skeleton loader for search result items
 */
export function StockSearchResultItemSkeleton() {
  return (
    <div className="w-full px-6 py-5">
      <div className="flex items-center gap-5">
        <Skeleton className="w-12 h-12 rounded-xl flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-14 rounded-md" />
            <Skeleton className="h-4 w-20 rounded-md" />
          </div>
          <Skeleton className="h-4 w-48 rounded-md" />
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-24 rounded-md" />
            <Skeleton className="h-4 w-16 rounded-md" />
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0">
          <Skeleton className="w-24 h-12 rounded-lg hidden sm:block" />
          <Skeleton className="w-8 h-8 rounded-full" />
        </div>
      </div>
    </div>
  );
}
