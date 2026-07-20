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
import { getScan, SCANS, SCAN_SLUGS } from "~/@/lib/scans/registry";
import { getScanResults } from "~/app/actions/getScanResults";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// NOTE: no loading.tsx anywhere on this route on purpose — without a
// streaming boundary the page resolves before the response commits, so
// notFound() below yields a real HTTP 404 for unknown scan slugs.
// ISR at 15min: deploys prerender the no-data shell (skipForBuild) and a
// short page TTL caps how long it serves; the data layer stays 1h-cached.
export const revalidate = 900;
export const dynamicParams = true;

export function generateStaticParams() {
  return SCAN_SLUGS.map((slug) => ({ slug }));
}

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
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: scan.h1,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: scan.title,
      description: scan.description,
      images: [siteConfig.ogImage],
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

function formatPrice(v: number): string {
  if (v <= 0) return "—";
  return v >= 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(3).replace(/0$/, "")}`;
}

function DeltaCell({ value, suffix }: { value: number; suffix: string }) {
  if (!Number.isFinite(value) || value === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={
        value > 0
          ? "font-medium text-red-500"
          : "font-medium text-emerald-500"
      }
    >
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}
      {suffix}
    </span>
  );
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
            <div className="overflow-x-auto rounded-lg border border-border/60">
              <table className="w-full text-sm">
                <caption className="sr-only">{scan.h1}</caption>
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">
                      Company
                    </th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">
                      Industry
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Short %</th>
                    <th className="px-3 py-2 text-right font-medium">Δ 4w</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                      Price
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Δ 1m</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Days to cover
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.code}>
                      <td className="px-3 py-2 font-semibold">
                        <Link
                          href={`/shorts/${r.code}`}
                          className="text-primary hover:underline"
                        >
                          {r.code}
                        </Link>
                      </td>
                      <td className="hidden max-w-[220px] truncate px-3 py-2 text-muted-foreground sm:table-cell">
                        {r.name}
                      </td>
                      <td className="hidden max-w-[180px] truncate px-3 py-2 text-muted-foreground md:table-cell">
                        {r.industry}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.shortPct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <DeltaCell value={r.shortPctChange4w} suffix="pp" />
                      </td>
                      <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                        {formatPrice(r.latestPrice)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <DeltaCell value={r.priceChange1m} suffix="%" />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.daysToCover > 0 ? r.daysToCover.toFixed(1) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
