import { type Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import {
  TrendingUp,
  TrendingDown,
  Building2,
  ChevronRight,
  BarChart3,
  Clock,
  Sparkles,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import { IndustrySignalPanel } from "~/@/components/industry/industry-signal-panel";
import { RelatedThemesForIndustry } from "~/@/components/themes/theme-chips";
import {
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  getIndustryStocks,
  getIndustryData,
  getAllIndustrySlugs,
} from "../../actions/industry/getIndustryData";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import {
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { getSectorImagePath, getSectorImageAlt } from "~/@/lib/sector-images";
import { buildIndustryIntelligenceStory } from "~/@/lib/industry-intelligence";
import { buildIndustryNarrative } from "./industry-narrative";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  let industry: Awaited<ReturnType<typeof getIndustryStocks>>["industry"];
  let reason: Awaited<ReturnType<typeof getIndustryStocks>>["reason"];
  try {
    // getIndustryStocks is React-cached, so this shares the page's fetch (and
    // its ISR-safe `next: { revalidate }` cache mode) rather than adding one.
    const result = await getIndustryStocks(slug);
    industry = result.industry;
    reason = result.reason;
  } catch {
    industry = null;
    reason = "unavailable";
  }

  if (!industry) {
    return {
      title: "Industry Short Positions",
      // An unknown slug renders a 200 shell — noindex the soft-404. Never
      // noindex on "unavailable": a degraded regen must not deindex a real
      // industry page (the directive would stick until the next revalidate).
      ...(reason === "unknown-slug"
        ? { robots: { index: false, follow: false } }
        : {}),
    };
  }

  const title = `Most Shorted ${industry.name} Stocks ASX | ${industry.stockCount} Tracked`;

  // Lead the description with the leader and its number — the strongest
  // snippet for "most shorted {sector} stocks asx" — and only include stats
  // that actually exist, so a degraded feed never yields "0.00%" copy.
  const descriptionParts: string[] = [];
  if (industry.topStock && industry.topStock.shortPercent > 0) {
    descriptionParts.push(
      `${industry.topStock.code} leads the most shorted ${industry.name.toLowerCase()} stocks on the ASX at ${industry.topStock.shortPercent.toFixed(2)}% of shares on issue.`,
    );
  } else {
    descriptionParts.push(
      `The most shorted ${industry.name.toLowerCase()} stocks on the ASX, ranked by short interest.`,
    );
  }
  if (industry.stockCount > 0) {
    descriptionParts.push(
      industry.avgShortPercent > 0
        ? `${industry.stockCount} stocks tracked, averaging ${industry.avgShortPercent.toFixed(2)}% short interest.`
        : `${industry.stockCount} stocks tracked.`,
    );
  }
  descriptionParts.push("Official ASIC data, published T+4.");
  const description = descriptionParts.join(" ");

  return {
    title,
    description,
    keywords: [
      `most shorted ${industry.name.toLowerCase()} stocks`,
      `${industry.name.toLowerCase()} short interest ASX`,
      `${industry.name.toLowerCase()} sector shorts`,
      `ASX ${industry.name.toLowerCase()} short selling`,
      `bearish ${industry.name.toLowerCase()} stocks Australia`,
      "ASIC short position data",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/industry/${slug}`,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/industry/${slug}`,
    },
  };
}

// Generate static pages for all industries
// Falls back to on-demand generation if API is unavailable (e.g., during CI builds)
export async function generateStaticParams() {
  // Skip static generation during local builds (pre-commit hook sets this)
  if (process.env.SKIP_STATIC_GENERATION === "1") {
    return [];
  }
  try {
    const slugs = await getAllIndustrySlugs();
    return slugs.map((slug) => ({ slug }));
  } catch (error) {
    console.warn("Failed to fetch industry slugs for static generation, pages will be generated on-demand:", error);
    return [];
  }
}

// Revalidate every hour
export const revalidate = 3600;

export default async function IndustryPage({ params }: PageProps) {
  const { slug } = await params;
  const [{ industry, stocks }, allIndustries] = await Promise.all([
    getIndustryStocks(slug),
    getIndustryData(),
  ]);

  if (!industry) {
    // During build or when API is unavailable, render minimal page for ISR
    return (
      <DashboardLayout>
        <div className="space-y-8">
          <section className="relative border-b border-border/40 pb-8">
            <div className="flex items-start gap-5 mb-4">
              <div className="relative h-20 w-20 md:h-28 md:w-28 flex-shrink-0">
                <Image
                  src={getSectorImagePath("other")}
                  alt="Industry sector icon"
                  width={112}
                  height={112}
                  className="rounded-xl object-contain drop-shadow-md opacity-50"
                />
              </div>
              <div className="pt-1">
                <h1 className={pageTitle}>
                  Industry Short Positions
                </h1>
                <p className="text-muted-foreground mt-1">
                  Loading industry data...
                </p>
              </div>
            </div>
          </section>
        </div>
      </DashboardLayout>
    );
  }

  // Find related industries (sorted by avg short %, exclude current)
  const relatedIndustries = allIndustries
    .filter((i) => i.slug !== slug)
    .sort((a, b) => b.avgShortPercent - a.avgShortPercent)
    .slice(0, 8);

  const breadcrumbItems = [
    { label: "Industries", href: "/industry" },
    { label: industry.name, href: `/industry/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Industries", url: `${siteConfig.url}/industry` },
    { name: industry.name, url: `${siteConfig.url}/industry/${slug}` },
  ];

  // Calculate stats
  const highlyShorted = stocks.filter((s) => s.shortPercent > 10).length;
  const increasing = stocks.filter((s) => (s.change ?? 0) > 0).length;
  // Server-rendered narrative summary. Pure function over data already
  // fetched above; returns null when there is nothing truthful to say.
  const narrative = buildIndustryNarrative({ industry, stocks });
  const industryStory = buildIndustryIntelligenceStory({
    industry,
    stocks,
    asAt: new Date().toISOString().slice(0, 10),
  });

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <ItemListStructuredData
        name={`Most Shorted ${industry.name} Stocks on the ASX`}
        description={`Ranked list of ${industry.stockCount} ${industry.name.toLowerCase()} stocks by short interest percentage, sourced from official ASIC data.`}
        items={stocks.slice(0, 20).map((s) => ({
          name: `${s.code} Short Position`,
          url: `${siteConfig.url}/shorts/${s.code}`,
          description: `${s.code} has ${s.shortPercent.toFixed(2)}% of shares sold short`,
        }))}
      />
      <LLMMeta
        title={`${industry.name} Industry Short Positions - ASX`}
        description={`Short selling data for ${industry.stockCount} ${industry.name.toLowerCase()} stocks on the ASX. Average short interest: ${industry.avgShortPercent.toFixed(2)}%.`}
        keywords={[
          `${industry.name.toLowerCase()} short positions`,
          `${industry.name.toLowerCase()} ASX`,
          `most shorted ${industry.name.toLowerCase()} stocks`,
          "ASIC short data",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
        requiresAuth={false}
      />

      <div className="space-y-8">
        {/* Breadcrumbs */}
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-start gap-5 mb-4">
            <div className="relative h-20 w-20 md:h-28 md:w-28 flex-shrink-0">
              <Image
                src={getSectorImagePath(industry.name)}
                alt={getSectorImageAlt(industry.name)}
                width={112}
                height={112}
                priority
                className="rounded-xl object-contain drop-shadow-md"
              />
            </div>
            <div className="pt-1">
              <h1 className={pageTitle}>
                {industry.name} Short Positions
              </h1>
              <p className="text-muted-foreground mt-1">
                {industry.stockCount} ASX stocks tracked in this sector
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-3">
                <Clock className="h-3.5 w-3.5" />
                <span>Data delayed T+4 trading days</span>
                <span>•</span>
                <span>Source: ASIC</span>
              </div>
            </div>
          </div>
        </section>

        {/* Narrative summary — server HTML, no client JS */}
        {narrative && (
          <section aria-labelledby="industry-summary-heading">
            <h2 id="industry-summary-heading" className="sr-only">
              {industry.name} short selling summary
            </h2>
            <p className="max-w-[70ch] text-base leading-relaxed text-muted-foreground text-pretty">
              {narrative.segments.map((segment, index) =>
                segment.kind === "stock" ? (
                  <Link
                    key={`${segment.code}-${index}`}
                    href={`/shorts/${segment.code}`}
                    className="font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {segment.code}
                  </Link>
                ) : (
                  <span key={`t-${index}`}>{segment.text}</span>
                ),
              )}
            </p>
          </section>
        )}

        {/* Stats Grid */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Average Short %"
            value={`${industry.avgShortPercent.toFixed(2)}%`}
            icon={<BarChart3 className="h-4 w-4" />}
            color="amber"
          />
          <StatCard
            label="Stocks Tracked"
            value={industry.stockCount.toString()}
            icon={<Building2 className="h-4 w-4" />}
            color="rust"
          />
          <StatCard
            label="Highly Shorted"
            value={highlyShorted.toString()}
            icon={<TrendingDown className="h-4 w-4" />}
            color="red"
            subtext="Above 10%"
          />
          <StatCard
            label="Short Interest Rising"
            value={increasing.toString()}
            icon={<TrendingUp className="h-4 w-4" />}
            color="orange"
            subtext="vs 3 months ago"
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-5 shadow-amber-sm">
            <div className={cn(eyebrow, "mb-3 inline-flex items-center gap-2 font-medium text-primary")}>
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Industry Intelligence
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-balance">
              Read {industry.name} in the wider evidence story
            </h2>
            <p className="mt-3 max-w-[68ch] text-sm text-muted-foreground text-pretty">
              Connect this sector table to the top-shorts leaderboard, stock
              detail pages, and alert workflows.
            </p>
            <Link
              href={`/industry-intelligence?industry=${slug}`}
              prefetch={false}
              className="mt-5 inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Open Industry Intelligence
              <ChevronRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <IndustrySignalPanel story={industryStory} stockLimit={5} />
        </section>

        {/* Stock Table */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top Shorted {industry.name} Stocks
          </h2>

          <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50 backdrop-blur-sm">
            {/* Header */}
            <div className="grid grid-cols-[60px_1fr_100px_100px_48px] md:grid-cols-[60px_1fr_120px_120px_48px] gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <div className="text-center">Rank</div>
              <div>Stock</div>
              <div className="text-right">Short %</div>
              <div className="text-right">Change</div>
              <div></div>
            </div>

            {/* Rows */}
            <div className="divide-y divide-border/40">
              {stocks.slice(0, 50).map((stock, index) => {
                const change = stock.change ?? 0;
                return (
                  <Link
                    key={stock.code}
                    href={`/shorts/${stock.code}`}
                    className="grid grid-cols-[60px_1fr_100px_100px_48px] md:grid-cols-[60px_1fr_120px_120px_48px] gap-4 px-4 py-4 items-center hover:bg-muted/50 transition-colors group"
                  >
                    {/* Rank */}
                    <div className="text-center">
                      <span
                        className={cn(
                          "text-lg font-bold tabular-nums",
                          index < 3 && "text-red-500",
                          index >= 3 && index < 10 && "text-orange-500",
                          index >= 10 && "text-foreground/70"
                        )}
                      >
                        {index + 1}
                      </span>
                    </div>

                    {/* Stock Info */}
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground group-hover:text-primary transition-colors">
                        {stock.code}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {stock.name}
                      </div>
                    </div>

                    {/* Short % */}
                    <div className="text-right">
                      <ShortPercentageCell value={stock.shortPercent} />
                    </div>

                    {/* Change */}
                    <div className="text-right">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-sm font-medium tabular-nums",
                          change > 0 && "text-red-500",
                          change < 0 && "text-green-500",
                          change === 0 && "text-foreground/70"
                        )}
                      >
                        {change > 0 ? (
                          <TrendingUp className="h-3 w-3" />
                        ) : change < 0 ? (
                          <TrendingDown className="h-3 w-3" />
                        ) : null}
                        {change >= 0 ? "+" : ""}
                        {change.toFixed(2)}%
                      </span>
                    </div>

                    {/* Arrow */}
                    <div className="flex justify-end">
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {stocks.length > 50 && (
            <p className="text-sm text-muted-foreground mt-4 text-center">
              Showing top 50 of {stocks.length} stocks
            </p>
          )}
        </section>

        {/* SEO Content */}
        <section className="prose prose-sm dark:prose-invert max-w-none">
          <h2>About {industry.name} Short Selling on the ASX</h2>
          {/* Methodology, not a restatement of the summary above — the
              narrative block already carries the sector's numbers. */}
          <p>
            This ranking measures{" "}
            <Link href="/glossary/short-interest" className="font-semibold">
              short interest
            </Link>{" "}
            as a percentage of shares on issue:
            the aggregated net short position each market participant reports to ASIC,
            divided by the company&apos;s total shares outstanding. Positions must be
            reported once they exceed $100,000 or 0.01% of issued capital, so smaller
            positions in {industry.name.toLowerCase()} stocks never appear in the data.
            Rankings are compared against the same sector, since what counts as heavy
            short interest differs markedly between industries.
          </p>
          <p>
            Short selling data is sourced from official ASIC reports, published with a T+4 trading day
            delay. High short interest in {industry.name.toLowerCase()} stocks may reflect sector-specific headwinds,
            commodity exposure, or broader market sentiment. Use the{" "}
            <Link href="/screener" className="font-semibold">stock screener</Link>{" "}
            to filter {industry.name.toLowerCase()} stocks by short interest, days to cover, and more.
          </p>
        </section>

        {/* Curated thematic baskets that sit inside this industry. Static
            registry data — no fetch — and renders nothing for the industries
            no theme claims. */}
        <RelatedThemesForIndustry industry={industry.name} className="mt-12" />

        {/* Related Industries */}
        <section className="mt-12 pt-8 border-t border-border/40">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Explore Other Industries</h2>
            <Link
              href="/industry"
              className="text-xs text-primary hover:underline"
            >
              View all industries
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {relatedIndustries.map((ri) => (
              <Link
                key={ri.slug}
                href={`/industry/${ri.slug}`}
              >
                <Badge
                  variant="outline"
                  className="hover:bg-primary/10 cursor-pointer gap-1.5 py-1"
                >
                  <Image
                    src={getSectorImagePath(ri.name)}
                    alt=""
                    width={16}
                    height={16}
                    className="rounded-sm"
                  />
                  {ri.name}
                  {ri.avgShortPercent > 0 && (
                    <span className="text-muted-foreground">
                      {ri.avgShortPercent.toFixed(1)}%
                    </span>
                  )}
                </Badge>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}

// Stat Card Component
function StatCard({
  label,
  value,
  icon,
  color,
  subtext,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: "red" | "orange" | "amber" | "rust";
  subtext?: string;
}) {
  // Flat tinted surfaces, no decorative gradient. Amber/rust carry the
  // non-directional stats; red/orange stay on the short-interest heat ramp.
  const colorClasses = {
    red: "bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400",
    orange: "bg-orange-500/10 border-orange-500/30 text-orange-600 dark:text-orange-400",
    amber: "bg-primary/10 border-primary/30 text-primary",
    rust: "bg-accent/10 border-accent/30 text-accent",
  };

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        colorClasses[color]
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {subtext && (
        <div className="text-xs text-muted-foreground mt-1">{subtext}</div>
      )}
    </div>
  );
}

// Short Percentage Cell with heat color
function ShortPercentageCell({ value }: { value: number }) {
  const getHeatColor = (pct: number) => {
    if (pct >= 20) return "bg-red-600 text-white border-red-700";
    if (pct >= 15) return "bg-red-500 text-white border-red-600";
    if (pct >= 10) return "bg-orange-500 text-white border-orange-600";
    if (pct >= 5) return "bg-yellow-500 text-black border-yellow-600";
    return "bg-muted text-foreground border-border";
  };

  return (
    <span
      className={cn(
        "inline-block px-2 py-1 rounded text-sm font-semibold tabular-nums border",
        getHeatColor(value)
      )}
    >
      {value.toFixed(2)}%
    </span>
  );
}
