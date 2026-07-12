import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { NewsCard, type NewsCardArticle } from "~/@/components/news/news-card";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import {
  buildApiUrl,
  getServerShortsApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { type TakeLike } from "~/@/components/news/masthead/shared";
import { isValidStockCode } from "~/@/lib/stock-code";
import { MastheadHeader } from "~/@/components/news/masthead/masthead-header";
import { MarketPulse } from "~/@/components/news/masthead/market-pulse";
import { FeaturedStory } from "~/@/components/news/masthead/featured-story";
import { FEATURED } from "~/@/components/news/masthead/featured";
import { LeadStory } from "~/@/components/news/masthead/lead-story";
import { StoryStack } from "~/@/components/news/masthead/story-stack";
import { WireList } from "~/@/components/news/masthead/wire-list";

export const metadata: Metadata = {
  // Root layout applies `%s | Shorted` template — don't include the suffix here.
  title: "ASX News & Short Selling Sentiment",
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
    title: "ASX News & Short Selling Sentiment",
    description:
      "Latest ASX news with sentiment analysis. Track stories, announcements and short-selling coverage from Australian sources.",
    url: `${siteConfig.url}/news`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX News & Short Selling Sentiment",
    description:
      "Latest ASX news with sentiment analysis from Australian sources.",
    site: "@shorted___",
    creator: "@shorted___",
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

// Event-driven ISR: 24h safety net. News is busted on-demand when the aggregator
// stores new articles / the sync runs / a take is published
// (POST /api/revalidate?path=/news or ?tag=news-index).
export const revalidate = 86400;

// This route is ISR, so its RPCs must be plain-JSON POSTs (string bodies)
// with an explicit data-cache option — the connect transport's streamed
// bodies can't be data-cached ("Failed to generate cache key"), and its
// runtime no-store fallback throws "Dynamic server usage" during ISR
// regeneration, silently pinning the page to a stale copy (same landmine
// as sitemap/feed, fixed the same way).
const newsIndexFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 300, tags: ["news-index"] },
  } as RequestInit);

async function rpcJson<T>(rpc: string, body: unknown): Promise<T | undefined> {
  try {
    const resp = await newsIndexFetch(
      buildApiUrl(
        getServerShortsApiUrl(),
        `/shorts.v1alpha1.ShortedStocksService/${rpc}`,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) return undefined;
    return (await resp.json()) as T;
  } catch {
    return undefined;
  }
}

// Connect JSON encoding of an editorial take (Timestamps are RFC3339 strings
// on this path, unlike the protobuf-es client's bigint seconds).
interface TakeJson {
  id?: string;
  slug?: string;
  headline?: string;
  standfirst?: string;
  byline?: string;
  sentiment?: string;
  stockCode?: string;
  heroImageUrl?: string;
  heroCaption?: string;
  heroCredit?: string;
  publishedAt?: string;
}

const toTakeLike = (t: TakeJson): TakeLike | undefined => {
  if (!t.slug || !t.headline) return undefined;
  const ms = t.publishedAt ? Date.parse(t.publishedAt) : NaN;
  return {
    id: t.id ?? t.slug,
    slug: t.slug,
    headline: t.headline,
    standfirst: t.standfirst,
    byline: t.byline,
    sentiment: t.sentiment,
    stockCode: t.stockCode,
    heroImageUrl: t.heroImageUrl,
    heroCaption: t.heroCaption,
    heroCredit: t.heroCredit,
    publishedAt: Number.isNaN(ms)
      ? undefined
      : { seconds: Math.floor(ms / 1000) },
  };
};

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
  syndicationCount?: number;
  syndicatedSources?: string[];
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
  // Drop noise like NEW/BUY/HAS/GOLD that the aggregator misclassifies
  // as stock codes — keeps cards from linking to /shorts/<stop-word>.
  stockCode: isValidStockCode(a.stockCode) ? a.stockCode : undefined,
  isPriceSensitive: a.isPriceSensitive,
  syndicationCount: a.syndicationCount,
  syndicatedSources: a.syndicatedSources,
});

