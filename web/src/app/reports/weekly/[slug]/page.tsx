import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle, eyebrow } from "~/@/lib/typography";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import {
  resolveWeeklySlugParam,
  weeklyReportPath,
} from "~/@/lib/reports/weekly-slug";
import {
  TrendingDown,
  TrendingUp,
  BarChart3,
  ArrowLeft,
  Calendar,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
  DatasetStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { MoversTable } from "~/@/components/reports/movers-table";
import {
  WeekNavigation,
  WEEKLY_ARCHIVE_LIMIT,
} from "~/@/components/reports/week-navigation";
import { CitationFootnotes } from "~/@/components/reports/citation-renderer";
import { LinkifiedNarrative } from "~/@/components/reports/linkified-narrative";
import { StatTile } from "~/@/components/reports/stat-tile";
import { TopStocksTable } from "~/@/components/reports/top-stocks-table";
import { IndustryBreakdown } from "~/@/components/reports/industry-breakdown";
import {
  getWeeklyReportData,
  getEnhancedWeeklyReportData,
  getEnhancedWeeklyReportDataStrict,
  getStockFinancialHighlights,
  getReportsList,
  type StockFinancialHighlight,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export const dynamic = "force-dynamic";

function formatWeekTitle(slug: string): string {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return slug;
  return `Week ${parseInt(match[2])}, ${match[1]}`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Monday/Friday (YYYY-MM-DD) for an ISO week slug — used to synthesize the
// week envelope when the narrative exists but market data is unavailable.
function weekDateRange(slug: string): { startDate: string; endDate: string } {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return { startDate: "", endDate: "" };
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay();
  const monday = new Date(simple);
  if (dow <= 4) monday.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
  else monday.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  return {
    startDate: monday.toISOString().slice(0, 10),
    endDate: friday.toISOString().slice(0, 10),
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  // Accept both slug forms; 301 the legacy ISO form to the canonical
  // query-matching path. The redirect must fire HERE (pre-commit) — thrown
  // from the streamed page body it degrades to a meta-refresh, not a 301.
  const resolved = resolveWeeklySlugParam(rawSlug);
  if (!resolved) {
    notFound();
  }
  if (!resolved.canonical) {
    permanentRedirect(weeklyReportPath(resolved.dbSlug));
  }
  const slug = resolved.dbSlug;
  const canonicalPath = weeklyReportPath(slug);
  const weekTitle = formatWeekTitle(slug);

  // The existence guard must live HERE, not only in the page body: metadata
  // resolves before the response commits, so notFound() still yields a real
  // HTTP 404. The page body streams behind loading.tsx — by the time its
  // notFound() fires the 200 status is already on the wire and Next can only
  // swap in the not-found UI + a noindex meta tag (the soft-404 GSC flagged
  // on /reports/weekly/2026-W28, July 2026).
  //
  // Hard-404 requires DEFINITIVE absence on both sources:
  //  - narrative: strict fetch returned null (report genuinely unpublished),
  //    NOT a transient failure (throw) — 404ing a published, sitemapped URL
  //    because the backend blipped signals removal to Google;
  //  - market data: the fetch succeeded with zero rows (data === undefined
  //    means the fetch itself failed). Guarding on market data alone also
  //    404'd every FRESH report: the week's Friday data lags ~4-6 days
  //    behind publication (ASIC T+4).
  // Transient failures render a degraded 200 instead.
  let enhanced = null;
  let enhancedUnavailable = false;
  try {
    enhanced = await getEnhancedWeeklyReportDataStrict(slug);
  } catch {
    enhancedUnavailable = true;
  }
  const data = await getWeeklyReportData(slug);
  if (!enhanced && !enhancedUnavailable && data && data.topStocks.length === 0) {
    notFound();
  }
  const headline = enhanced?.headline;

  // Title is ALWAYS the query-matching series pattern (what the freshness
  // SERPs reward — the incumbents' weekly series titles work exactly this
  // way); the editorial LLM headline leads the description + stays the H1.
  const title = `The 10 Most Shorted ASX Stocks — ${weekTitle}`;
  const description = headline
    ? `${headline}. Top shorted stocks, biggest risers and fallers for ${weekTitle}, from official ASIC data.`
    : `Weekly short selling report for the ASX — ${weekTitle}. Top shorted stocks, biggest movers, and industry analysis from official ASIC data.`;

  // Derive publication date from the week slug (Friday of that week)
  const parsed = slug.match(/^(\d{4})-W(\d{2})$/);
  let publishedDate: string | undefined;
  if (parsed?.[1] && parsed[2]) {
    const year = parseInt(parsed[1]);
    const week = parseInt(parsed[2]);
    const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
    const dow = simple.getUTCDay();
    const monday = new Date(simple);
    if (dow <= 4) monday.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
    else monday.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
    const friday = new Date(monday);
    friday.setUTCDate(monday.getUTCDate() + 4);
    publishedDate = friday.toISOString();
  }

  // Thin-content guard: if AI narrative isn't ready yet, tell crawlers not to
  // index this URL. The page still renders for users; once narrative lands,
  // ISR will regenerate and this metadata flips to indexable.
  const noindex = !headline;

  return {
    title,
    description,
    robots: noindex
      ? { index: false, follow: true, googleBot: { index: false, follow: true } }
      : undefined,
    keywords: [
      "10 most shorted ASX stocks",
      "most shorted ASX stocks",
      `most shorted ASX stocks ${weekTitle.toLowerCase()}`,
      "most shorted ASX stocks this week",
      `weekly short interest ${weekTitle}`,
      "ASX short positions weekly",
      "short selling risers fallers",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}${canonicalPath}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      publishedTime: publishedDate,
      modifiedTime: publishedDate,
      authors: [siteConfig.author],
      images: [
        {
          url: `${siteConfig.url}${canonicalPath}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `The 10 Most Shorted ASX Stocks — ${weekTitle}`,
        },
      ],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
      images: [`${siteConfig.url}${canonicalPath}/opengraph-image`],
    },
    alternates: {
      canonical: `${siteConfig.url}${canonicalPath}`,
      languages: {
        "en-AU": `${siteConfig.url}${canonicalPath}`,
        "x-default": `${siteConfig.url}${canonicalPath}`,
      },
    },
  };
}

export default async function WeeklyReportPage({ params }: PageProps) {
  const { slug: rawSlug } = await params;

  // Backstop for the redirect/404 already performed in generateMetadata.
  const resolved = resolveWeeklySlugParam(rawSlug);
  if (!resolved) {
    notFound();
  }
  if (!resolved.canonical) {
    permanentRedirect(weeklyReportPath(resolved.dbSlug));
  }
  const slug = resolved.dbSlug;

  // Both fetches are deduped with generateMetadata, which already ran the
  // hard-404 existence guard. The body guard mirrors it with the lenient
  // fetch: a transient narrative failure here (null) with definitively
  // empty market data falls through to the degraded 200 render below —
  // only definitive double-absence soft-404s.
  // publishedWeekly drives the prev/next pagination below. It's the same
  // 1h-cached ListReports call the /reports index makes (and it already
  // filters headline-less partial rows), so the neighbours we link are weeks
  // that definitely rendered — not blind week arithmetic into gaps. It
  // swallows its own errors and returns [], in which case WeekNavigation
  // falls back to arithmetic.
  const [rawData, enhanced, publishedWeekly] = await Promise.all([
    getWeeklyReportData(slug),
    getEnhancedWeeklyReportData(slug),
    getReportsList("weekly", WEEKLY_ARCHIVE_LIMIT),
  ]);
  if (!enhanced && rawData && rawData.topStocks.length === 0) {
    notFound();
  }

  // A published narrative can outrun market data (transient RPC failure or
  // the ASIC T+4 lag window) — synthesize the week envelope from the slug so
  // the render below never dereferences undefined.
  const data = rawData ?? {
    weekSlug: slug,
    ...weekDateRange(slug),
    dates: [],
    topStocks: [],
    totalStocksShorted: 0,
  };

  // financialHighlights depends on topStocks (falls back to the narrative's
  // own top-shorted list when market data is lagging).
  const topCodes = (
    data.topStocks.length > 0
      ? data.topStocks.slice(0, 20).map((s) => s.code)
      : (enhanced?.topShorted ?? []).slice(0, 20).map((s) => s.code)
  );
  const financialHighlights = topCodes.length > 0
    ? await getStockFinancialHighlights(topCodes)
    : ({} as Record<string, StockFinancialHighlight[]>);

  const weekTitle = formatWeekTitle(slug);
  const hasNarrative = !!enhanced?.narrative?.openingHook;
  const weeklySlugs = publishedWeekly.map((r) => r.slug);

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: "Weekly", href: "/reports/weekly" },
    { label: weekTitle, href: weeklyReportPath(slug) },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Reports", url: `${siteConfig.url}/reports` },
    { name: "Weekly Reports", url: `${siteConfig.url}/reports/weekly` },
    { name: weekTitle, url: `${siteConfig.url}${weeklyReportPath(slug)}` },
  ];

  const topStock = data.topStocks[0];

  // Use enhanced data if available, otherwise fall back to basic data
  const displayTopStocks = enhanced?.topShorted ?? data.topStocks.slice(0, 10).map((s, i) => ({
    rank: i + 1,
    code: s.code,
    name: s.name,
    shortPct: s.shortPercent,
    wowChange: 0,
    industry: s.industry,
  }));

  const risers = enhanced?.risers ?? [];
  const fallers = enhanced?.fallers ?? [];
  const faqs = enhanced?.faqs ?? [];
  const citations = enhanced?.citations ?? [];
  const marketStats = enhanced?.marketStats;
  const industryBreakdown = enhanced?.industryBreakdown ?? [];

  // Article schema for SEO (when narrative exists)
    // Citation markers ([ref-N]/[report-N]) from the grounding pipeline must
  // not leak into structured data.
  const cleanSummary = (enhanced?.summary ?? "")
    .replace(/\[(?:ref|report)-\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

  const canonicalUrl = `${siteConfig.url}${weeklyReportPath(slug)}`;
  // NewsArticle (not plain Article): the weekly series competes on freshness
  // SERPs where the ranking incumbents all carry NewsArticle markup.
  const articleSchema = hasNarrative ? {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: enhanced?.headline ?? `The 10 Most Shorted ASX Stocks — ${weekTitle}`,
    alternativeHeadline: `The 10 Most Shorted ASX Stocks — ${weekTitle}`,
    description: cleanSummary,
    datePublished: data.endDate,
    dateModified: data.endDate,
    // Organization author only — "Shorted AI Research" is not a Person, and
    // Google's guidance requires author to accurately represent authorship.
    author: [
      {
        "@type": "Organization",
        name: siteConfig.name,
        url: siteConfig.url,
      },
    ],
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
      logo: { "@type": "ImageObject", url: siteConfig.logo.url, width: siteConfig.logo.width, height: siteConfig.logo.height },
    },
    isPartOf: {
      "@type": "CreativeWorkSeries",
      name: "The 10 Most Shorted ASX Stocks — Weekly Series",
      url: `${siteConfig.url}/reports`,
    },
    articleSection: "Short Selling",
    inLanguage: "en-AU",
    isAccessibleForFree: true,
    mainEntityOfPage: canonicalUrl,
    image: [siteConfig.ogImage],
  } : null;

  return (
    <DashboardLayout>
      {/* Schema Markup */}
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      {articleSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
        />
      )}
      {/* FAQPage schema removed — only eligible for government/healthcare sites since Aug 2023 */}
      <ItemListStructuredData
        name={`Top Shorted ASX Stocks — ${weekTitle}`}
        description={`The most shorted stocks on the ASX for ${weekTitle}`}
        items={displayTopStocks.slice(0, 10).map((s) => ({
          name: `${s.code} — ${s.name}`,
          url: `${siteConfig.url}/shorts/${s.code}`,
          description: `${s.shortPct.toFixed(2)}% short interest`,
        }))}
      />
      <DatasetStructuredData
        datasetInfo={{
          name: `ASX Short Positions — ${weekTitle}`,
          description: `ASIC short position data for ASX-listed companies during ${weekTitle}`,
          url: `${siteConfig.url}${weeklyReportPath(slug)}`,
          datePublished: data.startDate,
          dateModified: data.endDate,
        }}
      />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <Link
          href="/reports/weekly"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All weekly reports
        </Link>

        {/* Hero */}
        <section className="border-b border-border/40 pb-8">
          <p className={cn(eyebrow, "mb-3 font-medium")}>
            The 10 Most Shorted ASX Stocks · {weekTitle}
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>
            {hasNarrative ? enhanced.headline : "Weekly Short Selling Report"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {formatDate(data.startDate)} — {formatDate(data.endDate)}
          </p>
          {hasNarrative && enhanced.summary && (
            <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed text-muted-foreground">
              {enhanced.summary}
            </p>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            By <span className="font-medium text-foreground">Shorted AI Research</span>
            {" · "}
            Published{" "}
            <time dateTime={data.endDate}>{formatDate(data.endDate)}</time>
            {" · "}
            Sourced from official ASIC short position reports (T+4 delay).
            {" "}
            <a href="/methodology" className="underline hover:no-underline">
              Methodology
            </a>
            {" · "}
            <a href="/disclaimer" className="underline hover:no-underline">
              Not financial advice
            </a>
            .
          </p>
        </section>

        {/* Stats */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="Stocks Shorted"
            value={String(marketStats?.totalStocksShorted ?? data.totalStocksShorted)}
          />
          <StatTile
            label="Most Shorted"
            value={
              marketStats
                ? `${marketStats.maxShortPct.toFixed(2)}%`
                : topStock
                  ? `${topStock.shortPercent.toFixed(2)}%`
                  : "—"
            }
            sub={marketStats?.maxShortCode ?? topStock?.code}
          />
          {marketStats ? (
            <>
              <StatTile
                label="Avg Short %"
                value={`${marketStats.avgShortPct.toFixed(2)}%`}
                delta={marketStats.wowAvgChange}
                deltaSuffix="%"
                sub={
                  marketStats.riserCount > 0 || marketStats.fallerCount > 0
                    ? `${marketStats.riserCount} up · ${marketStats.fallerCount} down`
                    : undefined
                }
              />
              {marketStats.medianShortPct > 0 && (
                <StatTile
                  label="Median Short %"
                  value={`${marketStats.medianShortPct.toFixed(2)}%`}
                />
              )}
              {marketStats.stocksAbove10Pct > 0 && (
                <StatTile
                  label="Above 10% Short"
                  value={String(marketStats.stocksAbove10Pct)}
                  sub={
                    marketStats.stocksAbove5Pct > 0
                      ? `${marketStats.stocksAbove5Pct} above 5%`
                      : undefined
                  }
                />
              )}
            </>
          ) : null}
          <StatTile label="Trading Days" value={String(data.dates.length)} />
        </section>

        {/* Opening Analysis (LLM narrative) */}
        {hasNarrative && enhanced.narrative.openingHook && (
          <section className="border-l-2 border-border pl-5 md:pl-6">
            <h2 className={cn(sectionTitle, "mb-3")}>
              This Week&apos;s Analysis
            </h2>
            <p className="max-w-prose text-[15px] leading-7 text-foreground/90">
              <LinkifiedNarrative text={enhanced.narrative.openingHook} citations={citations} validCodes={topCodes} />
            </p>
            {enhanced.narrative.topAnalysis && (
              <p className="mt-4 max-w-prose text-[15px] leading-7 text-foreground/80">
                <LinkifiedNarrative text={enhanced.narrative.topAnalysis} citations={citations} validCodes={topCodes} />
              </p>
            )}
          </section>
        )}

        {/* Daily Snapshots */}
        {data.dates.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              Daily Snapshots
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.dates.map((date) => (
                <Link key={date} href={`/market/${date}`} prefetch={false}>
                  <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                    {formatDate(date)}
                  </Badge>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Top Stocks Table (enhanced with logos, trend, days-to-cover, WoW) */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top Shorted Stocks This Week
          </h2>
          <TopStocksTable
            stocks={displayTopStocks.slice(0, 20)}
            changeLabel="WoW"
            showChange={!!enhanced}
          />
        </section>

        {/* Financial Snapshot */}
        {Object.keys(financialHighlights).length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              Financial Snapshot
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Key financial metrics from recent company reports for the most shorted stocks.
            </p>
            <div className="space-y-3">
              {displayTopStocks.slice(0, 10).filter((s) => financialHighlights[s.code]?.length).map((stock) => {
                const reports = financialHighlights[stock.code]!;
                const report = reports[0]!;
                const keyMetrics = report.metrics.filter((m) =>
                  ["revenue", "net_profit", "npat", "eps", "ebitda", "dividend"].includes(m.metricType) &&
                  // Extractions can store empty placeholder metrics ({source_text: ""}) —
                  // skip anything with no renderable value.
                  (Boolean(m.attributes.value_millions) || Boolean(m.attributes.value_cents) || Boolean(m.attributes.value) || m.sourceText.trim() !== "")
                ).slice(0, 4);
                if (keyMetrics.length === 0) return null;
                return (
                  <div key={stock.code} className="rounded-lg border border-border/60 bg-card/50 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <Link href={`/shorts/${stock.code}`} prefetch={false} className="hover:text-primary transition-colors">
                        <span className="font-semibold">{stock.code}</span>
                        <span className="text-sm text-muted-foreground ml-2">{stock.name}</span>
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {report.reportTitle} ({report.reportDate})
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                      {keyMetrics.map((m, i) => {
                        const label = m.metricType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                        const attrs = m.attributes;
                        const val = attrs.value_millions
                          ? `$${Number(attrs.value_millions).toLocaleString()}M`
                          : attrs.value_cents
                            ? `${Number(attrs.value_cents).toFixed(1)}c`
                            : attrs.value
                              ? attrs.value
                              : m.sourceText.slice(0, 60);
                        const period = attrs.period ?? "";
                        return (
                          <div key={i} className="text-sm">
                            <span className="text-muted-foreground">{label}:</span>{" "}
                            <span className="font-medium tabular-nums">{val}</span>
                            {period && <span className="text-xs text-muted-foreground ml-1">({period})</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Biggest Risers */}
        {risers.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-red-500" />
              Biggest Risers
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Stocks with the largest increase in short interest this week.
            </p>
            <MoversTable movers={risers} type="risers" />
          </section>
        )}

        {/* Biggest Fallers */}
        {fallers.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-green-500" />
              Biggest Fallers
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Stocks with the largest decrease in short interest this week.
            </p>
            <MoversTable movers={fallers} type="fallers" />
          </section>
        )}

        {/* Movers Analysis (LLM narrative) */}
        {hasNarrative && enhanced.narrative.moversAnalysis && (
          <section className="border-l-2 border-border pl-5 md:pl-6">
            <h2 className={cn(sectionTitle, "mb-3")}>
              Movers Analysis
            </h2>
            <p className="max-w-prose text-[15px] leading-7 text-foreground/80">
              <LinkifiedNarrative text={enhanced.narrative.moversAnalysis} citations={citations} validCodes={topCodes} />
            </p>
          </section>
        )}

        {/* Industry Positioning — data first, then LLM commentary */}
        {(industryBreakdown.length > 0 ||
          (hasNarrative && enhanced.narrative.industryAnalysis)) && (
          <section>
            <h2 className="text-xl font-semibold mb-4">Industry Positioning</h2>
            {industryBreakdown.length > 0 && (
              <IndustryBreakdown industries={industryBreakdown} changeLabel="WoW" />
            )}
            {hasNarrative && enhanced.narrative.industryAnalysis && (
              <p className="mt-4 max-w-prose text-[15px] leading-7 text-foreground/80">
                <LinkifiedNarrative text={enhanced.narrative.industryAnalysis} citations={citations} validCodes={topCodes} />
              </p>
            )}
          </section>
        )}

        {/* Outlook (LLM narrative) */}
        {hasNarrative && enhanced.narrative.outlook && (
          <section className="border-t border-border/40 pt-6">
            <h2 className={cn(sectionTitle, "mb-3")}>
              Outlook
            </h2>
            <p className="max-w-prose text-[15px] leading-7 text-foreground/80">
              <LinkifiedNarrative text={enhanced.narrative.outlook} citations={citations} validCodes={topCodes} />
            </p>
          </section>
        )}

        {/* FAQs */}
        {faqs.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4">
              Frequently Asked Questions
            </h2>
            <div className="space-y-4">
              {faqs.map((faq, i) => (
                <div key={i} className="rounded-lg border border-border/60 bg-card/50 p-4">
                  <h3 className="font-semibold text-foreground mb-2">{faq.question}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{faq.answer}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Citation Sources */}
        {citations.length > 0 && (
          <CitationFootnotes citations={citations} />
        )}

        {/* Hub links — internal-link mesh back to the live surfaces. */}
        <section className="border-t border-border/40 pt-4 text-sm text-muted-foreground">
          <p>
            Track the live rankings on the{" "}
            <Link href="/top" className="text-primary hover:underline">
              most shorted ASX stocks
            </Link>{" "}
            page, watch{" "}
            <Link href="/battlegrounds" className="text-primary hover:underline">
              short squeeze candidates
            </Link>
            , or see market-wide totals in the{" "}
            <Link href="/statistics" className="text-primary hover:underline">
              ASX short selling statistics
            </Link>
            .
          </p>
        </section>

        {/* Disclaimer */}
        <section className="text-xs text-muted-foreground border-t border-border/40 pt-4">
          <p>
            Data sourced from ASIC short position reports (T+4 delayed).
            This report is for informational purposes only and does not constitute financial advice.
            Short selling data may not reflect real-time market conditions.
          </p>
        </section>

        {/* Week Navigation — prev/next across the published weekly series. */}
        <WeekNavigation currentSlug={slug} availableSlugs={weeklySlugs} />
      </div>
    </DashboardLayout>
  );
}
