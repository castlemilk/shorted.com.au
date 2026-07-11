import Link from "next/link";
import { cn } from "~/@/lib/utils";
import { type ReportIndustryStat } from "~/app/actions/reports/getReportData";

/**
 * Horizontal bar list of industry short-interest positioning for a report
 * period. Server component — plain HTML/CSS bars, no chart library.
 *
 * Bar length encodes average short % (magnitude → one hue, per the
 * red-equals-risk convention on report pages). The week-on-week delta is a
 * right-aligned arrow + number; identity and values stay in ink tokens.
 */

interface IndustryBreakdownProps {
  industries: ReportIndustryStat[];
  /** Label for the period-on-period delta column, e.g. "WoW" | "MoM" | "YoY" */
  changeLabel?: string;
  className?: string;
}

function DeltaArrow({ change }: { change: number }) {
  const rising = change > 0.005;
  const falling = change < -0.005;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
        rising && "text-red-500",
        falling && "text-green-600",
        !rising && !falling && "text-muted-foreground",
      )}
    >
      <span aria-hidden="true" className="text-[9px] leading-none">
        {rising ? "▲" : falling ? "▼" : "–"}
      </span>
      {change > 0 ? "+" : ""}
      {change.toFixed(2)}
    </span>
  );
}

export function IndustryBreakdown({
  industries,
  changeLabel = "WoW",
  className,
}: IndustryBreakdownProps) {
  const rows = (industries ?? []).filter((i) => i.industry);
  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => b.avgShortPct - a.avgShortPct);
  const maxAvg = Math.max(...sorted.map((i) => i.avgShortPct), 0.0001);

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-card/50",
        className,
      )}
      data-testid="industry-breakdown"
    >
      <div className="flex items-baseline justify-between border-b border-border/60 px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Avg short interest by industry
        </span>
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {changeLabel}
        </span>
      </div>
      <ul className="divide-y divide-border/40 px-4">
        {sorted.map((row) => (
          <li key={row.industry} className="py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {row.industry}
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {row.avgShortPct.toFixed(2)}%
                </span>
                <DeltaArrow change={row.wowChange} />
              </span>
            </div>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="presentation"
            >
              <div
                className="h-full rounded-full bg-red-500/60 dark:bg-red-500/50"
                style={{
                  width: `${Math.max((row.avgShortPct / maxAvg) * 100, 1.5)}%`,
                }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {row.stockCount} {row.stockCount === 1 ? "stock" : "stocks"}
              </span>
              {row.topStockCode ? (
                <span className="inline-flex items-center gap-1">
                  <span>top</span>
                  <Link
                    href={`/shorts/${row.topStockCode}`}
                    prefetch={false}
                    className="font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline"
                  >
                    {row.topStockCode}
                  </Link>
                  <span className="tabular-nums">
                    {row.topStockPct.toFixed(2)}%
                  </span>
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
