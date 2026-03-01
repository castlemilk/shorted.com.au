"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { type WidgetProps } from "@/types/dashboard";
import { type ScreenerStock } from "~/gen/shorts/v1alpha1/shorts_pb";
import { ScreenerSortField, SortDirection } from "~/gen/shorts/v1alpha1/shorts_pb";
import { screenStocks } from "~/app/actions/screenStocks";
import { cn } from "@/lib/utils";

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function ScreenerWidget({
  config: _config,
  sizeVariant = "standard",
}: WidgetProps) {
  const router = useRouter();
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
          sizeVariant === "compact" ? 5 : 10,
          0,
        );
        if (!cancelled && response) {
          setStocks(response.stocks);
        }
      } catch {
        // Silently handle errors in widget
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sizeVariant]);

  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-6 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="text-left py-1.5 px-2 font-medium">Stock</th>
              <th className="text-right py-1.5 px-2 font-medium">Short %</th>
              <th className="text-right py-1.5 px-2 font-medium">4W Chg</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((stock) => (
              <tr
                key={stock.stockCode}
                className="border-b last:border-b-0 hover:bg-muted/50 cursor-pointer transition-colors"
                onClick={() => router.push(`/shorts/${stock.stockCode}`)}
              >
                <td className="py-1.5 px-2 font-medium">
                  {stock.stockCode}
                </td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {stock.shortPct.toFixed(2)}%
                </td>
                <td
                  className={cn(
                    "py-1.5 px-2 text-right font-mono",
                    stock.shortPctChange4w > 0
                      ? "text-red-500"
                      : stock.shortPctChange4w < 0
                        ? "text-green-500"
                        : "",
                  )}
                >
                  {formatPercent(stock.shortPctChange4w)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t p-2">
        <Link
          href="/screener"
          className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Open full screener <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
