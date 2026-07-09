import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
// Consolidated per-stock chart (price + short interest, dual-axis, volume, brush).
// Client-only: uses Connect-RPC + market-data hooks.
const StockChartPanel = nextDynamic(
  () =>
    import("~/@/components/charts/StockChartPanel").then(
      (m) => m.StockChartPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] animate-pulse rounded-lg bg-muted/40" />
    ),
  },
);
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
import { FinancialDigest } from "~/@/components/company/financial-digest";
import { CommunityOverviewTeaser } from "~/@/components/company/community/community-overview-teaser";
import { CommunityTab } from "~/@/components/company/community/community-tab";
import { StockEvidencePanel } from "~/@/components/company/stock-evidence-panel";

// Dynamic import to avoid SSR issues — child components import @connectrpc/connect
const StockTabs = nextDynamic(
  () => import("~/@/components/company/stock-tabs").then((m) => m.StockTabs),
  { ssr: false }
);
import { Suspense } from "react";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta, StockLLMMeta } from "~/@/components/seo/llm-meta";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { siteConfig } from "~/@/config/site";
import { RelatedStocks } from "~/@/components/seo/related-stocks";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { ShortInterestHistory } from "./short-interest-history";
import { NotFoundError } from "~/app/actions/withRetry";
import { notFound } from "next/navigation";
import {
  getStockFinancialHighlights,
  type StockFinancialHighlight,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();

  // Try to fetch stock data for enriched metadata
  let title = `${code} Short Position | Official ASIC Data (T+4)`;
  let description = `${code} short selling data from official ASIC reports. Current short interest %, historical trends, charts & analysis. Updated daily with T+4 delay. Free ASX short position tracking.`;
  let shouldNoindex = false;
  // Content-addressed OG image version: changes when the short % changes, so
  // the social card refreshes exactly when data does (and is served from
  // immutable cache otherwise). Also moves off any stale/frozen cached URL.
  let ogVersion = "default";

  try {
    const stock = await getStockOrNotFound(code);
    if (stock) {
      const companyName = stock.name ? `(${stock.name})` : "";
      const shortPct = stock.percentageShorted > 0 ? ` | ${stock.percentageShorted.toFixed(2)}% Shorted` : "";
      title = `${code} ${companyName} Short Position${shortPct} | ASIC Data`;
      if (stock.percentageShorted > 0) ogVersion = stock.percentageShorted.toFixed(2);

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

  const ogImage = {
    url: `${siteConfig.url}/shorts/${code}/opengraph-image?p=${ogVersion}`,
    width: 1200,
    height: 630,
    alt: `${code} short position — ${siteConfig.name}`,
  };

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
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${siteConfig.name}`,
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

// Connect RPC calls use no-store fetches, which are incompatible with ISR for
// uncached dynamicParams. Cloudflare caches public stock HTML at the edge for
// 24h, so keep Next dynamic and let the edge absorb repeat traffic.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const dynamicParams = true;

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

  // Financial highlights — fetched server-side, cached 24h, degrades gracefully
  const financialHighlightsMap = await getStockFinancialHighlights([stockCode]).catch(
    (): Record<string, StockFinancialHighlight[]> => ({}),
  );
  const financialHighlights = financialHighlightsMap?.[stockCode] ?? [];

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
        // Strip ASIC security-type suffixes ("ORDINARY", "CDI 1:1", "FPO" …)
        // from the product string for schema name fields — "LOTUS RESOURCES
        // LTD ORDINARY" is a product label, not a company name.
        const cleanName = companyName
          .replace(/\s+(ORDINARY|FPO|CDI(\s+\d+:\d+)?|UNITS?|STAPLED(\s+SECURITIES)?|NON-VOTING.*)$/i, "")
          .trim() || companyName;
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
                and in the a11y tree). The same facts are shown visibly below in
                CompanyProfile / CompanyStats / the chart. */}
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
            <CompanyStats stockCode={stockCode} initialStock={stock} />
          </Suspense>
        </div>
      </div>

      {/* Price & short interest — the page centrepiece, full width, flat. */}
      <section aria-labelledby="stock-chart-heading" className="mb-6 min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2
            id="stock-chart-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Price &amp; short interest
          </h2>
          <span className="text-xs text-muted-foreground">
            Toggle series, zoom, and compare · ASIC daily, T+4
          </span>
        </div>
        <StockChartPanel stockCode={stockCode} />
      </section>

      {/* Tabbed content area */}
      <StockTabs
        stockCode={stockCode}
        overviewMain={
          <>
            {/* Per-stock public-source evidence with industry drill-up links */}
            <Suspense fallback={null}>
              <StockEvidencePanel
                stockCode={stockCode}
                industry={relatedData.industry}
                industrySlug={relatedData.industrySlug}
              />
            </Suspense>

            {/* SSR short-interest history + FAQ — crawlable trend facts.
                Native <details open> keeps the content in the DOM (crawlable)
                whether expanded or collapsed. */}
            {stock && (stock.percentageShorted ?? 0) > 0 && (
              <details
                open
                className="group rounded-lg border bg-card [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
                  Short interest history &amp; FAQ
                  <span className="text-muted-foreground transition-transform group-open:rotate-180">
                    ▾
                  </span>
                </summary>
                <div className="border-t px-4 py-3">
                  <Suspense fallback={null}>
                    <ShortInterestHistory
                      stockCode={stockCode}
                      companyName={stock.name || stockCode}
                    />
                  </Suspense>
                </div>
              </details>
            )}

            {/* Enriched Company Insights (reports shown in Financials tab) */}
            <EnrichedCompanySection stockCode={stockCode} hideReports />
          </>
        }
        overviewRail={
          <>
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

            <CommunityOverviewTeaser stockCode={stockCode} />
          </>
        }
        financialsContent={
          <div className="flex flex-col gap-4 md:gap-6">
            <FinancialDigest highlights={financialHighlights} />
            <Suspense fallback={<CompanyFinancialsPlaceholder />}>
              <CompanyFinancials stockCode={stockCode} />
            </Suspense>
            <EnrichedCompanySection stockCode={stockCode} />
          </div>
        }
        communityContent={
          <CommunityTab
            stockCode={stockCode}
          />
        }
      />
    </DashboardLayout>
  );
};

export default Page;