/** Format a Date as YYYY-MM-DD in the Australia/Sydney timezone. */
const sydneyYMD = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const groupByDay = (articles: NewsCardArticle[]) => {
  const groups: Record<string, NewsCardArticle[]> = {};
  const todayYMD = sydneyYMD(new Date());
  const yesterdayYMD = sydneyYMD(new Date(Date.now() - 86400000));

  for (const article of articles) {
    const date = new Date(article.publishedAt);
    if (Number.isNaN(date.getTime())) continue;

    const articleYMD = sydneyYMD(date);
    let label: string;
    if (articleYMD === todayYMD) label = "Today";
    else if (articleYMD === yesterdayYMD) label = "Yesterday";
    else
      label = date.toLocaleDateString("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "long",
        day: "numeric",
        month: "long",
      });

    (groups[label] ??= []).push(article);
  }
  return groups;
};

export default async function NewsIndexPage() {
  const [response, takesResp] = await Promise.all([
    rpcJson<{ articles?: ApiArticle[] }>("GetMarketNews", {
      limit: 60,
      priceSensitiveOnly: false,
    }),
    // Pull a generous batch so the lead + dedupe-by-stock story stack
    // still fills even when one ticker dominates recent coverage.
    rpcJson<{ takes?: TakeJson[] }>("ListEditorialTakes", {
      limit: 24,
      offset: 0,
      stockCode: "",
    }),
  ]);
  const articles: NewsCardArticle[] = (response?.articles ?? []).map(
    toCardArticle,
  );

  // Lead story: the newest published Take. Secondary stack: the next
  // takes, deduped by stock code (newest take wins per ticker —
  // mirrors take-card-grid's approach). Untickered takes are kept
  // individually since they don't share a slot.
  const allTakes = (takesResp?.takes ?? [])
    .map(toTakeLike)
    .filter((t): t is TakeLike => t !== undefined);
  const leadTake = allTakes[0];
  const seenStocks = new Set<string>();
  if (leadTake) {
    const leadKey = (leadTake.stockCode ?? "").trim().toUpperCase();
    if (leadKey) seenStocks.add(leadKey);
  }
  const secondaryTakes: typeof allTakes = [];
  for (const t of allTakes.slice(1)) {
    const key = (t.stockCode ?? "").trim().toUpperCase();
    if (key) {
      if (seenStocks.has(key)) continue;
      seenStocks.add(key);
    }
    secondaryTakes.push(t);
    if (secondaryTakes.length >= 6) break;
  }

  // Graceful degradation: no takes → first news article becomes the hero.
  const [newsHero, ...rest] = articles;
  // Cap the wire at 30 articles and strip heavy fields WireList doesn't render.
  const wireArticles = (leadTake ? articles : rest)
    .slice(0, 30)
    .map(({ summary: _summary, imageUrl: _imageUrl, ...a }) => a);
  const grouped = groupByDay(wireArticles);

  // ItemList only: this is an aggregation page, so asserting NewsArticle
  // entities for third-party publishers' content (with our render timestamps
  // as datePublished) is misleading structured data — Google may treat it as
  // spammy markup. NewsArticle belongs on our own /news/[slug] articles.
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

      <Breadcrumbs items={breadcrumbItems} />

      <div className="mx-auto max-w-7xl space-y-8">
        <MastheadHeader />
        <MarketPulse />

        {FEATURED[0] ? <FeaturedStory item={FEATURED[0]} /> : null}

        {leadTake ? (
          <LeadStory take={leadTake} />
        ) : newsHero ? (
          <NewsCard article={newsHero} variant="hero" />
        ) : (
          <p className="rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            No news available right now — check back in a few minutes.
          </p>
        )}

        <div className="grid gap-10 lg:grid-cols-[2fr,1fr]">
          <StoryStack takes={secondaryTakes} />
          <WireList groups={grouped} />
        </div>
      </div>
    </DashboardLayout>
  );
}
