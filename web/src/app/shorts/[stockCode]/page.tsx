import dynamic from "next/dynamic";
import { type Metadata } from "next";
import { MarketChartSkeleton } from "~/@/components/ui/market-chart";
const MarketChart = dynamic(() => import("~/@/components/ui/market-chart"), {
  ssr: false,
  loading: () => <MarketChartSkeleton withMenu={true} />,
});
import CompanyProfile, {
  CompanyProfilePlaceholder,
} from "~/@/components/ui/companyProfile";
import CompanyStats, {
  CompanyStatsPlaceholder,
} from "~/@/components/ui/companyStats";
import CompanyInfo, {
  CompanyInfoPlaceholder,
} from "~/@/components/ui/companyInfo";
import CompanyFinancials,{
  CompanyFinancialsPlaceholder,
} from "~/@/components/ui/companyFinancials";
import { EnrichedCompanySection } from "~/@/components/company/enriched-company-section";
import { CommunityOverviewTeaser } from "~/@/components/company/community/community-overview-teaser";
import { CommunityTab } from "~/@/components/company/community/community-tab";

// Dynamic import to avoid SSR issues — child components import @connectrpc/connect
const StockTabs = dynamic(
  () => import("~/@/components/company/stock-tabs").then((m) => m.StockTabs),
  { ssr: false }
);
// Client-only: uses fetchStockDataClient (Connect-RPC) + market-data API.
const ShortPriceOverlay = dynamic(
  () => import("~/@/components/company/short-price-overlay").then((m) => m.ShortPriceOverlay),
  { ssr: false }
);
import { Suspense } from "react";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta, StockLLMMeta } from "~/@/components/seo/llm-meta";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { TrendingDown, CandlestickChart } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { RelatedStocks } from "~/@/components/seo/related-stocks";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";
import { notFound } from "next/navigation";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getStockCommunitySummary } from "~/@/lib/community/firestore-community";
import { buildCommunitySummary } from "~/@/lib/community/summary";
import {
  listCommunityPulseItems,
  listCommunityThreads,
} from "~/@/lib/community/firestore-community";

/**
 * Pre-generate ALL stocks with non-zero short positions at build time (~940 stocks).
 * Uses getTopShortsData (wrapped in withRetryAndNotFound) to avoid importing
 * @connectrpc/connect directly in this server component, which causes SSR failures.
 */
