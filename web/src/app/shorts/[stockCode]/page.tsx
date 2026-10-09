import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CompanyInfo, {
  CompanyInfoPlaceholder,
} from "~/@/components/ui/companyInfo";
import { FundamentalsSummary } from "~/@/components/stocks/fundamentals-summary";
import { StrategyFitStrip } from "~/@/components/stocks/strategy-fit-strip";
import { CommunityOverviewTeaser } from "~/@/components/company/community/community-overview-teaser";
import { SignedOutOnly } from "~/@/components/ui/session-gates";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { LLMMeta, StockLLMMeta } from "~/@/components/seo/llm-meta";
import { RelatedStocks } from "~/@/components/seo/related-stocks";
import { LatestWeeklyReportLink } from "~/@/components/reports/latest-weekly-report-link";
import { siteConfig } from "~/@/config/site";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { thirtyDayChangeClause } from "~/@/lib/seo/short-change-clause";
import { stockOgImage } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStockHeadlines } from "~/app/actions/getStockNews";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { getDailyShortSeries } from "~/app/actions/getDailyShortSeries";
import { getStockFundamentals } from "~/app/actions/getStockFundamentals";
import {
  getStockStrategyFit,
  type StockStrategyFit,
} from "~/app/actions/getStockStrategyFit";
import { loadStockOrFail } from "./stock-page-data";
import {
  STOCK_CODE_PATTERN,
  asOfClauseFor,
  cleanCompanyName,
  formatAsOfDate,
} from "./stock-page-shared";

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();

  // Try to fetch stock data for enriched metadata. Titles lead with
  // "{CODE} Short Interest" — the phrasing the per-ticker query cluster
  // actually uses (the incumbents ranking for it are stale/thin) — with the
  // live % as a freshness signal.
  let title = `${code} Short Interest | Official ASIC Data (T+4)`;
  let description = `${code} short interest from official ASIC reports. Current short %, historical trends, charts & analysis. Updated daily with T+4 delay. Free ASX short position tracking.`;
  let shouldNoindex = false;
  // The social card's content-addressed version moves with the short % (see
  // stockOgImage), so the card refreshes exactly when the data does.
  let percentShorted: number | undefined;

  try {
    const stock = await getStockOrNotFound(code);
    if (stock) {
      const companyName = stock.name ? cleanCompanyName(stock.name, code) : "";
      const shortPct = stock.percentageShorted > 0 ? ` | ${stock.percentageShorted.toFixed(2)}% Shorted` : "";
      title = companyName
        ? `${code} Short Interest — ${companyName} (ASX:${code})${shortPct}`
        : `${code} Short Interest${shortPct} | ASIC Data`;
      percentShorted = stock.percentageShorted;

      // The date of the latest ASIC report this stock appears in — NOT
      // `new Date()`. ASIC publishes T+4, so "as of <today>" describes a
      // report that does not exist yet. Null when unknown: the sentence
      // drops the clause rather than inventing a date.
      //
      // The 30-day move comes next (docs/seo-audit-2026-09.md §6.2): the
      // level is already in the title, the change is what no competitor's
      // snippet carries. The daily series is the same cached read the
      // page's history summary makes, so this costs the metadata nothing
      // extra; an unavailable series drops the clause. (Two reads in
      // flight, not a Promise.all: page-old-api.test.tsx reads the page's
      // first Promise.all as the render's critical path.)
      const asOfRead = getLatestShortDate(code);
      const series = await getDailyShortSeries(code);
      const asOf = await asOfRead;
      const dateStr = asOf ? formatAsOfDate(asOf) : null;
      const descName = companyName || code;
      const shortInfo = stock.percentageShorted > 0
        ? `${descName} short interest is ${stock.percentageShorted.toFixed(2)}%${dateStr ? ` as of ${dateStr}` : ""}${thirtyDayChangeClause(series)}.`
        : `${descName} short selling data from official ASIC reports.`;
      const industryInfo = stock.industry ? ` Industry: ${stock.industry}.` : "";
      description = `${shortInfo}${industryInfo} Track ${code}'s short position history, price charts, peer comparison, and ASIC data. Updated daily with T+4 delay.`;

      // Index real companies (named + enriched OR meaningfully shorted), only
      // noindex genuinely thin stubs. Shared with the sitemap so the two never
      // disagree. See ~/@/lib/seo/stock-indexability.
      shouldNoindex = !isStockIndexable({
        code,
        name: stock.name,
        industry: stock.industry,
        percentShorted: stock.percentageShorted,
      });
    }
  } catch {
    // Fall back to default title/description if fetch fails
  }

  const ogImage = stockOgImage(code, percentShorted);

  return {
    title,
    description,
    // Omitted, not set to undefined, when indexable: Next 14.2 merges metadata
    // with `for (key in source)`, so an own `robots: undefined` replaces the root
    // layout's robots (and its googleBot max-image-preview / max-snippet
    // directives) with nothing. Absent, the page inherits them.
    ...(shouldNoindex
      ? {
          robots: {
            index: false,
            follow: true,
            googleBot: { index: false, follow: true },
          },
        }
      : {}),
    keywords: [
      `${code} short position`,
      `${code} short interest`,
      `${code} ASX short selling`,
      `${code} ASIC data`,
      `${code} stock analysis`,
      `${code} bearish sentiment`,
      `how much is ${code} shorted`,
      `${code} short squeeze`,
      "ASIC short position reports",
      "ASX short selling data",
      "Australian stocks short interest",
    ],
    openGraph: {
      // No `| Shorted` suffix: `siteName` below already carries the brand, and
      // the title itself is long — appending it produced a second brand
      // mention that cards truncate the actual company name to fit.
      title,
      description,
      url: `${siteConfig.url}/shorts/${code}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      images: [ogImage],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
    alternates: {
      canonical: `${siteConfig.url}/shorts/${code}`,
      languages: {
        "en-AU": `${siteConfig.url}/shorts/${code}`,
        "en": `${siteConfig.url}/shorts/${code}`,
        "x-default": `${siteConfig.url}/shorts/${code}`,
      },
    },
  };
}

// ISR: pages are generated on first request and cached for an hour (the
// underlying per-stock data caches are 24h, tag-busted by the daily sync).
// This required every server fetch in the render tree to be ISR-safe —
// connect POSTs are forced no-store at Vercel runtime and bail the route to
// dynamic inside a revalidating render, so they all run inside
// unstable_cache (getStock, getStockDetails, getStockHeadlines, the
// evidence snapshot) or carry an explicit next.revalidate. The per-request
// auth() read (which forces dynamic) was replaced with client-side session
// gates.
export const revalidate = 3600;
export const dynamicParams = true;

// Present-but-empty on purpose: a dynamic segment is only statically
// optimized (on-demand ISR) when generateStaticParams EXISTS — without it
// every request is plain SSR and the revalidate export above is inert.
// Empty because pre-rendering ~1,600 stock pages at build would blow the
// build budget; each page generates and caches on first request instead.
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

const Page = async ({ params }: PageProps) => {
  const { stockCode: rawStockCode } = await params;
  const stockCode = rawStockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(stockCode)) notFound();

  // Fundamentals (the crawlable summary paragraph). Cached 24h, tag-busted by
  // the picks job; degrades to null (the paragraph is then omitted).
  const fundamentalsPromise = getStockFundamentals(stockCode).catch(
    (): Awaited<ReturnType<typeof getStockFundamentals>> => null,
  );
  // Strategy fit (the strip). NOT in the critical Promise.all below: the
  // action throws on any failure (4 s abort, never cached) and this catch
  // hides the strip, so a slow or older API can never fail the ISR render.
  const strategyFitPromise = getStockStrategyFit(stockCode).catch(
    (err: unknown): StockStrategyFit | null => {
      console.warn(`[stock page] strategy fit unavailable for ${stockCode}:`, err);
      return null;
    },
  );
  // Three headlines for the digest; the full feed is the News tab.
  const stockNewsPromise = getStockHeadlines(stockCode, 3);
  // Date of the latest ASIC report containing this stock — the schema's
  // "as of". Never `new Date()`: ASIC publishes T+4.
  const latestShortDatePromise = getLatestShortDate(stockCode).catch(
    (): Date | null => null,
  );

  // 404s an unknown code and FAILS the render on a transient read, so a
  // degraded page is never baked into the ISR cache (see stock-page-data.ts).
  // getRelatedStocks degrades to an empty result on its own and never rejects.
  const [stock, relatedData] = await Promise.all([
    loadStockOrFail(stockCode),
    getRelatedStocks(stockCode),
  ]);

  const fundamentals = await fundamentalsPromise;
  const strategyFit = await strategyFitPromise;
  const newsArticles = await stockNewsPromise;
  const latestShortDate = await latestShortDatePromise;
  const asOfIso = latestShortDate ? latestShortDate.toISOString().slice(0, 10) : null;
  const asOfClause = asOfClauseFor(latestShortDate);
  const companyName = cleanCompanyName(stock.name || stockCode, stockCode);

  const breadcrumbItems = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: `/shorts/${stockCode}` },
  ];

  return (
    <>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <LLMMeta
        title={`${stockCode} Stock Analysis - Short Position Data`}
        description={`Comprehensive analysis of ${stockCode} short positions on the ASX. View real-time charts, company profile, and short interest data for ${stockCode} shares.`}
        keywords={[
          `${stockCode} short position`,
          `${stockCode} ASX`,
          `${stockCode} stock analysis`,
          `${stockCode} short interest`,
          "short selling data",
          "Australian stocks",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
        requiresAuth={false}
      />
      <StockLLMMeta
        stockCode={stockCode}
        companyName={companyName}
        industry={stock.industry || ""}
        sector={stock.industry || ""}
        shortPercentage={stock.percentageShorted || undefined}
        currentShortPosition={stock.reportedShortPositions || undefined}
      />

      {(() => {
        const shortPct = stock.percentageShorted ?? 0;
        const shortPositions = stock.reportedShortPositions ?? 0;
        const industry = stock.industry || "";
        // asOfIso / asOfClause are hoisted to the page body above — the
        // layout's visible summary states the same "as of" (asOfClauseFor),
        // and the two must not disagree.
        const positionsDisplay = shortPositions > 0
          ? new Intl.NumberFormat("en-AU").format(Math.round(shortPositions))
          : "—";
        const datasetSchema = {
          "@context": "https://schema.org",
          "@type": "Dataset",
          name: `${companyName} (${stockCode}) Short Position History`,
          description: `Daily ASIC-reported short positions and short interest % for ${companyName} (ASX:${stockCode}).`,
          url: `${siteConfig.url}/shorts/${stockCode}`,
          identifier: `ASX:${stockCode}`,
          isAccessibleForFree: true,
          keywords: [
            `${stockCode} short interest`,
            `${stockCode} short position`,
            "ASIC short position data",
            "ASX short selling",
          ],
          creator: {
            "@type": "Organization",
            name: siteConfig.name,
            url: siteConfig.url,
          },
          sourceOrganization: {
            "@type": "Organization",
            name: "Australian Securities and Investments Commission",
            url: "https://asic.gov.au/regulatory-resources/markets/short-selling/",
          },
          temporalCoverage: asOfIso ? `2010-06-01/${asOfIso}` : "2010-06-01/..",
          variableMeasured: [
            {
              "@type": "PropertyValue",
              name: "percentShort",
              unitText: "PERCENT",
              ...(shortPct > 0 ? { value: Number(shortPct.toFixed(2)) } : {}),
            },
            {
              "@type": "PropertyValue",
              name: "reportedShortPositions",
              unitText: "shares",
              ...(shortPositions > 0 ? { value: Math.round(shortPositions) } : {}),
            },
          ],
          license: "https://creativecommons.org/licenses/by/4.0/",
          about: {
            "@type": "Corporation",
            name: companyName,
            tickerSymbol: stockCode,
          },
        };
        // Corporation schema with sameAs anchors so Google's Knowledge
        // Graph treats this page as the canonical hub for [stockCode]'s
        // short-selling entity. ASX + Bloomberg URLs are deterministic.
        // Wikipedia/Wikidata require per-stock lookup — handled in a
        // follow-up enrichment pass.
        const cleanName = companyName;
        const corporationSchema = {
          "@context": "https://schema.org",
          "@type": "Corporation",
          name: cleanName,
          legalName: cleanName,
          tickerSymbol: stockCode,
          identifier: `ASX:${stockCode}`,
          ...(stock.logoUrl ? { logo: stock.logoUrl, image: stock.logoUrl } : {}),
          // no `naics`: it expects a numeric NAICS code, not a GICS name
          sameAs: [
            `https://www.asx.com.au/markets/company/${stockCode}`,
            `https://www.bloomberg.com/profile/company/${stockCode}:AU`,
            `https://au.finance.yahoo.com/quote/${stockCode}.AX`,
            `https://www.google.com/finance/quote/${stockCode}:ASX`,
            `https://simplywall.st/stocks/au/none/asx-${stockCode.toLowerCase()}`,
          ],
          subjectOf: {
            "@type": "WebPage",
            url: `${siteConfig.url}/shorts/${stockCode}`,
            name: `${companyName} (${stockCode}) Short Position`,
          },
        };
        return (
          <>
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify(datasetSchema),
              }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify(corporationSchema),
              }}
            />
            {/* Crawler/LLM summary — kept in the SSR DOM for SEO + AI bots but
                visually hidden (sr-only, not display:none, so it stays indexed
                and in the a11y tree). The same facts are shown visibly in the
                layout's CompanyProfile / CompanyStats / the chart. */}
            <section
              aria-label={`${stockCode} short interest summary`}
              className="sr-only"
            >
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">
                {companyName} ({stockCode}) Short Interest
              </h1>
              <p className="mt-2 text-sm md:text-base text-muted-foreground leading-relaxed">
                {shortPct > 0 ? (
                  <>
                    {companyName} (ASX:{stockCode}) had{" "}
                    <strong className="text-foreground">
                      {shortPct.toFixed(2)}%
                    </strong>{" "}
                    of shares reported as short positions {asOfClause},
                    representing {positionsDisplay} shares.
                    {industry ? ` ${companyName} operates in the ${industry} industry.` : ""}
                    {" "}Source: ASIC short position report (T+4 delay).
                  </>
                ) : (
                  <>
                    {companyName} (ASX:{stockCode}) has no reportable short
                    positions in the latest ASIC data {asOfClause}.
                    {industry ? ` ${companyName} operates in the ${industry} industry.` : ""}
                  </>
                )}
              </p>
              <p className="mt-4 text-xs text-muted-foreground">
                Source: official ASIC short position report, T+4 delay.{" "}
                <a href="/methodology" className="underline hover:no-underline">
                  Methodology
                </a>
                {" · "}
                <a href="/disclaimer" className="underline hover:no-underline">
                  Disclaimer — not financial advice
                </a>
                .
              </p>
            </section>
          </>
        );
      })()}

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          {/* Short interest digest: the weekly-report context link (an
              internal link into the ~200 dated reports) and the way in. */}
          <section
            aria-labelledby="overview-short-interest-heading"
            className="rounded-lg border bg-card px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="overview-short-interest-heading" className="text-sm font-medium">
                Short interest
              </h2>
              <Link
                href={stockTabHref(stockCode, "short-interest")}
                prefetch={false}
                className="text-xs text-primary hover:underline"
              >
                History &amp; FAQ →
              </Link>
            </div>
            <Suspense fallback={null}>
              <LatestWeeklyReportLink
                variant="inline"
                label="Weekly context:"
                className="mt-2"
              />
            </Suspense>
          </section>

          {strategyFit ? <StrategyFitStrip fit={strategyFit} /> : null}

          {/* Crawlable fundamentals paragraph; omitted (never guessed) without
              a held result. The full statements live on the Financials tab. */}
          <div className="flex flex-col gap-2">
            <FundamentalsSummary
              stockCode={stockCode}
              companyName={companyName}
              fundamentals={fundamentals}
            />
            <Link
              href={stockTabHref(stockCode, "financials")}
              prefetch={false}
              className="self-end text-xs text-primary hover:underline"
            >
              Full financials →
            </Link>
          </div>

          {newsArticles.length > 0 && (
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-medium">Latest {stockCode} news</h2>
                <Link
                  href={stockTabHref(stockCode, "news")}
                  prefetch={false}
                  className="text-xs text-primary hover:underline"
                >
                  All news
                </Link>
              </div>
              <ul className="divide-y border-t">
                {newsArticles.map((article) => (
                  <li key={article.id || article.url} className="px-4 py-2.5">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm leading-snug hover:text-primary hover:underline"
                    >
                      {article.headline}
                    </a>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {article.source}
                      {article.publishedAtIso
                        ? ` · ${new Date(article.publishedAtIso).toLocaleDateString("en-AU", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}`
                        : null}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          <Suspense fallback={<CompanyInfoPlaceholder />}>
            <CompanyInfo stockCode={stockCode} />
          </Suspense>

          {relatedData.stocks.length > 0 && (
            <RelatedStocks
              stocks={relatedData.stocks}
              currentStock={stockCode}
              industrySlug={relatedData.industrySlug}
              title={`More ${relatedData.industry} Stocks`}
              description="Other shorted stocks in this sector"
            />
          )}

          <nav
            aria-label="Short selling resources"
            className="rounded-lg border bg-card px-4 py-3 text-sm"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Explore
            </p>
            <ul className="mt-2 space-y-1.5">
              <li><Link href="/top" className="text-primary hover:underline">Most shorted ASX stocks</Link></li>
              <li><Link href="/battlegrounds" className="text-primary hover:underline">Short squeeze candidates</Link></li>
              <li><Link href="/statistics" className="text-primary hover:underline">ASX short selling statistics</Link></li>
              <li><Link href="/learn/how-to-short-the-asx" className="text-primary hover:underline">How to short the ASX</Link></li>
            </ul>
          </nav>

          <CommunityOverviewTeaser stockCode={stockCode} />

          {/* The dossier itself is on the Company tab (a signed-in surface);
              the Overview keeps only the way in, and only for the signed out. */}
          <SignedOutOnly>
            <div className="rounded-lg border border-primary/20 bg-card px-4 py-3 text-sm">
              <p className="font-medium">{stockCode} intelligence dossier</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Public-source evidence for this company, with industry drill-up links.
              </p>
              <Link
                href={stockTabHref(stockCode, "company")}
                prefetch={false}
                className="mt-2 inline-block text-xs text-primary hover:underline"
              >
                Sign in to unlock on the Company tab →
              </Link>
            </div>
          </SignedOutOnly>
        </div>
      </div>
    </>
  );
};

export default Page;
