import { type Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Calendar } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Card, CardContent } from "~/@/components/ui/card";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { StockLogo } from "~/@/components/reports/stock-logo";
import {
  getAvailableWeekSlugs,
  getAvailableMonthSlugs,
  getAvailableYearSlugs,
  getReportsList,
  type ReportListEntry,
} from "~/app/actions/reports/getReportData";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";

export const metadata: Metadata = {
  title: "ASX Short Selling Reports — Weekly & Monthly",
  description:
    "Weekly and monthly reports on ASX short selling activity. See top movers, industry trends, and aggregate short interest from official ASIC data.",
  keywords: [
    "ASX short selling reports",
    "weekly short interest report",
    "monthly short selling analysis",
    "ASIC short position reports",
    "Australian stock market reports",
  ],
  openGraph: {
    title: "ASX Short Selling Reports | Weekly & Monthly Analysis",
    description: "Weekly and monthly reports on ASX short selling activity.",
    url: `${siteConfig.url}/reports`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "ASX Short Selling Reports - Weekly & Monthly Analysis",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Selling Reports | Weekly & Monthly Analysis",
    description: "Weekly and monthly reports on ASX short selling activity.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/reports`,
  },
};

export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Reports", url: `${siteConfig.url}/reports` },
];

function formatWeekSlug(slug: string): string {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return slug;
  return `Week ${parseInt(match[2])}, ${match[1]}`;
}

