import { type Metadata } from "next";
import Link from "next/link";
import { FileText, ChevronRight, Calendar } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
} from "~/@/components/ui/card";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  getAvailableWeekSlugs,
  getAvailableMonthSlugs,
  getAvailableYearSlugs,
} from "~/app/actions/reports/getReportData";

export const metadata: Metadata = {
  title: "ASX Short Selling Reports | Weekly & Monthly Analysis | Shorted",
  description:
    "Weekly and monthly reports on ASX short selling activity. See top movers, industry trends, and aggregate short interest from official ASIC data.",
  keywords: [
    "ASX short selling reports",
    "weekly short interest report",
    "monthly short selling analysis",
    "ASIC short position reports",
    "Australian stock market reports",
  ],
  openGraph: {
    title: "ASX Short Selling Reports | Weekly & Monthly Analysis",
    description: "Weekly and monthly reports on ASX short selling activity.",
    url: `${siteConfig.url}/reports`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  alternates: {
    canonical: `${siteConfig.url}/reports`,
  },
};

export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Reports", url: `${siteConfig.url}/reports` },
];

function formatWeekSlug(slug: string): string {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return slug;
  return `Week ${parseInt(match[2])}, ${match[1]}`;
}

function formatMonthSlug(slug: string): string {
  const date = new Date(`${slug}-01T00:00:00`);
  return date.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

export default async function ReportsIndexPage() {
  const weekSlugs = await getAvailableWeekSlugs();
  const monthSlugs = await getAvailableMonthSlugs();
  const yearSlugs = await getAvailableYearSlugs();

  const breadcrumbItems = [{ label: "Reports", href: "/reports" }];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <FileText className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                Short Selling Reports
              </h1>
              <p className="text-muted-foreground mt-1">
                Weekly and monthly analysis of ASX short selling activity
              </p>
            </div>
          </div>
        </section>

        {/* Weekly Reports */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Weekly Reports
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {weekSlugs.slice(0, 12).map((slug) => (
              <Link key={slug} href={`/reports/weekly/${slug}`} className="group">
                <Card className="hover:border-primary/50 transition-colors h-full">
                  <CardContent className="pt-4 pb-4 flex items-center justify-between">
                    <div>
                      <p className="font-semibold group-hover:text-primary transition-colors">
                        {formatWeekSlug(slug)}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {weekSlugs.length > 12 && (
            <p className="text-sm text-muted-foreground mt-3">
              Showing latest 12 weeks. Older reports available via direct URL.
            </p>
          )}
        </section>

        {/* Year in Review */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Year in Review
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {yearSlugs.map((slug) => (
              <Link key={slug} href={`/reports/yearly/${slug}`} className="group">
                <Card className="hover:border-primary/50 transition-colors h-full">
                  <CardContent className="pt-4 pb-4 flex items-center justify-between">
                    <div>
                      <p className="font-semibold group-hover:text-primary transition-colors">
                        {slug} Year in Review
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>

        {/* Monthly Reports */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Monthly Reports
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {monthSlugs.slice(0, 12).map((slug) => (
              <Link key={slug} href={`/reports/monthly/${slug}`} className="group">
                <Card className="hover:border-primary/50 transition-colors h-full">
                  <CardContent className="pt-4 pb-4 flex items-center justify-between">
                    <div>
                      <p className="font-semibold group-hover:text-primary transition-colors">
                        {formatMonthSlug(slug)}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {monthSlugs.length > 12 && (
            <p className="text-sm text-muted-foreground mt-3">
              Showing latest 12 months. Older reports available via direct URL.
            </p>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
