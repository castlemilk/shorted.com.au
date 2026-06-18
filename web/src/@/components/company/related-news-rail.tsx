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
import { NewsSourceBadge } from "~/@/components/ui/news-source-badge";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Sparkles, ExternalLink } from "lucide-react";

interface RelatedNewsRailProps {
  stockCode: string;
  limit?: number;
}

export function RelatedNewsRail({ stockCode, limit = 6 }: RelatedNewsRailProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["related-news", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({ baseUrl: "" });
      const client = createClient(ShortedStocksService, transport);
      return client.getRelatedNews({ stockCode, limit, articleId: "" });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Related coverage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-3/4" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!data?.articles?.length) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Related coverage
        </CardTitle>
        <CardDescription>
          Semantically similar stories across outlets
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {data.articles.map((article) => (
            <a
              key={article.id}
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block group"
            >
              <div className="flex items-start justify-between gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium leading-tight line-clamp-2 group-hover:text-primary">
                    {article.headline}
                  </h4>
                  <div className="flex items-center gap-2 mt-1.5">
                    <NewsSourceBadge source={article.source} />
                    <SentimentBadge sentiment={article.sentiment} />
                    {article.stockCode && article.stockCode !== stockCode && (
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {article.stockCode}
                      </span>
                    )}
                  </div>
                </div>
                <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
