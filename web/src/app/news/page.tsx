import { type Metadata } from "next";
import { Newspaper } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { NewsCard, type NewsCardArticle } from "~/@/components/news/news-card";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { getMarketNews } from "~/app/actions/getStockNews";

export const metadata: Metadata = {
  title: "ASX News & Short Selling Sentiment | Shorted",
  description:
    "Australian stock market news with sentiment analysis. Track ASX short-selling-driven stories, price-sensitive announcements, and editorial coverage from Stockhead, Motley Fool, Kalkine and more.",
  keywords: [
    "ASX news",
    "Australian stock market news",
    "ASX short selling news",
    "stock market sentiment",
    "ASX price sensitive announcements",
    "Australian stocks news today",
  ],
  openGraph: {
    title: "ASX News & Short Selling Sentiment | Shorted",
    description:
      "Latest ASX news with sentiment analysis. Track stories, announcements and short-selling coverage from Australian sources.",
    url: `${siteConfig.url}/news`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX News & Short Selling Sentiment | Shorted",
    description:
      "Latest ASX news with sentiment analysis from Australian sources.",
  },
  alternates: {
    canonical: `${siteConfig.url}/news`,
    languages: {
      "en-AU": `${siteConfig.url}/news`,
      "en": `${siteConfig.url}/news`,
      "x-default": `${siteConfig.url}/news`,
    },
  },
};

// Revalidate every 10 minutes — news is fresh-ish but doesn't change every request.
export const revalidate = 600;

interface ApiArticle {
  id: string;
  headline: string;
  url: string;
  source: string;
  publishedAt?: { seconds?: bigint | number } | string;
  sentiment?: string;
  summary?: string;
  imageUrl?: string;
  stockCode?: string;
  isPriceSensitive?: boolean;
}

const toIso = (ts: ApiArticle["publishedAt"]): string => {
  if (!ts) return new Date().toISOString();
  if (typeof ts === "string") return ts;
  const seconds =
    typeof ts.seconds === "bigint"
      ? Number(ts.seconds)
      : typeof ts.seconds === "number"
        ? ts.seconds
        : 0;
  if (!seconds) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
};

const toCardArticle = (a: ApiArticle): NewsCardArticle => ({
  id: a.id,
  headline: a.headline,
  url: a.url,
  source: a.source,
  publishedAt: toIso(a.publishedAt),
  sentiment: a.sentiment,
  summary: a.summary,
  imageUrl: a.imageUrl,
  stockCode: a.stockCode,
  isPriceSensitive: a.isPriceSensitive,
});

const groupByDay = (articles: NewsCardArticle[]) => {
  const groups: Record<string, NewsCardArticle[]> = {};
  for (const article of articles) {
    const date = new Date(article.publishedAt);
    if (Number.isNaN(date.getTime())) continue;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const articleDay = new Date(date);
    articleDay.setHours(0, 0, 0, 0);

    let label: string;
    if (articleDay.getTime() === today.getTime()) label = "Today";
    else if (articleDay.getTime() === yesterday.getTime()) label = "Yesterday";
    else
      label = date.toLocaleDateString("en-AU", {
        weekday: "long",
        day: "numeric",
        month: "long",
      });

    (groups[label] ??= []).push(article);
  }
  return groups;
};

export default async function NewsIndexPage() {
  const response = await getMarketNews(60, false);
  const articles: NewsCardArticle[] = (
    (response?.articles ?? []) as unknown as ApiArticle[]
  ).map(toCardArticle);

  const [hero, ...rest] = articles;
  const grouped = groupByDay(rest);
  const groupOrder = Object.keys(grouped);

  // NewsArticle schema for the top ~10 stories (Google's recommendation).
  const newsSchema = articles.slice(0, 10).map((a) => ({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.headline,
    url: a.url,
    datePublished: a.publishedAt,
    image: a.imageUrl ? [a.imageUrl] : undefined,
    publisher: {
      "@type": "Organization",
      name: a.source,
    },
    about: a.stockCode && a.stockCode !== "MARKET"
      ? { "@type": "Corporation", tickerSymbol: a.stockCode }
      : undefined,
  }));

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Latest ASX News",
    itemListElement: articles.slice(0, 20).map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: a.url,
      name: a.headline,
    })),
  };

  const breadcrumbItems = [{ label: "News", href: "/news" }];

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />
      {newsSchema.map((s, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(s) }}
        />
      ))}
      <LLMMeta
        title="ASX News & Sentiment Hub"
        description="Latest news on Australian stocks with AI-classified sentiment, aggregated from multiple Australian financial publications."
        keywords={[
          "ASX news",
          "stock market news Australia",
          "short selling news",
          "ASX sentiment",
        ]}
        dataSource="RSS feeds + Gemini sentiment"
        dataFrequency="hourly"
        requiresAuth={false}
      />

      <section className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <Newspaper className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
              ASX News & Sentiment
            </h1>
            <p className="text-sm text-muted-foreground">
              Aggregated from Stockhead, Motley Fool, Small Caps, Kalkine and
              Google News. Sentiment classified by Gemini 2.0.
            </p>
          </div>
        </div>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      {articles.length === 0 ? (
        <p className="rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No news available right now — check back in a few minutes.
        </p>
      ) : (
        <>
          {hero && (
            <div className="mt-4">
              <NewsCard article={hero} variant="hero" />
            </div>
          )}

          {groupOrder.map((label) => (
            <section key={label} className="mt-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {grouped[label]!.map((article) => (
                  <NewsCard key={article.id} article={article} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </DashboardLayout>
  );
}
