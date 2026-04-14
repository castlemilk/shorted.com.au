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
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { cn } from "~/@/lib/utils";
import { MoversTable } from "~/@/components/reports/movers-table";
import {
  getMonthlyReportData,
  getEnhancedWeeklyReportData,
  getAvailableMonthSlugs,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  // Skip static generation during local builds (pre-commit hook sets this)
  if (process.env.SKIP_STATIC_GENERATION === "1") {
    return [];
  }
  try {
    const slugs = await getAvailableMonthSlugs();
    // Pre-generate all available months at build time — historical reports are immutable
    return slugs.map((slug) => ({ slug }));
  } catch {
    return [];
  }
}

function formatMonthTitle(slug: string): string {
  const date = new Date(`${slug}-01T00:00:00`);
  return date.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const monthTitle = formatMonthTitle(slug);

  const enhanced = await getEnhancedWeeklyReportData(slug);
  const headline = enhanced?.headline;

  const title = headline
    ? `${headline} | ${siteConfig.name}`
    : `ASX Short Selling Report: ${monthTitle} | ${siteConfig.name}`;
  const description = enhanced?.summary
    ?? `Monthly short selling report for the ASX — ${monthTitle}. Top shorted stocks, industry analysis, and aggregate short interest from official ASIC data.`;

  return {
    title,
    description,
    keywords: [
      `ASX short selling report ${monthTitle}`,
      `monthly short interest ${monthTitle}`,
      "ASX short positions monthly",
      "ASIC monthly report",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/reports/monthly/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      images: [
        {
          url: `${siteConfig.url}/reports/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `ASX Short Selling Monthly Report — ${monthTitle}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${siteConfig.url}/reports/opengraph-image`],
    },
    alternates: {
      canonical: `${siteConfig.url}/reports/monthly/${slug}`,
      languages: {
        "en-AU": `${siteConfig.url}/reports/monthly/${slug}`,
        "x-default": `${siteConfig.url}/reports/monthly/${slug}`,
      },
    },
  };
}

export const revalidate = 86400;

export default async function MonthlyReportPage({ params }: PageProps) {
  const { slug } = await params;

  if (!/^\d{4}-\d{2}$/.test(slug)) {
    notFound();
  }

  const [data, enhanced] = await Promise.all([
    getMonthlyReportData(slug),
    getEnhancedWeeklyReportData(slug),
  ]);

  if (!data) {
    notFound();
  }

  const monthTitle = formatMonthTitle(slug);
  const hasNarrative = !!enhanced?.narrative?.openingHook;
  const topStock = data.topStocks[0];

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

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: monthTitle, href: `/reports/monthly/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Reports", url: `${siteConfig.url}/reports` },
    { name: monthTitle, url: `${siteConfig.url}/reports/monthly/${slug}` },
  ];

  const articleSchema = hasNarrative ? {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: enhanced?.headline ?? `ASX Short Selling Report: ${monthTitle}`,
    description: enhanced?.summary,
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
      name: "Monthly ASX Short Selling Reports",
      url: `${siteConfig.url}/reports`,
    },
    mainEntityOfPage: `${siteConfig.url}/reports/monthly/${slug}`,
  } : null;

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      {articleSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
        />
      )}
      {/* FAQPage schema removed — only eligible for government/healthcare sites since Aug 2023 */}
      <ItemListStructuredData
        name={`Top Shorted ASX Stocks — ${monthTitle}`}
        description={`The most shorted stocks on the ASX for ${monthTitle}`}
        items={displayTopStocks.slice(0, 10).map((s) => ({
          name: `${s.code} — ${s.name}`,
          url: `${siteConfig.url}/shorts/${s.code}`,
          description: `${s.shortPct.toFixed(2)}% short interest`,
        }))}
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
                {hasNarrative ? enhanced.headline : "Monthly Short Selling Report"}
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {monthTitle}
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
              {topStock ? `${topStock.shortPercent.toFixed(2)}%` : "---"}
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
                  <span>MoM Change</span>
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

        {/* Opening Analysis */}
        {hasNarrative && enhanced.narrative.openingHook && (
          <section className="rounded-lg border border-primary/20 bg-primary/5 p-6">
            <h2 className="text-lg font-semibold mb-3">This Month&apos;s Analysis</h2>
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
                <Link key={date} href={`/market/${date}`} prefetch={false}>
                  <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                    {formatDate(date)}
                  </Badge>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Top Stocks Table */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top Shorted Stocks This Month
          </h2>
          <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50">
            <div className={cn(
              "gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider",
              enhanced ? "grid grid-cols-[60px_1fr_100px_90px_48px]" : "grid grid-cols-[60px_1fr_100px_48px]",
            )}>
              <div className="text-center">Rank</div>
              <div>Stock</div>
              <div className="text-right">Short %</div>
              {enhanced && <div className="text-right">MoM</div>}
              <div></div>
            </div>
            <div className="divide-y divide-border/40">
              {displayTopStocks.slice(0, 20).map((stock, index) => (
                <Link
                  key={stock.code}
                  href={`/shorts/${stock.code}`}
                  prefetch={false}
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

        {/* Biggest Risers */}
        {risers.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-red-500" />
              Biggest Risers
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Stocks with the largest increase in short interest this month.
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
              Stocks with the largest decrease in short interest this month.
            </p>
            <MoversTable movers={fallers} type="fallers" />
          </section>
        )}

        {/* Movers Analysis */}
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

        {/* Outlook */}
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
      </div>
    </DashboardLayout>
  );
}
