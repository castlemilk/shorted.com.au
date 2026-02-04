import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  TrendingUp,
  TrendingDown,
  Building2,
  ChevronRight,
  BarChart3,
  Clock,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import {
  BreadcrumbListSchema,
  FAQStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  getIndustryStocks,
  getAllIndustrySlugs,
} from "../../actions/industry/getIndustryData";
import { cn } from "~/@/lib/utils";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { industry } = await getIndustryStocks(slug);

  if (!industry) {
    return {
      title: "Industry Not Found",
    };
  }

  const title = `Most Shorted ${industry.name} Stocks ASX | ${industry.stockCount} Tracked`;
  const description = `Top ${Math.min(20, industry.stockCount)} most shorted ${industry.name.toLowerCase()} stocks on the ASX. Average short interest: ${industry.avgShortPercent.toFixed(2)}%. Official ASIC data with T+4 delay.`;

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
  const { industry, stocks } = await getIndustryStocks(slug);

  if (!industry) {
    notFound();
  }

  const breadcrumbItems = [
    { label: "Industries", href: "/industry" },
    { label: industry.name, href: `/industry/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Industries", url: `${siteConfig.url}/industry` },
    { name: industry.name, url: `${siteConfig.url}/industry/${slug}` },
  ];

  // FAQ data for rich snippets
  const faqs = [
    {
      question: `What are the most shorted ${industry.name.toLowerCase()} stocks on the ASX?`,
      answer: `The most shorted ${industry.name.toLowerCase()} stocks on the ASX include ${stocks.slice(0, 3).map(s => s.code).join(", ")}. This page shows all ${industry.stockCount} ${industry.name.toLowerCase()} stocks tracked with their current short positions from official ASIC data.`,
    },
    {
      question: `How much short interest is there in ${industry.name.toLowerCase()} stocks?`,
      answer: `The average short interest across ${industry.stockCount} ${industry.name.toLowerCase()} stocks on the ASX is ${industry.avgShortPercent.toFixed(2)}%. The highest shorted stock in this sector is ${industry.topStock?.code} at ${industry.topStock?.shortPercent.toFixed(2)}%.`,
    },
    {
      question: `Why are ${industry.name.toLowerCase()} stocks heavily shorted?`,
      answer: `${industry.name} stocks may attract short sellers due to sector-specific factors such as commodity price movements, regulatory changes, or broader market sentiment. High short interest can indicate bearish views but also potential for short squeezes.`,
    },
  ];

  // Calculate stats
  const highlyShorted = stocks.filter((s) => s.shortPercent > 10).length;
  const increasing = stocks.filter((s) => (s.change ?? 0) > 0).length;

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <FAQStructuredData faqs={faqs} />

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
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                {industry.name} Short Positions
              </h1>
              <p className="text-muted-foreground mt-1">
                {industry.stockCount} ASX stocks tracked in this sector
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-4">
            <Clock className="h-3.5 w-3.5" />
            <span>Data delayed T+4 trading days</span>
            <span>•</span>
            <span>Source: ASIC</span>
          </div>
        </section>

        {/* Stats Grid */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Average Short %"
            value={`${industry.avgShortPercent.toFixed(2)}%`}
            icon={<BarChart3 className="h-4 w-4" />}
            color="blue"
          />
          <StatCard
            label="Stocks Tracked"
            value={industry.stockCount.toString()}
            icon={<Building2 className="h-4 w-4" />}
            color="purple"
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

        {/* Related Industries */}
        <section className="mt-12 pt-8 border-t border-border/40">
          <h2 className="text-lg font-semibold mb-4">Explore Other Industries</h2>
          <div className="flex flex-wrap gap-2">
            <Link href="/industry">
              <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                View All Industries
              </Badge>
            </Link>
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
  color: "red" | "orange" | "blue" | "purple";
  subtext?: string;
}) {
  const colorClasses = {
    red: "from-red-500/20 to-red-500/5 border-red-500/30 text-red-500",
    orange: "from-orange-500/20 to-orange-500/5 border-orange-500/30 text-orange-500",
    blue: "from-blue-500/20 to-blue-500/5 border-blue-500/30 text-blue-500",
    purple: "from-purple-500/20 to-purple-500/5 border-purple-500/30 text-purple-500",
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-gradient-to-br p-4 backdrop-blur-sm",
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
