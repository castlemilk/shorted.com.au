import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { Calendar, ChevronRight, TrendingDown } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
} from "~/@/components/ui/card";
import {
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { getAvailableDates } from "~/app/actions/market/getMarketByDate";
import { skipForBuild } from "~/app/actions/config";

export const metadata: Metadata = {
  title: "Daily ASX Short Position Snapshots",
  description:
    "Browse daily snapshots of ASX short positions from official ASIC data. See which stocks were most shorted on any trading day. Historical short selling data since 2010.",
  keywords: [
    "daily short positions ASX",
    "ASIC short position history",
    "ASX short selling by date",
    "historical short interest data",
    "daily market snapshot",
  ],
  openGraph: {
    title: "Daily ASX Short Position Snapshots | Historical ASIC Data",
    description:
      "Browse daily snapshots of ASX short positions from official ASIC data.",
    url: `${siteConfig.url}/market`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Daily ASX Short Position Snapshots",
    description: "Browse daily snapshots of ASX short positions from ASIC data.",
  },
  alternates: {
    canonical: `${siteConfig.url}/market`,
  },
};

export const revalidate = 3600; // Revalidate hourly

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Market", url: `${siteConfig.url}/market` },
];

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function MarketIndexPage() {
  let dates: string[] = [];
  let latestDate = "";
  let earliestDate = "";

  if (!skipForBuild()) {
    try {
      const response = await getAvailableDates(90);
      dates = response.dates;
      latestDate = response.latestDate;
      earliestDate = response.earliestDate;
    } catch (error) {
      console.error("Failed to fetch available dates:", error);
    }
  }

  const breadcrumbItems = [
    { label: "Market", href: "/market" },
  ];

  // Group dates by month
  const datesByMonth = new Map<string, string[]>();
  for (const date of dates) {
    const monthKey = date.slice(0, 7); // YYYY-MM
    if (!datesByMonth.has(monthKey)) {
      datesByMonth.set(monthKey, []);
    }
    datesByMonth.get(monthKey)!.push(date);
  }

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
              <Calendar className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className={pageTitle}>
                Daily Market Snapshots
              </h1>
              <p className="text-muted-foreground mt-1">
                ASX short positions by trading date — official ASIC data
              </p>
            </div>
          </div>
          {latestDate && earliestDate && (
            <p className="text-sm text-muted-foreground">
              Data available from {formatDate(earliestDate)} to {formatDate(latestDate)}
            </p>
          )}
        </section>

        {/* Latest Date CTA */}
        {dates.length > 0 && dates[0] && (
          <section>
            <Link href={`/market/${dates[0]}`}>
              <Card className="bg-primary/5 border-primary/20 hover:bg-primary/10 transition-colors">
                <CardContent className="pt-6 flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Latest snapshot</p>
                    <p className="text-xl font-bold mt-1">{formatDate(dates[0])}</p>
                  </div>
                  <div className="flex items-center gap-2 text-primary">
                    <TrendingDown className="h-5 w-5" />
                    <span className="font-medium">View Report</span>
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          </section>
        )}

        {/* Dates by Month */}
        {Array.from(datesByMonth.entries()).map(([monthKey, monthDates]) => {
          const monthDate = new Date(monthKey + "-01T00:00:00");
          const monthName = monthDate.toLocaleDateString("en-AU", {
            year: "numeric",
            month: "long",
          });

          return (
            <section key={monthKey}>
              <h2 className="text-lg font-semibold mb-3">{monthName}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {monthDates.map((date) => {
                  const d = new Date(date + "T00:00:00");
                  const dayName = d.toLocaleDateString("en-AU", { weekday: "short" });
                  const dayNum = d.getDate();

                  return (
                    <Link
                      key={date}
                      href={`/market/${date}`}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:bg-muted/50 hover:border-primary/30 transition-colors group"
                    >
                      <div className="text-center min-w-[32px]">
                        <div className="text-xs text-muted-foreground">{dayName}</div>
                        <div className="text-lg font-bold tabular-nums">{dayNum}</div>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors ml-auto" />
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}

        {dates.length === 0 && (
          <section className="text-center py-12">
            <p className="text-muted-foreground">
              No market snapshot data available. Data will be available once the API is running.
            </p>
          </section>
        )}
      </div>
    </DashboardLayout>
  );
}
