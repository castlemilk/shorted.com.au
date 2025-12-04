"use client";

import { useState } from "react";
import Image from "next/image";
import { Badge } from "~/@/components/ui/badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Sparkline } from "~/@/components/ui/sparkline";
import { type StockSearchResult } from "@/lib/stock-data-service";
import { getIndustryColor } from "@/lib/industry-colors";
import { useSparklineData } from "@/hooks/use-sparkline-data";
import { cn } from "~/@/lib/utils";

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

  const validLogoUrl = isValidLogoUrl(stock.logoUrl)
    ? stock.logoUrl
    : undefined;

  // Deterministic color generator for placeholder
  const getStockPlaceholder = (code: string) => {
    const colors = [
      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
      "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
      "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
    ];
    const hash = code
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };

  const placeholderClass = getStockPlaceholder(stock.product_code);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-6 py-4 text-left hover:bg-accent/50 transition-colors cursor-pointer group"
    >
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex-shrink-0">
          {validLogoUrl && !imageError ? (
            <div className="relative w-10 h-10 rounded-md overflow-hidden bg-muted">
              <Image
                src={validLogoUrl}
                alt={`${stock.product_code} logo`}
                fill
                className="object-contain p-1"
                sizes="40px"
                onError={() => {
                  setImageError(true);
                }}
              />
            </div>
          ) : (
            <div
              className={cn(
                "w-10 h-10 rounded-md flex items-center justify-center font-bold text-sm",
                placeholderClass,
              )}
            >
              {stock.product_code.slice(0, 2)}
            </div>
          )}
        </div>

        {/* Stock Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-base group-hover:text-primary transition-colors">
              {stock.product_code}
            </span>
            {stock.industry && (
              <Badge
                variant={industryColor.variant}
                className={cn("text-xs font-normal", industryColor.className)}
              >
                {stock.industry}
              </Badge>
            )}
          </div>
          <div className="text-sm text-muted-foreground truncate">
            {stock.companyName ?? stock.name}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Short: {stock.percentage_shorted.toFixed(2)}%
            {stock.currentPrice !== undefined && (
              <>
                {" • "}${stock.currentPrice.toFixed(2)}
                {stock.priceChange !== undefined && (
                  <span
                    className={cn(
                      "ml-1",
                      stock.priceChange >= 0
                        ? "text-green-600"
                        : "text-red-600",
                    )}
                  >
                    ({stock.priceChange >= 0 ? "+" : ""}
                    {stock.priceChange.toFixed(2)}%)
                  </span>
                )}
              </>
            )}
          </div>

          {/* Tags */}
          {stock.tags && stock.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {stock.tags.slice(0, 3).map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="text-[10px] px-1 py-0 h-4 border-muted-foreground/30 text-muted-foreground"
                >
                  #{tag}
                </Badge>
              ))}
              {stock.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground self-center">
                  +{stock.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Sparkline */}
        <div className="flex-shrink-0">
          {sparklineLoading ? (
            <Skeleton className="w-20 h-10" />
          ) : sparklineData && sparklineData.length > 1 ? (
            <div className="w-20 h-10">
              <Sparkline
                data={sparklineData}
                width={80}
                height={40}
                isPositive={isPositive}
                showArea={true}
                strokeWidth={1.5}
                gradientId={`sparkline-${stock.product_code}`}
              />
            </div>
          ) : (
            <div className="w-20 h-10 flex items-center justify-center text-xs text-muted-foreground">
              No data
            </div>
          )}
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
    <div className="w-full px-6 py-4">
      <div className="flex items-center gap-4">
        <Skeleton className="w-10 h-10 rounded-md flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="w-20 h-10 flex-shrink-0" />
      </div>
    </div>
  );
}
