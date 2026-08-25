import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import Link from "next/link";
import { notFound } from "next/navigation";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  DatasetStructuredData,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { getScan, SCANS } from "~/@/lib/scans/registry";
import { getScanResults } from "~/app/actions/getScanResults";
import { ShortInterestTable } from "~/@/components/shorts/short-interest-table";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// NOTE: no loading.tsx anywhere on this route on purpose — without a
// streaming boundary the page resolves before the response commits, so
// notFound() below yields a real HTTP 404 for unknown scan slugs.
//
// force-dynamic (matching /market/[date] and /reports/weekly/[slug]): the
// backend is unreachable at build time, where skipForBuild() forces
// getScanResults() → null. Static prerendering therefore baked a
// "Scan data is temporarily unavailable" shell into every scan page that was
// served until the first *successful* ISR revalidation — i.e. the first
// visitor after each deploy saw an empty page. Rendering per-request instead
// always fetches real data at runtime (skipForBuild() is false off the build
// phase); getScanResults()'s own 1h unstable_cache keeps the DB cost down.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const scan = getScan(slug);
  if (!scan) {
    notFound();
  }
  const url = `${siteConfig.url}/scans/${scan.slug}`;
  return {
    title: scan.title,
    description: scan.description,
    keywords: scan.keywords,
    openGraph: {
      title: `${scan.title} | ${siteConfig.name}`,
      description: scan.description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      // No `images` key: this route ships its own opengraph-image.tsx and an
      // explicit `images` here would SHADOW the file convention.
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: scan.title,
      description: scan.description,
    },
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
  };
}

function formatAsOf(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default async function ScanPage({ params }: PageProps) {
  const { slug } = await params;
  const scan = getScan(slug);
  if (!scan) {
    notFound();
  }

  const results = await getScanResults(scan.slug);
  const rows = results?.rows ?? [];
  const asOf = results ? formatAsOf(results.asOfDate) : "";

  const breadcrumbItems = [
    { label: "Scans", href: "/scans" },
    { label: scan.h1, href: `/scans/${scan.slug}` },
  ];
  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Scans", url: `${siteConfig.url}/scans` },
    { name: scan.h1, url: `${siteConfig.url}/scans/${scan.slug}` },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <DatasetStructuredData
        datasetInfo={{
          name: scan.h1,
          description: scan.description,
          url: `${siteConfig.url}/scans/${slug}`,
          dateModified: results?.asOfDate,
        }}
      />
      {rows.length > 0 && (
        <ItemListStructuredData
          name={scan.h1}
          description={scan.description}
          items={rows.slice(0, 10).map((r) => ({
            name: `${r.code} - ${r.name}`,
            url: `${siteConfig.url}/shorts/${r.code}`,
            description: `${r.shortPct.toFixed(2)}% short interest, ${
              r.shortPctChange4w > 0 ? "+" : ""
            }${r.shortPctChange4w.toFixed(2)}pp over 4 weeks`,
          }))}
        />
      )}

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href="/scans" className="hover:text-foreground">
              Short interest scans
            </Link>
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>
            {scan.h1}
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">{scan.dek}</p>
          {asOf && (
            <p className="mt-3 text-sm text-muted-foreground">
              {results!.totalCount} matching stocks · short positions as of{" "}
              <time
                dateTime={results!.asOfDate}
                className="font-medium text-foreground"
              >
                {asOf}
              </time>{" "}
              · ASIC data, T+4 delay
            </p>
          )}
        </section>

        {rows.length > 0 ? (
          <section aria-label={`${scan.h1} results`}>
            <ShortInterestTable rows={rows} caption={scan.h1} />
            {results!.totalCount > rows.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing top {rows.length} of {results!.totalCount} matches —
                refine further in the{" "}
                <Link href="/screener" className="text-primary hover:underline">
                  screener
                </Link>
                .
              </p>
            )}
          </section>
        ) : (
          <section className="rounded-lg border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">
            {results
              ? "No stocks currently match this scan — check back after the next ASIC data drop."
              : "Scan data is temporarily unavailable; it refreshes automatically."}
          </section>
        )}

        <section
          id="about"
          aria-labelledby="about-heading"
          className="max-w-3xl space-y-3"
        >
          <h2 id="about-heading" className="text-lg font-semibold">
            About this scan
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {scan.blurb}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            All inputs come from official ASIC short position reports
            (published with a T+4 trading-day delay) joined with daily price
            and volume data; the scan is recomputed every trading day.
            Equities only — ETFs and debt securities are excluded.
          </p>
        </section>

        <section
          aria-labelledby="related-heading"
          className="border-t border-border/40 pt-6"
        >
          <h2
            id="related-heading"
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Related
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {scan.related.map((relSlug) => {
              const rel = SCANS[relSlug];
              if (!rel) return null;
              return (
                <li key={relSlug}>
                  <Link
                    href={`/scans/${rel.slug}`}
                    className="text-primary hover:underline"
                  >
                    {rel.h1}
                  </Link>
                </li>
              );
            })}
            <li>
              <Link href="/themes" className="text-primary hover:underline">
                Browse by theme
              </Link>
            </li>
            <li>
              <Link href="/top" className="text-primary hover:underline">
                Most shorted ASX stocks
              </Link>
            </li>
            <li>
              <Link
                href="/battlegrounds"
                className="text-primary hover:underline"
              >
                Short squeeze candidates
              </Link>
            </li>
            <li>
              <Link href="/statistics" className="text-primary hover:underline">
                ASX short selling statistics
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </DashboardLayout>
  );
}
