"use client";

import Link from "next/link";
import { TrendingUp, TrendingDown, Activity, ChevronRight } from "lucide-react";
import { type SerializedTimeSeriesData } from "~/app/actions/top/getTopPageData";
import { formatChange, formatPercentage } from "~/@/lib/shorts-calculations";
import { cn } from "~/@/lib/utils";
import { Skeleton } from "~/@/components/ui/skeleton";

type MoverType = "gainers" | "losers" | "volatile";

type MoverItem = SerializedTimeSeriesData & { change?: number; volatility?: number };

interface MoversCardProps {
  title: string;
  subtitle: string;
  items: MoverItem[];
  type: MoverType;
  isLoading?: boolean;
}

const typeConfig: Record<
  MoverType,
  {
    icon: typeof TrendingUp;
    iconColor: string;
    badgeColor: string;
    borderColor: string;
    getValue: (item: MoverItem) => number;
    formatValue: (value: number) => string;
  }
> = {
  gainers: {
    icon: TrendingUp,
    iconColor: "text-red-500",
    badgeColor: "bg-red-600 text-white",
    borderColor: "border-l-red-500",
    getValue: (item) => item.change ?? 0,
    formatValue: formatChange,
  },
  losers: {
    icon: TrendingDown,
    iconColor: "text-green-500",
    badgeColor: "bg-green-600 text-white",
    borderColor: "border-l-green-500",
    getValue: (item) => item.change ?? 0,
    formatValue: formatChange,
  },
  volatile: {
    icon: Activity,
    iconColor: "text-yellow-500",
    badgeColor: "bg-yellow-600 text-black",
    borderColor: "border-l-yellow-500",
    getValue: (item) => item.volatility ?? 0,
    formatValue: (v) => `±${formatPercentage(v)}`,
  },
};

export function MoversCard({
  title,
  subtitle,
  items,
  type,
  isLoading = false,
}: MoversCardProps) {
  const config = typeConfig[type];
  const Icon = config.icon;

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
        <div className="p-4 border-b border-border/40">
          <Skeleton className="h-5 w-32 mb-1" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="p-2 space-y-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-card/50 overflow-hidden border-l-4",
        config.borderColor
      )}
    >
      {/* Header */}
      <div className="p-4 border-b border-border/40">
        <div className="flex items-center gap-2">
          <Icon className={cn("h-4 w-4", config.iconColor)} aria-hidden="true" />
          <h3 className="font-semibold">{title}</h3>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      </div>

      {/* Items */}
      <nav className="divide-y divide-border/30" aria-label={`${title} stocks list`}>
        {items.map((item, index) => {
          const value = config.getValue(item);

          return (
            <Link
              key={item.productCode}
              href={`/shorts/${item.productCode}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3 min-w-0">
                {/* Rank */}
                <span className="text-xs text-muted-foreground w-4 tabular-nums" aria-label={`Rank ${index + 1}`}>
                  {index + 1}
                </span>

                {/* Stock info */}
                <div className="min-w-0">
                  <div className="font-medium text-sm group-hover:text-primary transition-colors">
                    {item.productCode}
                  </div>
                  <div className="text-xs text-muted-foreground truncate max-w-[140px]">
                    {item.name}
                  </div>
                </div>
              </div>

              {/* Value badge */}
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-xs font-semibold px-2 py-1 rounded tabular-nums",
                    config.badgeColor
                  )}
                  aria-label={`Change: ${config.formatValue(value)}`}
                >
                  {config.formatValue(value)}
                </span>
                <ChevronRight className="h-3 w-3 text-muted-foreground group-hover:text-foreground/70 transition-colors" aria-hidden="true" />
              </div>
            </Link>
          );
        })}
      </nav>

      {items.length === 0 && (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No data available
        </div>
      )}
    </div>
  );
}
