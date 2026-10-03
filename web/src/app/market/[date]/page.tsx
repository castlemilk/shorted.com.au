import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Calendar,
  ChevronRight,
  ChevronLeft,
  TrendingDown,
  BarChart3,
  Building2,
  ArrowLeft,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import {
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { cn } from "~/@/lib/utils";
import { formatCompanyName } from "~/@/lib/company-name";
import {
  getMarketByDateStrict,
  isValidMarketDate,
} from "~/app/actions/market/getMarketByDate";

interface PageProps {
  params: Promise<{ date: string }>;
}

async function getMarketSnapshot(date: string) {
  const data = await getMarketByDateStrict(date, 50, 0);
  // Strict reads throw on exhausted retries and return null only for NotFound.
  // Keep an unexpected undefined response retryable rather than caching a 404.
  if (data === undefined) throw new Error("Market snapshot temporarily unavailable");
  if (!data?.stocks?.length) notFound();
  return data;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { date } = await params;
  validateDate(date);
  // Resolve missing dates before streaming the page so they return a real 404.
  // The action is React-cached; the page reuses the same date/limit/offset read.
  await getMarketSnapshot(date);
  const formattedDate = formatDate(date);

  // Root layout applies a `%s | Shorted` title template — no brand suffix here.
  const title = `ASX Short Positions on ${formattedDate} | Daily ASIC Report`;
  const description = `Reported ASX securities with positive short positions for ${formattedDate}. View the top 50 securities, including shares, ETFs and debt, from ASIC data published with a T+4 delay.`;

  return {
    title,
    description,
    keywords: [
      `ASX short positions ${date}`,
      `ASIC short report ${formattedDate}`,
      "daily short interest data",
      "ASX market snapshot",
      "short selling history",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/market/${date}`,
      siteName: siteConfig.name,
      type: "article",
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
      canonical: `${siteConfig.url}/market/${date}`,
    },
  };
}

// Cache historical snapshots on first request; daily ingestion/corrections
// invalidate shorts-data and the 24h ceiling bounds a missed notification.
export const revalidate = 86400;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ date: string }> {
  return [];
}

function validateDate(dateStr: string): void {
  if (!isValidMarketDate(dateStr)) notFound();
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function DateDatasetStructuredData({ date }: { date: string }) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `ASX Short Positions - ${formatDate(date)}`,
    description: `Top 50 reported ASX securities with positive short positions for ${formatDate(date)}, including shares, ETFs and debt. ASIC publishes position data with a T+4 delay.`,
    url: `${siteConfig.url}/market/${date}`,
    temporalCoverage: date,
    creator: {
      "@type": "Organization",
      name: "Australian Securities and Investments Commission (ASIC)",
      url: "https://asic.gov.au",
    },
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    license: "https://creativecommons.org/licenses/by/4.0/",
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  );
}

export default async function MarketDatePage({ params }: PageProps) {
  const { date } = await params;

  validateDate(date);

  const data = await getMarketSnapshot(date);

  const formattedDate = formatDate(date);

  // Compute summary stats
  const totalSecurities = data.totalCount;
  const topStock = data.stocks[0];
  const highestShort = topStock?.percentageShorted ?? 0;

  const breadcrumbItems = [
    { label: "Market", href: "/market" },
    { label: formattedDate, href: `/market/${date}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Market", url: `${siteConfig.url}/market` },
    { name: formattedDate, url: `${siteConfig.url}/market/${date}` },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <DateDatasetStructuredData date={date} />

      <div className="space-y-8">
        {/* Breadcrumbs */}
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Back link */}
        <Link
          href="/market"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All Dates
        </Link>

        {/* Hero */}
        <section className="border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <Calendar className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className={pageTitle}>
                ASX Short Positions
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {formattedDate}
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Position date: {formattedDate}. ASIC publishes aggregated short
            positions with a T+4 delay. This snapshot includes shares, ETFs,
            debt and other securities with reported positive short positions.
            Their issued-product denominators differ, so percentages across
            instrument types are not directly comparable. The{" "}
            <Link href="/top" className="underline underline-offset-4">filtered top-shorts list</Link>{" "}
            excludes ETFs, debt and other non-equity instruments; ranks and
            counts can differ. Read the{" "}
            <Link href="/methodology" className="underline underline-offset-4">data methodology</Link>.
          </p>
        </section>

        {/* Stats Grid */}
        <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard
            label="Securities with Short Positions"
            value={totalSecurities.toString()}
            icon={<Building2 className="h-4 w-4" />}
            color="amber"
          />
          <StatCard
            label="Highest Short %"
            value={`${highestShort.toFixed(2)}%`}
            icon={<TrendingDown className="h-4 w-4" />}
            color="red"
            subtext={topStock?.productCode}
          />
          <StatCard
            label="Securities Displayed"
            value={data.stocks.length.toString()}
            icon={<BarChart3 className="h-4 w-4" />}
            color="rust"
            subtext={`Of ${totalSecurities.toLocaleString()} reported securities`}
          />
        </section>

        {/* Stock Table */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top {data.stocks.length} Shorted Securities
          </h2>

          <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50 backdrop-blur-sm">
            {/* Header */}
            <div className="grid grid-cols-[60px_1fr_100px_48px] md:grid-cols-[60px_1fr_120px_120px_48px] gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <div className="text-center">Rank</div>
              <div>Security</div>
              <div className="text-right">Short %</div>
              <div className="text-right hidden md:block">Industry</div>
              <div></div>
            </div>

            {/* Rows */}
            <div className="divide-y divide-border/40">
              {data.stocks.map((stock, index) => (
                <Link
                  key={stock.productCode}
                  href={`/shorts/${stock.productCode}`}
                  className="grid grid-cols-[60px_1fr_100px_48px] md:grid-cols-[60px_1fr_120px_120px_48px] gap-4 px-4 py-3 items-center hover:bg-muted/50 transition-colors group"
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
                      {stock.productCode}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {formatCompanyName(stock.name, stock.productCode)}
                    </div>
                    {stock.securityType && stock.securityType !== "ordinary" && (
                      <div className="text-xs text-muted-foreground">
                        Instrument type: {stock.securityType === "etf" ? "ETF" : stock.securityType}
                      </div>
                    )}
                  </div>

                  {/* Short % */}
                  <div className="text-right">
                    <ShortPercentageCell value={stock.percentageShorted} />
                  </div>

                  {/* Industry */}
                  <div className="text-right hidden md:block">
                    <span className="text-xs text-muted-foreground truncate">
                      {stock.industry || "—"}
                    </span>
                  </div>

                  {/* Arrow */}
                  <div className="flex justify-end">
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Prev/Next Navigation */}
        <section className="flex justify-between pt-4">
          {data.previousDate ? (
            <Link href={`/market/${data.previousDate}`}>
              <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                <ChevronLeft className="h-3 w-3 mr-1" />
                {formatDate(data.previousDate)}
              </Badge>
            </Link>
          ) : (
            <div />
          )}
          {data.nextDate ? (
            <Link href={`/market/${data.nextDate}`}>
              <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                {formatDate(data.nextDate)}
                <ChevronRight className="h-3 w-3 ml-1" />
              </Badge>
            </Link>
          ) : (
            <div />
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}

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
  color: "red" | "amber" | "rust";
  subtext?: string;
}) {
  // Flat tinted surfaces, no decorative gradient. Amber/rust carry the
  // non-directional stats; red stays on the short-interest heat ramp.
  const colorClasses = {
    red: "bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400",
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
