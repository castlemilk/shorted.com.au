import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "~/@/lib/utils";
import { StockLogo } from "~/@/components/reports/stock-logo";
import { Sparkline } from "~/@/components/reports/sparkline";

/**
 * Shared top-shorted-stocks table for weekly / monthly / yearly report
 * pages. Server component.
 *
 * Degrades gracefully for old reports that lack the snapshot fields:
 * the trend and days-to-cover columns only render when at least one row
 * has data, and the change column only renders when the enhanced report
 * exists. Mobile keeps the minimum viable columns (logo + code + short %).
 */

export interface TopStockRow {
  rank: number;
  code: string;
  name: string;
  shortPct: number;
  wowChange: number;
  daysToCover?: number;
  isNewEntrant?: boolean;
  industry?: string;
  history?: number[];
  logoUrl?: string;
}

interface TopStocksTableProps {
  stocks: TopStockRow[];
  /** Label for the period-on-period change column: "WoW" | "MoM" | "YoY" */
  changeLabel?: string;
  /** Whether the change column has real data (enhanced report present) */
  showChange?: boolean;
  className?: string;
}

function bandDotClass(shortPct: number): string | null {
  if (shortPct >= 10) return "bg-red-500";
  if (shortPct >= 5) return "bg-amber-500";
  return null;
}

export function TopStocksTable({
  stocks,
  changeLabel = "WoW",
  showChange = true,
  className,
}: TopStocksTableProps) {
  if (stocks.length === 0) return null;

  const hasTrend = stocks.some((s) => (s.history?.length ?? 0) >= 3);
  const hasDtc = stocks.some((s) => (s.daysToCover ?? 0) > 0);

  // md+ template assembled per available columns; mobile stays at the
  // minimum rank / stock / short % triplet (extra cells are display:none,
  // so grid auto-placement only sees three items).
  const mdCols = [
    "2.5rem",
    "minmax(0,1fr)",
    ...(hasTrend ? ["100px"] : []),
    ...(hasDtc ? ["60px"] : []),
    "88px",
    ...(showChange ? ["76px"] : []),
    "28px",
  ].join(" ");

  const gridClass =
    "grid grid-cols-[2rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 md:gap-x-4 md:[grid-template-columns:var(--report-grid-cols)]";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/60 bg-card/50",
        className,
      )}
      style={{ "--report-grid-cols": mdCols } as React.CSSProperties}
    >
      <div
        className={cn(
          gridClass,
          "border-b border-border/60 bg-muted/50 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        )}
      >
        <div className="text-center">#</div>
        <div>Stock</div>
        {hasTrend && (
          <div className="hidden text-right md:block">13w trend</div>
        )}
        {hasDtc && (
          <div
            className="hidden text-right md:block"
            title="Days to cover — reported short shares over 20-day average volume"
          >
            DtC
          </div>
        )}
        <div className="text-right">Short %</div>
        {showChange && <div className="hidden text-right md:block">{changeLabel}</div>}
        <div className="hidden md:block" />
      </div>
      <div className="divide-y divide-border/40">
        {stocks.map((stock, index) => {
          const dot = bandDotClass(stock.shortPct);
          return (
            <Link
              key={stock.code}
              href={`/shorts/${stock.code}`}
              prefetch={false}
              className={cn(
                gridClass,
                "group px-4 py-2.5 transition-colors hover:bg-muted/50",
              )}
            >
              <div
                className={cn(
                  "text-center text-sm tabular-nums",
                  index < 3
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {stock.rank}
              </div>
              <div className="flex min-w-0 items-center gap-2.5">
                <StockLogo code={stock.code} logoUrl={stock.logoUrl} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold transition-colors group-hover:text-primary">
                      {stock.code}
                    </span>
                    {stock.isNewEntrant && (
                      <span className="rounded border border-amber-500/40 px-1 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        New
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {stock.name}
                    {stock.industry ? ` · ${stock.industry}` : ""}
                  </div>
                </div>
              </div>
              {hasTrend && (
                <div className="hidden justify-end md:flex">
                  <Sparkline
                    data={stock.history ?? []}
                    width={84}
                    height={22}
                    label={`${stock.code} 13-week short interest trend`}
                  />
                </div>
              )}
              {hasDtc && (
                <div className="hidden text-right text-sm tabular-nums text-muted-foreground md:block">
                  {(stock.daysToCover ?? 0) > 0
                    ? stock.daysToCover!.toFixed(1)
                    : "—"}
                </div>
              )}
              <div className="flex items-center justify-end gap-1.5">
                {dot && (
                  <span
                    aria-hidden="true"
                    className={cn("h-1.5 w-1.5 rounded-full", dot)}
                  />
                )}
                <span className="text-sm font-semibold tabular-nums">
                  {stock.shortPct.toFixed(2)}%
                </span>
              </div>
              {showChange && (
                <div
                  className={cn(
                    "hidden text-right text-sm font-medium tabular-nums md:block",
                    stock.wowChange > 0 && "text-red-500",
                    stock.wowChange < 0 && "text-green-600",
                    stock.wowChange === 0 && "text-muted-foreground",
                  )}
                >
                  {stock.wowChange > 0 ? "+" : ""}
                  {stock.wowChange.toFixed(2)}%
                </div>
              )}
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
