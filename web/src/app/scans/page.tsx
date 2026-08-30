import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { SCANS } from "~/@/lib/scans/registry";
import { getScanResults } from "~/app/actions/getScanResults";

export const metadata: Metadata = {
  title: "ASX Short Interest Scans — Rising Shorts, Covering & Squeeze Fuel",
  description:
    "Daily short-selling scans over every ASX stock: rising short interest, short covering, heavily shorted names, days-to-cover extremes and squeeze setups. Official ASIC data.",
  keywords: [
    "asx short interest scans",
    "short selling screener asx",
    "rising short interest",
    "short covering asx",
    "days to cover scan",
  ],
  openGraph: {
    title: "ASX Short Interest Scans | Shorted",
    description:
      "Daily short-selling scans: rising shorts, covering, heavily shorted names and squeeze setups.",
    url: `${siteConfig.url}/scans`,
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
    title: "ASX Short Interest Scans",
    description:
      "Daily short-selling scans over every ASX stock, from official ASIC data.",
  },
  alternates: {
    canonical: `${siteConfig.url}/scans`,
    languages: {
      "en-AU": `${siteConfig.url}/scans`,
      "x-default": `${siteConfig.url}/scans`,
    },
  },
};

// force-dynamic, matching /scans/[slug] for the same reason: the hub now
// reads the ASIC data date via getScanResults(), and the backend is
// unreachable at build time where skipForBuild() forces it to null. Under
// ISR that would bake a date-less shell that survived until the first
// successful revalidation. Rendering per-request always resolves a real
// date; getScanResults()'s own 1h unstable_cache (shared with the slug
// pages) means this adds no backend load.
export const dynamic = "force-dynamic";

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Scans", url: `${siteConfig.url}/scans` },
];

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

export default async function ScansIndexPage() {
  const scans = Object.values(SCANS);

  // One scan's results carry the ASIC data date for the whole set (all scans
  // read the same MV). Tolerates null — the freshness line is simply omitted.
  const firstSlug = scans[0]?.slug;
  const results = firstSlug ? await getScanResults(firstSlug) : null;
  const asOf = results ? formatAsOf(results.asOfDate) : "";

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <ItemListStructuredData
        name="ASX Short Interest Scans"
        description="Daily short-selling scans over every ASX stock, from official ASIC data."
        items={scans.map((scan) => ({
          name: scan.h1,
          url: `${siteConfig.url}/scans/${scan.slug}`,
          description: scan.dek,
        }))}
      />
      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={[{ label: "Scans", href: "/scans" }]} />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            Scans
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>
            ASX Short Interest Scans
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Fixed daily scans over every ASX stock&apos;s official ASIC short
            position: who&apos;s being shorted, who&apos;s being covered, and
            where the squeeze fuel sits. For a curated basket instead of a rule
            — lithium, uranium, the magnet stocks — browse{" "}
            <Link href="/themes" className="text-primary hover:underline">
              by theme
            </Link>
            ; for ad-hoc filters, use the{" "}
            <Link href="/screener" className="text-primary hover:underline">
              screener
            </Link>
            .
          </p>
          {asOf && (
            <p className="mt-3 text-sm text-muted-foreground">
              Short positions as of{" "}
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

        <section aria-label="Available scans">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {scans.map((scan) => (
              <Link
                key={scan.slug}
                href={`/scans/${scan.slug}`}
                prefetch={false}
                className="group block"
              >
                <article className="flex h-full flex-col rounded-lg border border-border/60 bg-card/50 p-5 transition-colors hover:border-primary/40">
                  <h2 className="font-semibold leading-snug transition-colors group-hover:text-primary">
                    {scan.h1}
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {scan.dek}
                  </p>
                </article>
              </Link>
            ))}
          </div>
        </section>

        <section className="border-t border-border/40 pt-6 text-sm text-muted-foreground">
          <p>
            All scans recompute daily from ASIC short position reports (T+4
            trading-day delay), equities only. See also:{" "}
            <Link href="/top" className="text-primary hover:underline">
              most shorted ASX stocks
            </Link>
            {" · "}
            <Link href="/battlegrounds" className="text-primary hover:underline">
              short squeeze candidates
            </Link>
            {" · "}
            <Link href="/statistics" className="text-primary hover:underline">
              market-wide statistics
            </Link>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
