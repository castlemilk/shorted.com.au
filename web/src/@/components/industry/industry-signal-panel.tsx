import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, ChevronRight, Files, TrendingDown } from "lucide-react";

import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { getSectorImageAlt, getSectorImagePath } from "~/@/lib/sector-images";
import { cn } from "~/@/lib/utils";
import type {
  IndustryIntelligenceStory,
  IndustryTopStock,
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
  id,
}: {
  story: IndustryIntelligenceStory;
  stockLimit?: number;
  className?: string;
  id?: string;
}) {
  const stocks = story.topShortedStocks.slice(0, stockLimit);
  const statusCounts = {
    crowded: stocks.filter((stock) => stock.status === "crowded").length,
    elevated: stocks.filter((stock) => stock.status === "elevated").length,
    watching: stocks.filter((stock) => stock.status === "watching").length,
  };
  const rankedCount = stocks.length;
  const statusMix = [
    {
      label: "Crowded",
      count: statusCounts.crowded,
      detail: "10%+ short",
      barClassName: "bg-red-500",
    },
    {
      label: "Elevated",
      count: statusCounts.elevated,
      detail: "5-9.99%",
      barClassName: "bg-orange-500",
    },
    {
      label: "Watching",
      count: statusCounts.watching,
      detail: "Below 5%",
      barClassName: "bg-primary",
    },
  ];

  return (
    <section
      id={id}
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
              Industry ranking
            </div>
            <h2
              id="industry-signal-panel-title"
              className="text-xl font-semibold tracking-tight text-balance"
            >
              Top Shorts In This Industry
            </h2>
            <p className="mt-1 max-w-[58ch] text-sm text-muted-foreground text-pretty">
              Ranked companies in {story.industry.name}, with current short
              interest, movement, company metadata, and detail links.
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

      <div
        className="mt-4 rounded-md border border-border/60 bg-background/50 p-3"
        data-testid="industry-short-status-mix"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Short-interest mix
          </div>
          <div className="text-xs text-muted-foreground">
            {story.shortSignals.source.name},{" "}
            {story.shortSignals.source.cadence}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {statusMix.map((item) => (
            <div
              key={item.label}
              className="min-w-0 rounded-md border border-border/50 bg-card/55 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{item.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.detail}
                  </div>
                </div>
                <div className="font-mono text-lg font-semibold tabular-nums">
                  {item.count}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div
          className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted"
          aria-label="Short-interest status mix for ranked stocks"
        >
          {statusMix.map((item) => {
            const width =
              rankedCount > 0 ? (item.count / rankedCount) * 100 : 0;

            return (
              <span
                key={item.label}
                className={cn("block h-full", item.barClassName)}
                style={{ width: `${width}%` }}
              />
            );
          })}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border border-border/60 bg-background/50">
        {stocks.length > 0 ? (
          <div className="divide-y divide-border/50">
            <div className="hidden grid-cols-[36px_40px_minmax(0,1fr)_100px_92px_76px_20px] items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground md:grid">
              <span>Rank</span>
              <span aria-hidden="true" />
              <span>Company</span>
              <span>Status</span>
              <span className="text-right">Short</span>
              <span className="text-right">Change</span>
              <span aria-hidden="true" />
            </div>
            {stocks.map((stock) => (
              <Link
                key={stock.code}
                href={stock.href}
                prefetch={false}
                className="group grid min-w-0 grid-cols-[24px_34px_minmax(0,1fr)_70px_16px] items-center gap-2 px-3 py-3 text-sm transition-[background-color,transform] hover:bg-muted/60 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:grid-cols-[28px_34px_minmax(0,1fr)_74px_18px] sm:gap-3 md:grid-cols-[36px_40px_minmax(0,1fr)_100px_92px_76px_20px]"
              >
                <span className="font-mono text-sm font-semibold tabular-nums text-muted-foreground">
                  {stock.rank}
                </span>
                <StockLogoMark stock={stock} />
                <span className="min-w-0">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-semibold text-foreground transition-colors group-hover:text-primary">
                      {stock.code}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {stock.name}
                  </span>
                  <span className="mt-0.5 hidden text-xs leading-5 text-muted-foreground text-pretty sm:block">
                    {stock.detail}
                  </span>
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "hidden shrink-0 justify-center px-1.5 py-0.5 font-mono text-[10px] leading-4 md:inline-flex",
                    STATUS_CLASSES[stock.status],
                  )}
                >
                  {STATUS_LABELS[stock.status]}
                </Badge>
                <span className="text-right">
                  <span className="block font-mono font-semibold tabular-nums">
                    {formatPercent(stock.shortPercent)}
                  </span>
                  <span
                    className={cn(
                      "block font-mono text-[11px] tabular-nums md:hidden",
                      stock.change > 0 && "text-red-500",
                      stock.change < 0 && "text-green-600",
                      stock.change === 0 && "text-muted-foreground",
                    )}
                  >
                    {formatChange(stock.change)}
                  </span>
                </span>
                <span
                  className={cn(
                    "hidden text-right font-mono text-sm font-semibold tabular-nums md:block",
                    stock.change > 0 && "text-red-500",
                    stock.change < 0 && "text-green-600",
                    stock.change === 0 && "text-muted-foreground",
                  )}
                >
                  {formatChange(stock.change)}
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

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
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

function StockLogoMark({ stock }: { stock: IndustryTopStock }) {
  const codeMark = stock.code.slice(0, 3);
  const className =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card p-1 md:h-9 md:w-9";

  if (stock.logoUrl) {
    return (
      <span className={className}>
        <Image
          src={stock.logoUrl}
          alt={`${stock.name} logo`}
          width={28}
          height={28}
          className="h-full w-full object-contain"
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        className,
        "bg-primary/10 px-1 font-mono text-[10px] font-semibold text-primary",
      )}
      aria-label={`${stock.name} ticker mark`}
    >
      {codeMark}
    </span>
  );
}
