import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Briefcase, ExternalLink, TrendingDown, TrendingUp } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { getDirectorTrades } from "~/app/actions/getDirectorTrades";
import { getStock, getStockOrNotFound } from "~/app/actions/getStock";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { cn } from "~/@/lib/utils";

export const revalidate = 3600;

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();
  const title = `${code} Director Trades & Insider Activity | ASX`;
  const description = `Director and insider trades for ${code} on the ASX, sourced from Appendix 3Y filings. Buy/sell/exercise history, share counts and disclosed prices.`;

  // Inherit the stock page's indexability gate: a noindexed thin stock must
  // not leak an indexable insider-trading subpage (fail open on fetch errors).
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
      `${code} director trades`,
      `${code} insider trading`,
      `${code} Appendix 3Y`,
      `${code} director buying`,
      `${code} director selling`,
      `${code} insider sentiment`,
    ],
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url: `${siteConfig.url}/insider-trading/${code}`,
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
      canonical: `${siteConfig.url}/insider-trading/${code}`,
      languages: {
        "en-AU": `${siteConfig.url}/insider-trading/${code}`,
        "en": `${siteConfig.url}/insider-trading/${code}`,
        "x-default": `${siteConfig.url}/insider-trading/${code}`,
      },
    },
  };
}

interface ApiTrade {
  id: string;
  stockCode: string;
  directorName: string;
  tradeType: string;
  sharesTraded?: bigint | number;
  pricePerShare?: number;
  totalValue?: number;
  tradeDate: string;
  announcementUrl?: string;
}

const toNumber = (v: bigint | number | undefined): number => {
  if (v === undefined) return 0;
  if (typeof v === "bigint") return Number(v);
  return v;
};

const formatNumber = (n: number): string =>
  new Intl.NumberFormat("en-AU").format(Math.round(n));

const formatMoney = (n: number): string =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);

const formatPrice = (n: number): string =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 4,
  }).format(n);

const tradeTone = (type: string) => {
  switch (type.toLowerCase()) {
    case "buy":
      return {
        label: "Buy",
        icon: TrendingUp,
        className:
          "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
      };
    case "sell":
      return {
        label: "Sell",
        icon: TrendingDown,
        className:
          "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-700",
      };
    case "exercise_options":
      return {
        label: "Exercise",
        icon: Briefcase,
        className:
          "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
      };
    default:
      return {
        label: type,
        icon: Briefcase,
        className:
          "bg-muted text-muted-foreground border-border",
      };
  }
};

export default async function StockInsiderTradingPage({ params }: PageProps) {
  const { stockCode: raw } = await params;
  const code = raw.toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(code)) notFound();

  const [response, stock] = await Promise.all([
    getDirectorTrades(code, 100),
    getStockOrNotFound(code).catch(() => undefined),
  ]);

  const trades: ApiTrade[] = ((response?.trades ?? []) as unknown as ApiTrade[]);
  const companyName = stock?.name ?? code;

  // Aggregate buy/sell totals for the insider-sentiment summary.
  let totalBoughtValue = 0;
  let totalSoldValue = 0;
  for (const t of trades) {
    const value = toNumber(t.totalValue ?? 0);
    if (t.tradeType.toLowerCase() === "buy") totalBoughtValue += value;
    else if (t.tradeType.toLowerCase() === "sell") totalSoldValue += value;
  }
  const netSentiment = totalBoughtValue - totalSoldValue;

  const breadcrumbItems = [
    { label: "Insider Trading", href: "/insider-trading" },
    { label: code, href: `/insider-trading/${code}` },
  ];

  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: `${companyName} (${code}) Director Trades & Insider Activity`,
    description: `Recent director trades for ${companyName} on the ASX.`,
    url: `${siteConfig.url}/insider-trading/${code}`,
    datePublished: new Date().toISOString(),
    dateModified: new Date().toISOString(),
    author: {
      "@type": "Organization",
      name: "Shorted",
      url: siteConfig.url,
    },
    publisher: {
      "@type": "Organization",
      name: "Shorted",
      url: siteConfig.url,
      logo: { "@type": "ImageObject", url: siteConfig.ogImage },
    },
    about: {
      "@type": "Corporation",
      name: companyName,
      tickerSymbol: code,
      identifier: `ASX:${code}`,
    },
  };

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${code} Director Trades`,
    numberOfItems: trades.length,
    itemListElement: trades.slice(0, 30).map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "TradeAction",
        agent: { "@type": "Person", name: t.directorName },
        actionStatus: "https://schema.org/CompletedActionStatus",
        startTime: t.tradeDate,
        price: t.pricePerShare,
        priceCurrency: "AUD",
      },
    })),
  };

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(article) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />
      <LLMMeta
        title={`${code} Director Trades`}
        description={`Director trades for ${companyName} (ASX:${code}) from Appendix 3Y filings.`}
        keywords={[`${code} insider trading`, `${code} director trades`]}
        dataSource="ASX Appendix 3Y"
        dataFrequency="daily"
        requiresAuth={false}
      />

      <section className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <Briefcase className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className={pageTitle}>
              {companyName} ({code}) Director Trades
            </h1>
            <p className="text-sm text-muted-foreground">
              Insider activity from ASX Appendix 3Y filings.
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

      {trades.length > 0 && (
        <section
          aria-label="Insider sentiment summary"
          className="mt-4 rounded-lg border bg-card p-4 md:p-5"
        >
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Trades shown</dt>
              <dd className="font-semibold text-base">{trades.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bought (value)</dt>
              <dd className="font-semibold text-base text-emerald-700 dark:text-emerald-400">
                {formatMoney(totalBoughtValue)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sold (value)</dt>
              <dd className="font-semibold text-base text-rose-600 dark:text-rose-400">
                {formatMoney(totalSoldValue)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Net sentiment</dt>
              <dd
                className={cn(
                  "font-semibold text-base",
                  netSentiment > 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : netSentiment < 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "",
                )}
              >
                {netSentiment > 0 ? "+" : ""}
                {formatMoney(netSentiment)}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {trades.length === 0 ? (
        <p className="mt-6 rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No director trades recorded for {code} yet. Check back as ASX
          Appendix 3Y filings are ingested daily.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Director</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-right">Shares</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">Value</th>
                <th className="px-4 py-3 text-right">Filing</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {trades.map((t) => {
                const tone = tradeTone(t.tradeType);
                const Icon = tone.icon;
                const shares = toNumber(t.sharesTraded);
                const price = toNumber(t.pricePerShare);
                const value = toNumber(t.totalValue);
                return (
                  <tr key={t.id} className="hover:bg-muted/40">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                      {t.tradeDate}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium">
                      {t.directorName}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                          tone.className,
                        )}
                      >
                        <Icon className="h-3 w-3" />
                        {tone.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs">
                      {shares > 0 ? formatNumber(shares) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs">
                      {price > 0 ? formatPrice(price) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs font-semibold">
                      {value > 0 ? formatMoney(value) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {t.announcementUrl ? (
                        <a
                          href={t.announcementUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          View
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Source: ASX Appendix 3Y filings (Corporations Act s205G). Director
        trades must be lodged with the ASX within 14 days of the change in
        interest. See the official{" "}
        <Link href="/methodology" className="underline">methodology</Link>.
      </p>
    </DashboardLayout>
  );
}
