import { type Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle, eyebrow } from "~/@/lib/typography";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { StockLogo } from "~/@/components/reports/stock-logo";
import {
  getReportsList,
  type ReportListEntry,
} from "~/app/actions/reports/getReportData";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";
import { WEEKLY_ARCHIVE_LIMIT } from "~/@/components/reports/week-navigation";

/**
 * /reports/weekly — the weekly series archive.
 *
 * Why it exists: ~200 weekly reports are published, but /reports only surfaces
 * the latest 12 ("Older reports available via direct URL"). Everything beyond
 * that was orphaned — no crawlable path from anywhere on the site — and
 * /reports/weekly itself 404'd. This page is the series hub: every published
 * week, one dated descriptive anchor each.
 */

export const metadata: Metadata = {
  title: {
    absolute:
      "Weekly ASX Short Selling Reports — The 10 Most Shorted Stocks, Every Week | Shorted",
  },
  description:
    "Every weekly report on the 10 most shorted ASX stocks, from official ASIC short position data. Browse the full archive by week — top shorted stocks, biggest risers and fallers, and industry analysis.",
  keywords: [
    "weekly ASX short selling report",
    "10 most shorted ASX stocks",
    "most shorted ASX stocks this week",
    "ASX short interest weekly",
    "weekly short position report archive",
    "ASIC short position reports",
  ],
  openGraph: {
    title: "Weekly ASX Short Selling Reports — The 10 Most Shorted Stocks",
    description:
      "The full archive of weekly reports on the 10 most shorted ASX stocks, from official ASIC data.",
    url: `${siteConfig.url}/reports/weekly`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Weekly ASX Short Selling Reports",
      },
    ],
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Weekly ASX Short Selling Reports — The 10 Most Shorted Stocks",
    description:
      "The full archive of weekly reports on the 10 most shorted ASX stocks.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/reports/weekly`,
    languages: {
      "en-AU": `${siteConfig.url}/reports/weekly`,
      "x-default": `${siteConfig.url}/reports/weekly`,
    },
  },
};

// ISR, matching /reports. getReportsList is unstable_cache-backed with an
// explicit revalidate, so nothing here bails the route to dynamic.
export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Reports", url: `${siteConfig.url}/reports` },
  { name: "Weekly Reports", url: `${siteConfig.url}/reports/weekly` },
];

function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;
  return { year: parseInt(match[1], 10), week: parseInt(match[2], 10) };
}

function formatWeekTitle(slug: string): string {
  const parsed = parseWeekSlug(slug);
  if (!parsed) return slug;
  return `Week ${parsed.week}, ${parsed.year}`;
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
// leak into archive copy.
function stripCitationMarkers(text: string): string {
  return text
    .replace(/\[(?:ref|report)-\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function LogoCluster({ report, max = 4 }: { report: ReportListEntry; max?: number }) {
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

function WeekRow({ report }: { report: ReportListEntry }) {
  const weekTitle = formatWeekTitle(report.slug);
  const date = formatReportDate(report.reportDate);
  const summary = stripCitationMarkers(report.summary ?? "");
  return (
    <li>
      <Link
        href={weeklyReportPath(report.slug)}
        prefetch={false}
        className="group flex items-start justify-between gap-4 border-b border-border/40 py-4 transition-colors hover:bg-muted/30"
      >
        <div className="min-w-0">
          {/* Descriptive dated anchor — the phrasing the weekly SERP uses. */}
          <p className="text-sm font-semibold transition-colors group-hover:text-primary">
            The 10 most shorted ASX stocks — {weekTitle}
          </p>
          {report.headline && (
            <p className="mt-0.5 line-clamp-1 font-serif text-sm text-muted-foreground">
              {report.headline}
            </p>
          )}
          {!report.headline && summary && (
            <p className="mt-0.5 line-clamp-1 font-serif text-sm text-muted-foreground">
              {summary}
            </p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            {date && <span>{date}</span>}
            {report.maxShortCode && report.maxShortPct > 0 && (
              <span>
                Most shorted:{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {report.maxShortCode} {report.maxShortPct.toFixed(1)}%
                </span>
              </span>
            )}
            {report.totalStocksShorted > 0 && (
              <span className="tabular-nums">
                {report.totalStocksShorted} stocks shorted
              </span>
            )}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-3 pt-0.5">
          <span className="hidden sm:flex">
            <LogoCluster report={report} />
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
        </span>
      </Link>
    </li>
  );
}

export default async function WeeklyReportsIndexPage() {
  // Same limit as the report page's neighbour fetch, so both share one
  // cached ListReports result. The backend caps at 100 (≈ two years of
  // weeks); anything older stays reachable by direct URL.
  const reports = await getReportsList("weekly", WEEKLY_ARCHIVE_LIMIT);

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: "Weekly", href: "/reports/weekly" },
  ];

  // Group by year so the archive stays navigable as it grows.
  const byYear = new Map<number, ReportListEntry[]>();
  for (const report of reports) {
    const parsed = parseWeekSlug(report.slug);
    if (!parsed) continue;
    const bucket = byYear.get(parsed.year);
    if (bucket) bucket.push(report);
    else byYear.set(parsed.year, [report]);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  for (const year of years) {
    byYear
      .get(year)!
      .sort(
        (a, b) =>
          (parseWeekSlug(b.slug)?.week ?? 0) - (parseWeekSlug(a.slug)?.week ?? 0),
      );
  }

  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Weekly ASX Short Selling Reports",
    description:
      "Archive of weekly reports on the 10 most shorted ASX stocks, from official ASIC short position data.",
    url: `${siteConfig.url}/reports/weekly`,
    isPartOf: {
      "@type": "WebSite",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: reports.length,
      itemListElement: reports.slice(0, 100).map((report, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${siteConfig.url}${weeklyReportPath(report.slug)}`,
        name:
          report.headline ||
          `The 10 Most Shorted ASX Stocks — ${formatWeekTitle(report.slug)}`,
      })),
    },
  };

  return (
    <DashboardLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionSchema) }}
      />
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <section className="border-b border-border/40 pb-8">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Weekly series</p>
          <h1 className={pageTitle}>
            The 10 Most Shorted ASX Stocks — Weekly Reports
          </h1>
          <p className="mt-2 max-w-prose text-muted-foreground">
            Every week we rank the 10 most shorted stocks on the ASX from
            official ASIC short position data, alongside the biggest risers and
            fallers in short interest and how positioning shifted by industry.
            The full archive is below.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Prefer the live rankings?{" "}
            <Link href="/top" className="text-primary hover:underline">
              Most shorted ASX stocks
            </Link>{" "}
            updates daily. Monthly and annual reviews are on the{" "}
            <Link href="/reports" className="text-primary hover:underline">
              reports index
            </Link>
            .
          </p>
        </section>

        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The weekly report archive is temporarily unavailable. Browse the{" "}
            <Link href="/reports" className="text-primary hover:underline">
              reports index
            </Link>{" "}
            instead.
          </p>
        ) : (
          years.map((year) => (
            <section key={year}>
              <h2 className={cn(sectionTitle, "mb-2")}>{year}</h2>
              <ul className="border-t border-border/40">
                {byYear.get(year)!.map((report) => (
                  <WeekRow key={report.slug} report={report} />
                ))}
              </ul>
            </section>
          ))
        )}

        <section className="border-t border-border/40 pt-4 text-xs text-muted-foreground">
          <p>
            Data sourced from ASIC short position reports (T+4 delayed). For
            informational purposes only; not financial advice. See our{" "}
            <Link href="/methodology" className="underline hover:no-underline">
              methodology
            </Link>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
