import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import { Suspense } from "react";
import Link from "next/link";
import { Building2, ChevronRight } from "lucide-react";
import { CompanyDirectory } from "~/app/stocks/components/company-directory";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
} from "~/@/components/ui/card";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";

export const metadata: Metadata = {
  title: "ASX Stock Directory | All Australian Listed Companies",
  description:
    "Browse all Australian Securities Exchange (ASX) listed companies tracked by Shorted. A-Z directory of stocks with current short position data from official ASIC reports.",
  keywords: [
    "ASX stock directory",
    "Australian listed companies",
    "ASX company list",
    "Australian stocks A to Z",
    "ASX short positions directory",
  ],
  openGraph: {
    title: "ASX Stock Directory | All Australian Listed Companies",
    description:
      "Browse all ASX listed companies tracked by Shorted. A-Z directory with short position data.",
    url: `${siteConfig.url}/directory`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "ASX Stock Directory | All Australian Listed Companies",
    description: "Browse all ASX listed companies tracked by Shorted.",
  },
  alternates: {
    canonical: `${siteConfig.url}/directory`,
  },
};

export const revalidate = 300; // Short window: the build prerender is an empty shell (see [letter]/page.tsx)

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Directory", url: `${siteConfig.url}/directory` },
];

export default function DirectoryPage() {
  const breadcrumbItems = [
    { label: "Directory", href: "/directory" },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="space-y-8">
        {/* Breadcrumbs */}
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <Building2 className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className={pageTitle}>
                ASX Stock Directory
              </h1>
              <p className="text-muted-foreground mt-1">
                Browse all Australian listed companies with short position data
              </p>
            </div>
          </div>
        </section>

        {/* A-Z Letter Grid */}
        <section>
          <h2 className="text-xl font-semibold mb-4">Browse by Letter</h2>
          <div className="grid grid-cols-6 sm:grid-cols-9 md:grid-cols-13 gap-2">
            {LETTERS.map((letter) => (
              <Link
                key={letter}
                href={`/directory/${letter.toLowerCase()}`}
                className="flex items-center justify-center h-12 w-full rounded-lg border border-border bg-card hover:bg-primary/10 hover:border-primary/50 transition-colors text-lg font-bold"
              >
                {letter}
              </Link>
            ))}
          </div>
        </section>

        {/* Browsable company list — the page previously rendered ONLY the
            letter grid, which read as "nothing loads". Server-rendered top
            companies with logos (same component as /stocks). */}
        <Suspense fallback={<div className="h-64 animate-pulse rounded bg-muted" />}>
          <CompanyDirectory />
        </Suspense>

        {/* Info Section */}
        <section className="mt-12 pt-8 border-t border-border/40">
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-lg">
                    Looking for most shorted stocks?
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    See which ASX stocks have the highest short interest right now.
                  </p>
                </div>
                <Link
                  href="/top"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  View Top Shorted Stocks
                  <ChevronRight className="ml-2 h-4 w-4" />
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </DashboardLayout>
  );
}
