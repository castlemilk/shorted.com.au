import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle, eyebrow } from "~/@/lib/typography";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  TrendingDown,
  TrendingUp,
  ArrowLeft,
  Calendar,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { MoversTable } from "~/@/components/reports/movers-table";
import { StatTile } from "~/@/components/reports/stat-tile";
import { TopStocksTable } from "~/@/components/reports/top-stocks-table";
import { IndustryBreakdown } from "~/@/components/reports/industry-breakdown";
import {
  getMonthlyReportData,
  getEnhancedWeeklyReportData,
  getEnhancedWeeklyReportDataStrict,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export const dynamic = "force-dynamic";

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
  if (!/^\d{4}-\d{2}$/.test(slug)) {
    notFound();
  }
  const monthTitle = formatMonthTitle(slug);

  // Hard-404 guard (in generateMetadata so notFound() commits a real HTTP
  // 404 — the body's guard fires mid-stream and can only soft-404). Only
  // DEFINITIVE absence 404s: strict narrative fetch returned null (report
  // genuinely unpublished, not a backend blip) AND market data succeeded
  // with zero rows. Transient failures render a degraded 200 — never 404 a
  // published URL because the backend blipped. Mirrors weekly/[slug].
  let enhanced = null;
  let enhancedUnavailable = false;
  try {
    enhanced = await getEnhancedWeeklyReportDataStrict(slug);
  } catch {
    enhancedUnavailable = true;
  }
  const data = await getMonthlyReportData(slug);
  if (!enhanced && !enhancedUnavailable && data && data.topStocks.length === 0) {
    notFound();
  }
  const headline = enhanced?.headline;

  const title = headline
    ?? `ASX Short Selling Report: ${monthTitle}`;
  const description = enhanced?.summary
    ?? `Monthly short selling report for the ASX — ${monthTitle}. Top shorted stocks, industry analysis, and aggregate short interest from official ASIC data.`;

  const noindex = !headline;

  return {
    title,
    description,
    robots: noindex
      ? { index: false, follow: true, googleBot: { index: false, follow: true } }
      : undefined,
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

export default async function MonthlyReportPage({ params }: PageProps) {
  const { slug } = await params;

  if (!/^\d{4}-\d{2}$/.test(slug)) {
    notFound();
  }

  const [rawData, enhanced] = await Promise.all([
    getMonthlyReportData(slug),
    getEnhancedWeeklyReportData(slug),
  ]);

  // Definitive double-absence soft-404s; transient failures render a
  // degraded 200 with an envelope synthesized from the slug (mirrors
  // weekly/[slug]) so the render below never dereferences undefined.
  if (!enhanced && rawData && rawData.topStocks.length === 0) {
    notFound();
  }
  const data = rawData ?? {
    monthSlug: slug,
    month: new Date(`${slug}-01T00:00:00`).toLocaleDateString("en-AU", {
      month: "long",
    }),
    year: slug.slice(0, 4),
    dates: [],
    topStocks: [],
    totalStocksShorted: 0,
  };

  const monthTitle = formatMonthTitle(slug);
  const hasNarrative = !!enhanced?.narrative?.openingHook;
  const topStock = data.topStocks[0];

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
  const marketStats = enhanced?.marketStats;
  const industryBreakdown = enhanced?.industryBreakdown ?? [];

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: monthTitle, href: `/reports/monthly/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Reports", url: `${siteConfig.url}/reports` },
    { name: monthTitle, url: `${siteConfig.url}/reports/monthly/${slug}` },
  ];

    // Citation markers ([ref-N]/[report-N]) from the grounding pipeline must
  // not leak into structured data.
  const cleanSummary = (enhanced?.summary ?? "")
    .replace(/\[(?:ref|report)-\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

  // Publication date: the last ASIC data date covered by the report, falling
  // back to the last calendar day of the month when market data is lagging.
  // Google drops Article rich results entirely without a datePublished.
  const monthEndDate =
    data.dates[data.dates.length - 1] ??
    (() => {
      const [y, m] = slug.split("-").map(Number);
      if (!y || !m) return undefined;
      return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    })();

  const articleSchema = hasNarrative ? {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: enhanced?.headline ?? `ASX Short Selling Report: ${monthTitle}`,
    description: cleanSummary,
    ...(monthEndDate
      ? { datePublished: monthEndDate, dateModified: monthEndDate }
      : {}),
    inLanguage: "en-AU",
    isAccessibleForFree: true,
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
      name: "Monthly ASX Short Selling Reports",
      url: `${siteConfig.url}/reports`,
    },
    mainEntityOfPage: `${siteConfig.url}/reports/monthly/${slug}`,
    image: [siteConfig.ogImage],
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
          <p className={cn(eyebrow, "mb-3 font-medium")}>
            Monthly Report · {monthTitle}
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>
            {hasNarrative ? enhanced.headline : "Monthly Short Selling Report"}
          </h1>
          {hasNarrative && enhanced.summary && (
            <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed text-muted-foreground">
              {enhanced.summary}
            </p>
          )}
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

        {/* Opening Analysis */}
        {hasNarrative && enhanced.narrative.openingHook && (
          <section className="border-l-2 border-border pl-5 md:pl-6">
            <h2 className={cn(sectionTitle, "mb-3")}>
              This Month&apos;s Analysis
            </h2>
            <p className="max-w-prose text-[15px] leading-7 text-foreground/90">
              {enhanced.narrative.openingHook}
            </p>
            {enhanced.narrative.topAnalysis && (
              <p className="mt-4 max-w-prose text-[15px] leading-7 text-foreground/80">
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
          <TopStocksTable
            stocks={displayTopStocks.slice(0, 20)}
            changeLabel="MoM"
            showChange={!!enhanced}
          />
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
          <section className="border-l-2 border-border pl-5 md:pl-6">
            <h2 className={cn(sectionTitle, "mb-3")}>
              Movers Analysis
            </h2>
            <p className="max-w-prose text-[15px] leading-7 text-foreground/80">
              {enhanced.narrative.moversAnalysis}
            </p>
          </section>
        )}

        {/* Industry Positioning — data first, then LLM commentary */}
        {(industryBreakdown.length > 0 ||
          (hasNarrative && enhanced.narrative.industryAnalysis)) && (
          <section>
            <h2 className="text-xl font-semibold mb-4">Industry Positioning</h2>
            {industryBreakdown.length > 0 && (
              <IndustryBreakdown industries={industryBreakdown} changeLabel="MoM" />
            )}
            {hasNarrative && enhanced.narrative.industryAnalysis && (
              <p className="mt-4 max-w-prose text-[15px] leading-7 text-foreground/80">
                {enhanced.narrative.industryAnalysis}
              </p>
            )}
          </section>
        )}

        {/* Outlook */}
        {hasNarrative && enhanced.narrative.outlook && (
          <section className="border-t border-border/40 pt-6">
            <h2 className={cn(sectionTitle, "mb-3")}>
              Outlook
            </h2>
            <p className="max-w-prose text-[15px] leading-7 text-foreground/80">
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