export async function generateStaticParams(): Promise<{ stockCode: string }[]> {
  // Skip static generation during local builds (pre-commit hook sets this)
  if (process.env.SKIP_STATIC_GENERATION === "1") {
    return [];
  }
  try {
    // Only pre-generate top 50 stocks at build time.
    // The rest are generated on-demand via ISR (dynamicParams = true by default).
    // This saves ~3-5 minutes of Vercel build time vs generating all ~1000.
    const response = await getTopShortsData("max", 50, 0);
    if (!response) return [];

    const stockCodes = response.timeSeries
      .map((ts) => ts.productCode)
      .filter((code): code is string => !!code && /^[A-Z0-9]{1,4}$/.test(code));

    // Return unique stock codes
    return [...new Set(stockCodes)].map((code) => ({
      stockCode: code,
    }));
  } catch (error) {
    console.warn("Failed to fetch stock codes for static generation, pages will be generated on-demand:", error);
    // Return empty — pages will be generated on-demand at request time
    return [];
  }
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

// Stocks below this short % threshold are noindex'd. They produce thin
// templated pages with no narrative value, leading to "Crawled - currently
// not indexed" in GSC. Page remains accessible (no 404), just not indexed.
const STOCK_PAGE_NOINDEX_THRESHOLD = 0.5;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();

  // Try to fetch stock data for enriched metadata
  let title = `${code} Short Position | Official ASIC Data (T+4)`;
  let description = `${code} short selling data from official ASIC reports. Current short interest %, historical trends, charts & analysis. Updated daily with T+4 delay. Free ASX short position tracking.`;
  let shouldNoindex = false;

  try {
    const stock = await getStockOrNotFound(code);
    if (stock) {
      const companyName = stock.name ? `(${stock.name})` : "";
      const shortPct = stock.percentageShorted > 0 ? ` | ${stock.percentageShorted.toFixed(2)}% Shorted` : "";
      title = `${code} ${companyName} Short Position${shortPct} | ASIC Data`;

      const dateStr = new Date().toLocaleDateString("en-AU", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const shortInfo = stock.percentageShorted > 0
        ? `${stock.name || code} has ${stock.percentageShorted.toFixed(2)}% of shares sold short as of ${dateStr}.`
        : `${stock.name || code} short selling data from official ASIC reports.`;
      const industryInfo = stock.industry ? ` Industry: ${stock.industry}.` : "";
      description = `${shortInfo}${industryInfo} Track ${code}'s short position history, price charts, peer comparison, and ASIC data. Updated daily with T+4 delay.`;

      // Noindex thin stocks (no/minimal short interest) — they remain
      // crawlable but don't pollute the index with templated thin content.
      if ((stock.percentageShorted ?? 0) < STOCK_PAGE_NOINDEX_THRESHOLD) {
        shouldNoindex = true;
      }
    }
  } catch {
    // Fall back to default title/description if fetch fails
  }

  return {
    title,
    description,
    robots: shouldNoindex
      ? { index: false, follow: true, googleBot: { index: false, follow: true } }
      : undefined,
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
      title: `${title} | ${siteConfig.name}`,
      description,
      url: `${siteConfig.url}/shorts/${code}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${siteConfig.name}`,
      description,
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

// ISR: revalidate daily. On-demand revalidation via /api/revalidate?scope=all after daily sync.
export const revalidate = 86400;

const Chart = dynamic(() => import("~/@/components/ui/chart"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const Page = async ({ params }: PageProps) => {
  const { stockCode: rawStockCode } = await params;
  // This page is public for SEO and discovery - no authentication required
  const stockCode = rawStockCode.toUpperCase();

  // Validate stock code format (ASX codes are 1-4 alphanumeric characters)
  if (!/^[A-Z0-9]{1,4}$/.test(stockCode)) {
    notFound();
  }

  // Fetch stock data for StockLLMMeta and related stocks in parallel
  // getStockOrNotFound throws NotFoundError when the stock doesn't exist,
  // but returns undefined for transient backend errors.
  let stock: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  let relatedData: Awaited<ReturnType<typeof getRelatedStocks>>;
  const communitySummaryPromise = getStockCommunitySummary(stockCode).catch(() =>
    buildCommunitySummary({ stockCode, threads: [], pulse: [] }),
  );
  const communityThreadsPromise = listCommunityThreads(stockCode).catch(
    () => [],
  );
  const communityPulsePromise = listCommunityPulseItems(stockCode).catch(
    () => [],
  );
  try {
    [stock, relatedData] = await Promise.all([
      getStockOrNotFound(stockCode),
      getRelatedStocks(stockCode),
    ]);
  } catch (err) {
    // Stock genuinely doesn't exist in the database → show 404
    if (err instanceof NotFoundError) {
      notFound();
    }
    // Transient backend error → render page with fallback UI (retry components)
    relatedData = { stocks: [], industry: null, industrySlug: null };
  }
  const [communitySummary, communityThreads, communityPulse] = await Promise.all(
    [communitySummaryPromise, communityThreadsPromise, communityPulsePromise],
  );

  const breadcrumbItems = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: `/shorts/${stockCode}` },
  ];

  return (
    <DashboardLayout>
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
      {stock && (
        <StockLLMMeta
          stockCode={stockCode}
          companyName={stock.name || stockCode}
          industry={stock.industry || ""}
          sector={stock.industry || ""}
          shortPercentage={stock.percentageShorted || undefined}
          currentShortPosition={stock.reportedShortPositions || undefined}
        />
      )}

      {stock && (() => {
        const shortPct = stock.percentageShorted ?? 0;
        const shortPositions = stock.reportedShortPositions ?? 0;
        const companyName = stock.name || stockCode;
        const industry = stock.industry || "";
        const asOfIso = new Date().toISOString().slice(0, 10);
        const asOfDisplay = new Date().toLocaleDateString("en-AU", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
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
          temporalCoverage: `2010-06-01/${asOfIso}`,
          variableMeasured: [
            { "@type": "PropertyValue", name: "percentShort", unitText: "PERCENT" },
            { "@type": "PropertyValue", name: "reportedShortPositions", unitText: "shares" },
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
        const corporationSchema = {
          "@context": "https://schema.org",
          "@type": "Corporation",
          name: companyName,
          legalName: companyName,
          tickerSymbol: stockCode,
          identifier: `ASX:${stockCode}`,
          ...(stock.logoUrl ? { logo: stock.logoUrl, image: stock.logoUrl } : {}),
          ...(industry ? { naics: industry } : {}),
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
            <section
              aria-label={`${stockCode} short interest summary`}
              className="mb-4 rounded-lg border bg-card p-4 md:p-5"
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
                    of shares reported as short positions as of {asOfDisplay},
                    representing {positionsDisplay} shares.
                    {industry ? ` ${companyName} operates in the ${industry} industry.` : ""}
                    {" "}Source: ASIC short position report (T+4 delay).
                  </>
                ) : (
                  <>
                    {companyName} (ASX:{stockCode}) has no reportable short
                    positions in the latest ASIC data as of {asOfDisplay}.
                    {industry ? ` ${companyName} operates in the ${industry} industry.` : ""}
                  </>
                )}
              </p>
              <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Short interest</dt>
                  <dd className="font-semibold text-base">
                    {shortPct > 0 ? `${shortPct.toFixed(2)}%` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Reported positions</dt>
                  <dd className="font-semibold text-base">{positionsDisplay}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Industry</dt>
                  <dd className="font-semibold text-base">{industry || "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">As of</dt>
                  <dd className="font-semibold text-base">{asOfDisplay}</dd>
                </div>
              </dl>
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

      <div className="mb-4">
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      {/* Header: Profile & Stats (always visible above tabs) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 items-start mb-6">
        <div className="md:col-span-2">
          <Suspense fallback={<CompanyProfilePlaceholder />}>
            <CompanyProfile stockCode={stockCode} />
          </Suspense>
        </div>
        <div className="md:col-span-1 h-full">
          <Suspense fallback={<CompanyStatsPlaceholder />}>
            <CompanyStats stockCode={stockCode} />
          </Suspense>
        </div>
      </div>

      {/* Tabbed content area */}
      <StockTabs
        stockCode={stockCode}
        overviewContent={
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 items-start">
            <div className="md:col-span-1 flex flex-col gap-4 md:gap-6">
              <Suspense fallback={<CompanyInfoPlaceholder />}>
                <CompanyInfo stockCode={stockCode} />
              </Suspense>

              {/* Related stocks for internal linking */}
              {relatedData.stocks.length > 0 && (
                <RelatedStocks
                  stocks={relatedData.stocks}
                  currentStock={stockCode}
                  industrySlug={relatedData.industrySlug}
                  title={`More ${relatedData.industry} Stocks`}
                  description="Other shorted stocks in this sector"
                />
              )}
            </div>

            <div className="md:col-span-2 flex flex-col gap-4 md:gap-6">
              {/* Short Position Trends */}
              <Card className="border-l-4 border-l-red-500 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden">
                <CardHeader className="pb-4 bg-gradient-to-r from-red-50/50 to-transparent dark:from-red-950/20 dark:to-transparent">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-red-100 dark:bg-red-900/40 rounded-lg shadow-sm">
                      <TrendingDown className="h-6 w-6 text-red-600 dark:text-red-400" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-xl text-red-900 dark:text-red-100">
                        Short Position Trends
                      </CardTitle>
                      <CardDescription className="mt-1.5 text-sm">
                        Track bearish sentiment and short interest over time
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-2">
                  <Chart stockCode={stockCode} />
                </CardContent>
              </Card>

              <CommunityOverviewTeaser
                stockCode={stockCode}
                summary={communitySummary}
              />

              {/* Price vs Short Interest overlay — dual-axis visualization */}
              <ShortPriceOverlay stockCode={stockCode} />

              {/* Historical Price Data */}
              <Card className="border-l-4 border-l-blue-500 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden">
                <CardHeader className="pb-4 bg-gradient-to-r from-blue-50/50 to-transparent dark:from-blue-950/20 dark:to-transparent">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 rounded-lg shadow-sm">
                      <CandlestickChart className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-xl text-blue-900 dark:text-blue-100">
                        Historical Price Data
                      </CardTitle>
                      <CardDescription className="mt-1.5 text-sm">
                        View stock price movements, volume, and trading patterns
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-2">
                  <MarketChart stockCode={stockCode} />
                </CardContent>
              </Card>

              {/* Enriched Company Insights (reports shown in Financials tab) */}
              <EnrichedCompanySection stockCode={stockCode} hideReports />
            </div>
          </div>
        }
        financialsContent={
          <div className="flex flex-col gap-4 md:gap-6">
            <Suspense fallback={<CompanyFinancialsPlaceholder />}>
              <CompanyFinancials stockCode={stockCode} />
            </Suspense>
            <EnrichedCompanySection stockCode={stockCode} />
          </div>
        }
        communityContent={
          <CommunityTab
            stockCode={stockCode}
            threads={communityThreads}
            pulse={communityPulse}
          />
        }
      />
    </DashboardLayout>
  );
};

export default Page;

const ChartSkeleton = () => (
  <div className="grid">
    <div className="flex flex-row-reverse">
      <div className="flex">
        <div className="h-10 w-[60px] ml-2 rounded bg-muted animate-pulse" />
        <div className="h-10 w-[60px] ml-2 rounded bg-muted animate-pulse" />
      </div>
      <div className="flex space-x-2">
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="h-10 w-12 rounded bg-muted animate-pulse" />
        ))}
      </div>
    </div>
    <div>
      <div className="h-[500px] min-h-[500px] w-full mt-2 rounded bg-muted animate-pulse" />
    </div>
  </div>
);
