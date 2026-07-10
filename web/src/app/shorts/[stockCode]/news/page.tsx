import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Newspaper } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { NewsCard, type NewsCardArticle } from "~/@/components/news/news-card";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { getStockNews } from "~/app/actions/getStockNews";
import { getStock, getStockOrNotFound } from "~/app/actions/getStock";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";

export const revalidate = 600;

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();
  const title = `${code} News & Sentiment | Latest ASX Articles`;
  const description = `Latest news and sentiment analysis for ${code} on the ASX. Aggregated from Stockhead, Motley Fool, Small Caps, Kalkine and Google News, with AI-classified sentiment.`;

  // Inherit the stock page's indexability gate: a noindexed thin stock must
  // not leak an indexable /news subpage (fail open on transient fetch errors).
  let shouldNoindex = false;
  try {
    const stock = await getStock(code);
    if (stock) {
      shouldNoindex = !isStockIndexable({
        code,
        name: stock.name,
        industry: stock.industry,
        percentShorted: stock.percentageShorted,
      });
    }
  } catch {
    // fail open — keep default robots
  }

  return {
    title,
    description,
    robots: shouldNoindex
      ? { index: false, follow: true, googleBot: { index: false, follow: true } }
      : undefined,
    keywords: [
      `${code} news`,
      `${code} ASX news`,
      `${code} stock news`,
      `${code} sentiment`,
      `${code} announcements`,
      `${code} short selling news`,
    ],
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url: `${siteConfig.url}/shorts/${code}/news`,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${siteConfig.name}`,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/shorts/${code}/news`,
      languages: {
        "en-AU": `${siteConfig.url}/shorts/${code}/news`,
        "en": `${siteConfig.url}/shorts/${code}/news`,
        "x-default": `${siteConfig.url}/shorts/${code}/news`,
      },
    },
  };
}

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

export default async function StockNewsPage({ params }: PageProps) {
  const { stockCode: raw } = await params;
  const code = raw.toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(code)) notFound();

  const [response, stock] = await Promise.all([
    getStockNews(code, 60),
    getStockOrNotFound(code).catch(() => undefined),
  ]);
  const articles: NewsCardArticle[] = (
    (response?.articles ?? []) as unknown as ApiArticle[]
  ).map(toCardArticle);

  const companyName = stock?.name ?? code;
  const [hero, ...rest] = articles;

  const breadcrumbItems = [
    { label: "Stocks", href: "/shorts" },
    { label: code, href: `/shorts/${code}` },
    { label: "News", href: `/shorts/${code}/news` },
  ];

  // Per-stock NewsArticle schema (top 10) — eligible for Google News
  // Top Stories carousels and helps AI search engines cite us.
  const newsSchema = articles.slice(0, 10).map((a) => ({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.headline,
    url: a.url,
    datePublished: a.publishedAt,
    image: a.imageUrl ? [a.imageUrl] : undefined,
    publisher: { "@type": "Organization", name: a.source },
    about: { "@type": "Corporation", name: companyName, tickerSymbol: code },
  }));

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${code} News`,
    about: { "@type": "Corporation", name: companyName, tickerSymbol: code },
    itemListElement: articles.slice(0, 20).map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: a.url,
      name: a.headline,
    })),
  };

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
        title={`${code} News & Sentiment`}
        description={`Latest news on ${companyName} (ASX:${code}) with AI-classified sentiment.`}
        keywords={[`${code} news`, `${code} sentiment`, "ASX news"]}
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
              {companyName} ({code}) News
            </h1>
            <p className="text-sm text-muted-foreground">
              Latest articles and price-sensitive announcements with AI
              sentiment classification.
            </p>
          </div>
        </div>
        <Link
          href={`/shorts/${code}`}
          className="hidden rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-muted md:inline-flex"
        >
          ← Back to {code}
        </Link>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      {articles.length === 0 ? (
        <p className="mt-4 rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No news found for {code} yet. Check back as our aggregator pulls fresh
          articles every hour.
        </p>
      ) : (
        <>
          {hero && (
            <div className="mt-4">
              <NewsCard article={hero} variant="hero" showStockChip={false} />
            </div>
          )}
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rest.map((article) => (
              <NewsCard
                key={article.id}
                article={article}
                showStockChip={false}
              />
            ))}
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
