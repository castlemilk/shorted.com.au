"use client";

import { type WidgetProps, type NewsFeedSettings, WidgetType } from "~/@/types/dashboard";
import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { Skeleton } from "~/@/components/ui/skeleton";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import {
  NewsSourceBadge,
  isASXSource,
} from "~/@/components/ui/news-source-badge";
import { ExternalLink, AlertTriangle, Megaphone } from "lucide-react";
import { useWidgetVisibility } from "~/@/hooks/use-widget-visibility";
import { getTypedSettings } from "~/@/lib/widget-settings";
import Link from "next/link";

export function NewsFeedWidget({ config, sizeVariant = "standard" }: WidgetProps) {
  const { ref, hasBeenVisible } = useWidgetVisibility();

  const settings = getTypedSettings(WidgetType.NEWS_FEED, config.settings as Partial<NewsFeedSettings>);
  const { limit, priceSensitiveOnly, refreshInterval } = settings;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["market-news-widget", limit, priceSensitiveOnly],
    queryFn: async () => {
      const transport = createConnectTransport({ baseUrl: "" });
      const client = createClient(ShortedStocksService, transport);
      return client.getMarketNews({ limit, priceSensitiveOnly });
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: refreshInterval,
    enabled: hasBeenVisible,
    retry: false,
  });

  if (isLoading) {
    return (
      <div ref={ref} className="p-4 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (isError || !data?.articles?.length) {
    return (
      <div ref={ref} className="p-4 text-sm text-muted-foreground">
        No news articles available
      </div>
    );
  }

  const isCompact = sizeVariant === "compact";

  return (
    <div ref={ref} className="p-4 space-y-3 overflow-y-auto max-h-full">
      {data.articles.map((article) => {
        const isASX = isASXSource(article.source);
        return (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block group"
          >
            <div
              className={`flex items-start justify-between gap-2 p-2 rounded-md transition-colors ${
                isASX
                  ? "border border-yellow-200/60 dark:border-yellow-800/20 bg-yellow-50/40 dark:bg-yellow-950/10 hover:bg-yellow-50/70 dark:hover:bg-yellow-950/20"
                  : "hover:bg-muted/50"
              }`}
            >
              <div className="flex gap-2 flex-1 min-w-0">
                {isASX && !isCompact ? (
                  <Megaphone className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
                ) : null}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {article.isPriceSensitive && (
                      <AlertTriangle className="h-3 w-3 text-amber-500 flex-shrink-0" />
                    )}
                    {article.stockCode && article.stockCode !== "MARKET" && (
                      <Link
                        href={`/shorts/${article.stockCode}`}
                        className="text-xs font-mono font-bold text-primary hover:underline flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {article.stockCode}
                      </Link>
                    )}
                  </div>
                  <h4
                    className={`font-medium leading-tight group-hover:text-primary transition-colors ${isCompact ? "text-xs line-clamp-1" : "text-sm line-clamp-2"}`}
                  >
                    {article.headline}
                  </h4>
                  {!isCompact && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <NewsSourceBadge source={article.source} />
                      <SentimentBadge sentiment={article.sentiment} />
                    </div>
                  )}
                </div>
              </div>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </a>
        );
      })}
    </div>
  );
}
