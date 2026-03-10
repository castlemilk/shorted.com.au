"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import {
  NewsSourceBadge,
  isASXSource,
} from "~/@/components/ui/news-source-badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Newspaper, ExternalLink, AlertTriangle, Megaphone } from "lucide-react";

interface StockNewsFeedProps {
  stockCode: string;
  limit?: number;
}

export function StockNewsFeed({ stockCode, limit = 10 }: StockNewsFeedProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["stock-news", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(ShortedStocksService, transport);
      return client.getStockNews({ stockCode, limit });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Newspaper className="h-5 w-5" />
            News
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError || !data?.articles?.length) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Newspaper className="h-5 w-5" />
            News
          </CardTitle>
          <CardDescription>No recent news available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Newspaper className="h-5 w-5" />
          News
        </CardTitle>
        <CardDescription>
          {data.articles.length} recent article
          {data.articles.length !== 1 ? "s" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
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
                  className={`flex items-start justify-between gap-3 p-3 rounded-lg border transition-colors ${
                    isASX
                      ? "border-yellow-200 dark:border-yellow-800/30 bg-yellow-50/50 dark:bg-yellow-950/10 hover:bg-yellow-50 dark:hover:bg-yellow-950/20"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex gap-2.5 flex-1 min-w-0">
                    {isASX ? (
                      <Megaphone className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
                    ) : null}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {article.isPriceSensitive && (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300 flex-shrink-0">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            Price Sensitive
                          </span>
                        )}
                        <h4 className="text-sm font-medium leading-tight line-clamp-2 group-hover:text-primary">
                          {article.headline}
                        </h4>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <NewsSourceBadge source={article.source} />
                        <SentimentBadge sentiment={article.sentiment} />
                        <span className="text-[11px] text-muted-foreground">
                          {article.publishedAt
                            ? formatRelativeTime(
                                new Date(
                                  Number(article.publishedAt.seconds) * 1000,
                                ),
                              )
                            : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </a>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}
