import nextDynamic from "next/dynamic";
import { PoliticianInterestsCard } from "@/components/company/politician-interests-card-loader";
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
import {
  EnrichedCompanySection,
  FinancialReportsSection,
  FinancialStatementsSection,
} from "~/@/components/company/enriched-company-section";
import { CompanyTaxCard } from "~/@/components/company/company-tax-card";
import { FinancialDigest } from "~/@/components/company/financial-digest";
import { CommunityOverviewTeaser } from "~/@/components/company/community/community-overview-teaser";
import { CommunityTab } from "~/@/components/company/community/community-tab";
import { StockEvidencePanelClient } from "~/@/components/company/stock-evidence-panel-client";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";
import { SignedOutOnly } from "~/@/components/ui/session-gates";

// The tabs shell SSRs (static import): the server-rendered overview slots
// must reach the served HTML for crawlers. The connect-importing tab
// CHILDREN are lazy ssr:false imports INSIDE the shell — see stock-tabs.tsx.
import { StockTabs } from "~/@/components/company/stock-tabs";
import { Suspense } from "react";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta, StockLLMMeta } from "~/@/components/seo/llm-meta";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ChevronDown } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { RelatedStocks } from "~/@/components/seo/related-stocks";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStockHeadlines } from "~/app/actions/getStockNews";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { formatCompanyName } from "~/@/lib/company-name";
import Link from "next/link";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { ShortInterestHistory } from "./short-interest-history";
import {
  ShortInterestSummary,
  getShortInterestDeltas,
} from "./short-interest-summary";
import { LatestWeeklyReportLink } from "~/@/components/reports/latest-weekly-report-link";
import { NotFoundError } from "~/app/actions/withRetry";
import { notFound } from "next/navigation";
import {
  getStockFinancialHighlights,
  type StockFinancialHighlight,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

// Display name for every SEO-critical surface on this page (title, og:title,
// h1, crawler summary, schema). `stock.name` is the raw ASIC PRODUCT string —
// SHOUTED, with a security-type descriptor ("BHP GROUP LIMITED ORDINARY") —
// so it must go through the shared formatter, the same one the visible
// CompanyProfile uses. The page previously stripped only the security-type
// word, which left SERP titles shouting "BHP GROUP LIMITED".
function cleanCompanyName(name: string, code: string): string {
  return formatCompanyName(name, code) || name;
}

// ASIC report dates are Sydney calendar days — format them in that zone so a
// UTC-hosted render can't show the previous day.
function formatAsOfDate(date: Date): string {
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
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
  // Content-addressed OG image version: changes when the short % changes, so
  // the social card refreshes exactly when data does (and is served from
  // immutable cache otherwise). Also moves off any stale/frozen cached URL.
  let ogVersion = "default";

  try {
    const stock = await getStockOrNotFound(code);
    if (stock) {
      const companyName = stock.name ? cleanCompanyName(stock.name, code) : "";
      const shortPct = stock.percentageShorted > 0 ? ` | ${stock.percentageShorted.toFixed(2)}% Shorted` : "";
      title = companyName
        ? `${code} Short Interest — ${companyName} (ASX:${code})${shortPct}`
        : `${code} Short Interest${shortPct} | ASIC Data`;
      if (stock.percentageShorted > 0) ogVersion = stock.percentageShorted.toFixed(2);

      // The date of the latest ASIC report this stock appears in — NOT
      // `new Date()`. ASIC publishes T+4, so "as of <today>" describes a
      // report that does not exist yet. Null when unknown: the sentence
      // drops the clause rather than inventing a date.
      const asOf = await getLatestShortDate(code);
      const dateStr = asOf ? formatAsOfDate(asOf) : null;
      const descName = companyName || code;
      const shortInfo = stock.percentageShorted > 0
        ? `${descName} short interest is ${stock.percentageShorted.toFixed(2)}%${dateStr ? ` as of ${dateStr}` : ""}.`
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
  // Financial highlights (Financials tab) fetched in the same parallel batch —
  // cached 24h, degrades gracefully to an empty list.
  const financialHighlightsPromise = getStockFinancialHighlights([
    stockCode,
  ]).catch(
    (): Record<string, StockFinancialHighlight[]> => ({}),
  );
  // Latest headlines for the crawlable research section below the tabs —
  // ISR-safe accessor, degrades to an empty list.
  const stockNewsPromise = getStockHeadlines(stockCode, 5);
  // Date of the latest ASIC report containing this stock — the page's "as of"
  // everywhere. Never `new Date()`: ASIC publishes T+4.
  const latestShortDatePromise = getLatestShortDate(stockCode).catch(
    (): Date | null => null,
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

  // Under ISR a degraded render would be BAKED into the shared page cache
  // for up to an hour (schema-less shell served to every visitor and
  // crawler). Fail the generation instead: the request 500s, nothing is
  // cached, and the next request regenerates. (getStockOrNotFound returns
  // undefined only on transient errors — genuine not-found threw above.)
  if (!stock) {
    throw new Error(
      `stock data transiently unavailable for ${stockCode}; failing ISR render instead of caching a degraded page`,
    );
  }

  const financialHighlightsMap = await financialHighlightsPromise;
  const financialHighlights = financialHighlightsMap?.[stockCode] ?? [];
  const newsArticles = await stockNewsPromise;
  const latestShortDate = await latestShortDatePromise;

  // Hoisted out of the schema IIFE below because the visible summary paragraph
  // and the sr-only crawler summary must state the SAME "as of". The real ASIC
  // report date, never the render date — `null` degrades to "in the latest
  // ASIC report" rather than printing a date we can't stand behind (ASIC
  // publishes T+4, so "as of today" describes a report that cannot exist).
  const asOfIso = latestShortDate
    ? latestShortDate.toISOString().slice(0, 10)
    : null;
  const asOfDisplay = latestShortDate ? formatAsOfDate(latestShortDate) : null;
  const asOfClause = asOfDisplay
    ? `as of ${asOfDisplay}`
    : "in the latest ASIC report";

  // Trailing-window deltas for the summary paragraph. Reads the SAME
  // React-cached "max" series getLatestShortDate already pulled, so it costs
  // no extra backend call; returns all-nulls (clauses omitted) on failure.
  const shortDeltas = await getShortInterestDeltas(stockCode);

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
          companyName={cleanCompanyName(stock.name || stockCode, stockCode)}
          industry={stock.industry || ""}
          sector={stock.industry || ""}
          shortPercentage={stock.percentageShorted || undefined}
          currentShortPosition={stock.reportedShortPositions || undefined}
        />
      )}

      {/* Guaranteed page h1: the rich crawler summary below only renders when
          stock data resolved — on transient backend errors the page would
          otherwise ship with no h1 at all. */}
      {!stock && (
        <h1 className="sr-only">{stockCode} Short Interest</h1>
      )}

      {stock && (() => {
        const shortPct = stock.percentageShorted ?? 0;
        const shortPositions = stock.reportedShortPositions ?? 0;
        const companyName = cleanCompanyName(stock.name || stockCode, stockCode);
        const industry = stock.industry || "";
        // asOfIso / asOfClause are hoisted to the page body above — the
        // visible summary and this crawler summary must not disagree.
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

      <div className="mb-4">
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      {/* Signed-out breadcrumb to login — dismissible, above the fold.
          Client-gated: the ISR HTML is shared across sessions, so the
          banner appears once the session resolves as signed-out.
          CLS guard: the slot div is ALWAYS in the server HTML; a pre-paint
          inline script in layout.tsx marks <html class="anon"> when no
          next-auth session cookie exists, and critical CSS reserves the
          banner's height under html.anon — so for the signed-out majority
          the banner hydrates into pre-reserved space instead of shifting
          the whole page down (~0.13 CLS on mobile). Signed-in visitors get
          a zero-height slot. */}
      <div className="login-slot">
        <SignedOutOnly>
          <div className="overflow-hidden rounded-lg border border-primary/20">
            <LoginPromptBanner />
          </div>
        </SignedOutOnly>
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

      {/* Templated short-interest summary — prose above the fold, built only
          from data this render already has. This is what wins "[ticker] short
          interest" against competitors whose pages are prose-first and
          data-thin; the sr-only block above is a schema/LLM companion, not a
          substitute for text a human can read. */}
      <ShortInterestSummary
        stockCode={stockCode}
        companyName={cleanCompanyName(stock.name || stockCode, stockCode)}
        industry={stock.industry || ""}
        shortPct={stock.percentageShorted ?? 0}
        shortPositions={stock.reportedShortPositions ?? 0}
        asOfClause={asOfClause}
        deltas={shortDeltas}
      />

      {/* Weekly context — one internal link into the weekly report series
          (the ~200 dated posts that had almost no inbound links). Streamed
          under Suspense so its cached fetch can't delay this page's ISR
          render, and renders nothing if the archive is unavailable.
          Deliberately NOT "this stock appears in week N" — that would couple
          the stock page to a per-report membership lookup. */}
      <Suspense fallback={null}>
        <LatestWeeklyReportLink
          variant="inline"
          label="Weekly context:"
          className="mb-6"
        />
      </Suspense>

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

      {/* Tabbed content area. The shell SSRs (its connect-importing tab
          children are lazy client-only inside it), so everything in the
          overview slots below reaches the served HTML — peers, history,
          headlines and hub links live in their proper rail/main positions
          AND stay crawlable. */}
      <StockTabs
        stockCode={stockCode}
        overviewMain={
          <>
            {/* Per-stock public-source evidence with industry drill-up
                links. Signed-out visitors see the lock with a yellow
                sign-in CTA instead of the dossier. The ISR page HTML is
                session-agnostic, so the dossier is fetched CLIENT-SIDE and
                only after the session resolves as authenticated — gated
                data never ships in the shared cached payload. */}
            <StockEvidencePanelClient
              stockCode={stockCode}
              industry={relatedData.industry}
              industrySlug={relatedData.industrySlug}
            />

            {/* SSR short-interest history + FAQ — crawlable trend facts.
                Native <details> keeps the content in the DOM (crawlable)
                whether expanded or collapsed; defaults CLOSED so ~550px of
                FAQ prose doesn't sit mid-overview. */}
            {stock && (stock.percentageShorted ?? 0) > 0 && (
              <details className="group rounded-lg border bg-card [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
                  Short interest history &amp; FAQ
                  <ChevronDown
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
                  />
                </summary>
                <div className="border-t px-4 py-3">
                  <Suspense fallback={null}>
                    <ShortInterestHistory
                      stockCode={stockCode}
                      companyName={cleanCompanyName(stock.name || stockCode, stockCode)}
                    />
                  </Suspense>
                </div>
              </details>
            )}

            {/* Consolidated company research card — the ONLY place the
                enriched prose renders (the Financials tab shows reports
                + metrics only, no duplicated company content). */}
            <EnrichedCompanySection stockCode={stockCode} />

            {/* Latest headlines — server-fetched so stock pages carry
                fresh, crawlable text; the full feed lives on the News tab. */}
            {newsArticles.length > 0 && (
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between px-4 py-3">
                  <h2 className="text-sm font-medium">
                    Latest {stockCode} news
                  </h2>
                  <Link
                    href={`/shorts/${stockCode}/news`}
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
                          ? ` · ${new Date(
                              article.publishedAtIso,
                            ).toLocaleDateString("en-AU", {
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
          </>
        }
        overviewRail={
          <>
            <Suspense fallback={<CompanyInfoPlaceholder />}>
              <CompanyInfo stockCode={stockCode} />
            </Suspense>

            {/* Registers of Members'/Senators' Interests. A rail card rather
                than a 9th tab: the tab list already overflows on mobile, its
                `available` array is hardcoded (so a missed edit silently breaks
                ?tab= deep links), and the card is empty for most stocks.
                ssr:false keeps politicians_pb out of this route's 330kB budget. */}
            <PoliticianInterestsCard stockCode={stockCode} />

            {/* Related stocks — the peer internal-link mesh, in the SSR
                DOM via the SSR'd tabs shell. */}
            {relatedData.stocks.length > 0 && (
              <RelatedStocks
                stocks={relatedData.stocks}
                currentStock={stockCode}
                industrySlug={relatedData.industrySlug}
                title={`More ${relatedData.industry} Stocks`}
                description="Other shorted stocks in this sector"
              />
            )}

            {/* Hub links — part of the sitewide internal-link mesh. */}
            <nav
              aria-label="Short selling resources"
              className="rounded-lg border bg-card px-4 py-3 text-sm"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Explore
              </p>
              <ul className="mt-2 space-y-1.5">
                <li>
                  <Link href="/top" className="text-primary hover:underline">
                    Most shorted ASX stocks
                  </Link>
                </li>
                <li>
                  <Link href="/battlegrounds" className="text-primary hover:underline">
                    Short squeeze candidates
                  </Link>
                </li>
                <li>
                  <Link href="/statistics" className="text-primary hover:underline">
                    ASX short selling statistics
                  </Link>
                </li>
                <li>
                  <Link
                    href="/learn/how-to-short-the-asx"
                    className="text-primary hover:underline"
                  >
                    How to short the ASX
                  </Link>
                </li>
              </ul>
            </nav>

            <CommunityOverviewTeaser stockCode={stockCode} />
          </>
        }
        financialsContent={
          <div className="flex flex-col gap-4 md:gap-6">
            <FinancialDigest highlights={financialHighlights} />
            <Suspense fallback={<CompanyFinancialsPlaceholder />}>
              <CompanyFinancials stockCode={stockCode} />
            </Suspense>
            <FinancialStatementsSection stockCode={stockCode} />
            <CompanyTaxCard stockCode={stockCode} />
            <FinancialReportsSection stockCode={stockCode} />
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
