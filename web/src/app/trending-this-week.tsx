import Link from "next/link";
import { TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { cn } from "~/@/lib/utils";

/**
 * Server-rendered "Trending This Week" section for the homepage.
 * Shows stocks with the biggest short position changes (both increasing and decreasing).
 * Provides additional internal links for SEO and fresh content.
 */
export async function TrendingThisWeek() {
  let movers: Array<{
    code: string;
    name: string;
    percent: number;
    change: number;
  }> = [];

  try {
    const data = await getTopShortsData("1w", 50, 0);
    movers = (data?.timeSeries ?? [])
      .filter((ts) => ts.latestShortPosition > 0 && ts.points.length >= 2)
      .map((ts) => {
        // Calculate change from first to last point in the period
        const firstPoint = ts.points[0];
        const lastPoint = ts.points[ts.points.length - 1];
        const change = firstPoint && lastPoint
          ? lastPoint.shortPosition - firstPoint.shortPosition
          : 0;
        return {
          code: ts.productCode,
          name: ts.name || ts.productCode,
          percent: ts.latestShortPosition,
          change,
        };
      })
      .filter((s) => Math.abs(s.change) > 0.01)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 10);
  } catch {
    return null;
  }

  if (movers.length === 0) return null;

  const increasing = movers.filter((m) => m.change > 0).slice(0, 5);
  const decreasing = movers.filter((m) => m.change < 0).slice(0, 5);

  return (
    <section className="container mx-auto px-4 py-6 overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Trending This Week
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Stocks with the biggest short position changes
          </p>
        </div>
        <Link
          href="/screener"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
        >
          Screen all stocks <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Rising Short Interest */}
        {increasing.length > 0 && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-red-500" />
              <span className="text-sm font-medium text-red-600 dark:text-red-400">
                Rising Short Interest
              </span>
            </div>
            <div className="space-y-2">
              {increasing.map((stock) => (
                <Link
                  key={stock.code}
                  href={`/shorts/${stock.code}`}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-red-500/10 transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold text-sm group-hover:text-primary transition-colors">
                      {stock.code}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2 truncate">
                      {stock.name !== stock.code ? stock.name : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {stock.percent.toFixed(2)}%
                    </span>
                    <span className="text-xs font-medium text-red-500 tabular-nums">
                      +{stock.change.toFixed(2)}%
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Falling Short Interest */}
        {decreasing.length > 0 && (
          <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingDown className="h-4 w-4 text-green-500" />
              <span className="text-sm font-medium text-green-600 dark:text-green-400">
                Falling Short Interest
              </span>
            </div>
            <div className="space-y-2">
              {decreasing.map((stock) => (
                <Link
                  key={stock.code}
                  href={`/shorts/${stock.code}`}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-green-500/10 transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold text-sm group-hover:text-primary transition-colors">
                      {stock.code}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2 truncate">
                      {stock.name !== stock.code ? stock.name : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {stock.percent.toFixed(2)}%
                    </span>
                    <span className={cn(
                      "text-xs font-medium tabular-nums",
                      "text-green-500"
                    )}>
                      {stock.change.toFixed(2)}%
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
