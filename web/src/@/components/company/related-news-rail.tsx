"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Sparkles } from "lucide-react";
import { RelatedNewsRow, useRelatedNewsQuery } from "./stock-news-tab";

interface RelatedNewsRailProps {
  stockCode: string;
  limit?: number;
}

/**
 * Legacy standalone related-coverage card — the stock page News tab now
 * renders related coverage inside `StockNewsTab`, deduped against the feed.
 * Kept as a shim (same ["related-news", stockCode, limit] query key) for any
 * standalone usage. Errors and empty results render nothing: this content
 * is supplementary.
 */
export function RelatedNewsRail({
  stockCode,
  limit = 6,
}: RelatedNewsRailProps) {
  const { data, isLoading, isError } = useRelatedNewsQuery(stockCode, limit);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
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

  if (isError || !data?.articles?.length) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
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
            <RelatedNewsRow
              key={article.id}
              article={article}
              anchorStockCode={stockCode}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
