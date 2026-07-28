"use client";

import { Suspense } from "react";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { screenStocks } from "~/app/actions/screenStocks";
import { ScreenerSortField, SortDirection, type ScreenerStock } from "~/gen/shorts/v1alpha1/screener_pb";
import { cn } from "~/@/lib/utils";

function EmbedTopShortsInner() {
  const searchParams = useSearchParams();
  const limit = Number(searchParams.get("limit") ?? "10");

  const [stocks, setStocks] = useState<ScreenerStock[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await screenStocks(
          undefined,
          ScreenerSortField.SHORT_PCT,
          SortDirection.DESC,
          Math.min(limit, 50),
          0,
        );
        if (!cancelled && response) {
          setStocks(response.stocks);
        }
      } catch {
        // Silently handle errors
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  if (isLoading) {
    return (
      <div className="p-2 space-y-1.5">
        {Array.from({ length: Math.min(limit, 10) }).map((_, i) => (
          <div key={i} className="h-6 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-2">
      <h2 className="text-sm font-semibold mb-2">
        Top {stocks.length} Most Shorted ASX Stocks
      </h2>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-1 px-1.5 font-medium">#</th>
            <th className="text-left py-1 px-1.5 font-medium">Code</th>
            <th className="text-left py-1 px-1.5 font-medium">Company</th>
            <th className="text-right py-1 px-1.5 font-medium">Short %</th>
            <th className="text-right py-1 px-1.5 font-medium">DTC</th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock, idx) => (
            <tr
              key={stock.stockCode}
              className="border-b last:border-b-0 hover:bg-muted/30"
            >
              <td className="py-1 px-1.5 text-muted-foreground">{idx + 1}</td>
              <td className="py-1 px-1.5">
                <Link
                  href={`https://shorted.com.au/shorts/${stock.stockCode}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  {stock.stockCode}
                </Link>
              </td>
              <td className="py-1 px-1.5 truncate max-w-[150px] text-muted-foreground">
                {stock.companyName}
              </td>
              <td
                className={cn(
                  "py-1 px-1.5 text-right font-mono",
                  stock.shortPct >= 15
                    ? "text-red-500 font-semibold"
                    : stock.shortPct >= 10
                      ? "text-red-400"
                      : stock.shortPct >= 5
                        ? "text-orange-400"
                        : "",
                )}
              >
                {stock.shortPct.toFixed(2)}%
              </td>
              <td className="py-1 px-1.5 text-right font-mono text-muted-foreground">
                {stock.daysToCover > 0 ? stock.daysToCover.toFixed(1) : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Embeddable top shorts table widget.
 * Usage: <iframe src="https://shorted.com.au/embed/top-shorts?limit=10" />
 *
 * `limit` is the only supported param (clamped to 50). This previously
 * documented a `theme=dark` param that was never implemented — the widget
 * inherits the host page's theme tokens.
 */
export default function EmbedTopShorts() {
  return (
    <Suspense
      fallback={
        <div className="p-2 space-y-1.5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-6 bg-muted animate-pulse rounded" />
          ))}
        </div>
      }
    >
      <EmbedTopShortsInner />
    </Suspense>
  );
}
