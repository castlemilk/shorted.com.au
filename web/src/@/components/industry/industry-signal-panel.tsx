import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, ChevronRight, Files, TrendingDown } from "lucide-react";

import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { CompanyLogo } from "~/@/components/ui/company-logo";
import { getSectorImageAlt, getSectorImagePath } from "~/@/lib/sector-images";
import { cn } from "~/@/lib/utils";
import type {
  IndustryIntelligenceStory,
  StockCrowdingStatus,
} from "~/@/lib/industry-intelligence";

const STATUS_LABELS: Record<StockCrowdingStatus, string> = {
  crowded: "Crowded",
  elevated: "Elevated",
  watching: "Watching",
};

const STATUS_CLASSES: Record<StockCrowdingStatus, string> = {
  crowded: "border-red-500/30 bg-red-500/10 text-red-500",
  elevated: "border-orange-500/30 bg-orange-500/10 text-orange-500",
  watching: "border-primary/25 bg-primary/10 text-primary",
};

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatChange(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function IndustrySignalPanel({
  story,
  stockLimit = 8,
  className,
}: {
  story: IndustryIntelligenceStory;
  stockLimit?: number;
  className?: string;
}) {
  const stocks = story.topShortedStocks.slice(0, stockLimit);

  return (
    <section
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-card/80 p-4 shadow-amber-sm backdrop-blur-sm",
        className,
      )}
      aria-labelledby="industry-signal-panel-title"
      data-testid="industry-top-stocks-panel"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 p-1.5">
            <Image
              src={getSectorImagePath(story.industry.name)}
              alt={getSectorImageAlt(story.industry.name)}
              width={40}
              height={40}
              className="h-full w-full object-contain"
            />
          </span>
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-primary">
              <TrendingDown className="h-3 w-3" aria-hidden="true" />
              ASIC live signal
            </div>
            <h2
              id="industry-signal-panel-title"
              className="text-xl font-semibold tracking-tight text-balance"
            >
              Top Stocks In This Industry
            </h2>
            <p className="mt-1 max-w-[58ch] text-sm text-muted-foreground text-pretty">
              Ranked short-interest leaders for {story.industry.name}, linked
              into company pages and the broader top-shorts view.
            </p>
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-right">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Avg short
          </div>
          <div className="font-mono text-lg font-semibold tabular-nums">
            {formatPercent(story.shortSignals.averageShortPercent)}
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border border-border/60 bg-background/50">
        {stocks.length > 0 ? (
          <div className="divide-y divide-border/50">
            {stocks.map((stock) => (
              <Link
                key={stock.code}
                href={stock.href}
                prefetch={false}
                className="group grid min-w-0 grid-cols-[24px_34px_minmax(0,1fr)_70px_16px] items-center gap-2 px-3 py-3 text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:grid-cols-[28px_34px_minmax(0,1fr)_74px_18px] sm:gap-3"
              >
                <span className="font-mono text-sm font-semibold tabular-nums text-muted-foreground">
                  {stock.rank}
                </span>
                <CompanyLogo
                  stockCode={stock.code}
                  companyName={stock.name}
                  size={28}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-card p-1"
                  imageClassName="h-full w-full"
                />
                <span className="min-w-0">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-semibold text-foreground transition-colors group-hover:text-primary">
                      {stock.code}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "hidden shrink-0 justify-center px-1.5 py-0.5 font-mono text-[10px] leading-4 sm:inline-flex",
                        STATUS_CLASSES[stock.status],
                      )}
                    >
                      {STATUS_LABELS[stock.status]}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {stock.name}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-mono font-semibold tabular-nums">
                    {formatPercent(stock.shortPercent)}
                  </span>
                  <span
                    className={cn(
                      "block font-mono text-[11px] tabular-nums",
                      stock.change > 0 && "text-red-500",
                      stock.change < 0 && "text-green-600",
                      stock.change === 0 && "text-muted-foreground",
                    )}
                  >
                    {formatChange(stock.change)}
                  </span>
                </span>
                <ChevronRight
                  className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            No ranked stocks are available for this industry yet.
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-2">
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-10 justify-between"
        >
          <Link href="/top" prefetch={false}>
            View all top shorts
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-10 justify-between"
        >
          <Link href="/stocks" prefetch={false}>
            Find a stock
            <Files className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-10 justify-between"
        >
          <Link href={`/industry/${story.industry.slug}`} prefetch={false}>
            Open industry view
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
