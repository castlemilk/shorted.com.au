import { type Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowUpRight,
  ChevronRight,
  Sparkles,
  TrendingDown,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { getIndustryData } from "../actions/industry/getIndustryData";
import { getSectorImagePath, getSectorImageAlt } from "~/@/lib/sector-images";

export const metadata: Metadata = {
  title: "ASX Short Positions by Industry | Sector Analysis",
  description:
    "Explore short selling activity across ASX industry sectors. Compare short interest levels in Mining, Financials, Energy, Healthcare, Technology and more. Official ASIC data.",
  keywords: [
    "ASX industry short positions",
    "sector short selling",
    "most shorted industry ASX",
    "mining stocks short interest",
    "financial stocks short selling",
    "energy sector shorts",
    "ASX sector analysis",
    "industry short interest comparison",
  ],
  openGraph: {
    title: "ASX Short Positions by Industry | Sector Analysis",
    description:
      "Explore short selling activity across ASX industry sectors. Official ASIC data updated daily.",
    url: `${siteConfig.url}/industry`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Positions by Industry | Sector Analysis",
    description: "Explore short selling activity across ASX industry sectors.",
  },
  alternates: {
    canonical: `${siteConfig.url}/industry`,
  },
};

// Force dynamic rendering — this page requires a live backend for data
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Industries", url: `${siteConfig.url}/industry` },
];

export default async function IndustryIndexPage() {
  const industryData = await getIndustryData();
  const topIndustries = [...industryData]
    .sort((a, b) => b.avgShortPercent - a.avgShortPercent)
    .slice(0, 5);

  // CollectionPage + ItemList — exposes every industry/sector as a
  // structured child so crawlers can ingest the sector taxonomy.
  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "ASX Short Positions by Industry",
    description:
      "Short selling activity across ASX industry sectors. Aggregated short interest, ranked stock lists, and sector trends from official ASIC data.",
    url: "https://shorted.com.au/industry",
    isPartOf: {
      "@type": "WebSite",
      name: "Shorted",
      url: "https://shorted.com.au",
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: industryData.length,
      itemListElement: industryData.map((industry, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `https://shorted.com.au/industry/${industry.slug}`,
        name: `${industry.name} — ASX Short Positions`,
      })),
    },
  };

  return (
    <DashboardLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="space-y-8">
        {/* Hero Section */}
        <section className="overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.55fr)]">
            <div className="p-6 md:p-8">
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-primary/25 bg-primary/10 text-primary"
                >
                  Industry Intelligence
                </Badge>
                <Badge
                  variant="outline"
                  className="border-border/60 bg-background/70"
                >
                  ASIC daily T+4
                </Badge>
              </div>
              <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance md:text-5xl">
                Short Positions by Industry
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground text-pretty md:text-lg">
                Compare short-interest crowding across ASX sectors, then open
                the Industry Intelligence story to connect each sector with top
                stocks, source-ready public data modules, and premium alerts.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/industry-intelligence"
                  prefetch={false}
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Open Industry Intelligence
                  <ArrowUpRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  href="/top"
                  prefetch={false}
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-background px-5 py-2 text-sm font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Compare top shorts
                </Link>
              </div>
            </div>

            <div className="border-t border-border/60 bg-zinc-950 p-5 text-zinc-100 lg:border-l lg:border-t-0 md:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-300">
                    Live sector board
                  </p>
                  <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">
                    Highest average short interest
                  </h2>
                </div>
                <TrendingDown
                  className="h-5 w-5 text-amber-300"
                  aria-hidden="true"
                />
              </div>
              <div className="mt-5 overflow-hidden rounded-md border border-zinc-800">
                {topIndustries.map((industry, index) => (
                  <Link
                    key={industry.slug}
                    href={`/industry/${industry.slug}`}
                    className="grid grid-cols-[34px_minmax(0,1fr)_64px] items-center gap-3 border-b border-zinc-800 px-3 py-3 text-sm last:border-b-0 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/50"
                  >
                    <span className="font-mono text-xs text-zinc-500">
                      #{index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-white">
                        {industry.name}
                      </span>
                      <span className="block text-xs text-zinc-500">
                        {industry.stockCount} stocks tracked
                      </span>
                    </span>
                    <span className="text-right font-mono font-semibold tabular-nums text-amber-100">
                      {industry.avgShortPercent.toFixed(2)}%
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.45fr)]">
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-5 shadow-amber-sm">
            <div className="mb-3 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              New evidence story
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-balance">
              Turn any industry table into a cited sector story
            </h2>
            <p className="mt-3 max-w-[74ch] text-sm leading-6 text-muted-foreground text-pretty">
              Industry Intelligence keeps the live ASIC short-interest layer
              free, while premium evidence packs and alerts create the upgrade
              path for deeper monitoring.
            </p>
          </div>
          <Link
            href="/industry-intelligence"
            prefetch={false}
            className="group flex min-h-[150px] flex-col justify-between rounded-lg border border-border/60 bg-card/80 p-5 shadow-amber-sm transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Story route
              </div>
              <div className="mt-2 text-xl font-semibold tracking-tight group-hover:text-primary">
                Explore crowding, top stocks, evidence modules, and alerts
              </div>
            </div>
            <div className="mt-4 inline-flex items-center text-sm font-medium text-primary">
              Open the story
              <ChevronRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </div>
          </Link>
        </section>

        {/* Industry Grid */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Industry index
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Browse every sector
            </h2>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            Each card opens the canonical industry page with ranked top-shorted
            stocks and a shortcut back into the story view.
          </p>
        </div>
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {industryData.map((industry) => (
            <Link
              key={industry.slug}
              href={`/industry/${industry.slug}`}
              className="group"
            >
              <Card className="h-full hover:shadow-md transition-all duration-200 hover:border-primary/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="relative h-16 w-16 flex-shrink-0">
                        <Image
                          src={getSectorImagePath(industry.name)}
                          alt={getSectorImageAlt(industry.name)}
                          width={64}
                          height={64}
                          className="rounded-lg object-contain drop-shadow-sm"
                        />
                      </div>
                      <div>
                        <CardTitle className="text-lg group-hover:text-primary transition-colors">
                          {industry.name}
                        </CardTitle>
                        <CardDescription>
                          {industry.stockCount} stocks tracked
                        </CardDescription>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Avg Short %</span>
                      <Badge
                        variant={
                          industry.avgShortPercent > 10
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {industry.avgShortPercent.toFixed(2)}%
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Top Shorted</span>
                      <span className="font-medium">
                        {industry.topStock?.code ?? "N/A"}
                      </span>
                    </div>
                    {industry.topStock && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <TrendingDown className="h-3 w-3 text-red-500" />
                        <span>
                          {industry.topStock.code}:{" "}
                          {industry.topStock.shortPercent.toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </section>

        {/* SEO Content */}
        <section className="prose prose-sm dark:prose-invert max-w-none mt-12 pt-8 border-t border-border/40">
          <h2>Understanding Industry Short Positions</h2>
          <p>
            Short selling activity varies significantly across different
            industry sectors on the ASX. Understanding which industries are
            heavily shorted can provide valuable insights into market sentiment
            and potential opportunities.
          </p>
          <h3>High Short Interest Industries</h3>
          <p>
            Sectors like mining (especially lithium and rare earths),
            speculative technology, and retail often see higher short interest
            due to their volatile nature and sensitivity to commodity prices or
            consumer spending patterns.
          </p>
          <h3>Lower Short Interest Industries</h3>
          <p>
            Defensive sectors such as utilities, healthcare, and essential
            consumer staples typically maintain lower short interest levels due
            to their stable revenue streams and lower volatility.
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
