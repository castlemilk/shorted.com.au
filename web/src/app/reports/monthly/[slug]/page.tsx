import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FileText,
  ChevronRight,
  TrendingDown,
  BarChart3,
  Building2,
  ArrowLeft,
  Calendar,
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
  getMonthlyReportData,
  getAvailableMonthSlugs,
} from "~/app/actions/reports/getReportData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  try {
    const slugs = await getAvailableMonthSlugs();
    // Only pre-generate last 3 months at build time; rest via ISR on-demand
    return slugs.slice(0, 3).map((slug) => ({ slug }));
  } catch {
    return [];
  }
}

function formatMonthTitle(slug: string): string {
  const date = new Date(`${slug}-01T00:00:00`);
  return date.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const monthTitle = formatMonthTitle(slug);

  const title = `ASX Short Selling Report: ${monthTitle} | ${siteConfig.name}`;
  const description = `Monthly short selling report for the ASX — ${monthTitle}. Top shorted stocks, industry analysis, and aggregate short interest from official ASIC data.`;

  return {
    title,
    description,
    keywords: [
      `ASX short selling report ${monthTitle}`,
      `monthly short interest ${monthTitle}`,
      "ASX short positions monthly",
      "ASIC monthly report",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/reports/monthly/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
    },
    alternates: {
      canonical: `${siteConfig.url}/reports/monthly/${slug}`,
    },
  };
}

export const revalidate = 86400;

export default async function MonthlyReportPage({ params }: PageProps) {
  const { slug } = await params;

  if (!/^\d{4}-\d{2}$/.test(slug)) {
    notFound();
  }

  const data = await getMonthlyReportData(slug);
  if (!data) {
    notFound();
  }

  const monthTitle = formatMonthTitle(slug);

  const breadcrumbItems = [
    { label: "Reports", href: "/reports" },
    { label: monthTitle, href: `/reports/monthly/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Reports", url: `${siteConfig.url}/reports` },
    { name: monthTitle, url: `${siteConfig.url}/reports/monthly/${slug}` },
  ];

  const topStock = data.topStocks[0];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <Link
          href="/reports"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All Reports
        </Link>

        {/* Hero */}
        <section className="border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <FileText className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                Monthly Short Selling Report
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {monthTitle}
              </p>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="rounded-lg border bg-gradient-to-br from-blue-500/20 to-blue-500/5 border-blue-500/30 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Building2 className="h-4 w-4" />
              <span>Stocks Shorted</span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-blue-500">{data.totalStocksShorted}</div>
          </div>
          <div className="rounded-lg border bg-gradient-to-br from-red-500/20 to-red-500/5 border-red-500/30 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <TrendingDown className="h-4 w-4" />
              <span>Most Shorted</span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-red-500">
              {topStock ? `${topStock.shortPercent.toFixed(2)}%` : "—"}
            </div>
            {topStock && <div className="text-xs text-muted-foreground mt-1">{topStock.code}</div>}
          </div>
          <div className="rounded-lg border bg-gradient-to-br from-purple-500/20 to-purple-500/5 border-purple-500/30 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <BarChart3 className="h-4 w-4" />
              <span>Trading Days</span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-purple-500">{data.dates.length}</div>
          </div>
        </section>

        {/* Daily Snapshots */}
        {data.dates.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              Daily Snapshots
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.dates.map((date) => (
                <Link key={date} href={`/market/${date}`}>
                  <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                    {formatDate(date)}
                  </Badge>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Top Stocks Table */}
        <section>
          <h2 className="text-xl font-semibold mb-4">
            Top Shorted Stocks This Month
          </h2>
          <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50">
            <div className="grid grid-cols-[60px_1fr_100px_48px] gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <div className="text-center">Rank</div>
              <div>Stock</div>
              <div className="text-right">Short %</div>
              <div></div>
            </div>
            <div className="divide-y divide-border/40">
              {data.topStocks.slice(0, 30).map((stock, index) => (
                <Link
                  key={stock.code}
                  href={`/shorts/${stock.code}`}
                  className="grid grid-cols-[60px_1fr_100px_48px] gap-4 px-4 py-3 items-center hover:bg-muted/50 transition-colors group"
                >
                  <div className="text-center">
                    <span className={cn(
                      "text-lg font-bold tabular-nums",
                      index < 3 && "text-red-500",
                      index >= 3 && index < 10 && "text-orange-500",
                      index >= 10 && "text-foreground/70"
                    )}>
                      {index + 1}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold group-hover:text-primary transition-colors">{stock.code}</div>
                    <div className="text-xs text-muted-foreground truncate">{stock.name}</div>
                  </div>
                  <div className="text-right">
                    <span className={cn(
                      "inline-block px-2 py-1 rounded text-sm font-semibold tabular-nums border",
                      stock.shortPercent >= 10 ? "bg-red-600 text-white border-red-700" :
                      stock.shortPercent >= 5 ? "bg-yellow-500 text-black border-yellow-600" :
                      "bg-muted text-foreground border-border"
                    )}>
                      {stock.shortPercent.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-end">
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
