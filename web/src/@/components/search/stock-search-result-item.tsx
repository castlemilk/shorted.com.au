"use client";

import { Building2 } from "lucide-react";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { type StockSearchResult } from "@/lib/stock-data-service";
import { getIndustryColor } from "@/lib/industry-colors";
import { useSparklineData } from "@/hooks/use-sparkline-data";
import { cn } from "@/lib/utils";

interface StockSearchResultItemProps {
  stock: StockSearchResult;
  onClick: () => void;
}

export function StockSearchResultItem({
  stock,
  onClick,
}: StockSearchResultItemProps) {
  const {
    data: sparklineData,
    loading: sparklineLoading,
    isPositive,
  } = useSparklineData(stock.product_code);
  const industryColor = getIndustryColor(stock.industry);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-6 py-4 text-left hover:bg-accent/50 transition-colors cursor-pointer group"
    >
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex-shrink-0">
          {stock.logoUrl ? (
            <div className="relative w-10 h-10 rounded-md overflow-hidden bg-muted">
              <Image
                src={stock.logoUrl}
                alt={`${stock.product_code} logo`}
                fill
                className="object-contain p-1"
                sizes="40px"
                onError={(e) => {
                  // Fallback to icon if image fails
                  e.currentTarget.style.display = "none";
                }}
              />
              {/* Fallback icon overlay */}
              <div className="absolute inset-0 flex items-center justify-center">
                <Building2 className="h-6 w-6 text-muted-foreground/50" />
              </div>
            </div>
          ) : (
            <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center">
              <Building2 className="h-6 w-6 text-muted-foreground" />
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
            {stock.companyName || stock.name}
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
