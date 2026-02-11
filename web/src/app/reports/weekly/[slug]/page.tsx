import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FileText,
  ChevronRight,
  TrendingDown,
  TrendingUp,
  BarChart3,
  Building2,
  ArrowLeft,
  Calendar,
  Percent,
  ArrowUpDown,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import {
  BreadcrumbListSchema,
  FAQStructuredData,
  ItemListStructuredData,
  DatasetStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { cn } from "~/@/lib/utils";
import { MoversTable } from "~/@/components/reports/movers-table";
import { WeekNavigation } from "~/@/components/reports/week-navigation";
import {
  getWeeklyReportData,
  getEnhancedWeeklyReportData,
  getAvailableWeekSlugs,
  getStockFinancialHighlights,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  try {
    const slugs = await getAvailableWeekSlugs();
    // Only pre-generate last 4 weeks at build time; rest via ISR on-demand
    return slugs.slice(0, 4).map((slug) => ({ slug }));
  } catch {
    return [];
  }
}

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
    ? `${headline} | ${siteConfig.name}`
    : `Most Shorted ASX Stocks: ${weekTitle} | Top Shorts & Biggest Movers`;
  const description = enhanced?.summary
    ?? `Weekly short selling report for the ASX — ${weekTitle}. Top shorted stocks, biggest movers, and industry analysis from official ASIC data.`;

  return {
    title,
    description,
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
    },
    alternates: {
      canonical: `${siteConfig.url}/reports/weekly/${slug}`,
    },
  };
}

export const revalidate = 86400; // Historical weeks are immutable

