import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  TrendingDown,
  TrendingUp,
  BarChart3,
  ArrowLeft,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
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
  getEnhancedWeeklyReportData,
  getEnhancedWeeklyReportDataStrict,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  if (!/^\d{4}$/.test(slug)) {
    notFound();
  }
  // Hard-404 guard (in generateMetadata so notFound() commits a real HTTP
  // 404 — the body's guard fires mid-stream and can only soft-404). Only
  // DEFINITIVE absence 404s: the strict fetch returned null (report
  // genuinely unpublished). A transient backend failure (throw) renders
  // the degraded 200 instead — never 404 a published URL on a blip.
  let enhanced = null;
  let enhancedUnavailable = false;
  try {
    enhanced = await getEnhancedWeeklyReportDataStrict(slug);
  } catch {
    enhancedUnavailable = true;
  }
  if (!enhanced && !enhancedUnavailable) {
    notFound();
  }
  const headline = enhanced?.headline;

  const title = headline
    ?? `ASX Short Selling Year in Review: ${slug}`;
  const description = enhanced?.summary
    ?? `${slug} year-in-review of ASX short selling. A comprehensive look at the year's top shorted stocks, biggest movers, and market trends from official ASIC data.`;

  const noindex = !headline;

  return {
    title,
    description,
    robots: noindex
      ? { index: false, follow: true, googleBot: { index: false, follow: true } }
      : undefined,
    keywords: [
      `ASX short selling ${slug} year in review`,
      `${slug} most shorted stocks`,
      "ASX short interest annual report",
      "ASIC short position annual summary",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/reports/yearly/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      images: [
        {
          url: `${siteConfig.url}/reports/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `ASX Short Selling Year in Review: ${slug}`,
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
      canonical: `${siteConfig.url}/reports/yearly/${slug}`,
      languages: {
        "en-AU": `${siteConfig.url}/reports/yearly/${slug}`,
        "x-default": `${siteConfig.url}/reports/yearly/${slug}`,
      },
    },
  };
}

export default async function YearlyReportPage({ params }: PageProps) {
  const { slug } = await params;

  if (!/^\d{4}$/.test(slug)) {
    notFound();
  }

  const enhanced = await getEnhancedWeeklyReportData(slug);

  if (!enhanced) {
    notFound();
  }

  const hasNarrative = !!enhanced.narrative?.openingHook;
  const risers = enhanced.risers ?? [];
  const fallers = enhanced.fallers ?? [];
  const faqs = enhanced.faqs ?? [];
  const marketStats = enhanced.marketStats;
  const displayTopStocks = enhanced.topShorted ?? [];
  const industryBreakdown = enhanced.industryBreakdown ?? [];

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: `${slug} Year in Review`, href: `/reports/yearly/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Reports", url: `${siteConfig.url}/reports` },
    { name: `${slug} Year in Review`, url: `${siteConfig.url}/reports/yearly/${slug}` },
  ];

    // Citation markers ([ref-N]/[report-N]) from the grounding pipeline must
  // not leak into structured data.
  const cleanSummary = (enhanced?.summary ?? "")
    .replace(/\[(?:ref|report)-\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

  const articleSchema = hasNarrative ? {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: enhanced.headline ?? `ASX Short Selling Year in Review: ${slug}`,
    description: cleanSummary,
    datePublished: `${slug}-12-31`,
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
    mainEntityOfPage: `${siteConfig.url}/reports/yearly/${slug}`,
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
        name={`Top Shorted ASX Stocks — ${slug} Year End`}
        description={`The most shorted stocks on the ASX at the end of ${slug}`}
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
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Year in Review · {slug}
          </p>
          <h1 className="font-serif text-3xl font-semibold leading-[1.1] tracking-tight md:text-4xl">
            {hasNarrative ? enhanced.headline : `${slug} Year in Review`}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            ASX Short Selling — {slug} Annual Review
          </p>
          {hasNarrative && enhanced.summary && (
            <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed text-muted-foreground">
              {enhanced.summary}
            </p>
          )}
        </section>

        {/* Stats */}
        {marketStats && (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              label="Stocks Shorted (YE)"
              value={String(marketStats.totalStocksShorted)}
            />
            <StatTile
              label="Most Shorted"
              value={`${marketStats.maxShortPct.toFixed(2)}%`}
              sub={marketStats.maxShortCode}
            />
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
          </section>
        )}

        {/* Opening Analysis */}
        {hasNarrative && enhanced.narrative.openingHook && (
          <section className="border-l-2 border-border pl-5 md:pl-6">
            <h2 className="mb-3 font-serif text-2xl font-semibold tracking-tight">
              The Year in Short Selling
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

        {/* Top Stocks Table */}
        {displayTopStocks.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4">
              Top Shorted Stocks — Year End {slug}
            </h2>
            <TopStocksTable
              stocks={displayTopStocks}
              changeLabel="YoY"
              showChange
            />
          </section>
        )}

        {/* Biggest Risers */}
        {risers.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-red-500" />
              Year&apos;s Biggest Risers
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Stocks with the largest increase in short interest across {slug}.
            </p>
            <MoversTable movers={risers} type="risers" />
          </section>
        )}

        {/* Biggest Fallers */}
        {fallers.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-green-500" />
              Year&apos;s Biggest Fallers
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Stocks with the largest decrease in short interest across {slug}.
            </p>
            <MoversTable movers={fallers} type="fallers" />
          </section>
        )}

        {/* Movers Analysis */}
        {hasNarrative && enhanced.narrative.moversAnalysis && (
          <section className="border-l-2 border-border pl-5 md:pl-6">
            <h2 className="mb-3 font-serif text-2xl font-semibold tracking-tight">
              The Year&apos;s Biggest Stories
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
              <IndustryBreakdown industries={industryBreakdown} changeLabel="YoY" />
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
            <h2 className="mb-3 font-serif text-2xl font-semibold tracking-tight">
              Looking Ahead to {parseInt(slug) + 1}
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

        {/* Navigation back to reports */}
        <div className="flex justify-center pt-4">
          <Link
            href="/reports"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            <BarChart3 className="h-4 w-4" />
            View All Reports
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}
