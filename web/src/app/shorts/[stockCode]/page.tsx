import dynamic from "next/dynamic";
import MarketChart from "~/@/components/ui/market-chart";
import CompanyProfile, {
  CompanyProfilePlaceholder,
} from "~/@/components/ui/companyProfile";
import CompanyStats, {
  CompanyStatsPlaceholder,
} from "~/@/components/ui/companyStats";
import CompanyInfo, {
  CompanyInfoPlaceholder,
} from "~/@/components/ui/companyInfo";
import CompanyFinancials, {
  CompanyFinancialsPlaceholder,
} from "~/@/components/ui/companyFinancials";
import { EnrichedCompanySection } from "~/@/components/company/enriched-company-section";
import { Suspense } from "react";
import { StockStructuredData } from "~/@/components/seo/structured-data";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { TrendingDown, CandlestickChart } from "lucide-react";

interface PageProps {
  params: { stockCode: string };
}

// ISR: Revalidate every hour (3600 seconds)
export const revalidate = 3600;

const Chart = dynamic(() => import("~/@/components/ui/chart"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const Page = ({ params }: PageProps) => {
  // This page is public for SEO and discovery - no authentication required
  const stockCode = params.stockCode.toUpperCase();

  const breadcrumbItems = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: `/shorts/${stockCode}` },
  ];

  return (
    <DashboardLayout>
      <StockStructuredData stockCode={stockCode} />
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <LLMMeta
        title={`${stockCode} Stock Analysis - Short Position Data`}
        description={`Comprehensive analysis of ${stockCode} short positions on the ASX. View real-time charts, company profile, and short interest data for ${stockCode} shares.`}
        keywords={[
          `${stockCode} short position`,
          `${stockCode} ASX`,
          `${stockCode} stock analysis`,
          `${stockCode} short interest`,
          "short selling data",
          "Australian stocks",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
        requiresAuth={false}
      />

      <div className="mb-4">
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      <div className="grid auto-rows-min flex-1 items-start gap-4 md:gap-8 lg:grid-cols-3 xl:grid-cols-3">
        <div className="grid items-start gap-4 md:gap-8 lg:col-span-1">
          <div className="grid  gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyProfilePlaceholder />}>
              <CompanyProfile stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyStatsPlaceholder />}>
              <CompanyStats stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyInfoPlaceholder />}>
              <CompanyInfo stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyFinancialsPlaceholder />}>
              <CompanyFinancials stockCode={params.stockCode} />
            </Suspense>
          </div>
        </div>
        <div className="grid auto-rows-max items-start gap-6 lg:col-span-2">
          {/* Short Position Trends */}
          <Card className="border-l-4 border-l-red-500 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden">
            <CardHeader className="pb-4 bg-gradient-to-r from-red-50/50 to-transparent dark:from-red-950/20 dark:to-transparent">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-red-100 dark:bg-red-900/40 rounded-lg shadow-sm">
                  <TrendingDown className="h-6 w-6 text-red-600 dark:text-red-400" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-xl text-red-900 dark:text-red-100">
                    Short Position Trends
                  </CardTitle>
                  <CardDescription className="mt-1.5 text-sm">
                    Track bearish sentiment and short interest over time
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <Chart stockCode={params.stockCode} />
            </CardContent>
          </Card>

          {/* Historical Price Data */}
          <Card className="border-l-4 border-l-blue-500 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden">
            <CardHeader className="pb-4 bg-gradient-to-r from-blue-50/50 to-transparent dark:from-blue-950/20 dark:to-transparent">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 rounded-lg shadow-sm">
                  <CandlestickChart className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-xl text-blue-900 dark:text-blue-100">
                    Historical Price Data
                  </CardTitle>
                  <CardDescription className="mt-1.5 text-sm">
                    View stock price movements, volume, and trading patterns
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <MarketChart stockCode={params.stockCode} />
            </CardContent>
          </Card>

          {/* Enriched Company Insights */}
          <EnrichedCompanySection stockCode={stockCode} />
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Page;

const ChartSkeleton = () => (
  <div className="grid">
    <div className="flex flex-row-reverse">
      <div className="flex">
        <div className="h-10 w-[60px] ml-2 rounded bg-muted animate-pulse" />
        <div className="h-10 w-[60px] ml-2 rounded bg-muted animate-pulse" />
      </div>
      <div className="flex space-x-2">
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="h-10 w-12 rounded bg-muted animate-pulse" />
        ))}
      </div>
    </div>
    <div>
      <div className="h-[500px] min-h-[500px] w-full mt-2 rounded bg-muted animate-pulse" />
    </div>
  </div>
);
