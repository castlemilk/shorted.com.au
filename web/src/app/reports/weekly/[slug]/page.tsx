import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { WeekNavigation } from "~/@/components/reports/week-navigation";
import { CitationFootnotes } from "~/@/components/reports/citation-renderer";
import { LinkifiedNarrative } from "~/@/components/reports/linkified-narrative";
import { StatTile } from "~/@/components/reports/stat-tile";
import { TopStocksTable } from "~/@/components/reports/top-stocks-table";
import { IndustryBreakdown } from "~/@/components/reports/industry-breakdown";
import {
  getWeeklyReportData,
  getEnhancedWeeklyReportData,
  getStockFinancialHighlights,
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

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const weekTitle = formatWeekTitle(slug);

  // Try to get LLM headline for metadata
  const enhanced = await getEnhancedWeeklyReportData(slug);
  const headline = enhanced?.headline;

  const title = headline
    ?? `Most Shorted ASX Stocks: ${weekTitle} — Top Shorts & Biggest Movers`;
  const description = enhanced?.summary
    ?? `Weekly short selling report for the ASX — ${weekTitle}. Top shorted stocks, biggest movers, and industry analysis from official ASIC data.`;

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
      `ASX short selling report ${slug}`,
      `weekly short interest ${weekTitle}`,
      "ASX short positions weekly",
      "ASIC weekly report",
      "most shorted ASX stocks",
      "short selling risers fallers",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/reports/weekly/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      publishedTime: publishedDate,
      modifiedTime: publishedDate,
      authors: [siteConfig.author],
      images: [
        {
          url: `${siteConfig.url}/reports/weekly/${slug}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `ASX Short Selling Weekly Report — ${weekTitle}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${siteConfig.url}/reports/weekly/${slug}/opengraph-image`],
    },
    alternates: {
      canonical: `${siteConfig.url}/reports/weekly/${slug}`,
      languages: {
        "en-AU": `${siteConfig.url}/reports/weekly/${slug}`,
        "x-default": `${siteConfig.url}/reports/weekly/${slug}`,
      },
    },
  };
}

export default async function WeeklyReportPage({ params }: PageProps) {
  const { slug } = await params;

  if (!/^\d{4}-W\d{2}$/.test(slug)) {
    notFound();
  }

  // Start both independent fetches — don't block financialHighlights on enhanced
  const dataPromise = getWeeklyReportData(slug);
  const enhancedPromise = getEnhancedWeeklyReportData(slug);

  // Wait for data first (needed for guard + financialHighlights)
  const data = await dataPromise;

  // Show 404 only if there's no market data at all
  // Enhanced narrative is optional — page renders with basic data if AI report isn't ready
  if (!data || data.topStocks.length === 0) {
    notFound();
  }

  // financialHighlights depends on data.topStocks, runs in parallel with enhanced
  const topCodes = data.topStocks.slice(0, 20).map((s) => s.code);
  const [enhanced, financialHighlights] = await Promise.all([
    enhancedPromise,
    topCodes.length > 0
      ? getStockFinancialHighlights(topCodes)
      : Promise.resolve({} as Record<string, StockFinancialHighlight[]>),
  ]);

  const weekTitle = formatWeekTitle(slug);
  const hasNarrative = !!enhanced?.narrative?.openingHook;

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: weekTitle, href: `/reports/weekly/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Reports", url: `${siteConfig.url}/reports` },
    { name: weekTitle, url: `${siteConfig.url}/reports/weekly/${slug}` },
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

  const articleSchema = hasNarrative ? {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: enhanced?.headline ?? `ASX Short Selling Report: ${weekTitle}`,
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
      logo: { "@type": "ImageObject", url: `${siteConfig.url}/logo.png`, width: 512, height: 512 },
    },
    isPartOf: {
      "@type": "CreativeWorkSeries",
      name: "Weekly ASX Short Selling Reports",
      url: `${siteConfig.url}/reports`,
    },
    mainEntityOfPage: `${siteConfig.url}/reports/weekly/${slug}`,
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
          datePublished: data.startDate,
          dateModified: data.endDate,
        }}
      />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <Link
          href="/reports"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All Reports
        </Link>

        {/* Hero */}
        <section className="border-b border-border/40 pb-8">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Weekly Report · {weekTitle}
          </p>
          <h1 className="font-serif text-3xl font-semibold leading-[1.1] tracking-tight md:text-4xl">
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
            <h2 className="mb-3 font-serif text-2xl font-semibold tracking-tight">
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
            <h2 className="mb-3 font-serif text-2xl font-semibold tracking-tight">
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
            <h2 className="mb-3 font-serif text-2xl font-semibold tracking-tight">
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

        {/* Disclaimer */}
        <section className="text-xs text-muted-foreground border-t border-border/40 pt-4">
          <p>
            Data sourced from ASIC short position reports (T+4 delayed).
            This report is for informational purposes only and does not constitute financial advice.
            Short selling data may not reflect real-time market conditions.
          </p>
        </section>

        {/* Week Navigation */}
        <WeekNavigation currentSlug={slug} />
      </div>
    </DashboardLayout>
  );
}