function formatMonthSlug(slug: string): string {
  const date = new Date(`${slug}-01T00:00:00`);
  return date.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

function formatPeriod(report: ReportListEntry): string {
  if (report.reportType === "weekly") return formatWeekSlug(report.slug);
  if (report.reportType === "monthly") return formatMonthSlug(report.slug);
  return `${report.slug} Year in Review`;
}

function reportHref(report: ReportListEntry): string {
  // Weekly reports link to their canonical query-matching path
  // ("10-most-shorted-asx-stocks-week-N-YYYY"); the ISO form 301s there.
  if (report.reportType === "weekly") return weeklyReportPath(report.slug);
  return `/reports/${report.reportType}/${report.slug}`;
}

function formatReportDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const date = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Citation markers ([ref-N]/[report-N]) from the grounding pipeline must not
// leak into archive cards.
function stripCitationMarkers(text: string): string {
  return text
    .replace(/\[(?:ref|report)-\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function LogoCluster({
  report,
  max = 3,
}: {
  report: ReportListEntry;
  max?: number;
}) {
  const codes = report.topCodes.slice(0, max);
  if (codes.length === 0) return null;
  return (
    <span className="flex -space-x-1.5">
      {codes.map((code, i) => (
        <StockLogo
          key={code}
          code={code}
          logoUrl={report.topLogoUrls[i]}
          size="sm"
          className="rounded-full ring-2 ring-background"
        />
      ))}
    </span>
  );
}

function MaxShortChip({ report }: { report: ReportListEntry }) {
  if (!report.maxShortCode || report.maxShortPct <= 0) return null;
  return (
    <span className="inline-flex items-baseline gap-1 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className="relative top-[-1px] inline-block h-1.5 w-1.5 rounded-full bg-red-500"
      />
      <span className="font-semibold tabular-nums text-foreground">
        {report.maxShortPct.toFixed(1)}%
      </span>
      {report.maxShortCode}
    </span>
  );
}

function FeaturedReportCard({ report }: { report: ReportListEntry }) {
  const summary = stripCitationMarkers(report.summary);
  const date = formatReportDate(report.reportDate);
  return (
    <Link href={reportHref(report)} prefetch={false} className="group block">
      <article className="rounded-lg border border-border/60 bg-card/50 p-6 transition-colors hover:border-primary/40 md:p-8">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Latest weekly report · {formatPeriod(report)}
          {date ? ` · ${date}` : ""}
        </p>
        <h2 className="max-w-3xl font-serif text-2xl font-semibold leading-[1.1] tracking-tight transition-colors group-hover:text-primary md:text-3xl">
          {report.headline || `Weekly Short Selling Report — ${formatPeriod(report)}`}
        </h2>
        {summary && (
          <p className="mt-3 line-clamp-3 max-w-3xl font-serif text-base leading-relaxed text-muted-foreground">
            {summary}
          </p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          {report.topCodes.length > 0 && (
            <span className="flex items-center gap-2">
              <LogoCluster report={report} max={5} />
              <span className="text-xs text-muted-foreground">
                {report.topCodes.slice(0, 3).join(" · ")}
              </span>
            </span>
          )}
          <MaxShortChip report={report} />
          {report.totalStocksShorted > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">
                {report.totalStocksShorted}
              </span>{" "}
              stocks shorted
            </span>
          )}
          <span className="ml-auto hidden items-center gap-1 text-sm font-medium text-primary sm:inline-flex">
            Read report
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </article>
    </Link>
  );
}

function ReportCard({ report }: { report: ReportListEntry }) {
  return (
    <Link href={reportHref(report)} prefetch={false} className="group block h-full">
      <article className="flex h-full flex-col rounded-lg border border-border/60 bg-card/50 p-4 transition-colors hover:border-primary/40">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {formatPeriod(report)}
        </p>
        <h3 className="mt-1.5 line-clamp-2 text-sm font-semibold leading-snug transition-colors group-hover:text-primary">
          {report.headline || `${formatPeriod(report)} short selling report`}
        </h3>
        <div className="mt-auto flex items-center justify-between gap-3 pt-3">
          <LogoCluster report={report} />
          <MaxShortChip report={report} />
        </div>
      </article>
    </Link>
  );
}

function SlugCardGrid({
  slugs,
  hrefPrefix,
  formatLabel,
  hrefFor,
}: {
  slugs: string[];
  hrefPrefix: string;
  formatLabel: (slug: string) => string;
  /** Canonical-path builder override (weekly slugs don't join onto the prefix). */
  hrefFor?: (slug: string) => string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
      {slugs.map((slug) => (
        <Link
          key={slug}
          href={hrefFor ? hrefFor(slug) : `${hrefPrefix}/${slug}`}
          prefetch={false}
          className="group"
        >
          <Card className="hover:border-primary/50 transition-colors h-full">
            <CardContent className="pt-4 pb-4 flex items-center justify-between">
              <p className="font-semibold group-hover:text-primary transition-colors">
                {formatLabel(slug)}
              </p>
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function ReportSection({
  title,
  reports,
  fallbackSlugs,
  hrefPrefix,
  formatLabel,
  maxItems,
  footnote,
  hrefFor,
}: {
  title: string;
  reports: ReportListEntry[];
  fallbackSlugs: string[];
  hrefPrefix: string;
  formatLabel: (slug: string) => string;
  maxItems: number;
  footnote?: string;
  hrefFor?: (slug: string) => string;
}) {
  const items = reports.slice(0, maxItems);
  const slugs = fallbackSlugs.slice(0, maxItems);
  if (items.length === 0 && slugs.length === 0) return null;
  return (
    <section>
      <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
        <Calendar className="h-5 w-5 text-primary" />
        {title}
      </h2>
      {items.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {items.map((report) => (
            <ReportCard key={`${report.reportType}-${report.slug}`} report={report} />
          ))}
        </div>
      ) : (
        <SlugCardGrid
          slugs={slugs}
          hrefPrefix={hrefPrefix}
          formatLabel={formatLabel}
          hrefFor={hrefFor}
        />
      )}
      {footnote && (
        <p className="text-sm text-muted-foreground mt-3">{footnote}</p>
      )}
    </section>
  );
}

export default async function ReportsIndexPage() {
  const [reports, weekSlugs, monthSlugs, yearSlugs] = await Promise.all([
    getReportsList("", 60),
    getAvailableWeekSlugs(),
    getAvailableMonthSlugs(),
    getAvailableYearSlugs(),
  ]);

  const weekly = reports.filter((r) => r.reportType === "weekly");
  const monthly = reports.filter((r) => r.reportType === "monthly");
  const yearly = reports.filter((r) => r.reportType === "yearly");

  const featured = weekly[0];
  const remainingWeekly = featured ? weekly.slice(1) : weekly;

  const breadcrumbItems = [{ label: "Reports", href: "/reports" }];

  // ItemList + CollectionPage schema — gives Google the full inventory
  // of report URLs so the report archive is indexable as a series.
  // Built from the real published-report list when available; falls back
  // to date-derived slugs when the archive RPC is unavailable.
  const itemListElement =
    reports.length > 0
      ? reports.slice(0, 40).map((report, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: `https://shorted.com.au${reportHref(report)}`,
          name:
            report.headline ||
            `${report.reportType.charAt(0).toUpperCase()}${report.reportType.slice(1)} Short Selling Report ${report.slug}`,
        }))
      : [
          ...weekSlugs.slice(0, 20).map((slug, i) => ({
            "@type": "ListItem",
            position: i + 1,
            // Canonical path — the ISO form 301s.
            url: `https://shorted.com.au${weeklyReportPath(slug)}`,
            name: `Weekly Short Selling Report ${slug}`,
          })),
          ...monthSlugs.slice(0, 12).map((slug, i) => ({
            "@type": "ListItem",
            position: 100 + i,
            url: `https://shorted.com.au/reports/monthly/${slug}`,
            name: `Monthly Short Selling Report ${slug}`,
          })),
          ...yearSlugs.slice(0, 10).map((slug, i) => ({
            "@type": "ListItem",
            position: 200 + i,
            url: `https://shorted.com.au/reports/yearly/${slug}`,
            name: `Annual Short Selling Report ${slug}`,
          })),
        ];

  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "ASX Short Selling Reports",
    description:
      "Archive of weekly, monthly, and yearly ASX short selling reports with LLM-narrated analysis.",
    url: "https://shorted.com.au/reports",
    isPartOf: {
      "@type": "WebSite",
      name: "Shorted",
      url: "https://shorted.com.au",
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems:
        reports.length > 0
          ? reports.length
          : weekSlugs.length + monthSlugs.length + yearSlugs.length,
      itemListElement,
    },
  };

  return (
    <DashboardLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />
      <BreadcrumbListSchema items={breadcrumbs} />
      <LLMMeta
        title="ASX Short Selling Reports - Weekly & Monthly Analysis"
        description="Weekly and monthly reports on ASX short selling activity. See top movers, industry trends, and aggregate short interest from official ASIC data."
        keywords={[
          "ASX short selling reports",
          "weekly short interest report",
          "monthly short selling analysis",
          "ASIC short position reports",
        ]}
        dataSource="ASIC"
        dataFrequency="weekly"
      />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Reports
          </p>
          <h1 className="font-serif text-3xl font-semibold leading-[1.1] tracking-tight md:text-4xl">
            ASX Short Selling Reports
          </h1>
          <p className="text-muted-foreground mt-2">
            Weekly and monthly analysis of ASX short selling activity, from
            official ASIC data.
          </p>
        </section>

        {/* Featured latest weekly report */}
        {featured && <FeaturedReportCard report={featured} />}

        <ReportSection
          title="Weekly Reports"
          reports={remainingWeekly}
          fallbackSlugs={weekSlugs}
          hrefPrefix="/reports/weekly"
          formatLabel={formatWeekSlug}
          hrefFor={weeklyReportPath}
          maxItems={12}
          footnote={
            remainingWeekly.length > 12 || weekSlugs.length > 12
              ? "Showing latest 12 weeks. Older reports available via direct URL."
              : undefined
          }
        />

        <ReportSection
          title="Year in Review"
          reports={yearly}
          fallbackSlugs={yearSlugs}
          hrefPrefix="/reports/yearly"
          formatLabel={(slug) => `${slug} Year in Review`}
          maxItems={6}
        />

        <ReportSection
          title="Monthly Reports"
          reports={monthly}
          fallbackSlugs={monthSlugs}
          hrefPrefix="/reports/monthly"
          formatLabel={formatMonthSlug}
          maxItems={12}
          footnote={
            monthly.length > 12 || monthSlugs.length > 12
              ? "Showing latest 12 months. Older reports available via direct URL."
              : undefined
          }
        />
      </div>
    </DashboardLayout>
  );
}
