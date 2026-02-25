"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { AlertTriangle, ExternalLink } from "lucide-react";
import Link from "next/link";

export function BreakingNewsBanner() {
  const { data } = useQuery({
    queryKey: ["breaking-news"],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(ShortedStocksService, transport);
      return client.getMarketNews({ limit: 3, priceSensitiveOnly: true });
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: false,
  });

  if (!data?.articles?.length) return null;

  return (
    <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
          Price Sensitive
        </span>
      </div>
      <div className="space-y-2">
        {data.articles.map((article) => (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 group"
          >
            <div className="flex items-center gap-2 min-w-0">
              {article.stockCode && article.stockCode !== "MARKET" && (
                <Link
                  href={`/shorts/${article.stockCode}`}
                  className="text-xs font-mono font-bold text-primary hover:underline flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {article.stockCode}
                </Link>
              )}
              <span className="text-sm truncate group-hover:text-primary transition-colors">
                {article.headline}
              </span>
            </div>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>
        ))}
      </div>
    </div>
  );
}
