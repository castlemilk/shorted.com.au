import { type Metadata } from "next";
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
import {
  getMarketByDate,
} from "~/app/actions/market/getMarketByDate";

// Production API URL for static generation
const PRODUCTION_API_URL = "https://api.shorted.com.au";

interface PageProps {
  params: Promise<{ date: string }>;
}

export async function generateStaticParams(): Promise<{ date: string }[]> {
  try {
    const { createConnectTransport } = await import("@connectrpc/connect-web");
    const { createClient } = await import("@connectrpc/connect");
    const { ShortedStocksService } = await import("~/gen/shorts/v1alpha1/shorts_pb");

    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
        process.env.NEXT_PUBLIC_API_URL ??
        PRODUCTION_API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    // Only pre-generate last 10 dates at build time; rest via ISR on-demand
    const response = await client.getAvailableDates({ limit: 10, before: "" });

    return response.dates.map((date) => ({ date }));
  } catch (error) {
    console.warn("Failed to fetch dates for static generation:", error);
    return [];
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { date } = await params;
  const formattedDate = formatDate(date);

  const title = `ASX Short Positions on ${formattedDate} | Daily ASIC Report | ${siteConfig.name}`;
  const description = `Complete snapshot of ASX short positions for ${formattedDate}. Top shorted stocks, industry breakdown, and market-wide short interest from official ASIC data.`;

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
      card: "summary",
      title,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/market/${date}`,
    },
  };
}

// Historical dates are immutable, so we can cache them indefinitely
export const revalidate = 86400;

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function DateDatasetStructuredData({ date }: { date: string }) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `ASX Short Positions - ${formatDate(date)}`,
    description: `Daily snapshot of all ASX short positions reported to ASIC for ${formatDate(date)}`,
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

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    notFound();
  }

  const data = await getMarketByDate(date, 50, 0);

  if (!data || data.stocks.length === 0) {
    notFound();
  }

  const formattedDate = formatDate(date);

  // Compute summary stats
  const totalStocks = data.totalCount;
  const topStock = data.stocks[0];
  const highestShort = topStock?.percentageShorted ?? 0;
  const totalReportedPositions = data.stocks.reduce(
    (sum, s) => sum + Number(s.reportedShortPositions),
    0,
  );

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
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                ASX Short Positions
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {formattedDate}
              </p>
            </div>
          </div>
        </section>

        {/* Stats Grid */}
        <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard
            label="Stocks with Short Positions"
            value={totalStocks.toString()}
            icon={<Building2 className="h-4 w-4" />}
            color="blue"
          />
          <StatCard
            label="Highest Short %"
            value={`${highestShort.toFixed(2)}%`}
            icon={<TrendingDown className="h-4 w-4" />}
            color="red"
            subtext={topStock?.productCode}
          />
          <StatCard
            label="Total Short Positions"
            value={totalReportedPositions.toLocaleString()}
            icon={<BarChart3 className="h-4 w-4" />}
            color="purple"
            subtext="Shares reported"
          />
        </section>

        {/* Stock Table */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top 50 Most Shorted Stocks
          </h2>

          <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50 backdrop-blur-sm">
            {/* Header */}
            <div className="grid grid-cols-[60px_1fr_100px_48px] md:grid-cols-[60px_1fr_120px_120px_48px] gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <div className="text-center">Rank</div>
              <div>Stock</div>
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
                      {stock.name}
                    </div>
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
  color: "red" | "blue" | "purple";
  subtext?: string;
}) {
  const colorClasses = {
    red: "from-red-500/20 to-red-500/5 border-red-500/30 text-red-500",
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
