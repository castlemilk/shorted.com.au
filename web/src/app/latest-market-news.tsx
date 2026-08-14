import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getMarketNews } from "~/app/actions/getStockNews";
import { NewsCard, type NewsCardArticle } from "~/@/components/news/news-card";
import { isValidStockCode } from "~/@/lib/stock-code";
import type { NewsArticle } from "~/gen/shorts/v1alpha1/news_pb";

function toIso(ts: NewsArticle["publishedAt"]): string {
  if (!ts) return new Date().toISOString();
  const seconds =
    typeof ts.seconds === "bigint"
      ? Number(ts.seconds)
      : typeof ts.seconds === "number"
        ? ts.seconds
        : 0;
  if (!seconds) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function toCardArticle(a: NewsArticle): NewsCardArticle {
  return {
    id: a.id,
    headline: a.headline,
    url: a.url,
    source: a.source,
    publishedAt: toIso(a.publishedAt),
    sentiment: a.sentiment,
    summary: a.summary,
    imageUrl: a.imageUrl,
    stockCode: isValidStockCode(a.stockCode) ? a.stockCode : undefined,
    isPriceSensitive: a.isPriceSensitive,
    syndicationCount: a.syndicationCount,
    syndicatedSources: a.syndicatedSources,
  };
}

/**
 * Server-rendered "Market news" strip for the homepage — the freshest
 * cross-market coverage, placed ABOVE the blog strip. Articles with images
 * lead so the row always renders with visual weight; degrades to null when
 * the news backend is unavailable.
 */
export async function LatestMarketNews() {
  const response = await getMarketNews(12).catch(() => undefined);
  const articles = response?.articles ?? [];
  if (articles.length === 0) return null;

  // Lead with image-bearing stories, then fill from the rest (newest first).
  const withImages = articles.filter((a) => a.imageUrl);
  const withoutImages = articles.filter((a) => !a.imageUrl);
  const picks = [...withImages, ...withoutImages]
    .slice(0, 3)
    .map(toCardArticle);

  return (
    <section className="container mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Market news
        </h2>
        <Link
          href="/news"
          className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          View all
          <ChevronRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {picks.map((article) => (
          <NewsCard key={article.id} article={article} showStockChip />
        ))}
      </div>
    </section>
  );
}
