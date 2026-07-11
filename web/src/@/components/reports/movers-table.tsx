import Link from "next/link";
import { ChevronRight, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "~/@/lib/utils";
import { StockLogo } from "~/@/components/reports/stock-logo";
import { Sparkline } from "~/@/components/reports/sparkline";

interface Mover {
  code: string;
  name: string;
  currentPct: number;
  previousPct: number;
  change: number;
  // Snapshot fields — zero/empty on reports generated before the weekly
  // snapshot was extended; every column degrades gracefully.
  daysToCover?: number;
  zScore?: number;
  streakWeeks?: number;
  industry?: string;
  history?: number[];
  logoUrl?: string;
  significance?: number;
}

interface MoversTableProps {
  movers: Mover[];
  type: "risers" | "fallers";
}

export function MoversTable({ movers, type }: MoversTableProps) {
  if (movers.length === 0) return null;

  const isRisers = type === "risers";
  const Icon = isRisers ? TrendingUp : TrendingDown;
  const hasTrend = movers.some((m) => (m.history?.length ?? 0) >= 3);

  const mdCols = [
    "minmax(0,1fr)",
    ...(hasTrend ? ["100px"] : []),
    "150px",
    "84px",
    "28px",
  ].join(" ");

  const gridClass =
    "grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-3 md:gap-x-4 md:[grid-template-columns:var(--movers-grid-cols)]";

  return (
    <div
      className="overflow-hidden rounded-lg border border-border/60 bg-card/50"
      style={{ "--movers-grid-cols": mdCols } as React.CSSProperties}
    >
      <div
        className={cn(
          gridClass,
          "border-b border-border/60 bg-muted/50 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        )}
      >
        <div>Stock</div>
        {hasTrend && (
          <div className="hidden text-right md:block">13w trend</div>
        )}
        <div className="hidden text-right md:block">Prev → Now</div>
        <div className="text-right">Change</div>
        <div className="hidden md:block" />
      </div>
      <div className="divide-y divide-border/40">
        {movers.map((mover) => {
          const zScore = mover.zScore ?? 0;
          const streak = mover.streakWeeks ?? 0;
          const isUnusual = Math.abs(zScore) >= 2;
          return (
            <Link
              key={mover.code}
              href={`/shorts/${mover.code}`}
              prefetch={false}
              className={cn(
                gridClass,
                "group px-4 py-2.5 transition-colors hover:bg-muted/50",
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <StockLogo code={mover.code} logoUrl={mover.logoUrl} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold transition-colors group-hover:text-primary">
                      {mover.code}
                    </span>
                    {streak >= 3 && (
                      <span
                        className="rounded border border-border/70 bg-muted/60 px-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                        title={`${streak} consecutive weeks moving in the same direction`}
                      >
                        {streak}w streak
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {mover.name}
                    {mover.industry ? ` · ${mover.industry}` : ""}
                  </div>
                  {isUnusual && (
                    <div
                      className="mt-0.5 text-[11px] font-medium tabular-nums text-amber-600 dark:text-amber-400"
                      title="Standard deviations vs this stock's own 13-week change history"
                    >
                      {Math.abs(zScore).toFixed(1)}σ vs 13-wk norm — unusual move
                    </div>
                  )}
                </div>
              </div>
              {hasTrend && (
                <div className="hidden justify-end md:flex">
                  <Sparkline
                    data={mover.history ?? []}
                    width={84}
                    height={22}
                    label={`${mover.code} 13-week short interest trend`}
                  />
                </div>
              )}
              <div className="hidden items-baseline justify-end gap-1.5 md:flex">
                <span className="text-sm tabular-nums text-muted-foreground">
                  {mover.previousPct.toFixed(2)}
                </span>
                <span aria-hidden="true" className="text-xs text-muted-foreground/70">
                  →
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {mover.currentPct.toFixed(2)}%
                </span>
              </div>
              <div className="text-right">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                    isRisers
                      ? "bg-red-500/10 text-red-500"
                      : "bg-green-500/10 text-green-600",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {mover.change > 0 ? "+" : ""}
                  {mover.change.toFixed(2)}%
                </span>
              </div>
              <div className="hidden justify-end md:flex">
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