export default async function WeeklyReportPage({ params }: PageProps) {
  const { slug } = await params;

  if (!/^\d{4}-W\d{2}$/.test(slug)) {
    notFound();
  }

  const data = await getWeeklyReportData(slug);

  if (!data) {
    notFound();
  }

  // Fetch enhanced data and financial highlights in parallel (both depend on data)
  const topCodes = data.topStocks.slice(0, 20).map((s) => s.code);
  const [enhanced, financialHighlights] = await Promise.all([
    getEnhancedWeeklyReportData(slug),
    topCodes.length > 0 ? getStockFinancialHighlights(topCodes) : Promise.resolve({} as Record<string, import("~/app/actions/reports/getReportData").StockFinancialHighlight[]>),
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
  }));

  const risers = enhanced?.risers ?? [];
  const fallers = enhanced?.fallers ?? [];
  const faqs = enhanced?.faqs ?? [];
  const marketStats = enhanced?.marketStats;

  // Article schema for SEO (when narrative exists)
  const articleSchema = hasNarrative ? {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: enhanced?.headline ?? `ASX Short Selling Report: ${weekTitle}`,
    description: enhanced?.summary,
    datePublished: data.endDate,
    dateModified: data.endDate,
    author: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
      logo: { "@type": "ImageObject", url: siteConfig.ogImage },
    },
    isPartOf: {
      "@type": "CreativeWorkSeries",
      name: "Weekly ASX Short Selling Reports",
      url: `${siteConfig.url}/reports`,
    },
    mainEntityOfPage: `${siteConfig.url}/reports/weekly/${slug}`,
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
      {faqs.length > 0 && <FAQStructuredData faqs={faqs} />}
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
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <FileText className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                {hasNarrative ? enhanced.headline : "Weekly Short Selling Report"}
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {weekTitle} ({formatDate(data.startDate)} — {formatDate(data.endDate)})
              </p>
            </div>
          </div>
          {hasNarrative && enhanced.summary && (
            <p className="text-base text-muted-foreground max-w-3xl leading-relaxed">
              {enhanced.summary}
            </p>
          )}
        </section>

        {/* Stats */}
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="rounded-lg border bg-gradient-to-br from-blue-500/20 to-blue-500/5 border-blue-500/30 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Building2 className="h-4 w-4" />
              <span>Stocks Shorted</span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-blue-500">
              {marketStats?.totalStocksShorted ?? data.totalStocksShorted}
            </div>
          </div>
          <div className="rounded-lg border bg-gradient-to-br from-red-500/20 to-red-500/5 border-red-500/30 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <TrendingDown className="h-4 w-4" />
              <span>Most Shorted</span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-red-500">
              {topStock ? `${topStock.shortPercent.toFixed(2)}%` : "—"}
            </div>
            {topStock && <div className="text-xs text-muted-foreground mt-1">{topStock.code}</div>}
          </div>
          <div className="rounded-lg border bg-gradient-to-br from-purple-500/20 to-purple-500/5 border-purple-500/30 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <BarChart3 className="h-4 w-4" />
              <span>Trading Days</span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-purple-500">{data.dates.length}</div>
          </div>
          {marketStats && (
            <>
              <div className="rounded-lg border bg-gradient-to-br from-amber-500/20 to-amber-500/5 border-amber-500/30 p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <Percent className="h-4 w-4" />
                  <span>Avg Short %</span>
                </div>
                <div className="text-2xl font-bold tabular-nums text-amber-500">
                  {marketStats.avgShortPct.toFixed(2)}%
                </div>
              </div>
              <div className="rounded-lg border bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 border-emerald-500/30 p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <ArrowUpDown className="h-4 w-4" />
                  <span>WoW Change</span>
                </div>
                <div className={cn(
                  "text-2xl font-bold tabular-nums",
                  marketStats.wowAvgChange > 0 ? "text-red-500" :
                  marketStats.wowAvgChange < 0 ? "text-green-500" :
                  "text-emerald-500"
                )}>
                  {marketStats.wowAvgChange > 0 ? "+" : ""}{marketStats.wowAvgChange.toFixed(2)}%
                </div>
              </div>
            </>
          )}
        </section>

        {/* Opening Analysis (LLM narrative) */}
        {hasNarrative && enhanced.narrative.openingHook && (
          <section className="rounded-lg border border-primary/20 bg-primary/5 p-6">
            <h2 className="text-lg font-semibold mb-3">This Week&apos;s Analysis</h2>
            <p className="text-foreground/90 leading-relaxed">
              {enhanced.narrative.openingHook}
            </p>
            {enhanced.narrative.topAnalysis && (
              <p className="text-foreground/80 leading-relaxed mt-3">
                {enhanced.narrative.topAnalysis}
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
                <Link key={date} href={`/market/${date}`}>
                  <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                    {formatDate(date)}
                  </Badge>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Top Stocks Table (enhanced with WoW change) */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top Shorted Stocks This Week
          </h2>
          <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50">
            <div className={cn(
              "gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider",
              enhanced ? "grid grid-cols-[60px_1fr_100px_90px_48px]" : "grid grid-cols-[60px_1fr_100px_48px]",
            )}>
              <div className="text-center">Rank</div>
              <div>Stock</div>
              <div className="text-right">Short %</div>
              {enhanced && <div className="text-right">WoW</div>}
              <div></div>
            </div>
            <div className="divide-y divide-border/40">
              {displayTopStocks.slice(0, 20).map((stock, index) => (
                <Link
                  key={stock.code}
                  href={`/shorts/${stock.code}`}
                  className={cn(
                    "gap-4 px-4 py-3 items-center hover:bg-muted/50 transition-colors group",
                    enhanced ? "grid grid-cols-[60px_1fr_100px_90px_48px]" : "grid grid-cols-[60px_1fr_100px_48px]",
                  )}
                >
                  <div className="text-center">
                    <span className={cn(
                      "text-lg font-bold tabular-nums",
                      index < 3 && "text-red-500",
                      index >= 3 && index < 10 && "text-orange-500",
                      index >= 10 && "text-foreground/70"
                    )}>
                      {stock.rank}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold group-hover:text-primary transition-colors">{stock.code}</div>
                    <div className="text-xs text-muted-foreground truncate">{stock.name}</div>
                  </div>
                  <div className="text-right">
                    <span className={cn(
                      "inline-block px-2 py-1 rounded text-sm font-semibold tabular-nums border",
                      stock.shortPct >= 10 ? "bg-red-600 text-white border-red-700" :
                      stock.shortPct >= 5 ? "bg-yellow-500 text-black border-yellow-600" :
                      "bg-muted text-foreground border-border"
                    )}>
                      {stock.shortPct.toFixed(2)}%
                    </span>
                  </div>
                  {enhanced && (
                    <div className="text-right">
                      <span className={cn(
                        "text-sm font-medium tabular-nums",
                        stock.wowChange > 0 && "text-red-500",
                        stock.wowChange < 0 && "text-green-500",
                        stock.wowChange === 0 && "text-muted-foreground",
                      )}>
                        {stock.wowChange > 0 ? "+" : ""}{stock.wowChange.toFixed(2)}%
                      </span>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
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
                  ["revenue", "net_profit", "npat", "eps", "ebitda", "dividend"].includes(m.metricType)
                ).slice(0, 4);
                if (keyMetrics.length === 0) return null;
                return (
                  <div key={stock.code} className="rounded-lg border border-border/60 bg-card/50 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <Link href={`/shorts/${stock.code}`} className="hover:text-primary transition-colors">
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
          <section className="rounded-lg border border-border/40 bg-card/50 p-6">
            <h2 className="text-lg font-semibold mb-3">Movers Analysis</h2>
            <p className="text-foreground/80 leading-relaxed">
              {enhanced.narrative.moversAnalysis}
            </p>
            {enhanced.narrative.industryAnalysis && (
              <>
                <h3 className="text-base font-semibold mt-4 mb-2">Industry Trends</h3>
                <p className="text-foreground/80 leading-relaxed">
                  {enhanced.narrative.industryAnalysis}
                </p>
              </>
            )}
          </section>
        )}

        {/* Outlook (LLM narrative) */}
        {hasNarrative && enhanced.narrative.outlook && (
          <section className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-6">
            <h2 className="text-lg font-semibold mb-3">Outlook</h2>
            <p className="text-foreground/80 leading-relaxed">
              {enhanced.narrative.outlook}
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
