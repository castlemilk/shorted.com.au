import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { SCANS } from "~/@/lib/scans/registry";

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
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "ASX Short Interest Scans",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Interest Scans",
    description:
      "Daily short-selling scans over every ASX stock, from official ASIC data.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/scans`,
    languages: {
      "en-AU": `${siteConfig.url}/scans`,
      "x-default": `${siteConfig.url}/scans`,
    },
  },
};

export const revalidate = 86400;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Scans", url: `${siteConfig.url}/scans` },
];

export default function ScansIndexPage() {
  const scans = Object.values(SCANS);
  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
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
            where the squeeze fuel sits. For ad-hoc filters, use the{" "}
            <Link href="/screener" className="text-primary hover:underline">
              screener
            </Link>
            .
          </p>
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
