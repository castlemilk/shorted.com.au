"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import Link from "next/link";
import {
  ShortedStocksService,
  type NewsArticle,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Button } from "~/@/components/ui/button";
import { NewsSourceBadge } from "~/@/components/ui/news-source-badge";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { formatRelativeTime } from "~/@/lib/relative-time";
import { AlertTriangle, Newspaper, RefreshCw } from "lucide-react";

function newsClient() {
  const transport = createConnectTransport({ baseUrl: "" });
  return createClient(ShortedStocksService, transport);
}

/** Feed query — key kept identical to the legacy StockNewsFeed. */
export function useStockNewsQuery(stockCode: string, limit: number) {
  return useQuery({
    queryKey: ["stock-news", stockCode, limit],
    queryFn: async () => newsClient().getStockNews({ stockCode, limit }),
    staleTime: 5 * 60 * 1000,
  });
}

/** Related query — key kept identical to the legacy RelatedNewsRail. */
export function useRelatedNewsQuery(stockCode: string, limit: number) {
  return useQuery({
    queryKey: ["related-news", stockCode, limit],
    queryFn: async () =>
      newsClient().getRelatedNews({ stockCode, limit, articleId: "" }),
    staleTime: 5 * 60 * 1000,
    enabled: limit > 0,
  });
}

function articleTime(article: NewsArticle): string {
  if (!article.publishedAt) return "";
  return formatRelativeTime(
    new Date(Number(article.publishedAt.seconds) * 1000),
  );
}

/**
 * Aggregator summaries (Google News especially) often carry literal HTML
 * entities and just restate the headline plus the outlet name — decode the
 * entities and drop summaries that add nothing over the headline.
 */
export function displaySummary(article: NewsArticle): string {
  if (!article.summary) return "";
  const decoded = article.summary
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const headline = normalize(article.headline);
  const summary = normalize(decoded);
  // "Headline  Outlet" style summaries: identical or barely longer than the
  // headline itself — noise, not a summary.
  if (headline && summary.startsWith(headline)) {
    const extra = summary.slice(headline.length).trim();
    if (extra.split(" ").filter(Boolean).length <= 4) return "";
  }
  return decoded;
}

/** Full feed row with a fixed 96x64 thumbnail (or muted fallback tile). */
export function NewsFeedRow({ article }: { article: NewsArticle }) {
  const summary = displaySummary(article);
  const showSentiment =
    article.sentiment === "positive" || article.sentiment === "negative";
  const otherOutlets =
    article.syndicationCount > 1 ? article.syndicationCount - 1 : 0;
  const syndicationLabel =
    (article.syndicatedSources?.length ?? 0) > 0
      ? `Also covered by ${article.syndicatedSources.join(", ")}`
      : undefined;

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group -mx-2 flex gap-3 rounded-lg p-2 transition-colors hover:bg-muted/50"
    >
      <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md bg-muted">
        {article.imageUrl ? (
          <>
            {/* Plain <img>: news image hosts are arbitrary — next/image
                crashes on unconfigured remote hosts. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={article.imageUrl}
              alt=""
              width={96}
              height={64}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-inset ring-black/10 dark:ring-white/10"
            />
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Newspaper
              className="h-5 w-5 text-muted-foreground/50"
              aria-hidden
            />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h4 className="line-clamp-2 text-sm font-medium leading-snug transition-colors group-hover:text-primary">
          {article.headline}
        </h4>
        {summary && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {summary}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <NewsSourceBadge source={article.source} interactive={false} />
          {showSentiment && <SentimentBadge sentiment={article.sentiment} />}
          {article.isPriceSensitive && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3" />
              Price sensitive
            </span>
          )}
          {otherOutlets > 0 && (
            <span
              className="text-[11px] text-muted-foreground"
              title={syndicationLabel}
            >
              +{otherOutlets} outlet{otherOutlets > 1 ? "s" : ""}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {articleTime(article)}
          </span>
        </div>
      </div>
    </a>
  );
}

/** Compact related-coverage row: headline + source + stock code + time. */
export function RelatedNewsRow({
  article,
  anchorStockCode,
}: {
  article: NewsArticle;
  anchorStockCode?: string;
}) {
  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group -mx-2 block rounded-lg p-2 transition-colors hover:bg-muted/50"
    >
      <h4 className="line-clamp-2 text-sm font-medium leading-snug transition-colors group-hover:text-primary">
        {article.headline}
      </h4>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <NewsSourceBadge source={article.source} interactive={false} />
        {article.stockCode && article.stockCode !== anchorStockCode && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
            {article.stockCode}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">
          {articleTime(article)}
        </span>
      </div>
    </a>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="-mx-2 flex gap-3 p-2">
          <Skeleton className="h-16 w-24 shrink-0 rounded-md" />
          <div className="flex-1 space-y-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface StockNewsTabProps {
  stockCode: string;
  /** Max feed articles to fetch (default 20). */
  limit?: number;
  /** Max related articles to fetch; 0 disables the related section (default 6). */
  relatedLimit?: number;
}

/**
 * The stock page News tab: article feed with thumbnails plus a deduped
 * "Related coverage" section in a single card. The related query failing
 * (or returning only duplicates of the feed) silently omits that section.
 */
export function StockNewsTab({
  stockCode,
  limit = 20,
  relatedLimit = 6,
}: StockNewsTabProps) {
  const feed = useStockNewsQuery(stockCode, limit);
  const related = useRelatedNewsQuery(stockCode, relatedLimit);

  const articles = feed.data?.articles ?? [];
  const totalCount = feed.data?.totalCount ?? 0;

  // Drop related articles already shown in the feed (backend only excludes
  // the anchor article, so overlap is common).
  const feedIds = new Set(articles.map((a) => a.id));
  const feedUrls = new Set(articles.map((a) => a.url));
  const relatedArticles = (related.data?.articles ?? []).filter(
    (a) => !feedIds.has(a.id) && !feedUrls.has(a.url),
  );

  const description =
    feed.isSuccess && articles.length > 0
      ? totalCount > articles.length
        ? `${totalCount} articles`
        : `${articles.length} recent article${articles.length === 1 ? "" : "s"}`
      : undefined;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Newspaper className="h-5 w-5" />
              News
            </CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          <Link
            href={`/shorts/${stockCode}/news`}
            className="inline-flex min-h-[40px] shrink-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
          >
            View all →
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {feed.isLoading ? (
          <FeedSkeleton />
        ) : feed.isError ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertTriangle
              className="h-5 w-5 text-muted-foreground"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load news for {stockCode}.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void feed.refetch()}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : articles.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No recent news for {stockCode}
          </p>
        ) : (
          <>
            <div className="space-y-1">
              {articles.map((article) => (
                <NewsFeedRow key={article.id} article={article} />
              ))}
            </div>
            {relatedArticles.length > 0 && (
              <div className="mt-4 border-t pt-4">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Related coverage
                </h3>
                <div className="mt-2 space-y-1">
                  {relatedArticles.map((article) => (
                    <RelatedNewsRow
                      key={article.id}
                      article={article}
                      anchorStockCode={stockCode}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
